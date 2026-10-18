import { resolveRepoPathsReadOnly } from "../repoStore"
import { createFS, loadGitEngine } from "../gitCore"
import { runStatusRead, statusRevision, canPublishStatus } from "./statusScanService"
import { setLruEntry } from "../../utils/lru"
import { changedDirectoryPaths } from "../../utils/fileListPerformance"

export type WorktreeEntries = { files: string[]; directories: string[]; untrackedDirectories: string[] }
const directoryCounts = new Map<string, { revision: number; count: number }>()

/** Count only untracked leaf directories not already represented by visible files.
 * Parent containers and directories containing untracked Git files are not counted twice.
 * This is display state, never a FileChange or a request to stage/commit/stash.
 */
export function countNewDirectories(entries: WorktreeEntries): number {
  const fileParents = changedDirectoryPaths(entries.files)
  const directoryParents = changedDirectoryPaths(entries.directories)
  return entries.untrackedDirectories.filter(path => !fileParents.has(path) && !directoryParents.has(path)).length
}

/** Caller already holds runStatusRead; avoids nested coordinator reads. */
export async function readNewDirectoryCount(bookmarkName: string, reuse = false): Promise<number> {
  const paths = resolveRepoPathsReadOnly(bookmarkName)
  const cached = directoryCounts.get(paths.gitdir + "\0" + paths.workdir)
  if (reuse && cached?.revision === statusRevision(bookmarkName)) return cached.count
  return countNewDirectories(await readWorktreeEntries(bookmarkName))
}

/** Metadata-only tree inventory. Never reads file payloads, follows links, or enters Git storage.
 * Untracked ignored paths are omitted; tracked HEAD/index paths remain visible even if ignored.
 */
export function getWorktreeEntries(bookmarkName: string): Promise<WorktreeEntries> {
  return runStatusRead(bookmarkName, () => readWorktreeEntries(bookmarkName))
}

/** Internal: caller must hold the repository read or mutation barrier. */
export async function readWorktreeEntries(bookmarkName: string): Promise<WorktreeEntries> {
    const revision = statusRevision(bookmarkName)
    const { workdir: dir, gitdir } = resolveRepoPathsReadOnly(bookmarkName)
    if (!dir) throw new Error("工作区路径未确认")
    const { git } = await loadGitEngine()
    const fs = createFS(gitdir, dir)
    const root = dir.replace(/\/+$/, ""), metadata = gitdir.replace(/\/+$/, "")
    if (await FileManager.isLink(root) || !(await FileManager.isDirectory(root))) throw new Error("工作区不是可安全枚举的目录")
    const index = await git.listFiles({ fs, dir, gitdir })
    let head: string[] = []
    try { head = await git.listFiles({ fs, dir, gitdir, ref: "HEAD" }) }
    catch (error: any) { if (error?.code !== "NotFoundError" && error?.code !== "ENOENT") throw error }
    const tracked = new Set<string>([...head, ...index]), knownDirectories = changedDirectoryPaths([...tracked])
    const files: string[] = [], directories: string[] = [], untrackedDirectories: string[] = []
    const cache = {}; let count = 0
    async function visit(relative: string, depth: number): Promise<boolean> {
      if (depth > 128) throw new Error("工作区目录层数超出安全上限，未完整加载")
      const absolute = root + (relative ? "/" + relative : "")
      // Recheck immediately before enumeration after the awaited ignore query.
      if (await FileManager.isLink(absolute)) throw new Error("工作区目录已变为符号链接，未继续枚举")
      const entries = await FileManager.readDirectory(absolute)
      // Direct-child names or absolute direct-child paths are both accepted.
      const names = entries.map(item => {
        const name = (item.startsWith(absolute + "/") ? item.slice(absolute.length + 1) : item).replace(/\/$/, "")
        if (!name || name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name)) throw new Error("工作区目录条目格式异常，未完整加载")
        return name
      })
      // A nested repository is not part of this repository's editable worktree.
      if (relative && names.some(name => name.toLowerCase() === ".git")) return false
      for (const name of names) {
        if (++count > 50000) throw new Error("工作区条目超过安全上限，未完整加载")
        if (name.toLowerCase() === ".git") continue
        const path = relative ? relative + "/" + name : name, full = root + "/" + path
        if (full === metadata || full.startsWith(metadata + "/")) continue
        if (await FileManager.isLink(full)) continue
        const directory = await FileManager.isDirectory(full)
        const known = directory ? knownDirectories.has(path) : tracked.has(path)
        if (!known && await git.isIgnored({ fs, dir, gitdir, filepath: directory ? path + "/" : path, cache })) continue
        if (directory) {
          // Gitlinks stay represented by the existing HEAD/index file paths.
          if (tracked.has(path)) continue
          if (await visit(path, depth + 1)) {
            directories.push(path)
            if (!knownDirectories.has(path)) untrackedDirectories.push(path)
          }
        } else if (await FileManager.isFile(full)) files.push(path)
      }
      return true
    }
    await visit("", 0)
    const result = { files, directories, untrackedDirectories }
    if (canPublishStatus(bookmarkName, revision)) setLruEntry(directoryCounts, gitdir + "\0" + dir, { revision, count: countNewDirectories(result) }, 32)
    return result
}
