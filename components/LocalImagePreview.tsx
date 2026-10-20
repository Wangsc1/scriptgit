import { useHorizontalExit } from "../hooks/useHorizontalRoute"
import { Button, Text, VStack, ZStack, useMemo } from "scripting"
import { ImageViewer, LOCAL_IMAGE_BACKGROUND } from "./ImageViewer"
import type { LocalWorktreeFile } from "../services/gitService"
import { localImageDisplayDataUrl } from "../utils/localImageDisplay"
import { useEdgeBack } from "../hooks/useEdgeBack"

/** Read-only display. The service owns path checks and thumbnail creation; this
 * view never reads or writes the source file. Deletion remains the existing
 * confirmed action in the workspace file list.
 */
export function LocalImagePreview({ file, sessionId, onClose }: {
  file: LocalWorktreeFile; sessionId?: number; onClose(): void
}) {
  // Prefer verified original browser image bytes; native fallback only for other formats.
  const display = useMemo(() => file.previewDataUrl ? { url: file.previewDataUrl } : file.previewImage ? localImageDisplayDataUrl(file.previewImage, file.path) : { error: "图片预览不可用" }, [file.previewDataUrl, file.previewImage, file.path])
  const exit = useHorizontalExit(onClose)
  const errorBackGesture = useEdgeBack(exit)
  if (!("url" in display)) return <VStack simultaneousGesture={errorBackGesture} spacing={12} padding frame={{ maxWidth: Infinity, maxHeight: Infinity }}>
    <Text foregroundStyle="red">{display.error}；文件未修改，可关闭后重试或删除。</Text>
    <Button title="关闭" action={exit} />
  </VStack>
  return <ZStack frame={{ maxWidth: Infinity, maxHeight: Infinity }} background={LOCAL_IMAGE_BACKGROUND}
    ignoresSafeArea={{ regions: "all", edges: "all" }}>
    <ImageViewer url={display.url} compactImage sessionId={sessionId} onClose={onClose} />
  </ZStack>
}
