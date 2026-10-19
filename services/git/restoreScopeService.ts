import { expandRenameSelection, forwardRenameSelection, validatedLocalRenames, consumeRestoredRenames, type RestoreSelection } from "./localRenameHistory"
import { resolveRepoPathsReadOnly } from "../repoStore"
import { createFS, loadGitEngine } from "../gitCore"
import { readWorktreeEntries } from "./worktreeTreeService"
import { scanMutationMatrix } from "./matrixScanService"
import { matrixToStatus } from "./statusQueryService"
import { inspectEmptyDirectories, type EmptyDirectoryPlan } from "./emptyDirectoryRemoval"
import { restoreFileInternal } from "./worktreeService"

export type RestoreScopePlan = {
  scope: string; directory?: boolean; selections?: RestoreSelection[]; missingScopes?: string[]; head?: string | null; restoreFirst?: string[]; renameSources?: string[]; root: string; gitdir: string; filepaths: string[]; empty: EmptyDirectoryPlan
}
const within = (path: string, scope: string) => !scope || path === scope || path.startsWith(scope + "/")
function validateScope(scope: string) {
  if (scope && (scope.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(scope) || scope.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git"))) throw new Error("不安全的还原范围")
}
async function context(bookmarkName: string) {
  const { workdir, gitdir } = resolveRepoPathsReadOnly(bookmarkName)
  if (!workdir) throw new Error("工作区路径未确认")
  const dir = workdir.replace(/\/+$/, "")
  if (!dir.startsWith("/") || dir === "/" || dir.split("/").some(part => part === "." || part === "..")) throw new Error("工作区路径不安全")
  if (await FileManager.isLink(dir) || !await FileManager.isDirectory(dir)) throw new Error("工作区不是安全目录")
  const { git } = await loadGitEngine()
  return { git, fs: createFS(gitdir, dir), dir, gitdir }
}
/** Internal, caller holds a read/mutation barrier; no writes, including on cancel. */
export async function prepareRestoreScopeInternal(bookmarkName: string, scope = "", renameSources: string[] = [], directory = true): Promise<RestoreScopePlan> {
  validateScope(scope)
  const sources = [...new Set(renameSources)].filter(source => source !== scope)
  if (sources.length && !scope) throw new Error("重命名还原必须明确新目录范围")
  for (const source of sources) {
    validateScope(source)
    if (!source) throw new Error("不安全的重命名原目录范围")
  }
  const ctx = await context(bookmarkName)
  const events = await validatedLocalRenames(bookmarkName, ctx)
  let head: string | null = null
  try { head = await ctx.git.resolveRef({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, ref: "HEAD" }) }
  catch (error: any) { if (error?.code !== "NotFoundError") throw error }
  const requested = [{ path: scope, directory }, ...sources.map(path => ({ path, directory, related: true }))]
  const selection = scope && !await FileManager.exists(ctx.dir + "/" + scope) ? forwardRenameSelection(requested, events) : requested
  const scopes = expandRenameSelection(selection, events)
  for (const selected of scopes) validateScope(selected.path)
  const inScope = (path: string, work: number) => scopes.some(selected => (!selected.related || work === 0) && (selected.directory ? within(path, selected.path) : path === selected.path))
  let primaryMissing = false
  const missingScopes: string[] = []
  for (const selected of scopes) if (selected.path) {
    const range = selected.path
    let absolute = ctx.dir
    for (const part of range.split("/")) {
      absolute += "/" + part
      if (await FileManager.isLink(absolute)) throw new Error("还原范围不是安全目录")
      // Deleted original directories may be absent. Validate existing ancestors,
      // and only permit a missing primary scope when HEAD has deleted descendants.
      // Preview/cancel never creates directories.
      if (!await FileManager.exists(absolute)) {
        if (range === scope) primaryMissing = true
        missingScopes.push(range)
        break
      }
      if (absolute === ctx.dir + "/" + range && !selected.directory) {
        if (!await FileManager.isFile(absolute)) throw new Error("还原范围不是安全文件")
      } else if (!await FileManager.isDirectory(absolute)) throw new Error("还原范围不是安全目录")
    }
  }
  const entries = await readWorktreeEntries(bookmarkName)
  const paths = entries.untrackedDirectories.filter(path => scopes.some(selected => !selected.related && selected.directory && within(path, selected.path)))
  const matrix = await scanMutationMatrix(ctx, "还原范围新鲜检查")
  if (primaryMissing && !matrix.some(([path, head, work]) => (directory ? path.startsWith(scope + "/") : path === scope) && head === 1 && work === 0)) throw new Error("还原范围不是安全目录，也没有可恢复的已跟踪文件")
  const filepaths = matrix.filter(([path, head, work, stage]) => inScope(path, work) && matrixToStatus(head, work, stage) !== "unmodified").map(row => row[0]).sort()
  // Preview only permits files already in this explicit restore scope to become
  // absent; hidden/ignored/symlink payloads still make a directory ineligible.
  for (const filepath of filepaths) {
    validateScope(filepath)
    const absolute = ctx.dir + "/" + filepath, metadata = ctx.gitdir.replace(/\/+$/, "")
    if (absolute === metadata || absolute.startsWith(metadata + "/")) throw new Error("改动范围包含 Git 元数据，已拒绝还原")
  }
  const restoreFirst = matrix.filter(([path, head, work]) => inScope(path, work) && head === 1 && work === 0).map(row => row[0]).sort()
  const empty = await inspectEmptyDirectories(ctx.dir, paths, "preview", undefined, filepaths)
  return { scope, directory, selections: scopes, missingScopes, head, restoreFirst, ...(sources.length ? { renameSources: sources } : {}), root: ctx.dir, gitdir: ctx.gitdir, filepaths, empty }
}

/** Internal, one mutation barrier for the entire confirmed scope. */
export async function restoreScopeInternal(bookmarkName: string, approved: RestoreScopePlan): Promise<string> {
  const fresh = await prepareRestoreScopeInternal(bookmarkName, approved.scope, approved.renameSources, approved.directory ?? true)
  if (("head" in approved && fresh.head !== approved.head) || fresh.root !== approved.root || fresh.gitdir !== approved.gitdir || (approved.missingScopes && JSON.stringify(fresh.missingScopes) !== JSON.stringify(approved.missingScopes)) || (approved.selections && JSON.stringify(fresh.selections) !== JSON.stringify(approved.selections)) || JSON.stringify(fresh.filepaths) !== JSON.stringify(approved.filepaths)) throw new Error("还原范围或文件列表已变化，请刷新后重新确认")
  const expected = approved.empty
  const paths = expected?.directories.map(d => d.path) || []
  const candidates = new Set(fresh.empty?.directories.map(d => d.path) || [])
  const approvedPaths = new Set(paths)
  const newlyEmpty = [...candidates].filter(path => !approvedPaths.has(path)).length
  if (paths.some(path => !candidates.has(path))) throw new Error("空目录已变化、已被跟踪或变为非空；未执行还原，请重新确认")
  if (!expected) throw new Error("缺少已确认的目录身份，请重新确认")
  await inspectEmptyDirectories(fresh.root, paths, "verify", expected, fresh.filepaths)
  // Only Git FILE paths are passed to checkout, never a folder/root; preserve the
  // original HEAD/noUpdateHead semantics. Disable recursive parent pruning here.
  for (const filepath of fresh.filepaths) {
    let current = fresh.root
    for (const part of filepath.split("/")) {
      current += "/" + part
      if (part.toLowerCase() === ".git" || await FileManager.isLink(current)) throw new Error("文件路径变为符号链接或元数据，已停止还原")
      if (await FileManager.exists(current) && !await FileManager.isDirectory(current) && current !== fresh.root + "/" + filepath) throw new Error("文件父路径异常")
    }
    if (await FileManager.isDirectory(fresh.root + "/" + filepath)) throw new Error("待还原文件变为目录，已保留，请重新确认")
  }
  // Restore missing HEAD originals BEFORE overwriting/deleting any destination.
  // Failure here leaves all destination bytes intact; the write barrier is not a transaction.
  const first = new Set(fresh.restoreFirst || [])
  for (const filepath of [...first, ...fresh.filepaths.filter(path => !first.has(path))]) await restoreFileInternal(bookmarkName, filepath, true)
  const stillUntracked = new Set((await readWorktreeEntries(bookmarkName)).untrackedDirectories)
  const removable = paths.filter(path => stillUntracked.has(path))
  const removed = removable.length ? await inspectEmptyDirectories(fresh.root, removable, "delete", expected!) : null
  consumeRestoredRenames(fresh.root, fresh.gitdir, fresh.selections || [])
  return `已还原 ${fresh.filepaths.length} 个文件，删除 ${removed?.directories.length || 0} 个新增空目录。` +
    (newlyEmpty ? `\n确认后另出现 ${newlyEmpty} 个空目录，未纳入本次确认，已保留。` : "") +
    (removable.length < paths.length ? `\n另有 ${paths.length - removable.length} 个目录状态已变化，已保留，请刷新检查。` : "") +
    (removed?.retained.length ? `\n以下目录发生变化或非空，已保留：\n${removed.retained.join("\n")}` : "") +
    (fresh.empty?.retained.length ? `\n另保留 ${fresh.empty.retained.length} 个非空目录（含隐藏/忽略内容时不会删除）。` : "")
}
