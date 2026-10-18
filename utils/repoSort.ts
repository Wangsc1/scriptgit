/**
 * utils/repoSort.ts - 仓库列表排序（纯函数，无副作用）
 *
 * 按 GitHub 更新时间排序，同时间按名称稳定排序，不改动持久化数组。
 */

import type {
  RepoMeta,
} from "../types/git"

import { githubUpdatedTime } from "./repoUpdated"

/** 按 GitHub updated_at 新到旧；未知排后，同时间稳定按名称，不看本地待处理状态。 */
export function sortReposByGithubUpdated(repos: RepoMeta[]): RepoMeta[] {
  return repos.slice().sort((a, b) => {
    const left = githubUpdatedTime(a), right = githubUpdatedTime(b)
    if (left !== null && right !== null && left !== right) return right - left
    if (left !== null && right === null) return -1
    if (left === null && right !== null) return 1
    return compareName(a, b)
  })
}

/** 首字符是否为 ASCII（数字/英文等） */
function isAsciiLeading(name: string): boolean {
  return name.length > 0 && name.charCodeAt(0) < 128
}

/**
 * 名称比较：忽略大小写与首尾空格，数字按自然序。
 * ASCII 名在前、中文名按拼音在后（与系统文件 App 一致）；
 * 直接用 zh-Hans localeCompare 会把中文排到最前面。
 */
function compareName(a: RepoMeta, b: RepoMeta): number {
  const left = (a.name || "").trim()
  const right = (b.name || "").trim()
  const leftAscii = isAsciiLeading(left)
  if (leftAscii !== isAsciiLeading(right)) return leftAscii ? -1 : 1
  const result = left.localeCompare(right, "zh-Hans", {
    sensitivity: "base",
    numeric: true,
  })
  if (result !== 0) return result
  // 仅大小写不同时保证顺序稳定
  return left < right ? -1 : left > right ? 1 : 0
}
