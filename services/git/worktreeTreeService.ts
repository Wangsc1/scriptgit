import { resolveRepoPathsReadOnly } from "../repoStore"
import { createFS, loadGitEngine } from "../gitCore"
import { runStatusRead, statusRevision, canPublishStatus } from "./statusScanService"
import { setLruEntry } from "../../utils/lru"
import { changedDirectoryPaths } from "../../utils/fileListPerformance"

export type WorktreeEntries = { files: string[]; directories: string[]; untrackedDirectories: string[] }
const INVENTORY_CONCURRENCY = 16
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
    // 原生 FileManager 每次调用都是一次跨线程往返；逐条 await 会让 1400+ 文件的枚举按调用数串行等待。
    // 同一时刻最多 INVENTORY_CONCURRENCY 个元数据调用在途（只限制叶子调用，不在等待子目录时占槽，避免死锁）；
    // 结果按目录项顺序合并，输出与逐条遍历完全一致。
    let slots = INVENTORY_CONCURRENCY
    const waiting: (() => void)[] = []
    async function limited<T>(task: () => Promise<T>): Promise<T> {
      if (slots <= 0) await new Promise<void>(resolve => waiting.push(resolve))
      else slots--
      try { return await task() }
      finally { const next = waiting.shift(); if (next) next(); else slots++ }
    }
    type Visit = { ok: boolean; files: string[]; directories: string[]; untracked: string[] }
    type Entry = { kind: "skip" } | { kind: "file"; path: string } | { kind: "dir"; path: string; child: Visit }
    async function visit(relative: string, depth: number): Promise<Visit> {
      if (depth > 128) throw new Error("工作区目录层数超出安全上限，未完整加载")
      const absolute = root + (relative ? "/" + relative : "")
      const names = await limited(async () => {
        // Recheck immediately before enumeration after the awaited ignore query.
        if (await FileManager.isLink(absolute)) throw new Error("工作区目录已变为符号链接，未继续枚举")
        const entries = await FileManager.readDirectory(absolute)
        // Direct-child names or absolute direct-child paths are both accepted.
        return entries.map(item => {
          const name = (item.startsWith(absolute + "/") ? item.slice(absolute.length + 1) : item).replace(/\/$/, "")
          if (!name || name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name)) throw new Error("工作区目录条目格式异常，未完整加载")
          return name
        })
      })
      // A nested repository is not part of this repository's editable worktree.
      if (relative && names.some(name => name.toLowerCase() === ".git")) return { ok: false, files: [], directories: [], untracked: [] }
      for (const _name of names) if (++count > 50000) throw new Error("工作区条目超过安全上限，未完整加载")
      const entries: Promise<Entry>[] = names.map(async (name): Promise<Entry> => {
        if (name.toLowerCase() === ".git") return { kind: "skip" }
        const path = relative ? relative + "/" + name : name, full = root + "/" + path
        if (full === metadata || full.startsWith(metadata + "/")) return { kind: "skip" }
        const classified = await limited(async () => {
          if (await FileManager.isLink(full)) return "skip" as const
          const directory = await FileManager.isDirectory(full)
          const known = directory ? knownDirectories.has(path) : tracked.has(path)
          if (!known && await git.isIgnored({ fs, dir, gitdir, filepath: directory ? path + "/" : path, cache })) return "skip" as const
          if (directory) return "dir" as const
          return (await FileManager.isFile(full)) ? "file" as const : "skip" as const
        })
        if (classified === "skip") return { kind: "skip" }
        if (classified === "file") return { kind: "file", path }
        // Gitlinks stay represented by the existing HEAD/index file paths.
        if (tracked.has(path)) return { kind: "skip" }
        return { kind: "dir", path, child: await visit(path, depth + 1) }
      })
      const settled = await Promise.all(entries)
      const out: Visit = { ok: true, files: [], directories: [], untracked: [] }
      for (const entry of settled) {
        if (entry.kind === "file") out.files.push(entry.path)
        else if (entry.kind === "dir") {
          const child = entry.child
          out.files.push(...child.files); out.directories.push(...child.directories); out.untracked.push(...child.untracked)
          if (child.ok) {
            out.directories.push(entry.path)
            if (!knownDirectories.has(entry.path)) out.untracked.push(entry.path)
          }
        }
      }
      return out
    }
    const walked = await visit("", 0)
    files.push(...walked.files); directories.push(...walked.directories); untrackedDirectories.push(...walked.untracked)
    const result = { files, directories, untrackedDirectories }
    if (canPublishStatus(bookmarkName, revision)) setLruEntry(directoryCounts, gitdir + "\0" + dir, { revision, count: countNewDirectories(result) }, 32)
    return result
}
