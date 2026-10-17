import { Button, GeometryReader, Image, MagnifyGesture, ScrollView, Text, VStack, ZStack, useEffect, useRef, useState } from "scripting"
import { openLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"
import { localImportOnMain } from "../services/localImportExecution"
import { localImageZoomLayout, localImageZoomScale } from "../utils/localImageZoom"

/** Native display only. The service owns path checks and thumbnail creation;
 * this view never receives raw bytes, encodes an image, or writes the source.
 * Deletion remains the existing confirmed action in the workspace file list.
 */
export function LocalImagePreview({ bookmarkName, file, onReload }: {
  bookmarkName: string; file: LocalWorktreeFile; sessionId?: number
  onReload(file: LocalWorktreeFile): void
}) {
  const alive = useRef(true)
  const lock = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [scale, setScale] = useState(1)
  const committedScale = useRef(1)
  // Official TF views/gestures: MagnifyGesture(0.01).onChanged/onEnded with
  // value.magnification; ScrollView explicitly has NO native zoom API. Resize
  // its content with the pinch and let native two-axis scrolling own panning.
  function magnify(value: number, ended: boolean) {
    if (!alive.current || !Number.isFinite(value) || value <= 0) return
    const next = localImageZoomScale(committedScale.current * value)
    if (ended) committedScale.current = next
    setScale(next)
  }
  function resetZoom() {
    if (!alive.current) return
    committedScale.current = 1
    setScale(1)
  }
  useEffect(() => () => { alive.current = false }, [])
  async function reload() {
    if (lock.current) return
    lock.current = true
    try {
      await localImportOnMain("图片刷新开始", () => { if (alive.current) { setBusy(true); setError("") } })
      if (!alive.current) return
      const latest = await openLocalWorktreeFile(bookmarkName, file.path)
      await localImportOnMain("图片刷新结果", () => { if (alive.current) onReload(latest) })
    } catch (_) {
      await localImportOnMain("图片刷新错误", () => { if (alive.current) setError("图片刷新失败；保留当前预览，文件未修改。请返回列表后重试。") })
    } finally {
      lock.current = false
      await localImportOnMain("图片刷新收尾", () => { if (alive.current) setBusy(false) })
    }
  }
  // A destination in the APP's existing NavigationStack, not a new stack root.
  // Keep the system back button/interactive pop; don't replace it with a custom
  // leading toolbar action or a JS drag gesture.
  return <VStack spacing={12} padding frame={{ maxWidth: Infinity, maxHeight: Infinity }}
      navigationTitle={file.path.split("/").pop() || "图片预览"} navigationBarTitleDisplayMode="inline" navigationBarBackButtonHidden={false}
      toolbar={{ topBarTrailing: <Button title="刷新" action={reload} disabled={busy} /> }}>
      {error ? <Text foregroundStyle="red">{error}</Text> : null}
      {file.previewImage ? <GeometryReader>
        {proxy => {
          const layout = localImageZoomLayout({ width: file.previewImage!.width, height: file.previewImage!.height }, proxy.size, scale)
          return <ScrollView axes="all" scrollDisabled={scale <= 1} scrollClipDisabled={false} defaultScrollAnchor="center"
            frame={{ width: layout.width, height: layout.height }}
            simultaneousGesture={MagnifyGesture(0.01).onChanged(value => magnify(value.magnification, false)).onEnded(value => magnify(value.magnification, true))}
            onTapGesture={scale > 1 ? { count: 2, perform: resetZoom } : undefined}>
            <ZStack frame={{ width: layout.contentWidth, height: layout.contentHeight }}>
              <Image image={file.previewImage} resizable scaleToFit aspectRatio={{ value: null, contentMode: "fit" }}
                frame={{ width: layout.displayWidth, height: layout.displayHeight }} />
            </ZStack>
          </ScrollView>
        }}
      </GeometryReader> :
        <Text foregroundStyle="red">图片预览不可用；文件未修改，可返回列表重试或删除。</Text>}
    </VStack>
}
