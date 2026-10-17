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
  const paths = await DocumentPicker.pickFiles({ allowsMultipleSelection: false, shouldShowFileExtensions: true })
  if (!paths?.length) return null
  if (paths.length !== 1) throw new Error("请一次选择一个文件")
  const sourcePath = paths[0]
  // pickFiles grants access for this script run. Do not stop all security scopes:
  // that would also invalidate other user-selected workspace/bookmark access.
  return { sourcePath, name: sourcePath.split("/").pop() || "", release: async () => {} }
}

const imageTypes: Record<string, string[]> = {
  "public.jpeg": ["jpg", "jpeg"], "public.png": ["png"], "com.compuserve.gif": ["gif"],
  "org.webmproject.webp": ["webp"], "public.heic": ["heic"], "public.heif": ["heif"],
  "public.tiff": ["tif", "tiff"], "com.microsoft.bmp": ["bmp"], "com.microsoft.ico": ["ico"],
  "public.avif": ["avif"], "public.jpeg-2000": ["jp2"],
}
export async function pickLocalPhoto(): Promise<PickedLocalFile | null> {
  const results = await Photos.pick({ filter: PHPickerFilter.images(), limit: 1 })
  if (!results?.length) return null
  const provider = results[0].itemProvider
  const generic = new Set(["public.image", "public.data", "public.content", "public.item", "public.composite-content"])
  // Prefer the provider's first concrete type. Do not silently request a JPEG
  // alternative when its original/first representation is an unsupported RAW type.
  const type = provider.registeredTypes.find(value => !generic.has(value))
  const extensions = type ? imageTypes[type] : undefined
  if (!type || !extensions) throw new Error("照片未提供可识别的原格式文件类型；请使用“导入文件”选择原文件，未转换图片")
  const sourcePath = await provider.loadFilePath(type)
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
      if (!(await FileManager.isLink(sourcePath)) && await FileManager.isFile(sourcePath) && !(await FileManager.isDirectory(sourcePath))) await FileManager.remove(sourcePath)
    },
  }
}
