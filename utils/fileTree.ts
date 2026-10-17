export interface FileTreeNode {
  name: string
  path: string
  type: "directory" | "file"
  children: FileTreeNode[]
  size?: number
  modified?: number
}

interface MutableTreeNode extends FileTreeNode {
  childMap: Map<string, MutableTreeNode>
}

interface FileTreeOptions {
  /** 原生目录操作返回的目录（含空目录）。 */
  directories?: string[]
  /** 文件路径到元数据的映射；目录节点不填充 */
  metadata?: Map<string, { size: number; modified: number }>
}

function sortNodes(nodes: MutableTreeNode[]): FileTreeNode[] {
  return nodes
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .map((node) => ({
      name: node.name,
      path: node.path,
      type: node.type,
      size: node.size,
      modified: node.modified,
      children: sortNodes(Array.from(node.childMap.values())),
    }))
}

/** 把已跟踪文件路径转换为目录优先、同层按名称排序的树 */
export function buildFileTree(filepaths: string[], options?: FileTreeOptions): FileTreeNode[] {
  const roots = new Map<string, MutableTreeNode>()
  const directories = new Set(options?.directories || [])

  for (const filepath of [...(options?.directories || []), ...filepaths]) {
    const parts = String(filepath)
      .split("/")
      .filter(Boolean)
    if (parts.length === 0) continue

    let siblings = roots
    let currentPath = ""
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]
      currentPath = currentPath ? currentPath + "/" + name : name
      const isFile = index === parts.length - 1 && !directories.has(filepath)
      let node = siblings.get(name)
      if (!node) {
        const meta = isFile ? options?.metadata?.get(currentPath) : undefined
        node = {
          name,
          path: currentPath,
          type: isFile ? "file" : "directory",
          children: [],
          childMap: new Map(),
          size: meta?.size,
          modified: meta?.modified,
        }
        siblings.set(name, node)
      }
      siblings = node.childMap
    }
  }

  return sortNodes(Array.from(roots.values()))
}
