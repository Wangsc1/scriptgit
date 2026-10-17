import { Button, HStack, Spacer, Text, VStack, ZStack, useEffect, useMemo, useRef, useState } from "scripting"
import { ImageViewer } from "./ImageViewer"
import { openLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"
import { localImportOnMain } from "../services/localImportExecution"
import { localImageDisplayDataUrl } from "../utils/localImageDisplay"

/** Native display only. The service owns path checks and thumbnail creation;
 * this view never receives raw bytes, encodes an image, or writes the source.
 * Deletion remains the existing confirmed action in the workspace file list.
 */
export function LocalImagePreview({ bookmarkName, file, sessionId, onClose, onReload }: {
  bookmarkName: string; file: LocalWorktreeFile; sessionId?: number
  onClose(): void; onReload(file: LocalWorktreeFile): void
}) {
  const alive = useRef(true)
  const lock = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  // Display-only in-memory copy of the existing bounded native thumbnail. It is
  // not the source file: no file read, no repository write, no source bytes.
  const display = useMemo(() => file.previewImage ? localImageDisplayDataUrl(file.previewImage) : { error: "图片预览不可用" }, [file.previewImage])
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
  // Existing project ImageViewer (WebKit pinch/pan; its own tap/swipe close).
  // A small native refresh entry sits over it; deletion stays in the file list.
  if (!("url" in display)) return <VStack spacing={12} padding frame={{ maxWidth: Infinity, maxHeight: Infinity }}>
    <Text foregroundStyle="red">{display.error}；文件未修改，可关闭后重试或删除。</Text>
    <Button title="关闭" action={onClose} />
  </VStack>
  return <ZStack frame={{ maxWidth: Infinity, maxHeight: Infinity }}>
    <ImageViewer url={display.url} compactImage sessionId={sessionId} onClose={onClose} />
    <VStack spacing={8} padding>
      <HStack><Spacer /><Button title={busy ? "刷新中…" : "刷新"} action={reload} disabled={busy} /></HStack>
      {error ? <Text foregroundStyle="red">{error}</Text> : null}
      <Spacer />
    </VStack>
  </ZStack>
}
