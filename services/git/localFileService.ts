import { resolveWorkdir } from "../repoStore"

export const LOCAL_TEXT_LIMIT = 512 * 1024
export interface LocalWorktreeFile {
  path: string
  text: string | null
  readOnlyReason?: string
  version: { root: string; size: number; modified: number; bytes?: string }
}

/** 每次重新恢复授权工作区，检查工作区根及其内每级路径；不探测授权范围外的系统祖先。 */
async function safeFile(bookmarkName: string, path: string): Promise<{ root: string; absolute: string }> {
  const parts = path.split("/")
  if (!path || path.startsWith("/") || path.includes("\\") || /[\x00-\x1f]/.test(path) || parts.some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) throw new Error("不允许操作此文件路径")
  const root = resolveWorkdir(bookmarkName).replace(/\/+$/, "")
  if (!root.startsWith("/") || !root || root.split("/").some(p => p === "." || p === "..")) throw new Error("工作目录路径无效")
  const absolute = root + "/" + path
  if (await FileManager.isLink(root)) throw new Error("符号链接工作目录不允许编辑或删除")
  if (!(await FileManager.isDirectory(root))) throw new Error("工作区不是目录")
  let current = root
  for (const part of parts) {
    current += "/" + part
    if (await FileManager.isLink(current)) throw new Error("符号链接不允许编辑或删除")
    if (!(await FileManager.exists(current))) throw new Error("文件已不存在，请刷新文件或改动列表")
    if (current !== absolute && !(await FileManager.isDirectory(current))) throw new Error("父路径不是目录")
  }
  if (await FileManager.isDirectory(absolute)) throw new Error("只允许操作普通单文件，不能删除目录")
  if (!(await FileManager.isFile(absolute))) throw new Error("不是普通文件")
  return { root, absolute }
}

export async function readLocalFileInternal(bookmarkName: string, path: string): Promise<LocalWorktreeFile> {
  const { root, absolute } = await safeFile(bookmarkName, path)
  const stat = await FileManager.stat(absolute)
  const version: LocalWorktreeFile["version"] = { root, size: stat.size, modified: stat.modificationDate }
  if (stat.size > LOCAL_TEXT_LIMIT) return { path, text: null, version, readOnlyReason: "超过 512 KiB，只读，可删除" }
  const data = await FileManager.readAsData(absolute)
  const checked = await safeFile(bookmarkName, path)
  const after = await FileManager.stat(absolute)
  if (checked.root !== root || after.size !== stat.size || after.modificationDate !== stat.modificationDate) throw new Error("读取期间文件已变化，请重新打开")
  version.bytes = data.toBase64String()
  const text = data.toRawString("utf-8")
  const roundTrip = text === null ? null : Data.fromRawString(text, "utf-8")
  if (text === null || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || roundTrip?.toBase64String() !== version.bytes) return { path, text: null, version, readOnlyReason: "二进制或非无损 UTF-8 文件，只读，可删除" }
  return { path, text, version }
}

async function checkCurrent(bookmarkName: string, file: LocalWorktreeFile): Promise<string> {
  const { root, absolute } = await safeFile(bookmarkName, file.path)
  const stat = await FileManager.stat(absolute)
  const v = file.version
  if (root !== v.root || stat.size !== v.size || stat.modificationDate !== v.modified) throw new Error("文件已被外部修改，请重载后再操作；草稿保留")
  if (v.bytes !== undefined && (await FileManager.readAsData(absolute)).toBase64String() !== v.bytes) throw new Error("文件已被外部修改，请重载后再操作；草稿保留")
  const checked = await safeFile(bookmarkName, file.path)
  const latest = await FileManager.stat(absolute)
  if (checked.root !== root || latest.size !== v.size || latest.modificationDate !== v.modified) throw new Error("文件已变化，请重载后再操作；草稿保留")
  return absolute
}

export async function saveLocalFileInternal(bookmarkName: string, file: LocalWorktreeFile, text: string): Promise<LocalWorktreeFile> {
  if (file.readOnlyReason || file.text === null) throw new Error(file.readOnlyReason || "只读文件")
  const data = Data.fromRawString(text, "utf-8")
  if (!data || data.size > LOCAL_TEXT_LIMIT || data.toRawString("utf-8") !== text) throw new Error("文本必须为无损 UTF-8 且不超过 512 KiB")
  const absolute = await checkCurrent(bookmarkName, file)
  await FileManager.writeAsData(absolute, data)
  const saved = await readLocalFileInternal(bookmarkName, file.path)
  if (saved.version.bytes !== data.toBase64String()) throw new Error("写入后内容发生变化，请重载核对；草稿保留")
  return saved
}

export async function deleteLocalFileInternal(bookmarkName: string, file: LocalWorktreeFile): Promise<void> {
  const absolute = await checkCurrent(bookmarkName, file)
  // 已严格拒绝目录，绝不向 remove 传入目录或根路径。
  await FileManager.remove(absolute)
}
