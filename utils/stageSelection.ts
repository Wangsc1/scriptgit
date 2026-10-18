/**
 * utils/stageSelection.ts - 从 statusMatrix 行挑选需暂存/取消暂存的路径
 */

export type StatusMatrixRow = [string, number, number, number] | readonly [
  string,
  number,
  number,
  number,
]

/** 规范化矩阵中的相对路径 */
export function normalizeMatrixPath(filepath: unknown): string {
  return String(filepath || "").replace(/^\/+/, "")
}

/**
 * HEAD 与索引不同 → 可取消暂存。
 * 对齐 getChanges 的 staged: head !== stage
 */
export function pathsNeedingUnstage(
  matrix: readonly StatusMatrixRow[]
): string[] {
  const paths: string[] = []
  for (const row of matrix) {
    const path = normalizeMatrixPath(row[0])
    if (!path) continue
    const head = row[1]
    const stage = row[3]
    if (head === stage) continue
    paths.push(path)
  }
  return paths
}

/** 对单个路径决定暂存动作：删除用 remove，否则 add */
export function stageActionForRow(
  row: StatusMatrixRow
): "add" | "remove" | "skip" {
  const path = normalizeMatrixPath(row[0])
  if (!path) return "skip"
  const work = row[2]
  const stage = row[3]
  if (work === stage) return "skip"
  return work === 0 ? "remove" : "add"
}
