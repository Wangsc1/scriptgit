/**
 * 删除「由本 App 克隆得到」的仓库工作区文件夹（不可逆）。
 *
 * 克隆目录布局（cloneWorkspace.cloneRoot + cloneQueue）：<容器>/git/<仓库名>，其中容器为
 *   本地 Scripting 文稿目录 / iCloud 文稿目录 / 用户授权的外部父目录（访问书签）。
 * 可靠判定 = source==="clone" 且 工作区恰好位于 <已知容器>/git/<名称> 且名称与记录一致。
 * 不能证明时一律拒绝（调用方改为提供明确的「仅移除记录」选项），绝不按前缀猜测。
 */
import type { RepoMeta } from "../types/git"
import { findRepo, listRepos, removeRepo, resolveRepoPathsReadOnly } from "./repoStore"
import { resolveGitdir } from "./git/runtime"

export type CloneRemovalPlan =
  | { ok: true; path: string; name: string; label: string; location: "local" | "icloud" | "external" }
  | { ok: false; reason: string }

export type RemovalIdentity = {
  bookmarkName: string; repoId?: string; createdAt?: number; workdir?: string
  source?: RepoMeta["source"]; accessBookmarkName?: string; workdirRelative?: string; workdirDocumentsRelative?: string
  confirmedPath: string | null; confirmedLocation: string | null; confirmedName: string | null
}

const trim = (path: string) => path.replace(/\/+$/, "")
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const parent = (path: string) => path.slice(0, path.lastIndexOf("/"))

function safeAbsolute(path: string): boolean {
  if (!path.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(path) || path.endsWith("/")) return false
  const parts = path.split("/").slice(1)
  return parts.length >= 3 && parts.every(part => part !== "" && part !== "." && part !== "..")
}

export function identityOf(repo: RepoMeta, plan: CloneRemovalPlan = planCloneRemoval(repo.bookmarkName)): RemovalIdentity {
  return {
    bookmarkName: repo.bookmarkName, repoId: repo.repoId, createdAt: repo.createdAt, workdir: repo.workdir,
    source: repo.source, accessBookmarkName: repo.accessBookmarkName, workdirRelative: repo.workdirRelative,
    workdirDocumentsRelative: repo.workdirDocumentsRelative,
    confirmedPath: plan.ok ? plan.path : null, confirmedLocation: plan.ok ? plan.location : null, confirmedName: plan.ok ? plan.name : null,
  }
}

/** 纯读取：判断该仓库的工作区文件夹是否可证明属于 App 克隆目录。不访问磁盘内容。 */
export function planCloneRemoval(bookmarkName: string): CloneRemovalPlan {
  const repo = findRepo(bookmarkName)
  if (!repo) return { ok: false, reason: "仓库记录已不存在" }
  if (repo.source !== "clone") return { ok: false, reason: "不是由本 App 克隆的仓库" }
  let paths: ReturnType<typeof resolveRepoPathsReadOnly>
  try { paths = resolveRepoPathsReadOnly(bookmarkName) } catch (_e) { return { ok: false, reason: "无法解析工作区位置" } }
  const path = paths.workdir ? trim(paths.workdir) : ""
  const stored = repo.workdir ? trim(repo.workdir) : ""
  if (!path || !stored) return { ok: false, reason: "工作区位置未记录" }
  if (!safeAbsolute(path)) return { ok: false, reason: "工作区路径不规范" }
  const name = base(path)
  if (name.startsWith(".")) return { ok: false, reason: "工作区目录名不受支持" }
  if (name !== base(stored)) return { ok: false, reason: "工作区目录名与仓库记录不一致" }
  const gitFolder = parent(path)
  if (base(gitFolder) !== "git") return { ok: false, reason: "工作区不在 App 的 git 克隆目录下" }
  const container = parent(gitFolder)
  const documents = FileManager.documentsDirectory ? trim(FileManager.documentsDirectory) : ""
  if (documents && container === documents) return { ok: true, path, name, label: `git/${name}`, location: "local" }
  let icloud = ""
  try { if (FileManager.isiCloudEnabled && FileManager.iCloudDocumentsDirectory) icloud = trim(FileManager.iCloudDocumentsDirectory) } catch (_e) { icloud = "" }
  if (icloud && container === icloud) return { ok: true, path, name, label: `git/${name}`, location: "icloud" }
  if (repo.accessBookmarkName && repo.workdirRelative === `git/${name}`) {
    let root = ""
    try { if (FileManager.bookmarkExists(repo.accessBookmarkName)) root = trim(FileManager.bookmarkedPath(repo.accessBookmarkName) || "") } catch (_e) { root = "" }
    if (root && container === root) return { ok: true, path, name, label: `git/${name}`, location: "external" }
  }
  return { ok: false, reason: "无法证明该文件夹位于 App 管理的克隆目录（git/）中" }
}

export const LOCATION_LABEL = { local: "本机 Scripting 文稿", icloud: "iCloud 文稿", external: "所选外部目录" } as const

type StatusHint = { uncommitted?: number; ahead?: number; newDirectories?: number } | undefined

/** 删除确认文案。只用已有状态快照，不触发扫描；路径只显示相对 git/ 的位置。 */
export function cloneRemovalAlert(name: string, plan: CloneRemovalPlan, hint: StatusHint): { title: string; message: string; confirm: string } {
  if (!plan.ok) {
    return {
      title: "无法删除文件夹",
      message: `无法确认「${name}」的文件夹属于 App 克隆目录（${plan.reason}），为避免误删，不会删除任何文件。\n\n仍可仅从列表移除记录并清除本地 Git 缓存；工作区文件会原样保留。`,
      confirm: "仅移除记录",
    }
  }
  const risks: string[] = []
  const known = hint !== undefined && typeof hint.uncommitted === "number" && typeof hint.ahead === "number"
  if (known) {
    if ((hint!.uncommitted as number) > 0) risks.push(`有 ${hint!.uncommitted} 项未提交改动`)
    if ((hint!.newDirectories ?? 0) > 0) risks.push(`有 ${hint!.newDirectories} 个未跟踪的新目录`)
    if ((hint!.ahead as number) > 0) risks.push(`有 ${hint!.ahead} 个提交尚未推送`)
  }
  const risk = !known ? "未能确认是否存在未提交改动或未推送的提交，这些内容也会一并丢失。"
    : risks.length ? `⚠️ ${risks.join("、")}，删除后将无法找回。`
    : "状态快照显示没有未提交改动和未推送提交，但快照可能不是最新。"
  return {
    title: "永久删除克隆仓库？",
    message: `将永久删除「${name}」的本地文件夹「${plan.label}」（${LOCATION_LABEL[plan.location]}）及其全部内容，并从列表移除、清除本地 Git 缓存。此操作不可撤销，也不会删除 GitHub 上的远程仓库。\n\n${risk}`,
    confirm: "永久删除",
  }
}

async function assertNoUnfinishedWork(gitdir: string): Promise<void> {
  for (const marker of ["gitgit-merge-state.json", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "index.lock"]) {
    if (await FileManager.exists(gitdir + "/" + marker)) throw new Error("仓库存在未完成的合并/操作，请先进入仓库处理；未删除任何文件")
  }
}

/** No realpath API is documented. Check EVERY lexical ancestor, including the container.
 * Deliberately reject even OS aliases (/var -> /private/var); never guess canonical paths.
 * isLink MUST precede exists, since a dangling link reports exists=false.
 */
async function assertUnlinkedPathChain(path: string): Promise<void> {
  if (!safeAbsolute(path)) throw new Error("无法安全验证路径链；未删除任何文件")
  let current = ""
  for (const segment of path.split("/").slice(1)) {
    current += "/" + segment
    if (await FileManager.isLink(current)) throw new Error("工作区、容器或其祖先包含符号链接（含系统路径别名），无法安全删除；未删除任何文件")
    if (await FileManager.exists(current) && !(await FileManager.isDirectory(current))) throw new Error("路径链包含非文件夹；未删除任何文件")
  }
}

function assertConfirmation(expected: RemovalIdentity): Extract<CloneRemovalPlan, { ok: true }> {
  const repo = findRepo(expected.bookmarkName)
  const fields = ["repoId", "createdAt", "workdir", "source", "accessBookmarkName", "workdirRelative", "workdirDocumentsRelative"] as const
  if (!repo || fields.some(key => repo[key] !== expected[key])) {
    throw new Error("仓库记录已变化，未删除任何文件，请重新操作")
  }
  const plan = planCloneRemoval(expected.bookmarkName)
  if (!plan.ok) throw new Error(`${plan.reason}；未删除任何文件`)
  if (plan.path !== expected.confirmedPath || plan.location !== expected.confirmedLocation || plan.name !== expected.confirmedName) {
    throw new Error("文件夹位置或书签解析结果已变化，未删除任何文件，请重新确认")
  }
  return plan
}

async function assertExclusiveWorkdir(expected: RemovalIdentity, path: string): Promise<void> {
  for (const other of listRepos()) {
    if (other.bookmarkName === expected.bookmarkName) continue
    if (expected.accessBookmarkName && other.accessBookmarkName === expected.accessBookmarkName) {
      throw new Error("访问书签被其他仓库共享，拒绝删除文件夹；未删除任何文件")
    }
    let resolved: string | null
    try { resolved = resolveRepoPathsReadOnly(other.bookmarkName).workdir }
    catch (_e) { throw new Error("无法验证其他仓库的目录范围，拒绝删除；未删除任何文件") }
    // Refuse unresolved/linked paths rather than overlooking aliases of this workdir.
    if (!resolved) throw new Error("其他仓库目录无法解析，拒绝删除；未删除任何文件")
    const otherPath = trim(resolved)
    await assertUnlinkedPathChain(otherPath)
    if (otherPath === path || otherPath.startsWith(path + "/") || path.startsWith(otherPath + "/")) {
      throw new Error("文件夹与其他仓库共享或嵌套，拒绝删除；未删除任何文件")
    }
  }
}

/** Must run inside the repository write barrier. Confirmation is rechecked after async guards. */
export async function removeClonedRepositoryInternal(expected: RemovalIdentity): Promise<"deleted" | "missing"> {
  const plan = assertConfirmation(expected)
  await assertNoUnfinishedWork(resolveGitdir(expected.bookmarkName))
  await assertUnlinkedPathChain(plan.path)
  await assertExclusiveWorkdir(expected, plan.path)
  let result: "deleted" | "missing" = "missing"
  const exists = await FileManager.exists(plan.path)
  // Guards above may yield to UI/bookmark updates. Never use a newly resolved path here.
  assertConfirmation(expected)
  if (exists) {
    try { await FileManager.remove(plan.path) }
    catch (e: any) { throw new Error(`文件夹删除失败（可能已部分删除）：${String(e?.message || e)}。仓库记录已保留，可重试`) }
    if (await FileManager.isLink(plan.path) || await FileManager.exists(plan.path)) throw new Error("文件夹删除后仍然存在（可能已部分删除）。仓库记录已保留，可重试")
    result = "deleted"
  }
  try { await removeRepo(expected.bookmarkName) }
  catch (e: any) { throw new Error(`${result === "deleted" ? "文件夹已删除" : "文件夹原本不存在"}，但清理仓库记录失败：${String(e?.message || e)}。请再次删除以完成清理`) }
  return result
}
