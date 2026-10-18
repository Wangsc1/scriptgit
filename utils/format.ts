/**
 * utils/format.ts - 纯工具格式化函数（无副作用）
 */

import type { FileChange } from "../types/git"

/** oid 截短为前 7 位（类 GitHub 风格） */
export function shortOid(oid: string): string {
  return oid ? oid.substring(0, 7) : ""
}

/** ISO 时间 → 相对时间描述（如 "3 分钟前"） */
export function relativeTime(iso: string): string {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return "刚刚"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return d.toLocaleDateString()
}

/** 提取 commit message 的首行（标题） */
export function commitTitle(message: string): string {
  return message.split("\n")[0].trim()
}

/** 提取 commit message 首行之后的正文（补充说明） */
export function commitBody(message: string): string {
  const text = message || ""
  const idx = text.indexOf("\n")
  if (idx < 0) return ""
  return text.slice(idx + 1).trim()
}

/** 截断过长路径，中间用 … 省略 */
export function truncatePath(path: string, max = 40): string {
  if (path.length <= max) return path
  return path.substring(0, max - 1) + "…"
}

/** 从 Git URL 提取仓库目录名（去掉 .git） */
export function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "")
  const raw = cleaned.split("/").filter(Boolean).pop() || "repo"
  const name = raw.replace(/[^a-zA-Z0-9._-]/g, "_")
  return name || "repo"
}

/** 字节 → 人类可读大小 */
export function formatBytes(bytes?: number): string {
  if (bytes == null || bytes < 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** 时间戳 → 短日期（列表用）：今天/昨天/月/日/年 */
export function formatDate(ms?: number): string {
  if (ms == null) return ""
  const date = new Date(ms)
  const now = new Date()
  const isToday = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  if (isToday) return "今天"
  const isYesterday = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate() - 1
  if (isYesterday) return "昨天"
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

/** ISO 8601 时间 → 美式短日期 M/D/YY（远端文件列表用） */
export function formatISODate(iso?: string): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (isNaN(date.getTime())) return ""
  return `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear()).slice(-2)}`
}

/** 根据已暂存文件生成 GitHub 风格的提交标题 */
export function suggestCommitTitle(changes: FileChange[]): string {
  const staged = changes.filter((change) => change.staged)
  if (staged.length === 0) return ""
  if (staged.length > 1) return `更新 ${staged.length} 个文件`

  const change = staged[0]
  const action = change.status.includes("added")
    ? "新增"
    : change.status.includes("deleted")
      ? "删除"
      : "更新"
  return `${action} ${change.filepath}`
}

/** 组装 GitHub 风格提交信息：标题 + 可选描述 */
export function buildCommitMessage(title: string, description?: string): string {
  const head = title.trim()
  const body = (description || "").trim()
  if (!body) return head
  return `${head}\n\n${body}`
}
