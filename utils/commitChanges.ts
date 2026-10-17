/**
 * utils/commitChanges.ts - 提交详情「更改」视图的逐文件加载器
 *
 * 只负责调度：每个文件的真实 diff 仍由调用方传入的读取函数（getCommitFileDiff）计算。
 * 分页 + 有限并发 + 暂停/恢复 + 重试；释放后迟到结果被忽略，避免旧提交污染新页面。
 */

import type { FileDiff } from "../services/diffService"

export const COMMIT_CHANGES_PAGE_SIZE = 20
export const COMMIT_CHANGES_CONCURRENCY = 3
/** 更改视图内单文件最多渲染的行数；完整内容仍可进入单文件差异页 */
export const COMMIT_CHANGES_MAX_RENDER_LINES = 300

export type CommitChangeState = "pending" | "loading" | "done" | "error"

export interface CommitChangeEntry {
  filepath: string
  state: CommitChangeState
  diff: FileDiff | null
  added: number
  deleted: number
  error: string | null
}

export interface CommitChangesSnapshot {
  total: number
  /** 当前允许加载的文件（分页上限内） */
  visible: CommitChangeEntry[]
  /** 尚未纳入本次分页的文件数，用户需点击加载更多，不会静默丢弃 */
  remaining: number
  doneCount: number
  failedCount: number
  /** 已加载文件的真实增删合计 */
  added: number
  deleted: number
}

export function countDiffLines(diff: FileDiff): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const line of diff.lines) {
    if (line.type === "add") added++
    else if (line.type === "del") deleted++
  }
  return { added, deleted }
}

export class CommitChangesLoader {
  readonly entries: CommitChangeEntry[]
  private limit: number
  private running = 0
  private active = false
  private disposed = false
  private readonly listeners = new Set<() => void>()
  private readonly pageSize: number
  private readonly concurrency: number

  constructor(
    filepaths: string[],
    private readonly read: (filepath: string) => Promise<FileDiff>,
    options: { pageSize?: number; concurrency?: number } = {}
  ) {
    this.pageSize = Math.max(1, options.pageSize ?? COMMIT_CHANGES_PAGE_SIZE)
    this.concurrency = Math.max(1, options.concurrency ?? COMMIT_CHANGES_CONCURRENCY)
    this.limit = Math.min(filepaths.length, this.pageSize)
    this.entries = filepaths.map((filepath) => ({
      filepath, state: "pending", diff: null, added: 0, deleted: 0, error: null,
    }))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    if (this.disposed) return
    for (const listener of Array.from(this.listeners)) listener()
  }

  snapshot(): CommitChangesSnapshot {
    const visible = this.entries.slice(0, this.limit)
    let added = 0
    let deleted = 0
    let doneCount = 0
    let failedCount = 0
    for (const entry of visible) {
      if (entry.state === "done") { doneCount++; added += entry.added; deleted += entry.deleted }
      else if (entry.state === "error") failedCount++
    }
    return { total: this.entries.length, visible, remaining: this.entries.length - this.limit, doneCount, failedCount, added, deleted }
  }

  /** 进入更改视图时调用；可重复调用，已完成/进行中的文件不会重复读取 */
  start(): void {
    if (this.disposed) return
    this.active = true
    this.pump()
  }

  /** 离开视图：不再启动新读取；已发出的读取完成后保存结果 */
  pause(): void {
    this.active = false
  }

  dispose(): void {
    this.disposed = true
    this.active = false
    this.listeners.clear()
  }

  loadMore(): void {
    if (this.disposed || this.limit >= this.entries.length) return
    this.limit = Math.min(this.entries.length, this.limit + this.pageSize)
    this.notify()
    this.pump()
  }

  retry(filepath?: string): void {
    if (this.disposed) return
    for (const entry of this.entries.slice(0, this.limit)) {
      if (entry.state === "error" && (filepath === undefined || entry.filepath === filepath)) {
        entry.state = "pending"
        entry.error = null
      }
    }
    this.notify()
    this.pump()
  }

  private pump(): void {
    if (this.disposed || !this.active) return
    while (this.running < this.concurrency) {
      const next = this.entries.slice(0, this.limit).find((entry) => entry.state === "pending")
      if (!next) break
      this.run(next)
    }
  }

  private run(entry: CommitChangeEntry): void {
    entry.state = "loading"
    this.running++
    this.notify()
    Promise.resolve()
      .then(() => this.read(entry.filepath))
      .then((diff) => {
        if (this.disposed) return
        const counts = countDiffLines(diff)
        entry.diff = diff
        entry.added = counts.added
        entry.deleted = counts.deleted
        entry.state = "done"
      })
      .catch((error: any) => {
        if (this.disposed) return
        entry.state = "error"
        entry.error = String(error?.message || error)
      })
      .then(() => {
        this.running--
        if (this.disposed) return
        this.notify()
        this.pump()
      })
  }
}
