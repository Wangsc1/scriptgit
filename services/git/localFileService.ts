import { resolveWorkdir } from "../repoStore"

export const LOCAL_TEXT_LIMIT = 512 * 1024
export interface LocalWorktreeFile {
  path: string
  text: string | null
  readOnlyReason?: string
  /** 仅安全读取的本地栅格图片快照；不把任意文件路径交给 WebView。 */
  previewUrl?: string
  version: { root: string; size: number; modified: number; bytes?: string }
}

/** 每次重新恢复授权工作区，检查工作区根及其内每级路径；不探测授权范围外的系统祖先。 */
async function safeFile(bookmarkName: string, path: string, directory = false): Promise<{ root: string; absolute: string }> {
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
    if (await FileManager.isDirectory(current)) {
      const entries = await FileManager.readDirectory(current)
      if (entries.some(name => name.toLowerCase() === ".git")) throw new Error("嵌套 Git 仓库不允许操作")
    }
  }
  if (directory) {
    if (!(await FileManager.isDirectory(absolute))) throw new Error("不是文件夹")
    return { root, absolute }
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

/** ImageViewer 用 WebKit 加载已校验快照，不读取 file://，不创建文本 Editor。 */
export async function readLocalFileForOpenInternal(bookmarkName: string, path: string): Promise<LocalWorktreeFile> {
  const file = await readLocalFileInternal(bookmarkName, path)
  const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon" } as Record<string, string>)[path.split(".").pop()?.toLowerCase() || ""]
  if (!mime) return file
  if (file.version.size > 8 * 1024 * 1024) throw new Error("图片超过 8 MiB，无法预览；仍可长按复制、重命名或左滑删除")
  const absolute = await checkCurrent(bookmarkName, file)
  const data = await FileManager.readAsData(absolute)
  await checkCurrent(bookmarkName, file)
  if (data.size !== file.version.size) throw new Error("读取期间图片已变化，请重新打开")
  return { ...file, text: null, previewUrl: `data:${mime};base64,${data.toBase64String()}` }
}

function validNewName(name: string): void {
  if (!name || name !== name.trim() || name === "." || name === ".." || name.toLowerCase() === ".git" || /[\/\\:\x00-\x1f\x7f]/.test(name) || name.endsWith(".") || name.length > 240) throw new Error("请输入合法名称（不能含路径、.git、控制字符或结尾空格/点）")
}
async function newTarget(bookmarkName: string, file: LocalWorktreeFile, name: string): Promise<{ source: string; target: string; path: string }> {
  validNewName(name)
  const source = await checkCurrent(bookmarkName, file)
  const parent = source.slice(0, source.lastIndexOf("/"))
  // 一律拒绝大小写/Unicode规范等价重名，包括仅改大小写；不做临时改名以免失败毁原件。
  const folded = (value: string) => value.normalize("NFC").toLowerCase()
  const names = await FileManager.readDirectory(parent)
  if (names.some(entry => folded(entry.split("/").pop() || entry) === folded(name))) throw new Error("同目录已有同名文件（含大小写重名）；不覆盖，仅改大小写不支持")
  const target = parent + "/" + name
  if (await FileManager.isLink(target) || await FileManager.exists(target)) throw new Error("目标已存在，未覆盖")
  // readDirectory/确认期间仍须再次校验源文件及父目录。
  if (await checkCurrent(bookmarkName, file) !== source) throw new Error("工作区路径已变化")
  const slash = file.path.lastIndexOf("/")
  return { source, target, path: (slash < 0 ? "" : file.path.slice(0, slash + 1)) + name }
}
export async function copyLocalFileInternal(bookmarkName: string, file: LocalWorktreeFile, name: string): Promise<string> {
  const { source, target, path } = await newTarget(bookmarkName, file, name)
  // 原生文件复制保持二进制字节，不把大文件解码或整体加载到 JS 内存。
  await FileManager.copyFile(source, target)
  return path
}
export async function renameLocalFileInternal(bookmarkName: string, file: LocalWorktreeFile, name: string): Promise<string> {
  const { source, target, path } = await newTarget(bookmarkName, file, name)
  await FileManager.rename(source, target)
  return path
}

type DirectoryEntry = { path: string; directory: boolean; size: number; modified: number }

/** 仅遍历路径和元数据；删除、复制、改名共用保护，不读取文件内容。 */
async function scanDirectory(bookmarkName: string, path: string, expectedRoot?: string) {
  const { root, absolute } = await safeFile(bookmarkName, path, true)
  if (expectedRoot && root !== expectedRoot) throw new Error("工作区路径已变化")
  const entries: DirectoryEntry[] = []
  async function visit(relative: string, directory: boolean) {
    const checked = await safeFile(bookmarkName, relative, directory)
    if (checked.root !== root) throw new Error("工作区路径已变化")
    const stat = await FileManager.stat(checked.absolute)
    entries.push({ path: relative, directory, size: stat.size, modified: stat.modificationDate })
    if (!directory) return
    for (const name of (await FileManager.readDirectory(checked.absolute)).sort()) {
      if (!name || /[\/\\\x00-\x1f\x7f]/.test(name) || name === "." || name === ".." || name.toLowerCase() === ".git") throw new Error("文件夹含不安全路径或 Git 元数据，拒绝操作")
      const child = checked.absolute + "/" + name
      if (await FileManager.isLink(child)) throw new Error("文件夹含符号链接，拒绝操作")
      await visit(relative + "/" + name, await FileManager.isDirectory(child))
    }
  }
  await visit(path, true)
  return { root, absolute, entries }
}

/** 保留单文件入口原有拒绝目录约束。 */
export async function deleteLocalDirectoryInternal(bookmarkName: string, path: string): Promise<void> {
  const checked = await scanDirectory(bookmarkName, path)
  const latest = await safeFile(bookmarkName, path, true)
  if (checked.root !== latest.root) throw new Error("工作区路径已变化")
  await FileManager.remove(checked.absolute)
}

export interface LocalDirectoryResult { path: string; files: string[]; directories: string[] }

async function changeDirectory(bookmarkName: string, path: string, name: string, copy: boolean): Promise<LocalDirectoryResult> {
  validNewName(name)
  const snapshot = await scanDirectory(bookmarkName, path)
  const parent = snapshot.absolute.slice(0, snapshot.absolute.lastIndexOf("/"))
  const target = parent + "/" + name
  const slash = path.lastIndexOf("/")
  const targetPath = (slash < 0 ? "" : path.slice(0, slash + 1)) + name
  async function vacant(absolute: string) {
    const folded = (value: string) => value.normalize("NFC").toLowerCase()
    const base = absolute.slice(absolute.lastIndexOf("/") + 1)
    const parent = absolute.slice(0, absolute.lastIndexOf("/"))
    if ((await FileManager.readDirectory(parent)).some(entry => folded(entry) === folded(base)) || await FileManager.isLink(absolute) || await FileManager.exists(absolute)) throw new Error("同目录已有同名目标（含大小写重名），未覆盖")
  }
  await vacant(target)
  const latest = await scanDirectory(bookmarkName, path, snapshot.root)
  if (JSON.stringify(snapshot.entries) !== JSON.stringify(latest.entries)) throw new Error("文件夹已变化，请刷新后重试")
  await vacant(target)
  const mapped = (entry: DirectoryEntry) => targetPath + entry.path.slice(path.length)
  if (!copy) {
    // 原生 rename 支持目录；绝不用 copy + remove 模拟移动。
    const source = await safeFile(bookmarkName, path, true)
    if (source.root !== snapshot.root) throw new Error("工作区路径已变化")
    await FileManager.rename(source.absolute, target)
  } else {
    // copyFile 只承诺文件：逐级建目录，叶子用原生二进制复制。
    // 失败保留原件与部分目标，不做 remove 回滚，避免误删外部新增内容。
    let started = false
    try {
      for (const entry of snapshot.entries) {
        const source = await safeFile(bookmarkName, entry.path, entry.directory)
        if (source.root !== snapshot.root) throw new Error("工作区路径已变化")
        const stat = await FileManager.stat(source.absolute)
        if (stat.size !== entry.size || stat.modificationDate !== entry.modified) throw new Error("源内容已变化")
        const dest = snapshot.root + "/" + mapped(entry)
        if (entry.path !== path) {
          const checkedParent = await safeFile(bookmarkName, mapped(entry).slice(0, mapped(entry).lastIndexOf("/")), true)
          if (checkedParent.root !== snapshot.root) throw new Error("工作区路径已变化")
        }
        await vacant(dest)
        started = true
        if (entry.directory) await FileManager.createDirectory(dest, false)
        else await FileManager.copyFile(source.absolute, dest)
      }
      const after = await scanDirectory(bookmarkName, path, snapshot.root)
      if (JSON.stringify(after.entries) !== JSON.stringify(snapshot.entries)) throw new Error("复制期间源文件夹已变化，请核对目标")
    } catch (error: any) {
      throw new Error(`${String(error?.message || error)}${started ? "；原文件夹保留，目标可能已部分复制，请核对；未自动删除任何内容" : ""}`)
    }
  }
  return { path: targetPath, files: snapshot.entries.filter(e => !e.directory).map(mapped), directories: snapshot.entries.filter(e => e.directory).map(mapped) }
}
export function copyLocalDirectoryInternal(bookmarkName: string, path: string, name: string): Promise<LocalDirectoryResult> {
  return changeDirectory(bookmarkName, path, name, true)
}
export function renameLocalDirectoryInternal(bookmarkName: string, path: string, name: string): Promise<LocalDirectoryResult> {
  return changeDirectory(bookmarkName, path, name, false)
}
