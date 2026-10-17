import { listRepos } from "./repoStore"
import { autoPullFastForward } from "./gitService"
import { RemoteCancelToken } from "../utils/remoteProgress"

export type StartupPullRow = { key: string; name: string; status: "updated" | "unchanged" | "skipped" | "failed" | "cancelled" | "waiting"; reason: string }
export type StartupPullState = { running: boolean; results: StartupPullRow[] }
const listeners = new Set<(value: StartupPullState, settledKey?: string) => void>()
let state: StartupPullState = { running: false, results: [] }
let once: Promise<void> | null = null
export function getStartupPullState(): StartupPullState { return state }
export function subscribeStartupPull(listener: (value: StartupPullState, settledKey?: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publish(row?: StartupPullRow, settled = false) {
  // 无结果UI：仅保留内部状态；失败/等待写入console供排查（文案已脱敏分类）。
  if (row && (row.status === "failed" || row.status === "waiting")) console.warn(`启动自动拉取：${row.name} · ${row.reason}`)
  if (row) state = { ...state, results: [...state.results.filter(item => item.key !== row.key), row] }
  for (const listener of listeners) listener(state, settled ? row?.key : undefined)
}
/** 仅给用户可操作的分类信息，不把网络错误中的URL、凭据或原生长路径带进UI。 */
function failure(error: any): string {
  const message = String(error?.message || error)
  if (/401|403|auth|credential|token|Unauthorized|Forbidden/i.test(message)) return "认证或权限失败，请检查凭据；未降级匿名重试"
  if (/目录|路径|文件|ENOENT|EACCES|permission/i.test(message)) return "本地文件或目录访问失败，请检查授权后手动重试"
  return "自动拉取失败，请检查网络、远端与本地状态后手动重试"
}
/** 模块内一次；effect调用后再让出一帧，render不额外读取Storage/工作区、不联网。 */
export function startStartupPull(): Promise<void> {
  if (once) return once
  once = new Promise<void>(resolve => setTimeout(resolve, 0)).then(async () => {
    state = { ...state, running: true }; publish()
    const repos = listRepos().filter(repo => repo.source === "clone")
    const seen = new Set<string>()
    for (const repo of repos) {
      if (seen.has(repo.bookmarkName)) continue
      seen.add(repo.bookmarkName)
      const base = { key: repo.bookmarkName, name: (repo.name.split(/[\\/]/).pop() || "仓库").replace(/[\x00-\x1f]/g, "").slice(0, 80) }
      const token = new RemoteCancelToken()
      let timedOut = false
      // 仅请求协作取消；不race、不提前返回/解锁。原网络未结束时串行队列继续等待。
      const timer = setTimeout(() => {
        timedOut = true; token.cancel()
        publish({ ...base, status: "waiting", reason: "等待过久，已请求取消；原任务未结束前仍保留写锁，后续仓库等待" })
      }, 60_000)
      try {
        const outcome = await autoPullFastForward(repo.bookmarkName, { cancelToken: token })
        publish({ ...base, ...outcome }, true)
      } catch (error: any) {
        const busy = /正在执行其它写操作|暂未执行写操作/.test(String(error?.message || error))
        publish({ ...base, status: busy ? "skipped" : token.isCancelled ? "cancelled" : "failed", reason: busy ? "仓库正忙，未自动重试，请稍后手动拉取" : token.isCancelled ? timedOut ? "等待超时，原任务已结束；未继续自动更新" : "已取消自动拉取，原任务已结束" : failure(error) }, true)
      } finally { clearTimeout(timer) }
    }
  }).catch(() => {
    publish({ key: "startup-list", name: "仓库列表", status: "failed", reason: "无法读取仓库列表，未继续自动拉取" })
  }).finally(() => { state = { ...state, running: false }; publish() })
  return once
}
