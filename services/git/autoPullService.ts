import { createHttpTransport } from "../gitCore"
import { getAuth } from "../authStore"
import { cleanupOriginAfterMissingTarget } from "./remoteService"
import { findRepo, updateBranchLastPulledAt } from "../repoStore"
import { getCtx, resolveGitdir, resolveCurrentBranch, type GitContext } from "./runtime"
import { parseUpstreamConfig, upstreamMergeBranch } from "../../utils/remote"
import { checkRemoteCancelled, createGitOnProgress, type RemoteOpOptions } from "../../utils/remoteProgress"

/** 默认只拉取 clone；用户显式刷新可允许所有已注册来源，安全检查不变。 */
export type AutoPullOptions = RemoteOpOptions & { includeAllSources?: boolean }
export type AutoPullOutcome = { status: "updated" | "unchanged" | "skipped"; reason: string }
class SkipAutoPull extends Error {}
const skip = (reason: string): never => { throw new SkipAutoPull(reason) }
type Baseline = { branch: string; oid: string; remote: string; remoteBranch: string; url: string }

async function inspect(ctx: GitContext): Promise<Baseline> {
  const { git, fs, dir, gitdir } = ctx
  for (const marker of ["gitgit-merge-state.json", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "index.lock"]) {
    if (await FileManager.exists(gitdir + "/" + marker)) skip("存在未完成合并/变基或索引锁，请手动处理")
  }
  const branch = await resolveCurrentBranch(git, fs, dir, gitdir)
  if (!branch) skip("HEAD 未指向本地分支")
  let oid: string
  try { oid = await git.resolveRef({ fs, dir, gitdir, ref: "HEAD" }) }
  catch (error: any) {
    if (error?.code === "NotFoundError") return skip("当前分支尚无提交")
    throw error
  }
  const upstream = parseUpstreamConfig(
    await git.getConfig({ fs, dir, gitdir, path: `branch.${branch}.remote` }),
    await git.getConfig({ fs, dir, gitdir, path: `branch.${branch}.merge` })
  )
  if (!upstream || upstream.remote === ".") skip("当前分支未配置可用远端 upstream")
  const remotes = await git.listRemotes({ fs, dir, gitdir })
  const url = remotes.find((item: { remote: string; url: string }) => item.remote === upstream!.remote)?.url
  if (!url || !/^https?:\/\//i.test(url)) skip("upstream 远端缺失或协议不支持自动拉取")
  // 不复用状态缓存；ignored=true 也保护可能被新远端文件覆盖的忽略/未跟踪文件。
  const matrix = await git.statusMatrix({ fs, dir, gitdir, ignored: true, filter: (path: string) => path !== ".git" && !path.startsWith(".git/") })
  if (matrix.some((row: [string, number, number, number]) => row[1] !== row[2] || row[2] !== row[3])) skip("存在未提交、暂存或未跟踪文件，保留本地内容")
  return { branch, oid, remote: upstream!.remote, remoteBranch: upstreamMergeBranch(upstream!.merge), url }
}
function same(a: Baseline, b: Baseline): boolean {
  return a.branch === b.branch && a.oid === b.oid && a.remote === b.remote && a.remoteBranch === b.remoteBranch && a.url === b.url
}

/** 必须由 facade 在同仓 mutation 屏障内调用。与手动 pull 的合并路径完全分离。 */
export async function autoPullInternal(bookmarkName: string, options?: AutoPullOptions): Promise<AutoPullOutcome> {
  try {
    checkRemoteCancelled(options)
    const repo = findRepo(bookmarkName)
    if (!repo) return skip("仓库未注册")
    if (!options?.includeAllSources && repo.source !== "clone") skip("不是已注册的克隆仓库")
    const registration = { source: repo.source, repoId: repo.repoId, createdAt: repo.createdAt }
    if (!(await FileManager.exists(resolveGitdir(bookmarkName) + "/HEAD"))) skip("本地 Git 数据不可用，未自动初始化")
    const ctx = await getCtx(bookmarkName)
    const before = await inspect(ctx)
    checkRemoteCancelled(options)
    const auth = getAuth()
    const { git, fs, dir, gitdir } = ctx
    // 仅用户手动拉取（页面显式传入）才同一次抓取全部 origin 分支并 prune；后台/默认路径保持单分支。
    const syncOrigin = options?.pruneOriginBranches === true && before.remote === "origin"
    let fetched: Awaited<ReturnType<typeof git.fetch>>
    try {
      fetched = await git.fetch({
        fs, dir, gitdir, http: createHttpTransport(auth?.username, auth?.password),
        onAuth: () => auth || { username: "anonymous", password: "" },
        remote: before.remote, ref: before.remoteBranch, singleBranch: !syncOrigin, prune: syncOrigin, tags: false,
        onProgress: createGitOnProgress(options),
      })
    } catch (error: any) {
      await cleanupOriginAfterMissingTarget(bookmarkName, before.remote, error, options)
      throw error
    }
    checkRemoteCancelled(options)
    const current = findRepo(bookmarkName)
    // 旧注册记录可能在解析工作目录时补齐 repoId，不将该兼容迁移误判为重新注册。
    if (!current || current.source !== registration.source || (registration.repoId && current.repoId !== registration.repoId) || current.createdAt !== registration.createdAt) skip("仓库注册状态已变化")
    const latest = await getCtx(bookmarkName)
    if (latest.dir !== dir || latest.gitdir !== gitdir) skip("工作区授权路径已变化")
    const after = await inspect(latest)
    if (!same(before, after)) skip("拉取期间分支、HEAD 或 upstream 已变化")
    const theirs = await git.resolveRef({ fs, dir, gitdir, ref: `refs/remotes/${before.remote}/${before.remoteBranch}` })
    if (!fetched.fetchHead || fetched.fetchHead !== theirs) skip("远端跟踪引用未确认，未更新本地分支")
    if (theirs === before.oid) {
      checkRemoteCancelled(options)
      updateBranchLastPulledAt(bookmarkName, before.branch, Date.now())
      return { status: "unchanged", reason: "已是最新" }
    }
    const bases: string[] = await git.findMergeBase({ fs, dir, gitdir, oids: [before.oid, theirs] })
    if (bases.includes(theirs)) {
      checkRemoteCancelled(options)
      updateBranchLastPulledAt(bookmarkName, before.branch, Date.now())
      return { status: "unchanged", reason: "本地领先，未改动本地提交" }
    }
    if (!bases.includes(before.oid)) skip("本地与远端已分叉，仅允许快进，请手动处理")
    // 图遍历后、写工作区前再次检查，明确不调用手动 merge/rebase/commit 或 force checkout。
    if (!same(before, await inspect(latest))) skip("更新前本地状态已变化")
    checkRemoteCancelled(options)
    await git.checkout({ fs, dir, gitdir, ref: theirs, noUpdateHead: true, track: false, force: false })
    // 进入更新阶段不在工作区和分支 ref 之间响应取消，以免留下人为制造的半完成状态。
    if (await resolveCurrentBranch(git, fs, dir, gitdir) !== before.branch || await git.resolveRef({ fs, dir, gitdir, ref: "HEAD" }) !== before.oid) throw new Error("更新期间外部分支已变化，请手动核对工作区")
    await git.writeRef({ fs, dir, gitdir, ref: `refs/heads/${before.branch}`, value: theirs, force: true })
    updateBranchLastPulledAt(bookmarkName, before.branch, Date.now())
    return { status: "updated", reason: "已快进更新" }
  } catch (error) {
    if (error instanceof SkipAutoPull) return { status: "skipped", reason: error.message }
    throw error
  }
}
