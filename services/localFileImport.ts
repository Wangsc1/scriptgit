import { localImportStep } from "./localImportExecution"

/** Picker APIs checked against the official llms.txt index, 2026-10-17:
 * /guide/Device%20Capabilities/DocumentPicker.md
 * /guide/Device%20Capabilities/Photos/index.md
 * /guide/Utilities/ItemProvider.md
 * Use file representations only: never UIImage/JPEG/PNG re-encoding or whole-file JS Data.
 */
export interface PickedLocalFile {
  sourcePath: string
  name: string
  release(): Promise<void>
}

export async function pickLocalDocument(): Promise<PickedLocalFile | null> {
  const paths = await localImportStep("DocumentPicker.pickFiles", () => DocumentPicker.pickFiles({ allowsMultipleSelection: false, shouldShowFileExtensions: true }))
  if (!paths?.length) return null
  if (paths.length !== 1) throw new Error("请一次选择一个文件")
  const sourcePath = paths[0]
  // pickFiles grants access for this script run. Do not stop all security scopes:
  // that would also invalidate other user-selected workspace/bookmark access.
  return { sourcePath, name: sourcePath.split("/").pop() || "", release: async () => {} }
}

/** Explicit UTI filter: Scripting PickFilesOption.types + Apple's UTType.folder
 * https://scriptingapp.github.io/guide/Device%20Capabilities/DocumentPicker.md
 * https://developer.apple.com/documentation/uniformtypeidentifiers/uttype-swift.struct/folder
 * No directory-bookmark overload or silent fallback to an untyped picker.
 */
export async function pickLocalDirectory(onProgress?: (message: string) => void | Promise<void>): Promise<PickedLocalFile | null> {
  await onProgress?.("目录选择：入口 pickFiles，types=public.folder；进入要导入的文件夹后点击右上角“打开”")
  const paths = await localImportStep("DocumentPicker.pickFiles(public.folder)", () => DocumentPicker.pickFiles({
    types: ["public.folder"], allowsMultipleSelection: false, shouldShowFileExtensions: true,
  }))
  if (!paths?.length) { await onProgress?.("目录选择：返回0项（取消或未选中），未写入"); return null }
  await onProgress?.(`目录选择：返回${paths.length}项，正在检查是否为目录`)
  if (paths.length !== 1) throw new Error("请一次选择一个目录")
  const sourcePath = paths[0].replace(/\/+$/, "")
  const directory = await localImportStep("目录类型检查", () => FileManager.isDirectory(sourcePath))
  await onProgress?.(`目录选择：返回类型=${directory ? "目录" : "非目录"}`)
  if (!directory) throw new Error("系统未返回目录（已限定 public.folder）；请选择文件夹，不是文件")
  // pickFiles owns the per-run access scope; do not stop unrelated workspace scopes.
  return { sourcePath, name: sourcePath.split("/").pop() || "", release: async () => {} }
}

const imageTypes: Record<string, string[]> = {
  "public.jpeg": ["jpg", "jpeg"], "public.png": ["png"], "com.compuserve.gif": ["gif"],
  "org.webmproject.webp": ["webp"], "public.heic": ["heic"], "public.heif": ["heif"],
  "public.tiff": ["tif", "tiff"], "com.microsoft.bmp": ["bmp"], "com.microsoft.ico": ["ico"],
  "public.avif": ["avif"], "public.jpeg-2000": ["jp2"],
}
/** System-exported file bytes, not a guarantee of the library asset's format.
 * Official TF: item_provider/en.md (strict representation + owned temporary copy),
 * image_io/en.md (readMetadata(path) validates an encoded image without JS Data).
 */
export async function pickLocalPhoto(): Promise<PickedLocalFile | null> {
  const filter = await localImportStep("PHPickerFilter.images", () => PHPickerFilter.images())
  const results = await localImportStep("Photos.pick", () => Photos.pick({ filter, limit: 1 }))
  if (!results?.length) return null
  let types: string[] = []
  const failures: string[] = []
  const diagnostic = () => new Error(`无法取得可命名的系统图片文件；未压缩或转换。registeredTypes=${JSON.stringify(types)}；候选阶段=${failures.join("；")}`)
  let provider: ItemProvider
  try {
    provider = await localImportStep("照片itemProvider", () => results[0].itemProvider)
    types = await localImportStep("照片registeredTypes", () => [...provider.registeredTypes])
  } catch (_) { failures.push("itemProvider/registeredTypes读取失败"); throw diagnostic() }
  const generic = new Set(["public.data", "public.content", "public.item", "public.composite-content"])
  // Concrete known images first, then the generic image representation. Remaining
  // private/dynamic identifiers are not assumed to be images: ImageIO must validate.
  const candidates = [...new Set([
    ...types.filter(type => !!imageTypes[type] || type === "public.camera-raw-image"),
    "public.image",
    ...types.filter(type => !generic.has(type)),
  ])]
  async function releaseCopy(path: string): Promise<void> {
    // Only paths returned by loadFilePath enter here: documented owned copies.
    if (!(await localImportStep("照片清理.isLink", () => FileManager.isLink(path))) &&
      await localImportStep("照片清理.isFile", () => FileManager.isFile(path)) &&
      !(await localImportStep("照片清理.isDirectory", () => FileManager.isDirectory(path)))) {
      await localImportStep("照片清理.remove", () => FileManager.remove(path))
    }
  }
  for (const type of candidates) {
    let sourcePath: string | null = null
    let stage = "hasRepresentationConforming"
    let accepted = false
    try {
      if (!(await localImportStep(`照片.${stage}`, () => provider.hasRepresentationConforming(type)))) {
        failures.push(`${type}:${stage}=false`); continue
      }
      stage = "loadFilePath"
      sourcePath = await localImportStep(`照片.${stage}`, () => provider.loadFilePath(type))
      if (!sourcePath) { failures.push(`${type}:${stage}=null`); continue }
      stage = "文件类型检查"
      if (await localImportStep("照片isLink", () => FileManager.isLink(sourcePath!)) ||
        !(await localImportStep("照片isFile", () => FileManager.isFile(sourcePath!))) ||
        await localImportStep("照片isDirectory", () => FileManager.isDirectory(sourcePath!))) {
        failures.push(`${type}:${stage}失败`); continue
      }
      // Container-level validation; no pixel decoding, re-encoding, or whole-file
      // Data/Uint8Array in JS. Never expose EXIF/GPS or names in diagnostics.
      stage = "ImageIO.readMetadata"
      await localImportStep(`照片.${stage}`, () => ImageIO.readMetadata(sourcePath!))
      stage = "导出文件名/扩展名"
      const exportedName = sourcePath.split("/").pop() || ""
      const ext = /\.([a-zA-Z0-9]{1,16})$/.exec(exportedName)?.[1]
      if (!ext) { failures.push(`${type}:${stage}缺失`); continue }
      const validName = exportedName !== "." && exportedName !== ".." && exportedName === exportedName.trim() &&
        !/[\\/:\x00-\x1f\x7f]/.test(exportedName) && exportedName.length <= 240
      const name = validName ? exportedName : `image-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const ownedPath = sourcePath
      let released = false
      accepted = true
      return { sourcePath: ownedPath, name, async release() {
        if (released) return
        await releaseCopy(ownedPath)
        released = true
      } }
    } catch (_) {
      // Native error strings may contain private paths or asset names. Report
      // the exact failing API stage and types, not private native error payloads.
      failures.push(`${type}:${stage}异常`)
    } finally {
      if (sourcePath && !accepted) {
        try { await releaseCopy(sourcePath) }
        catch (_) { failures.push(`${type}:临时副本清理失败`); throw diagnostic() }
      }
    }
  }
  throw diagnostic()
}
