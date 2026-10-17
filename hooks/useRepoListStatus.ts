import { useEffect, useRef, useState } from "scripting"
import type { RepoListStatus, RepoMeta, RepoSnapshot } from "../types/git"
import { listRepos, readSnapshots } from "../services/repoStore"
import { getCachedRepoStatus, getRepoListStatus } from "../services/gitService"
import { sortReposByGithubUpdated } from "../utils/repoSort"
import { useRepoGithubUpdated } from "./useRepoGithubUpdated"

export type RepoRefreshState = { phase: "queued" | "reading" | "slow" | "error" | "deferred"; message?: string }
const VIEW_WAIT_MS = 10_000
const MAX_READS = 2

function cachedStatuses(repos: RepoMeta[]): Record<string, RepoListStatus> {
  const result: Record<string, RepoListStatus> = {}
  for (const repo of repos) {
    try {
      const cached = getCachedRepoStatus(repo.bookmarkName)
      if (cached) result[repo.bookmarkName] = cached
    } catch (_e) { /* 单仓缓存不可用不阻断首屏 */ }
  }
  return result
}

/** 仅限制界面等多久，不取消/替换真实读取，也不释放协调器的读写屏障。 */
function waitForView(promise: Promise<unknown>, remaining: number): Promise<boolean> {
  if (remaining <= 0) return Promise.resolve(false)
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), remaining)
    const done = () => { clearTimeout(timer); resolve(true) }
    promise.then(done, done)
  })
}

export function useRepoListStatus(setRepos: (repos: RepoMeta[]) => void) {
  const githubUpdated = useRepoGithubUpdated(setRepos)
  const [statusMap, setStatusMap] = useState<Record<string, RepoListStatus>>(() => cachedStatuses(listRepos()))
  const [snapshotMap, setSnapshotMap] = useState<Record<string, RepoSnapshot>>({})
  const [repoRefreshMap, setRepoRefreshMap] = useState<Record<string, RepoRefreshState>>({})
  // 当前主页不展示逐仓进度；仅保存读数，避免每完成一个仓库都重渲染整张列表。
  const progressRef = useRef({ running: false, completed: 0, total: 0, current: "" })
  const setProgress = (value: typeof progressRef.current | ((previous: typeof progressRef.current) => typeof progressRef.current)) => {
    progressRef.current = typeof value === "function" ? value(progressRef.current) : value
  }
  const state = useRef({
    publishTimer: null as ReturnType<typeof setTimeout> | null,
    statuses: new Map<string, RepoListStatus>(),
    refreshes: new Map<string, RepoRefreshState | undefined>(),
    active: false, epoch: 0, rerun: false, forceNext: false, forcing: false,
    pending: null as Promise<void> | null,
    reads: new Map<string, { promise: Promise<RepoListStatus>; startedAt: number }>(),
  })
  const exists = (key: string) => listRepos().some(repo => repo.bookmarkName === key)

  function publish() {
    if (state.current.publishTimer !== null) clearTimeout(state.current.publishTimer)
    state.current.publishTimer = null
    const statuses = new Map(state.current.statuses), refreshes = new Map(state.current.refreshes)
    state.current.statuses.clear(); state.current.refreshes.clear()
    if (!state.current.active) return
    const keys = new Set(listRepos().map(repo => repo.bookmarkName))
    if (statuses.size) setStatusMap(previous => {
      const next = { ...previous }
      for (const [key, value] of statuses) if (keys.has(key)) next[key] = value
      return next
    })
    if (refreshes.size) setRepoRefreshMap(previous => {
      const next = { ...previous }
      for (const [key, value] of refreshes) if (keys.has(key)) {
        if (value) next[key] = value
        else delete next[key]
      }
      return next
    })
  }
  function schedulePublish() {
    if (state.current.publishTimer === null) state.current.publishTimer = setTimeout(publish, 100)
  }
  function setRefresh(key: string, refresh?: RepoRefreshState) {
    if (!state.current.active) return
    state.current.refreshes.set(key, refresh)
    schedulePublish()
  }

  function stop() {
    githubUpdated.stop()
    state.current.active = false
    publish() // 取消待发布计时器，不在隐藏/卸载后写 UI 状态。
    state.current.epoch++
    state.current.rerun = false
    state.current.forceNext ||= state.current.forcing
    // 不终止仍在进行的原生读取；返回页面只能复用它，不能启动同仓第二次读取。
  }
  useEffect(() => stop, [])

  function startRead(repo: RepoMeta, force: boolean, source: string) {
    const key = repo.bookmarkName
    const existing = state.current.reads.get(key)
    if (existing) return existing
    if (state.current.reads.size >= MAX_READS) return null
    const promise = Promise.resolve().then(() => getRepoListStatus(key, undefined, { source, force }))
    const entry = { promise, startedAt: Date.now() }
    state.current.reads.set(key, entry)
    // 真实读取迟到完成仍可回填；未完成前始终保留同仓单飞记录。
    promise.then(status => {
      if (!state.current.active || !exists(key)) return
      state.current.statuses.set(key, status)
      schedulePublish()
      setRefresh(key, status.error ? { phase: "error", message: status.error } : undefined)
    }, error => {
      setRefresh(key, { phase: "error", message: String(error?.message || error) })
    }).finally(() => {
      if (state.current.reads.get(key) === entry) state.current.reads.delete(key)
    })
    return entry
  }

  async function readForView(repo: RepoMeta, force: boolean, source: string, epoch: number) {
    const key = repo.bookmarkName
    const current = () => state.current.active && state.current.epoch === epoch && exists(key)
    const entry = startRead(repo, force, source)
    if (!entry) {
      if (current()) setRefresh(key, { phase: "deferred", message: "已有两个状态读取仍在进行，本仓暂未扫描；请稍后重试" })
      return
    }
    if (current()) setRefresh(key, { phase: "reading" })
    const done = await waitForView(entry.promise, VIEW_WAIT_MS - (Date.now() - entry.startedAt))
    if (!done && current() && state.current.reads.get(key) === entry) {
      setRefresh(key, { phase: "slow", message: "状态读取较慢，原任务仍在后台进行；重试会复用它，不会重复扫描。尚不能判定目录失效。" })
    }
  }

  async function refreshRound(force: boolean) {
    const epoch = state.current.epoch
    const current = () => state.current.active && state.current.epoch === epoch
    const latest = listRepos()
    setRepos(latest)
    const statuses = cachedStatuses(latest)
    setStatusMap(statuses)
    setRepoRefreshMap(Object.fromEntries(latest.map(repo => [repo.bookmarkName, { phase: "queued" as const }])))
    setProgress({ running: true, completed: 0, total: latest.length, current: "" })
    let snapshots: Record<string, RepoSnapshot> = {}
    // 快照仅为展示信息，不应成为所有仓库刷新前的全局 await 屏障。
    readSnapshots().then(value => {
      snapshots = value
      if (current()) setSnapshotMap(value)
    }).catch(() => {})
    // 首屏先交还事件循环，仓库和操作入口不必等文件系统或 Git 扫描。
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    // 小型并发池（与 MAX_READS 一致），避免逐个串行等待拖慢首屏
    let completed = 0
    const targets = sortReposByGithubUpdated(latest).filter(repo => exists(repo.bookmarkName))
    let cursor = 0
    async function worker() {
      while (current()) {
        const repo = targets[cursor++]
        if (!repo) return
        await readForView(repo, force, force ? "列表下拉" : "列表出现", epoch)
        completed++
        if (current()) setProgress({ running: true, completed, total: targets.length, current: repo.name })
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_READS, targets.length) }, () => worker()))
    if (current()) {
      publish()
      setProgress({ running: false, completed, total: targets.length, current: "" })
    }
  }

  function refreshAll(force = false): Promise<void> {
    if (!state.current.active) return Promise.resolve()
    void githubUpdated.refresh(force)
    if (state.current.pending) {
      if (force) { state.current.forceNext = true; state.current.rerun = true }
      return state.current.pending
    }
    const pending = Promise.resolve().then(async () => {
      try {
        let nextForce = force || state.current.forceNext
        do {
          state.current.rerun = false; state.current.forceNext = false; state.current.forcing = nextForce
          await refreshRound(nextForce)
          nextForce = state.current.forceNext
        } while (state.current.active && state.current.rerun)
      } finally {
        state.current.forcing = false; state.current.pending = null
        if (state.current.active) setProgress(previous => ({ ...previous, running: false }))
      }
    })
    state.current.pending = pending
    return pending
  }

  function appear() {
    state.current.active = true
    const epoch = state.current.epoch
    const latest = listRepos()
    setRepos(latest)
    setStatusMap(cachedStatuses(latest))
    setRepoRefreshMap({})
    // 打开/返回列表仅恢复已有缓存；没有缓存时等待用户手动刷新。
    readSnapshots().then(value => {
      if (state.current.active && state.current.epoch === epoch) setSnapshotMap(value)
    }).catch(() => {})
  }

  function refreshRepo(repo: RepoMeta) {
    // 批量页在导航栈顶时只登记仓库，不在隐藏的根列表为每个新增仓库排扫描。
    if (!state.current.active) return
    readForView(repo, true, "列表新增", state.current.epoch).catch(error => {
      setRefresh(repo.bookmarkName, { phase: "error", message: String(error?.message || error) })
    })
  }

  function forgetRepo(bookmarkName: string) {
    setStatusMap(previous => { const next = { ...previous }; delete next[bookmarkName]; return next })
    setRepoRefreshMap(previous => { const next = { ...previous }; delete next[bookmarkName]; return next })
  }

  return { statusMap, snapshotMap, repoRefreshMap, progress: progressRef.current, githubUpdatedProgress: githubUpdated.progress, refreshAll, refreshRepo, forgetRepo, appear, disappear: stop }
}
