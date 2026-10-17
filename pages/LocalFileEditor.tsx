import { Button, Editor, NavigationStack, Text, VStack, ScrollView, useEffect, useMemo, useRef, useState } from "scripting"
import { COLOR_SECONDARY_LABEL } from "../constants/colors"
import { readLocalWorktreeFile, saveLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"
import { getFileVersions, type FileVersions, type FileDiff } from "../services/diffService"

import { DiffViewer } from "../components/DiffViewer"
import { FileChangeSwitcher } from "../components/FileChangeSwitcher"
import { editorDiff } from "../utils/editorDiff"

/** 全屏本地工作区编辑：不暂存、不提交、不推送；退出始终核对控制器当前草稿。 */
export function LocalFileEditor({ bookmarkName, file, onClose, onReload, onChanged }: {
  bookmarkName: string; file: LocalWorktreeFile; onClose: () => void
  onReload: (file: LocalWorktreeFile) => void
  onChanged: (path: string, deleted: boolean) => void | Promise<void>
}) {
  const baseline = useRef(file)
  const lock = useRef(false)
  const alive = useRef(true)
  const editor = useMemo(() => {
    // 二进制/超限文件不创建不使用的原生编辑器；构造失败留在页面报告，不逃逸 render。
    if (file.text === null) return { controller: null, error: "" }
    try { return { controller: new EditorController({ content: file.text, ext: extension(file.path), readOnly: !!file.readOnlyReason }), error: "" } }
    catch (e: any) { return { controller: null, error: "编辑器初始化失败：" + String(e?.message || e) } }
  }, [])
  const controller = editor.controller
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  // “原内容”沿用当前工作区编辑器；“改动项”只读对比 HEAD 和内存草稿。
  const [viewKind, setViewKind] = useState<"content" | "changes">("content")
  const [versions, setVersions] = useState<FileVersions | null>(null)
  const versionRef = useRef<FileVersions | null>(null)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [hasChanges, setHasChanges] = useState(false)
  const [versionsError, setVersionsError] = useState("")
  const [diffRevision, setDiffRevision] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadingVersions = useRef(false)
  function updateDiff() {
    const v = versionRef.current
    if (!alive.current || !v || !controller) return
    const draft = controller.content
    setHasChanges(v.added || draft !== v.original)
    setDiff(editorDiff(v, draft))
    setDiffRevision(n => n + 1)
  }
  async function loadVersions() {
    if (!controller || file.readOnlyReason || loadingVersions.current) return
    loadingVersions.current = true
    setVersionsError("")
    try {
      const v = await getFileVersions(bookmarkName, file.path)
      if (!alive.current) return
      versionRef.current = v
      setVersions(v)
      updateDiff()
    } catch (e: any) {
      if (alive.current) setVersionsError("读取改动失败：" + String(e?.message || e))
    } finally { loadingVersions.current = false }
  }
  useEffect(() => {
    if (controller) controller.onContentChanged = () => {
      if (!alive.current) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(updateDiff, 250)
    }
    void loadVersions()
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
      if (controller) controller.onContentChanged = undefined
      controller?.dispose()
    }
  }, [])
  const dirty = () => controller !== null && controller.content !== baseline.current.text

  async function discard(title: string) {
    return !dirty() || await Dialog.confirm({ title, message: "尚未保存的本地草稿将丢失。可取消后复制草稿。", confirmLabel: "放弃草稿" }) === true
  }
  async function back() {
    if (lock.current) return
    lock.current = true; setBusy(true); setStatus("")
    try {
      // 返回默认保存：无修改直接返回；保存失败/外部冲突留在本页并保留草稿。
      if (controller !== null && !file.readOnlyReason && dirty()) {
        baseline.current = await saveLocalWorktreeFile(bookmarkName, baseline.current, controller.content)
        await notifyChanged()
      }
      if (alive.current) onClose()
    } catch (e: any) {
      if (alive.current) setStatus(String(e?.message || e) + "（未返回，草稿未清除；可复制草稿后再刷新）")
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  async function reload() {
    if (lock.current) return
    lock.current = true; setBusy(true); setStatus("")
    try {
      if (!await discard("刷新并放弃草稿？")) return
      const latest = await readLocalWorktreeFile(bookmarkName, file.path)
      if (alive.current) onReload(latest)
    } catch (e: any) {
      if (alive.current) setStatus(String(e?.message || e) + "（草稿未清除；可复制草稿后再刷新）")
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  async function notifyChanged() {
    try { await onChanged(file.path, false) }
    catch (e: any) { console.warn("本地文件保存后状态刷新失败: " + String(e?.message || e)); if (alive.current) setStatus("已保存，但状态刷新失败；请到改动页核对") }
  }
  function selectView(kind: "content" | "changes") {
    if (lock.current) return
    if (timer.current) clearTimeout(timer.current)
    updateDiff() // 直接读取控制器，捕捉最后 100ms 内尚未回调的输入。
    setViewKind(kind)
  }
  const added = diff?.lines.filter(line => line.type === "add").length ?? 0
  const deleted = diff?.lines.filter(line => line.type === "del").length ?? 0

  return <NavigationStack>
    <VStack spacing={0} frame={{ maxWidth: Infinity, maxHeight: Infinity }} navigationTitle={file.path.split("/").pop() || "本地文件"} navigationBarTitleDisplayMode="inline"
      safeAreaInset={hasChanges && !versions?.binary ? { bottom: { spacing: 0, content:
        <FileChangeSwitcher selected={viewKind} added={added} deleted={deleted} disabled={busy} onSelect={selectView} />
      } } : undefined}
      toolbar={{
        topBarLeading: <Button title="返回" action={back} disabled={busy} />,
        topBarTrailing: <Button title="刷新" action={reload} disabled={busy} />,
      }}>
      {file.readOnlyReason ? <Text>{file.readOnlyReason}</Text> : null}
      {editor.error ? <Text foregroundStyle="red">{editor.error}</Text> : null}
      {status ? <Text font="caption">{status}</Text> : null}
      {versionsError ? <VStack spacing={6}>
        <Text font="caption" foregroundStyle="red">{versionsError}</Text>
        <Button title="重试读取改动" action={loadVersions} disabled={busy} />
      </VStack> : null}
      {viewKind === "changes" && hasChanges && diff ? <ScrollView frame={{ maxWidth: Infinity, maxHeight: Infinity }}>
        <VStack spacing={0} padding={{ horizontal: 5, vertical: 10 }}>
          {added === 0 && deleted === 0 && hasChanges ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>仅换行或文件格式发生变化，无行级增删。</Text> :
            <DiffViewer key={diffRevision} diff={diff} compact />}
        </VStack>
      </ScrollView> : controller !== null ? <Editor controller={controller} scriptName="scriptgit" showAccessoryView /> :
        (file.readOnlyReason || editor.error) ? null : <Text foregroundStyle={COLOR_SECONDARY_LABEL}>无法编辑此文件</Text>}
    </VStack>
  </NavigationStack>
}
function extension(path: string): "tsx" | "ts" | "js" | "jsx" | "txt" | "md" | "css" | "html" | "json" {
  const ext = path.split(".").pop()?.toLowerCase() || "txt"
  return (["tsx", "ts", "js", "jsx", "md", "css", "html", "json"].includes(ext) ? ext : "txt") as ReturnType<typeof extension>
}
