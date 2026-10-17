import type { LocalImportBatchResult } from "./git/localFileService"

/** No source paths, native error payloads, EXIF or identifiers in the UI. */
export function localImportBatchSummary(result: LocalImportBatchResult): string {
  const success = result.entries.filter(entry => entry.status === "success").length
  const skipped = result.entries.filter(entry => entry.status === "skipped").length
  const failed = result.entries.filter(entry => entry.status === "failed").length
  const cleanup = result.entries.filter(entry => entry.cleanupFailed).length
  const details = result.entries.filter(entry => entry.status !== "success" || entry.cleanupFailed)
  return `${success ? "批量导入结果" : "未导入任何文件"}：成功${success}/跳过${skipped}/失败${failed}` +
    (cleanup ? `；临时副本清理失败${cleanup}（未重跑导入）` : "") +
    details.slice(0, 20).map(entry => `\n${entry.name.split(/[\\/]/).pop() || "未命名项"}：${entry.reason || "已导入"}${entry.cleanupFailed ? "；临时副本清理失败" : ""}`).join("") +
    (details.length > 20 ? `\n另${details.length - 20}项未列出` : "")
}
