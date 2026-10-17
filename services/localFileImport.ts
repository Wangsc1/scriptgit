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
export async function pickLocalPhoto(): Promise<PickedLocalFile | null> {
  const filter = await localImportStep("PHPickerFilter.images", () => PHPickerFilter.images())
  const results = await localImportStep("Photos.pick", () => Photos.pick({ filter, limit: 1 }))
  if (!results?.length) return null
  const provider = await localImportStep("照片itemProvider", () => results[0].itemProvider)
  const generic = new Set(["public.image", "public.data", "public.content", "public.item", "public.composite-content"])
  // Prefer the provider's first concrete type. Do not silently request a JPEG
  // alternative when its original/first representation is an unsupported RAW type.
  const type = await localImportStep("照片registeredTypes", () => provider.registeredTypes.find(value => !generic.has(value)))
  const extensions = type ? imageTypes[type] : undefined
  if (!type || !extensions) throw new Error("照片未提供可识别的原格式文件类型；请使用“导入文件”选择原文件，未转换图片")
  const sourcePath = await localImportStep("ItemProvider.loadFilePath", () => provider.loadFilePath(type))
  if (!sourcePath) throw new Error("无法取得照片文件，未导入或转换图片")
  const exportedName = sourcePath.split("/").pop() || ""
  const ext = exportedName.split(".").pop()?.toLowerCase() || ""
  // PHPickerResult has no documented original-filename metadata. Preserve a valid
  // filename from the concrete exported file; otherwise name it by that concrete UTI.
  const validName = exportedName && exportedName !== "." && exportedName !== ".." && exportedName === exportedName.trim() &&
    !/[\\/:\x00-\x1f\x7f]/.test(exportedName) && exportedName.length <= 240 && extensions.includes(ext)
  const name = validName ? exportedName : `image-${Date.now()}-${Math.random().toString(36).slice(2)}.${extensions[0]}`
  return {
    sourcePath, name,
    async release() {
      // loadFilePath explicitly returns an owned temporary COPY. Never remove the
      // original photo or a DocumentPicker path, and never recursively remove directories.
      if (!(await localImportStep("照片清理.isLink", () => FileManager.isLink(sourcePath))) && await localImportStep("照片清理.isFile", () => FileManager.isFile(sourcePath)) && !(await localImportStep("照片清理.isDirectory", () => FileManager.isDirectory(sourcePath)))) await localImportStep("照片清理.remove", () => FileManager.remove(sourcePath))
    },
  }
}
