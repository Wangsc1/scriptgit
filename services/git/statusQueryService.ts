import { validatedLocalRenames } from "./localRenameHistory"
import type {
  CommitEntry,
  FileChange,
  FileChangeStatus,
} from "../../types/git"
import { paginateHistory, type HistoryPage } from "../../utils/history"
import { setLruEntry } from "../../utils/lru"
import { measureOperation } from "../../utils/performance"
import { getCtx, type GitContext } from "./runtime"
import {
  cacheRepoChanges,
  getCachedRepoChanges,
  rememberChangesCount,
  runStatusRead,
  scanStatusMatrix,
  statusRevision,
} from "./statusScanService"

const HISTORY_INITIAL_DEPTH = 64
const HISTORY_SEARCH_INITIAL_DEPTH = 256
export const HISTORY_CACHE_REPO_LIMIT = 4
export const HISTORY_CACHE_ENTRY_LIMIT = 5000

type LogCache = {
  headOid: string
  remoteOid: string | null
  branch: string | null
  depth: number
  exhausted: boolean
  limited: boolean
  entries: CommitEntry[]
}

const logCaches = new Map<string, LogCache>()

function storeLogCache(bookmarkName: string, cache: LogCache): void {
  setLruEntry(logCaches, bookmarkName, cache, HISTORY_CACHE_REPO_LIMIT)
}

function touchLogCache(bookmarkName: string, cache: LogCache): LogCache {
  storeLogCache(bookmarkName, cache)
  return cache
}

export function getHistoryCacheStats(): {
  repoCount: number
  entryCount: number
  repoLimit: number
  entryLimit: number
} {
  let entryCount = 0
  for (const cache of logCaches.values()) entryCount += cache.entries.length
  return {
    repoCount: logCaches.size,
    entryCount,
    repoLimit: HISTORY_CACHE_REPO_LIMIT,
    entryLimit: HISTORY_CACHE_ENTRY_LIMIT,
  }
}

export function matrixToStatus(head: number, work: number, stage: number): FileChangeStatus {
  const key = `${head}${work}${stage}`
  switch (key) {
    case "003":
    case "020":
    case "023":
      return "*added"
    case "022":
      return "added"
    case "100":
      return "deleted"
    case "101":
    case "110":
      return "*deleted"
    case "111":
      return "unmodified"
    case "120":
    case "121":
    case "123":
      return "*modified"
    case "122":
      return "modified"
    default:
      if (head !== work || head !== stage || work !== stage) {
        return work === 0 ? "*deleted" : head === 0 ? "*added" : "*modified"
      }
      return "unmodified"
  }
}

export async function hasHeadCommit(bookmarkName: string): Promise<boolean> {
  const { git, fs, dir, gitdir } = await getCtx(bookmarkName)
  if (!(await FileManager.exists(gitdir + "/HEAD"))) return false
  try {
    await git.resolveRef({ fs, dir, gitdir, ref: "HEAD" })
    return true
  } catch (_e) {
    return false
  }
}

export function getChanges(
  bookmarkName: string,
  source = "详情刷新",
  options?: { fresh?: boolean }
): Promise<FileChange[]> {
  // fresh=true 仅在详情“出现”路径传入：复用 30 秒内本仓成功读取；其余调用始终实时。
  if (options?.fresh) {
    const cached = getCachedRepoChanges(bookmarkName)
    if (cached) return Promise.resolve(cached)
  }
  return runStatusRead(bookmarkName, () => readChanges(bookmarkName, source))
}

async function readChanges(bookmarkName: string, source: string): Promise<FileChange[]> {
  const revision = statusRevision(bookmarkName)
  const ctx = await getCtx(bookmarkName)
  await validatedLocalRenames(bookmarkName, ctx)
  const { dir, gitdir } = ctx
  if (!(await FileManager.exists(gitdir + "/HEAD"))) {
    rememberChangesCount(bookmarkName, 0, revision)
    return []
  }
  try {
    const sample = await FileManager.readDirectory(dir)
    if (!sample) throw new Error("工作区不可读: " + dir)
  } catch (error: any) {
    throw new Error(
      "工作区无法访问（请移除后重新添加/克隆以重建安全访问）: " +
        String(error?.message || error)
    )
  }

  const matrix = await scanStatusMatrix(bookmarkName, ctx, source)
  const changes: FileChange[] = []
  for (const row of matrix as [string, number, number, number][]) {
    const filepath = String(row[0] || "").replace(/^\/+/, "")
    if (!filepath) continue
    const [head, work, stage] = row.slice(1) as [number, number, number]
    if (head === 1 && work === 1 && stage === 1) continue
    const status = matrixToStatus(head, work, stage)
    if (status === "unmodified") continue
    changes.push({
      filepath,
      status,
      staged: head !== stage,
      unstaged: work !== stage,
      worktreeDeleted: work === 0,
    })
  }
  rememberChangesCount(bookmarkName, changes.length, revision)
  // 供 30 秒内详情“出现”复用；代次/写入屏障变化会拒绝发布旧结果
  cacheRepoChanges(bookmarkName, changes, revision)
  return changes
}

async function resolveOptionalRef(
  ctx: GitContext,
  ref: string
): Promise<string | null> {
  try {
    return await ctx.git.resolveRef({
      fs: ctx.fs,
      dir: ctx.dir,
      gitdir: ctx.gitdir,
      ref,
    })
  } catch (_e) {
    return null
  }
}

async function readLogEntries(
  ctx: GitContext,
  depth: number,
  headOid: string,
  branch: string | null,
  remoteOid: string | null
): Promise<CommitEntry[]> {
  const { git, fs, dir, gitdir } = ctx
  const log = await measureOperation<any[]>(
    "读取本地历史",
    () => git.log({ fs, dir, gitdir, ref: headOid, depth }),
    `depth=${depth}`
  )
  const remoteOids = new Set<string>()
  if (branch && remoteOid) {
    try {
      const remoteLog = await measureOperation<any[]>(
        "读取远端历史",
        () => git.log({
          fs,
          dir,
          gitdir,
          ref: "refs/remotes/origin/" + branch,
          depth,
        }),
        `depth=${depth}`
      )
      for (const entry of remoteLog as any[]) remoteOids.add(entry.oid)
    } catch (_e) {
      // 远端跟踪历史不可读时保留本地标签。
    }
  }

  return log.map((entry: any) => ({
    oid: entry.oid,
    message: entry.commit.message.trim(),
    author: {
      name: entry.commit.author?.name || "",
      email: entry.commit.author?.email || "",
    },
    date: new Date(entry.commit.author.timestamp * 1000).toISOString(),
    syncStatus: remoteOids.size > 0
      ? (remoteOids.has(entry.oid) ? "remote" : "unpushed")
      : "local",
    isHead: entry.oid === headOid,
  }))
}

async function getLogState(bookmarkName: string): Promise<{
  ctx: GitContext
  headOid: string
  branch: string | null
  remoteOid: string | null
}> {
  const ctx = await getCtx(bookmarkName)
  const headOid = (await resolveOptionalRef(ctx, "HEAD")) || ""
  if (!headOid) return { ctx, headOid, branch: null, remoteOid: null }
  let branch: string | null = null
  try {
    branch = await ctx.git.currentBranch({
      fs: ctx.fs,
      dir: ctx.dir,
      gitdir: ctx.gitdir,
      fullname: false,
    })
  } catch (_e) {
    branch = null
  }
  const remoteOid = branch
    ? await resolveOptionalRef(ctx, "refs/remotes/origin/" + branch)
    : null
  return { ctx, headOid, branch, remoteOid }
}

function cacheMatches(
  cache: LogCache | undefined,
  headOid: string,
  branch: string | null,
  remoteOid: string | null
): cache is LogCache {
  return !!cache &&
    cache.headOid === headOid &&
    cache.branch === branch &&
    cache.remoteOid === remoteOid
}

async function loadCachedLog(
  bookmarkName: string,
  minimumDepth: number,
  expand: boolean
): Promise<LogCache> {
  const state = await getLogState(bookmarkName)
  if (!state.headOid) {
    const empty: LogCache = {
      headOid: "",
      remoteOid: null,
      branch: null,
      depth: 0,
      exhausted: true,
      limited: false,
      entries: [],
    }
    storeLogCache(bookmarkName, empty)
    return empty
  }
  const existing = logCaches.get(bookmarkName)
  const cache = cacheMatches(
    existing,
    state.headOid,
    state.branch,
    state.remoteOid
  )
    ? existing
    : undefined
  if (cache?.exhausted || cache?.limited ||
    (cache && cache.depth >= minimumDepth && !expand)) {
    return touchLogCache(bookmarkName, cache)
  }

  const baseDepth = cache?.depth || 0
  const requestedDepth = Math.max(
    minimumDepth,
    baseDepth > 0 ? baseDepth * 2 : HISTORY_INITIAL_DEPTH
  )
  const depth = Math.min(requestedDepth, HISTORY_CACHE_ENTRY_LIMIT)
  const entries = await readLogEntries(
    state.ctx,
    depth,
    state.headOid,
    state.branch,
    state.remoteOid
  )
  const next: LogCache = {
    headOid: state.headOid,
    remoteOid: state.remoteOid,
    branch: state.branch,
    depth,
    exhausted: entries.length < depth,
    limited: entries.length >= HISTORY_CACHE_ENTRY_LIMIT,
    entries: entries.slice(0, HISTORY_CACHE_ENTRY_LIMIT),
  }
  storeLogCache(bookmarkName, next)
  return next
}

export async function getLog(
  bookmarkName: string,
  depth = 50
): Promise<CommitEntry[]> {
  try {
    const state = await getLogState(bookmarkName)
    if (!state.headOid) return []
    return await readLogEntries(
      state.ctx,
      depth,
      state.headOid,
      state.branch,
      state.remoteOid
    )
  } catch (_e) {
    return []
  }
}

export async function getLogPage(
  bookmarkName: string,
  offset: number,
  limit: number,
  query = ""
): Promise<HistoryPage> {
  const safeOffset = Math.max(0, Math.trunc(offset))
  const safeLimit = Math.max(1, Math.trunc(limit))
  const normalizedQuery = query.trim()
  const requiredDepth = safeOffset + safeLimit + 1
  const initialDepth = normalizedQuery
    ? Math.max(HISTORY_SEARCH_INITIAL_DEPTH, requiredDepth)
    : requiredDepth
  let cache = await loadCachedLog(bookmarkName, initialDepth, false)
  let page = paginateHistory(
    cache.entries,
    safeOffset,
    safeLimit,
    normalizedQuery
  )
  const scannedMatches = normalizedQuery ? page.totalMatches || 0 : cache.entries.length
  if (!cache.exhausted && scannedMatches <= safeOffset + safeLimit) {
    cache = await loadCachedLog(bookmarkName, initialDepth, true)
    page = paginateHistory(
      cache.entries,
      safeOffset,
      safeLimit,
      normalizedQuery
    )
  }
  return {
    headOid: cache.headOid,
    entries: page.entries,
    hasMore: page.hasMore || (!cache.exhausted && !cache.limited),
    totalMatches: normalizedQuery && cache.exhausted ? page.totalMatches : null,
    limited: cache.limited,
  }
}

export async function getTrackedFiles(bookmarkName: string): Promise<string[]> {
  const { git, fs, dir, gitdir } = await getCtx(bookmarkName)
  if (!(await FileManager.exists(gitdir + "/HEAD"))) return []
  try {
    await git.resolveRef({ fs, dir, gitdir, ref: "HEAD" })
  } catch (error: any) {
    if (error?.code === "NotFoundError" || error?.code === "ENOENT") return []
    throw error
  }
  const files = await git.listFiles({ fs, dir, gitdir, ref: "HEAD" })
  return (files as string[])
    .map(String)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
}

// Counts are independent of the bounded, full-detail pagination cache. Only OIDs
// and a traversal frontier are retained while counting; no extra UI rows are built.
const historyCounts = new Map<string, number>()

async function localCountState(ctx: GitContext): Promise<{ headOid: string; shallow: string; key: string }> {
  const { git, fs, dir, gitdir } = ctx
  let headOid: string
  try { headOid = await git.resolveRef({ fs, dir, gitdir, ref: "HEAD" }) }
  catch (error: any) {
    // Only a missing symbolic local branch is an unborn repository. Permission,
    // malformed HEAD and detached missing objects must not masquerade as zero.
    if (error?.code !== "NotFoundError") throw error
    const head = String(await (fs.promises || fs).readFile(gitdir + "/HEAD", "utf8")).trim()
    if (!/^ref: refs\/heads\/[^\s]+$/.test(head)) throw error
    let missingBranch = false
    try { await git.resolveRef({ fs, dir, gitdir, ref: head.slice(5) }) }
    catch (branchError: any) {
      if (branchError?.code !== "NotFoundError") throw branchError
      missingBranch = true
    }
    if (!missingBranch) throw error
    headOid = ""
  }
  let shallow = ""
  try { shallow = String(await (fs.promises || fs).readFile(gitdir + "/shallow", "utf8")).trim() }
  catch (error: any) { if (error?.code !== "ENOENT" && error?.code !== "NotFoundError") throw error }
  if (shallow && !shallow.split(/\s+/).every(oid => /^[0-9a-f]{40}$/.test(oid))) throw new Error("浅克隆边界无效")
  return { headOid, shallow, key: gitdir + "\0" + dir + "\0" + headOid + "\0" + shallow }
}

/** All locally reachable commits from HEAD, stopping at declared shallow roots.
 * No fetch; missing objects outside declared boundaries are errors, not totals. */
export async function getHistoryTotal(bookmarkName: string, expectedHeadOid?: string): Promise<number> {
  const ctx = await getCtx(bookmarkName)
  const state = await localCountState(ctx)
  if (expectedHeadOid !== undefined && expectedHeadOid !== state.headOid) throw new Error("历史 HEAD 已变化")
  const cached = historyCounts.get(state.key)
  if (cached !== undefined) return cached
  const seen = new Set<string>()
  const boundary = new Set(state.shallow.split(/\s+/).filter(Boolean))
  const pending = state.headOid ? [state.headOid] : []
  while (pending.length) {
    const oid = pending.pop()!
    if (seen.has(oid)) continue
    const entry = await ctx.git.readCommit({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, oid })
    seen.add(oid)
    if (!boundary.has(oid)) for (const parent of entry.commit.parent) if (!seen.has(parent)) pending.push(parent)
  }
  // A branch/commit/deepen during the walk invalidates this result. The caller
  // keeps its unknown title and can retry on the next history refresh.
  if ((await localCountState(ctx)).key !== state.key) throw new Error("历史 HEAD 已变化")
  setLruEntry(historyCounts, state.key, seen.size, HISTORY_CACHE_REPO_LIMIT)
  return seen.size
}
