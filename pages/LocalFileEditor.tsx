import { Button, Editor, NavigationStack, Text, VStack, ScrollView, ProgressView, useObservable, useEffect, useMemo, useRef, useState } from "scripting"
import { COLOR_SECONDARY_LABEL } from "../constants/colors"
import { readLocalWorktreeFile, saveLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"
import { getFileVersions, type FileVersions, type FileDiff } from "../services/diffService"

import { DiffViewer } from "../components/DiffViewer"
import { FileChangeSwitcher } from "../components/FileChangeSwitcher"
import { editorDiff } from "../utils/editorDiff"

/** 全屏本地工作区编辑：不暂存、不提交、不推送；退出始终核对控制器当前草稿。 */
export function LocalFileEditor({ bookmarkName, file, initialHasChanges = false, onClose, onReload, onChanged }: {
  bookmarkName: string; file: LocalWorktreeFile; initialHasChanges?: boolean; onClose: () => void
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
  // 打开内容只使用已读取的快照：不读 HEAD，不做行差异计算。
  const selection = useObservable(0)
  const [viewKind, setViewKind] = useState(0)
  const versionRef = useRef<FileVersions | null>(null)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [hasChanges, setHasChanges] = useState(initialHasChanges)
  const [versionsError, setVersionsError] = useState("")
  const [diffRevision, setDiffRevision] = useState(0)
  const [diffBusy, setDiffBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadingVersions = useRef(false)
  async function loadDiff() {
    if (!controller || file.readOnlyReason || loadingVersions.current || selection.value !== 1) return
    loadingVersions.current = true
    setDiffBusy(true); setVersionsError("")
    try {
      const v = versionRef.current ?? await getFileVersions(bookmarkName, file.path)
      if (!alive.current) return
      versionRef.current = v
      // 离开改动项后不再计算，返回原内容从不等待此请求。
      if (selection.value !== 1) return
      const draft = controller.content
      setDiff(editorDiff(v, draft))
      setDiffRevision(n => n + 1)
    } catch (e: any) {
      if (alive.current) setVersionsError("读取改动失败：" + String(e?.message || e))
    } finally {
      loadingVersions.current = false
      if (alive.current) setDiffBusy(false)
    }
  }
  useEffect(() => {
    const onSelection = (value: number) => {
      if (!alive.current) return
      setViewKind(value)
      if (timer.current) clearTimeout(timer.current)
      // 先呈现页签/加载态，再开始 HEAD 读取和差异计算。
      if (value === 1) { setDiffBusy(true); timer.current = setTimeout(() => void loadDiff(), 0) }
    }
    selection.subscribe(onSelection)
    if (controller) controller.onContentChanged = () => {
      if (!alive.current) return
      // 原内容输入只做字符串比较，不计算 LCS、不读取磁盘。
      setHasChanges(initialHasChanges || controller.content !== baseline.current.text)
    }
    return () => {
      alive.current = false
      selection.unsubscribe(onSelection)
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
  const added = diff?.lines.filter(line => line.type === "add").length ?? 0
  const deleted = diff?.lines.filter(line => line.type === "del").length ?? 0

  return <NavigationStack>
    <VStack spacing={0} frame={{ maxWidth: Infinity, maxHeight: Infinity }} navigationTitle={file.path.split("/").pop() || "本地文件"} navigationBarTitleDisplayMode="inline"
      toolbar={{
        topBarLeading: <Button title="返回" action={back} disabled={busy} />,
        topBarTrailing: <Button title="刷新" action={reload} disabled={busy} />,
      }}>
      {file.readOnlyReason ? <Text>{file.readOnlyReason}</Text> : null}
      {editor.error ? <Text foregroundStyle="red">{editor.error}</Text> : null}
      {status ? <Text font="caption">{status}</Text> : null}
      {hasChanges && controller !== null && !file.readOnlyReason ? <FileChangeSwitcher selection={selection} disabled={busy}
        content={<Editor controller={controller} scriptName="scriptgit" showAccessoryView={false} />}
        changes={viewKind === 1 ? <ScrollView frame={{ maxWidth: Infinity, maxHeight: Infinity }}>
          <VStack spacing={0} padding={{ horizontal: 5, vertical: 10 }}>
            {versionsError ? <VStack spacing={6}><Text font="caption" foregroundStyle="red">{versionsError}</Text>
              <Button title="重试读取改动" action={loadDiff} disabled={busy || diffBusy} /></VStack> :
              diffBusy || !diff ? <ProgressView /> : <>
                <Text font="caption" foregroundStyle={COLOR_SECONDARY_LABEL}>−{deleted} +{added}</Text>
                {added === 0 && deleted === 0 && controller.content !== versionRef.current?.original ?
                  <Text foregroundStyle={COLOR_SECONDARY_LABEL}>仅换行或文件格式发生变化，无行级增删。</Text> :
                  <DiffViewer key={diffRevision} diff={diff} compact />}
              </>}
          </VStack>
        </ScrollView> : <Text />}
      /> : controller !== null ? <Editor controller={controller} scriptName="scriptgit" showAccessoryView={false} /> :
        (file.readOnlyReason || editor.error) ? null : <Text foregroundStyle={COLOR_SECONDARY_LABEL}>无法编辑此文件</Text>}
    </VStack>
  </NavigationStack>
}
function extension(path: string): "tsx" | "ts" | "js" | "jsx" | "txt" | "md" | "css" | "html" | "json" {
  const ext = path.split(".").pop()?.toLowerCase() || "txt"
  return (["tsx", "ts", "js", "jsx", "md", "css", "html", "json"].includes(ext) ? ext : "txt") as ReturnType<typeof extension>
}
