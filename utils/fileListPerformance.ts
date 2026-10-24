import type { FileTreeNode } from "./fileTree"

/** 一次遍历建立所有父目录标记，避免每个目录反复扫描整个改动表。 */
export function changedDirectoryPaths(paths: string[]): Set<string> {
  const result = new Set<string>()
  for (const path of paths) {
    let slash = path.lastIndexOf("/")
    while (slash > 0) {
      result.add(path.slice(0, slash))
      slash = path.lastIndexOf("/", slash - 1)
    }
  }
  return result
}

/** 只读取当前可见展开路径的元数据；已收拢的动画内容即使保留，也不预读。 */
export function expandedFilePaths(tree: FileTreeNode[], expanded: Set<string>): string[] {
  const result: string[] = []
  function visit(nodes: FileTreeNode[]) {
    for (const node of nodes) {
      if (node.type === "file") result.push(node.path)
      else if (expanded.has(node.path)) visit(node.children)
    }
  }
  visit(tree)
  return result
}

export type FileMetadata = { size: number; modified: number }

/** 小批量原生 I/O，每批后交还 UI 事件循环；取消后不再开始下一批。 */
export async function readMetadataBatched(
  paths: string[],
  read: (path: string) => Promise<FileMetadata>,
  cancelled: () => boolean,
): Promise<Map<string, FileMetadata>> {
  const result = new Map<string, FileMetadata>()
  for (let start = 0; start < paths.length && !cancelled(); start += 4) {
    await Promise.all(paths.slice(start, start + 4).map(async path => {
      if (cancelled()) return
      try { result.set(path, await read(path)) }
      catch (_e) { /* 删除或不可访问只影响单个文件。 */ }
    }))
    if (start + 4 < paths.length && !cancelled()) await new Promise<void>((resolve, reject) => {
      try { setTimeout(resolve, 0) }
      catch (error: any) { reject(new Error("[readMetadataBatched.yieldTimer] " + String(error?.message || error))) }
    })
  }
  return result
}
