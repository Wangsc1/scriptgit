import { resolveWorkdir } from "../repoStore"
import { localImportStep } from "../localImportExecution"
import type { LocalImportSource, PickedLocalFile } from "../localFileImport"

export const LOCAL_TEXT_LIMIT = 512 * 1024
export interface LocalWorktreeFile {
  path: string
  text: string | null
  readOnlyReason?: string
  /** Bounded native fallback thumbnail for formats WebKit cannot reliably decode. */
  previewImage?: UIImage
  /** Original browser-compatible bytes, only after bounded safe/version-checked read. */
  previewDataUrl?: string
  image?: boolean
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

const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "heic", "heif", "tif", "tiff", "avif", "jp2"])
function isImagePath(path: string): boolean { return imageExtensions.has(path.split(".").pop()?.toLowerCase() || "") }

export async function readLocalFileInternal(bookmarkName: string, path: string): Promise<LocalWorktreeFile> {
  const { root, absolute } = await safeFile(bookmarkName, path)
  const stat = await FileManager.stat(absolute)
  const version: LocalWorktreeFile["version"] = { root, size: stat.size, modified: stat.modificationDate }
  // Classify before the TEXT limit and before any JS whole-file read, including
  // tiny images. All original safety/path/version checks remain authoritative.
  if (isImagePath(path)) return { path, text: null, version, image: true, readOnlyReason: "图片只读，可返回文件列表删除" }
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

/** Official TF ui_image/en.md: UIImage.fromFile(path), preparingThumbnail(size).
 * Browser image originals use a bounded checked read. Other formats use native
 * decoding + bounded DISPLAY bitmap only; never encode/write source.
 * HEIC/HEIF decoding is delegated to iOS; null/unsupported decoder is explicit.
 */
export const LOCAL_BROWSER_IMAGE_LIMIT = 8 * 1024 * 1024
const browserImageMime: Record<string, string> = { png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", jpg: "image/jpeg", jpeg: "image/jpeg" }
export async function readLocalFileForOpenInternal(bookmarkName: string, path: string): Promise<LocalWorktreeFile> {
  const file = await readLocalFileInternal(bookmarkName, path)
  if (!file.image) return file
  const absolute = await checkCurrent(bookmarkName, file)
  const mime = browserImageMime[path.split(".").pop()?.toLowerCase() || ""]
  if (mime) {
    if (file.version.size > LOCAL_BROWSER_IMAGE_LIMIT) throw new Error("图片超过 8 MiB 显示上限；未读取或修改原文件")
    const data = await FileManager.readAsData(absolute)
    await checkCurrent(bookmarkName, file)
    if (data.size !== file.version.size || data.size > LOCAL_BROWSER_IMAGE_LIMIT) throw new Error("读取期间图片大小已变化，请重新打开")
    // No UIImage/thumbnail/encoding: alpha and the entire encoded image survive.
    return { ...file, previewDataUrl: `data:${mime};base64,${data.toBase64String()}` }
  }
  const previewImage = await localImportStep("图片原生预览", () => {
    const source = UIImage.fromFile(absolute)
    if (!source) throw new Error("图片预览失败：系统无法解码此图片；文件未修改，可返回列表删除")
    const thumbnail = source.preparingThumbnail({ width: 1600, height: 1600 })
    if (!thumbnail) throw new Error("图片预览失败：系统无法生成显示缩略图；文件未修改，可返回列表删除")
    return thumbnail
  })
  await checkCurrent(bookmarkName, file)
  return { ...file, previewImage }
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

/** Move one ordinary file into an existing directory; never copy/delete fallback. */
export async function moveLocalFileInternal(bookmarkName: string, path: string, directory: string, expectedRoot: string): Promise<string> {
  const source = await safeFile(bookmarkName, path)
  const parent = await safeFile(bookmarkName, directory, true)
  if (source.root !== expectedRoot || parent.root !== expectedRoot) throw new Error("工作区路径已变化，请重新拖动")
  const name = path.split("/").pop() || ""
  validNewName(name)
  const targetPath = directory + "/" + name
  if (targetPath === path) throw new Error("文件已在此目录中")
  const target = parent.absolute + "/" + name
  const folded = (value: string) => value.normalize("NFC").toLowerCase()
  async function checkTarget() {
    const names = await FileManager.readDirectory(parent.absolute)
    if (names.some(entry => folded(entry.split("/").pop() || entry) === folded(name))) throw new Error("目标目录已有同名文件（含大小写或 Unicode 等价名称），未覆盖")
    if (await FileManager.isLink(target) || await FileManager.exists(target)) throw new Error("目标已存在，未覆盖")
  }
  await checkTarget()
  const latestSource = await safeFile(bookmarkName, path)
  const latestParent = await safeFile(bookmarkName, directory, true)
  if (latestSource.root !== expectedRoot || latestParent.root !== expectedRoot || latestSource.absolute !== source.absolute || latestParent.absolute !== parent.absolute) throw new Error("工作区路径已变化，请重新拖动")
  await checkTarget()
  // FileManager.rename is the native move used by the existing rename action.
  // No remove/rollback: a failed native operation must not delete source/target.
  await FileManager.rename(source.absolute, target)
  return targetPath
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

export class LocalImportConflictError extends Error {}

/** Root-only additions. The UI never infers a destination from expanded folders. */
async function additionRoot(bookmarkName: string, expectedRoot?: string, creationDate?: number) {
  const root = resolveWorkdir(bookmarkName).replace(/\/+$/, "")
  if (!root.startsWith("/") || root.split("/").some(p => p === "." || p === "..") || (expectedRoot !== undefined && root !== expectedRoot)) throw new Error("工作区路径已变化")
  if (await FileManager.isLink(root) || !(await FileManager.isDirectory(root))) throw new Error("工作区不是安全目录")
  const stat = await FileManager.stat(root)
  if (creationDate !== undefined && stat.creationDate !== creationDate) throw new Error("工作区目录身份已变化，未继续写入")
  return { root, creationDate: stat.creationDate }
}
async function additionTarget(bookmarkName: string, name: string, expectedRoot?: string) {
  validNewName(name)
  const identity = await additionRoot(bookmarkName, expectedRoot)
  async function check() {
    await additionRoot(bookmarkName, identity.root, identity.creationDate)
    const fold = (value: string) => value.normalize("NFC").toLowerCase()
    const names = await FileManager.readDirectory(identity.root)
    if (names.some(entry => fold(entry.split("/").pop() || entry) === fold(name))) throw new LocalImportConflictError("根目录已有同名目标（含大小写重名），未覆盖")
    const target = identity.root + "/" + name
    if (await FileManager.isLink(target) || await FileManager.exists(target)) throw new LocalImportConflictError("目标已存在，未覆盖")
    await additionRoot(bookmarkName, identity.root, identity.creationDate)
    return target
  }
  return { ...identity, check }
}

export async function createLocalEntryInternal(bookmarkName: string, name: string, directory: boolean, expectedRoot?: string): Promise<string> {
  const destination = await additionTarget(bookmarkName, name, expectedRoot)
  if (directory) {
    const target = await destination.check()
    try {
      await FileManager.createDirectory(target, false)
      await additionRoot(bookmarkName, destination.root, destination.creationDate)
      return name
    } catch (error: any) {
      throw new Error(String(error?.message || error) + "；目标目录可能已创建，未自动删除，请刷新核对")
    }
  }
  // writeAsData overwrites existing files. Write only inside our exclusively created
  // staging directory, then native copyFile (no overwrite) into the worktree.
  const staging = FileManager.temporaryDirectory.replace(/\/+$/, "") + "/scriptgit-empty-" + Date.now() + "-" + Math.random().toString(36).slice(2)
  await FileManager.createDirectory(staging, false)
  try {
    await FileManager.writeAsData(staging + "/empty", Data.fromRawString("", "utf-8")!)
    await FileManager.copyFile(staging + "/empty", await destination.check())
    await additionRoot(bookmarkName, destination.root, destination.creationDate)
    return name
  } catch (error: any) {
    throw new Error(String(error?.message || error) + "；未自动删除任何工作区目标，请刷新核对")
  } finally {
    // Only the scratch directory created above belongs to this operation.
    try { if (!(await FileManager.isLink(staging))) await FileManager.remove(staging) } catch (_) { /* Scratch cleanup must not hide the operation result. */ }
  }
}

/** sourcePath must be the exact picker-authorized file (or its exported temporary representation). */
export async function importLocalFileInternal(bookmarkName: string, sourcePath: string, name: string, expectedRoot?: string, beforeWrite?: () => void, expectedCreationDate?: number): Promise<string> {
  if (!sourcePath.startsWith("/") || sourcePath.includes("\\") || /[\x00-\x1f\x7f]/.test(sourcePath) || sourcePath.split("/").some(p => p === "." || p === ".." || p.toLowerCase() === ".git")) throw new Error("导入来源路径不安全")
  const destination = await additionTarget(bookmarkName, name, expectedRoot)
  async function sourceStat() {
    // The picker grants this exact path, not its system ancestors. Normal iOS
    // aliases (e.g. /var -> /private/var) must not invalidate the selected file.
    if (await FileManager.isLink(sourcePath) || !(await FileManager.isFile(sourcePath)) || await FileManager.isDirectory(sourcePath)) throw new Error("导入来源不是普通文件或已变为符号链接")
    return FileManager.stat(sourcePath)
  }
  const before = await sourceStat()
  const target = await destination.check()
  const latest = await sourceStat()
  if (before.size !== latest.size || before.modificationDate !== latest.modificationDate || before.creationDate !== latest.creationDate) throw new Error("导入来源已变化，未复制")
  try {
    if (expectedCreationDate !== undefined) await additionRoot(bookmarkName, expectedRoot, expectedCreationDate)
    const copy = () => {
      beforeWrite?.() // Re-check AFTER preflight AND delayed native dispatch.
      return FileManager.copyFile(sourcePath, target)
    }
    if (beforeWrite) await localImportStep("批量.原生文件复制", copy)
    else await copy()
    const after = await sourceStat()
    await additionRoot(bookmarkName, destination.root, destination.creationDate)
    const saved = await safeFile(bookmarkName, name)
    const stat = await FileManager.stat(saved.absolute)
    if (stat.size !== before.size || after.size !== before.size || after.modificationDate !== before.modificationDate || after.creationDate !== before.creationDate) throw new Error("导入期间文件发生变化")
    return name
  } catch (error: any) {
    throw new Error(String(error?.message || error) + "；目标可能已部分导入，源文件保留，未自动删除任何源文件或目标，请刷新核对")
  }
}

export interface LocalImportBatchEntry {
  name: string
  status: "success" | "skipped" | "failed"
  path?: string
  reason?: string
  cleanupFailed?: boolean
}
export interface LocalImportBatchResult { entries: LocalImportBatchEntry[]; writeAttempted: boolean }
/** Called under ONE facade write barrier. Serial acquisition/copy/release keeps
 * photo memory and temporary copies bounded; never rollback successful targets. */
export async function importLocalFilesInternal(bookmarkName: string, sources: LocalImportSource[], expectedRoot: string, canWrite: () => void): Promise<LocalImportBatchResult> {
  const entries: LocalImportBatchEntry[] = []
  let writeAttempted = false
  let identity: { root: string; creationDate: number } | undefined
  let stopped = false
  for (const source of sources) {
    const entry: LocalImportBatchEntry = { name: source.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 240), status: "failed" }
    entries.push(entry)
    if (stopped) { entry.status = "skipped"; entry.reason = "页面、合并状态或工作区身份已变化，未继续"; continue }
    let picked: PickedLocalFile | null = null
    let stage = "导出文件表示"
    try {
      try {
        canWrite()
        identity = await additionRoot(bookmarkName, expectedRoot, identity?.creationDate)
        canWrite()
      } catch (_) { stopped = true; entry.status = "skipped"; entry.reason = "页面、合并状态或工作区身份已变化，未继续"; continue }
      picked = await localImportStep("批量.导出文件表示", () => source.acquire())
      entry.name = picked.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 240)
      stage = "写入前状态检查"
      try { canWrite(); await additionRoot(bookmarkName, expectedRoot, identity.creationDate); canWrite() }
      catch (_) { stopped = true; entry.status = "skipped"; entry.reason = "页面、合并状态或工作区身份已变化，未写入"; continue }
      stage = "原生复制/核对"
      writeAttempted = true
      entry.path = await localImportStep("批量.原生复制", () => importLocalFileInternal(bookmarkName, picked!.sourcePath, picked!.name, expectedRoot, canWrite, identity!.creationDate))
      entry.status = "success"
    } catch (error: any) {
      // Never expose a native error containing private source paths/metadata.
      const message = String(error?.message || error)
      if (stage === "导出文件表示" && message.includes(":临时副本清理失败")) entry.cleanupFailed = true
      if (error instanceof LocalImportConflictError || /根目录已有同名目标|目标已存在|\bEEXIST\b/.test(message)) {
        entry.status = "skipped"; entry.reason = "同名目标已存在（含大小写/同批重名），未覆盖"
      } else {
        entry.reason = stage === "导出文件表示" && message.includes("registeredTypes=") && message.includes("无法取得可命名") ? message.slice(message.indexOf("无法取得可命名")) : `${stage}失败；成功项保留，目标可能部分导入，未回滚`
      }
    } finally {
      if (picked) {
        try { await localImportStep("批量.释放临时副本", () => picked!.release()) }
        catch (_) { entry.cleanupFailed = true } // Never repeat the copy on cleanup failure.
      }
    }
  }
  return { entries, writeAttempted }
}

/** Selected-directory scope only. No probing/enumeration above sourceRoot. */
export async function importLocalDirectoryInternal(bookmarkName: string, sourcePath: string, expectedRoot?: string): Promise<LocalDirectoryResult> {
  const sourceRoot = sourcePath.replace(/\/+$/, "")
  if (!sourceRoot.startsWith("/") || sourceRoot.includes("\\") || /[\x00-\x1f\x7f]/.test(sourceRoot) || sourceRoot.split("/").some(p => p === "." || p === ".." || p.toLowerCase() === ".git")) throw new Error("导入目录来源路径不安全")
  const name = sourceRoot.split("/").pop() || ""
  const destination = await additionTarget(bookmarkName, name, expectedRoot)
  if (destination.root === sourceRoot || destination.root.startsWith(sourceRoot + "/")) throw new Error("不能将源目录导入其自身内部")
  type Entry = { path: string; directory: boolean; size: number; modified: number; created: number }
  async function inspect(relative: string, known?: Entry[]) {
    // Check the selected root plus descendants, never /var, /private, or a provider parent.
    let absolute = sourceRoot
    for (const part of ["", ...relative.split("/").filter(Boolean)]) {
      if (part) absolute += "/" + part
      if (await FileManager.isLink(absolute)) throw new Error("导入目录含符号链接，拒绝整次导入")
      const directory = await FileManager.isDirectory(absolute)
      if (absolute !== sourceRoot + (relative ? "/" + relative : "") && !directory) throw new Error("源目录父路径已变化")
      if (!directory && !(await FileManager.isFile(absolute))) throw new Error("导入目录含非普通文件，拒绝整次导入")
      const stat = await FileManager.stat(absolute)
      if (known) {
        const path = absolute.slice(sourceRoot.length).replace(/^\//, "")
        const before = known.find(entry => entry.path === path)
        if (!before || before.directory !== directory || before.created !== stat.creationDate || before.size !== stat.size || before.modified !== stat.modificationDate) throw new Error("导入源目录已变化")
      }
    }
    const directory = await FileManager.isDirectory(absolute)
    const stat = await FileManager.stat(absolute)
    return { path: relative, directory, size: stat.size, modified: stat.modificationDate, created: stat.creationDate }
  }
  async function scan() {
    const entries: Entry[] = []
    async function visit(relative: string) {
      const entry = await inspect(relative)
      if (!relative && !entry.directory) throw new Error("请选择普通目录")
      entries.push(entry)
      if (!entry.directory) return
      const absolute = sourceRoot + (relative ? "/" + relative : "")
      const names = (await FileManager.readDirectory(absolute)).sort()
      const folded = new Set<string>()
      for (const child of names) {
        validNewName(child) // rejects .git (including gitdir files), traversal and unsafe names
        const key = child.normalize("NFC").toLowerCase()
        if (folded.has(key)) throw new Error("源目录含大小写或 Unicode 等价重名，拒绝整次导入")
        folded.add(key)
        // Revalidate ancestors after asynchronous provider calls, before entering a child.
        await inspect(relative, entries)
        await visit(relative ? relative + "/" + child : child)
      }
    }
    await visit("")
    return entries
  }
  const snapshot = await scan()
  if (JSON.stringify(snapshot) !== JSON.stringify(await scan())) throw new Error("导入源目录已变化，未复制")
  await destination.check()
  const targetDirectories = new Map<string, number>()
  const mapped = (relative: string) => name + (relative ? "/" + relative : "")
  let started = false
  try {
    for (const entry of snapshot) {
      await additionRoot(bookmarkName, destination.root, destination.creationDate)
      await inspect(entry.path, snapshot)
      const targetPath = mapped(entry.path)
      const target = destination.root + "/" + targetPath
      if (!entry.path) await destination.check()
      else {
        const parent = targetPath.slice(0, targetPath.lastIndexOf("/"))
        await safeFile(bookmarkName, parent, true)
        // Destination parents must still be the directories this operation created.
        for (const [path, created] of targetDirectories) if (parent === path || parent.startsWith(path + "/")) {
          const checked = await safeFile(bookmarkName, path, true)
          if ((await FileManager.stat(checked.absolute)).creationDate !== created) throw new Error("导入目标父目录身份已变化")
        }
        if ((await FileManager.readDirectory(destination.root + "/" + parent)).some(value => value.normalize("NFC").toLowerCase() === targetPath.split("/").pop()!.normalize("NFC").toLowerCase()) || await FileManager.isLink(target) || await FileManager.exists(target)) throw new Error("导入目标已存在，未覆盖")
      }
      await additionRoot(bookmarkName, destination.root, destination.creationDate)
      started = true
      if (entry.directory) {
        await FileManager.createDirectory(target, false)
        const checked = await safeFile(bookmarkName, targetPath, true)
        targetDirectories.set(targetPath, (await FileManager.stat(checked.absolute)).creationDate)
      } else {
        await FileManager.copyFile(sourceRoot + "/" + entry.path, target)
        const checked = await safeFile(bookmarkName, targetPath)
        if ((await FileManager.stat(checked.absolute)).size !== entry.size) throw new Error("导入文件大小不一致")
      }
    }
    await additionRoot(bookmarkName, destination.root, destination.creationDate)
    for (const [path, created] of targetDirectories) {
      const checked = await safeFile(bookmarkName, path, true)
      if ((await FileManager.stat(checked.absolute)).creationDate !== created) throw new Error("导入目标目录身份已变化")
    }
    if (JSON.stringify(snapshot) !== JSON.stringify(await scan())) throw new Error("复制期间源目录已变化")
  } catch (error: any) {
    throw new Error(String(error?.message || error) + (started ? "；源目录保留，目标可能已部分导入，未自动删除任何内容，请刷新核对" : ""))
  }
  return { path: name, files: snapshot.filter(entry => !entry.directory).map(entry => mapped(entry.path)), directories: snapshot.filter(entry => entry.directory).map(entry => mapped(entry.path)) }
}
