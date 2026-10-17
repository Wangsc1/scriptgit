/** Display-only encoding of the existing native UIImage thumbnail (official
 * UIImage.toJPEGBase64String). It reads no source file and writes nothing. JPEG
 * has no alpha, so transparent areas display opaque. */
export const LOCAL_IMAGE_DATA_URL_MAX_CHARS = 6 * 1024 * 1024
export function localImageDisplayDataUrl(image: { toJPEGBase64String?: (quality?: number) => string | null }): { url: string } | { error: string } {
  try {
    if (typeof image.toJPEGBase64String !== "function") return { error: "无法生成显示图片" }
    for (const quality of [0.85, 0.6, 0.4]) {
      const base64 = image.toJPEGBase64String(quality)
      if (!base64) return { error: "无法编码显示图片" }
      const url = "data:image/jpeg;base64," + base64
      if (url.length <= LOCAL_IMAGE_DATA_URL_MAX_CHARS) return { url }
    }
    return { error: "显示图片过大" }
  } catch (_) { return { error: "无法编码显示图片" } }
}
