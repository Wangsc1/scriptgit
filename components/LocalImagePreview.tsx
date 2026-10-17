import { Button, Image, Text, VStack, useEffect, useRef, useState } from "scripting"
import { openLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"
import { localImportOnMain } from "../services/localImportExecution"

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
      {file.previewImage ? <Image image={file.previewImage} resizable scaleToFit aspectRatio={{ value: null, contentMode: "fit" }} frame={{ maxWidth: Infinity, maxHeight: Infinity }} /> :
        <Text foregroundStyle="red">图片预览不可用；文件未修改，可返回列表重试或删除。</Text>}
    </VStack>
}
