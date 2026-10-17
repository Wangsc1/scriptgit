import { lineDiff, type FileDiff, type FileVersions } from "../services/diffService"

/** 编辑器草稿与 HEAD 对照；不重新读取磁盘、不写入工作区或 index。 */
export function editorDiff(versions: FileVersions, draft: string): FileDiff {
  const lines = (text: string | null) => {
    if (text === null || text === "") return []
    const result = text.split("\n").map(line => line.replace(/\r$/, ""))
    if (text.endsWith("\n")) result.pop()
    return result
  }
  return { filepath: versions.filepath, added: versions.added, deleted: false, binary: versions.binary,
    lines: versions.binary ? [] : lineDiff(lines(versions.original), lines(draft)) }
}
