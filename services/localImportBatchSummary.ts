import type { LocalImportBatchResult } from "./git/localFileService"

/** Display text for a finished batch: empty when everything succeeded. Only
 * skipped/failed/cleanup-failed items are listed (short, file name only); no
 * success statistics, source paths, native error payloads, EXIF or identifiers. */
export function localImportBatchSummary(result: LocalImportBatchResult): string {
  const details = result.entries.filter(entry => entry.status !== "success" || entry.cleanupFailed)
  if (!details.length) return ""
  const succeeded = result.entries.some(entry => entry.status === "success")
  const lines = details.slice(0, 5).map(entry =>
    `${entry.name.split(/[\\/]/).pop() || "未命名项"}：${entry.status === "success" ? "已导入" : entry.reason || (entry.status === "skipped" ? "已跳过" : "导入失败")}${entry.cleanupFailed ? "；临时副本清理失败" : ""}`)
  const unimported = details.some(entry => entry.status !== "success")
  return (!unimported ? "临时副本清理失败" : succeeded ? "部分文件未导入" : "未导入任何文件") + (lines.length ? "\n" + lines.join("\n") : "") +
    (details.length > 5 ? `\n另${details.length - 5}项未列出` : "")
}
