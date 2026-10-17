/** Display-only encoding of the existing native UIImage thumbnail. It reads no
 * source file and writes nothing. Official UIImage has no public hasAlpha; the
 * only alpha probe (getPixelData) would copy a full RGBA buffer into JS, so we
 * decide by the source extension: JPEG files cannot contain alpha and may use
 * JPEG; every other format (PNG/HEIC/HEIF/...) keeps fidelity with PNG
 * (toPNGBase64String) and, if too large, shrinks the thumbnail (official
 * preparingThumbnail) instead of converting to JPEG, so transparency is never
 * flattened to white. */
export const LOCAL_IMAGE_DATA_URL_MAX_CHARS = 6 * 1024 * 1024
type DisplayImage = {
  width?: number; height?: number
  toPNGBase64String?: () => string | null
  toJPEGBase64String?: (quality?: number) => string | null
  preparingThumbnail?: (size: { width: number; height: number }) => DisplayImage | null
}
export function localImageDisplayDataUrl(image: DisplayImage, path = ""): { url: string } | { error: string } {
  try {
    const jpegSource = /\.jpe?g$/i.test(path)
    if (jpegSource) {
      if (typeof image.toJPEGBase64String !== "function") return { error: "无法生成显示图片" }
      for (const quality of [0.85, 0.6, 0.4]) {
        const base64 = image.toJPEGBase64String(quality)
        if (!base64) return { error: "无法编码显示图片" }
        const url = "data:image/jpeg;base64," + base64
        if (url.length <= LOCAL_IMAGE_DATA_URL_MAX_CHARS) return { url }
      }
      return { error: "显示图片过大" }
    }
    let current: DisplayImage | null = image
    for (let attempt = 0; attempt < 5 && current; attempt++) {
      if (typeof current.toPNGBase64String !== "function") return { error: "无法生成显示图片" }
      const base64 = current.toPNGBase64String()
      if (!base64) return { error: "无法编码显示图片" }
      const url = "data:image/png;base64," + base64
      if (url.length <= LOCAL_IMAGE_DATA_URL_MAX_CHARS) return { url }
      const width = current.width, height = current.height
      if (typeof current.preparingThumbnail !== "function" || !(width && height && width > 0 && height > 0)) break
      current = current.preparingThumbnail({ width: Math.max(1, Math.floor(width * 0.7)), height: Math.max(1, Math.floor(height * 0.7)) })
    }
    return { error: "显示图片过大" }
  } catch (_) { return { error: "无法编码显示图片" } }
}
