import { resolveRepoPathsReadOnly } from "../repoStore"
import { createFS, loadGitEngine } from "../gitCore"
import { readWorktreeEntries } from "./worktreeTreeService"
import { scanMutationMatrix } from "./matrixScanService"
import { matrixToStatus } from "./statusQueryService"
import { inspectEmptyDirectories, type EmptyDirectoryPlan } from "./emptyDirectoryRemoval"
import { restoreFileInternal } from "./worktreeService"

export type RestoreScopePlan = {
  scope: string; root: string; gitdir: string; filepaths: string[]; empty: EmptyDirectoryPlan
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
export async function prepareRestoreScopeInternal(bookmarkName: string, scope = ""): Promise<RestoreScopePlan> {
  validateScope(scope)
  const ctx = await context(bookmarkName)
  if (scope) {
    let absolute = ctx.dir
    for (const part of scope.split("/")) {
      absolute += "/" + part
      if (await FileManager.isLink(absolute) || !await FileManager.isDirectory(absolute)) throw new Error("还原范围不是安全目录")
    }
  }
  const entries = await readWorktreeEntries(bookmarkName)
  const paths = entries.untrackedDirectories.filter(path => within(path, scope))
  const matrix = await scanMutationMatrix(ctx, "还原范围新鲜检查")
  const filepaths = matrix.filter(([path, head, work, stage]) => within(path, scope) && matrixToStatus(head, work, stage) !== "unmodified").map(row => row[0]).sort()
  // Preview only permits files already in this explicit restore scope to become
  // absent; hidden/ignored/symlink payloads still make a directory ineligible.
  for (const filepath of filepaths) {
    validateScope(filepath)
    const absolute = ctx.dir + "/" + filepath, metadata = ctx.gitdir.replace(/\/+$/, "")
    if (absolute === metadata || absolute.startsWith(metadata + "/")) throw new Error("改动范围包含 Git 元数据，已拒绝还原")
  }
  const empty = await inspectEmptyDirectories(ctx.dir, paths, "preview", undefined, filepaths)
  return { scope, root: ctx.dir, gitdir: ctx.gitdir, filepaths, empty }
}

/** Internal, one mutation barrier for the entire confirmed scope. */
export async function restoreScopeInternal(bookmarkName: string, approved: RestoreScopePlan): Promise<string> {
  const fresh = await prepareRestoreScopeInternal(bookmarkName, approved.scope)
  if (fresh.root !== approved.root || fresh.gitdir !== approved.gitdir || JSON.stringify(fresh.filepaths) !== JSON.stringify(approved.filepaths)) throw new Error("还原范围或文件列表已变化，请刷新后重新确认")
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
      if (await FileManager.exists(current) && !await FileManager.isDirectory(current) && current !== fresh.root + "/" + filepath && !await FileManager.isFile(current)) throw new Error("文件父路径异常")
    }
    if (await FileManager.isDirectory(fresh.root + "/" + filepath)) throw new Error("待还原文件变为目录，已保留，请重新确认")
    await restoreFileInternal(bookmarkName, filepath, true)
  }
  const stillUntracked = new Set((await readWorktreeEntries(bookmarkName)).untrackedDirectories)
  const removable = paths.filter(path => stillUntracked.has(path))
  const removed = removable.length ? await inspectEmptyDirectories(fresh.root, removable, "delete", expected!) : null
  return `已还原 ${fresh.filepaths.length} 个文件，删除 ${removed?.directories.length || 0} 个新增空目录。` +
    (newlyEmpty ? `\n确认后另出现 ${newlyEmpty} 个空目录，未纳入本次确认，已保留。` : "") +
    (removable.length < paths.length ? `\n另有 ${paths.length - removable.length} 个目录状态已变化，已保留，请刷新检查。` : "") +
    (removed?.retained.length ? `\n以下目录发生变化或非空，已保留：\n${removed.retained.join("\n")}` : "") +
    (fresh.empty?.retained.length ? `\n另保留 ${fresh.empty.retained.length} 个非空目录（含隐藏/忽略内容时不会删除）。` : "")
}
