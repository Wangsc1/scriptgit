export type ScanRun = {
  sources: Set<string>
  queuedAt: number
  startedAt: number
  activeScans: number
  onSource?: (source: string) => void
}

type ScanJob<T> = {
  run: ScanRun
  task: (run: ScanRun) => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  promise: Promise<T>
}

// 状态读取可并发共享矩阵；写操作先挡住新读取，再等待已有读取安全收尾。
export class StatusCoordinator<T> {
  private readers = new Map<string, Set<Promise<unknown>>>()
  private writers = new Map<string, Promise<void>>()
  private revisions = new Map<string, number>()
  private scans = new Map<string, ScanJob<T>>()
  private queue: ScanJob<T>[] = []
  private activeScans = new Set<ScanJob<T>>()
  private slowScans = new Set<ScanJob<T>>()

  constructor(private options: { slowScanMs?: number; maxActiveScans?: number; writeWaitMs?: number } = {}) {}

  revision(key: string): number {
    return this.revisions.get(key) ?? 0
  }

  isWriting(key: string): boolean {
    return this.writers.has(key)
  }

  read<R>(key: string, task: () => Promise<R>): Promise<R> {
    const writer = this.writers.get(key)
    if (writer) return writer.then(() => this.read(key, task))
    let readers = this.readers.get(key)
    if (!readers) this.readers.set(key, readers = new Set())
    const pending = Promise.resolve().then(task).finally(() => {
      readers!.delete(pending)
      if (readers!.size === 0) this.readers.delete(key)
    })
    readers.add(pending)
    return pending
  }

  async mutate<R>(key: string, task: () => Promise<R>): Promise<R> {
    if (this.writers.has(key)) {
      throw new Error("该仓库正在执行其它写操作，请稍后再试")
    }
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    this.writers.set(key, barrier)
    this.revisions.set(key, this.revision(key) + 1)
    try {
      // 失败的旧读取也必须收尾，但不能阻断用户的写操作。
      const reads = Promise.all(Array.from(this.readers.get(key) ?? []).map(
        (pending) => pending.catch(() => undefined)
      ))
      // 只对写入的“准入等待”计时；真实读者仍登记，绝不超时释放正在执行的读/写。
      if (this.options.writeWaitMs) {
        await new Promise<void>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout>
          try {
            timer = setTimeout(() => reject(new Error("仓库仍有状态读取未结束，暂未执行写操作；请等待读取完成后重试")), this.options.writeWaitMs)
          } catch (error: any) {
            reject(new Error("[StatusCoordinator.writeWaitTimer] " + String(error?.message || error)))
            return
          }
          reads.then(() => {
            try { clearTimeout(timer); resolve() }
            catch (error: any) { reject(new Error("[StatusCoordinator.clearWriteWaitTimer] " + String(error?.message || error))) }
          }, error => {
            try { clearTimeout(timer) } catch (clearError: any) { reject(new Error("[StatusCoordinator.clearWriteWaitTimer] " + String(clearError?.message || clearError))); return }
            reject(error)
          })
        })
      } else await reads
      return await task()
    } finally {
      this.revisions.set(key, this.revision(key) + 1)
      this.writers.delete(key)
      release()
    }
  }

  scan(key: string, source: string, task: (run: ScanRun) => Promise<T>): Promise<T> {
    const existing = this.scans.get(key)
    if (existing) {
      existing.run.sources.add(source)
      existing.run.onSource?.(source)
      return existing.promise
    }
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    const job: ScanJob<T> = {
      run: { sources: new Set([source]), queuedAt: Date.now(), startedAt: 0, activeScans: 1 },
      task, resolve, reject, promise,
    }
    this.scans.set(key, job)
    this.queue.push(job)
    // 同一轮微任务内允许详情请求加入并提升尚未开始的列表扫描。
    Promise.resolve().then(() => this.drain())
    return promise.finally(() => {
      if (this.scans.get(key) === job) this.scans.delete(key)
    })
  }

  private drain(): void {
    // 正常仍串行；只有慢扫描占住槽位时，允许另一个仓库使用有限的备用槽。
    // 慢任务并未取消/释放，仍占扫描槽且共享同仓 promise，读写屏障一直有效。
    const capacity = this.slowScans.size > 0 ? Math.max(1, this.options.maxActiveScans || 1) : 1
    if (this.activeScans.size >= capacity || this.queue.length === 0) return
    const foreground = this.queue.findIndex((job) =>
      Array.from(job.run.sources).some((source) => !source.startsWith("列表"))
    )
    const [job] = this.queue.splice(foreground < 0 ? 0 : foreground, 1)
    this.activeScans.add(job)
    job.run.startedAt = Date.now()
    job.run.activeScans = this.activeScans.size
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      timer = this.options.slowScanMs ? setTimeout(() => {
        if (!this.activeScans.has(job)) return
        this.slowScans.add(job)
        this.drain()
      }, this.options.slowScanMs) : null
    } catch (error: any) {
      // No scan started. Reject the caller instead of leaving it pending after
      // an unhandled timer-registration exception in this drain microtask.
      this.activeScans.delete(job)
      job.reject(new Error("[StatusCoordinator.slowScanTimer] " + String(error?.message || error)))
      Promise.resolve().then(() => this.drain())
      return
    }
    const finish = (failed: boolean, result: unknown) => {
      try { if (timer !== null) clearTimeout(timer) }
      catch (error: any) {
        const cleanup = "[StatusCoordinator.clearSlowScanTimer] " + String(error?.message || error)
        result = new Error(failed ? String((result as any)?.message || result) + "\n" + cleanup : cleanup)
        failed = true
      }
      // The underlying task has fully settled, even when timer cleanup fails.
      this.activeScans.delete(job)
      this.slowScans.delete(job)
      if (failed) job.reject(result)
      else job.resolve(result as T)
      // 给完成回调让出时机，避免下一项抢在页面状态更新之前启动。
      Promise.resolve().then(() => this.drain())
    }
    Promise.resolve().then(() => job.task(job.run)).then(value => finish(false, value), error => finish(true, error))
  }
}
