/** Display-only zoom of the existing bounded UIImage thumbnail, not a new
 * decode or a promise of original-resolution detail. Native ScrollView owns
 * pan offsets, inertia and edge clamping; these are its actual content bounds. */
export const LOCAL_IMAGE_MAX_ZOOM = 4
export function localImageZoomScale(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(LOCAL_IMAGE_MAX_ZOOM, value)) : 1
}
export function localImageZoomLayout(image: { width: number; height: number }, viewport: { width: number; height: number }, scale: number) {
  const width = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : 1
  const height = Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : 1
  const imageWidth = Number.isFinite(image.width) && image.width > 0 ? image.width : width
  const imageHeight = Number.isFinite(image.height) && image.height > 0 ? image.height : height
  const fit = Math.min(width / imageWidth, height / imageHeight)
  const zoom = localImageZoomScale(scale)
  const displayWidth = imageWidth * fit * zoom
  const displayHeight = imageHeight * fit * zoom
  return {
    width, height, displayWidth, displayHeight,
    contentWidth: Math.max(width, displayWidth),
    contentHeight: Math.max(height, displayHeight),
  }
}
