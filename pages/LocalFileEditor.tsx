import { Button, NavigationStack, Text, VStack, ScrollView, ProgressView, useObservable, useEffect, useMemo, useRef, useState } from "scripting"
import { COLOR_SECONDARY_LABEL } from "../constants/colors"
import { readLocalWorktreeFile, saveLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"
import { getFileVersions, type FileVersions, type FileDiff } from "../services/diffService"

import { DiffViewer } from "../components/DiffViewer"
import { FileChangeSwitcher } from "../components/FileChangeSwitcher"
import { LocalCodeEditor } from "../components/LocalCodeEditor"
import { createLocalCodeEditorController } from "../services/localCodeEditor"
import { editorDiff } from "../utils/editorDiff"
import { useEdgeBack } from "../hooks/useEdgeBack"

/** 全屏本地工作区编辑：不暂存、不提交、不推送；退出始终核对控制器当前草稿。 */
export function LocalFileEditor({ bookmarkName, file, initialHasChanges = false, onClose, onReload, onChanged }: {
  bookmarkName: string; file: LocalWorktreeFile; initialHasChanges?: boolean; onClose: () => void
  onReload: (file: LocalWorktreeFile) => void
  onChanged: (path: string, deleted: boolean) => void | Promise<void>
}) {
  const baseline = useRef(file)
  const lock = useRef(false)
  const exiting = useRef(false)
  const alive = useRef(true)
  const editor = useMemo(() => {
    // 二进制/超限文件不创建不使用的原生编辑器；构造失败留在页面报告，不逃逸 render。
    if (file.text === null) return { controller: null, error: "" }
    try { return { controller: createLocalCodeEditorController({ content: file.text, ext: extension(file.path), readOnly: !!file.readOnlyReason }), error: "" } }
    catch (e: any) { return { controller: null, error: "编辑器初始化失败：" + String(e?.message || e) } }
  }, [])
  const controller = editor.controller
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  // 首屏只使用已读取快照；数量统计延后加载，不阻塞编辑器呈现。
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
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  async function loadDiff(background = false) {
    if (!controller || file.readOnlyReason || loadingVersions.current || (!background && selection.value !== 1)) return
    loadingVersions.current = true
    setDiffBusy(true); setVersionsError("")
    try {
      const v = versionRef.current ?? await getFileVersions(bookmarkName, file.path)
      if (!alive.current) return
      versionRef.current = v
      // 离开改动项后不再计算，返回原内容从不等待此请求。
      if (!background && selection.value !== 1) return
      // 后台计数使用桥接草稿，不能触发退出前读取，否则会打断中文候选输入。
      const draft = background ? controller.content : await controller.getContent()
      if (!alive.current) return
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
      if (value === 1) {
        if (statsTimer.current) clearTimeout(statsTimer.current)
        setDiffBusy(true); timer.current = setTimeout(() => void loadDiff(), 0)
      }
    }
    selection.subscribe(onSelection)
    // 给编辑视图首屏留出时间；统计使用真实 HEAD/草稿，不显示猜测数字。
    if (initialHasChanges) statsTimer.current = setTimeout(() => void loadDiff(true), 500)
    if (controller) controller.onContentChanged = () => {
      if (!alive.current) return
      // 输入当下只比较字符串；停顿后再更新增删统计。
      const changed = initialHasChanges || controller.content !== baseline.current.text
      setHasChanges(changed)
      setDiff(null)
      if (statsTimer.current) clearTimeout(statsTimer.current)
      if (changed) statsTimer.current = setTimeout(() => void loadDiff(true), 500)
    }
    return () => {
      alive.current = false
      selection.unsubscribe(onSelection)
      if (timer.current) clearTimeout(timer.current)
      if (statsTimer.current) clearTimeout(statsTimer.current)
      if (controller) controller.onContentChanged = undefined
      controller?.dispose()
    }
  }, [])
  const dirty = () => controller !== null && controller.content !== baseline.current.text

  async function discard(title: string) {
    return !dirty() || await Dialog.confirm({ title, message: "尚未保存的本地草稿将丢失。可取消后复制草稿。", confirmLabel: "放弃草稿" }) === true
  }
  async function back() {
    if (!alive.current || lock.current || exiting.current) return
    lock.current = true; setBusy(true); setStatus("")
    try {
      // 返回默认保存：无修改直接返回；保存失败/外部冲突留在本页并保留草稿。
      let saved = false
      if (controller !== null && !file.readOnlyReason) await controller.getContent()
      if (controller !== null && !file.readOnlyReason && dirty()) {
        baseline.current = await saveLocalWorktreeFile(bookmarkName, baseline.current, controller.content)
        saved = true
      }
      if (alive.current) { exiting.current = true; onClose() }
      // 保存成功才关闭；状态扫描等全屏退场后执行，避免阻塞右滑返回。
      // 此任务有意跨编辑器卸载保留，由稳定父详情页接收刷新结果。
      if (saved) setTimeout(() => void notifyChanged(), 350)
    } catch (e: any) {
      if (alive.current) setStatus(String(e?.message || e) + "（未返回，草稿未清除；可复制草稿后再刷新）")
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  async function reload() {
    if (lock.current) return
    lock.current = true; setBusy(true); setStatus("")
    try {
      if (controller !== null) await controller.getContent()
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

  // CodeMirror already owns a WebKit edge recognizer (including IME/selection
  // guards) via onBack. Do not layer a second native recognizer over that WebView.
  const backGesture = useEdgeBack(back, !busy)
  return <NavigationStack background={{ light: "white", dark: "#242424" }}>
    <VStack simultaneousGesture={viewKind === 1 || controller === null ? backGesture : undefined} spacing={0} frame={{ maxWidth: Infinity, maxHeight: Infinity }} background={{ light: "white", dark: "#242424" }} foregroundStyle="label" ignoresSafeArea={{ regions: "container", edges: "bottom" }}
      toolbarBackground={{ style: { light: "white", dark: "#242424" }, bars: ["navigationBar"] }}
      toolbarBackgroundVisibility={{ visibility: "visible", bars: ["navigationBar"] }} navigationTitle={file.path.split("/").pop() || "本地文件"} navigationBarTitleDisplayMode="inline"
      toolbar={{
        topBarLeading: <Button title="返回" action={back} disabled={busy} />,
        topBarTrailing: <Button title="刷新" action={reload} disabled={busy} />,
      }}>
      {file.readOnlyReason ? <Text>{file.readOnlyReason}</Text> : null}
      {editor.error ? <Text foregroundStyle="red">{editor.error}</Text> : null}
      {status ? <Text font="caption">{status}</Text> : null}
      {hasChanges && controller !== null && !file.readOnlyReason ? <FileChangeSwitcher selection={selection} disabled={busy} stats={diff ? { added, deleted } : null}
        content={<LocalCodeEditor controller={controller} onBack={back} />}
        changes={viewKind === 1 ? <ScrollView frame={{ maxWidth: Infinity, maxHeight: Infinity }}
          background={{ light: "white", dark: "#242424" }} ignoresSafeArea={{ regions: "container", edges: "bottom" }}>
          <VStack spacing={0} padding={{ horizontal: 5, top: 10, bottom: 110 }}>
            {versionsError ? <VStack spacing={6}><Text font="caption" foregroundStyle="red">{versionsError}</Text>
              <Button title="重试读取改动" action={() => loadDiff()} disabled={busy || diffBusy} /></VStack> :
              diffBusy || !diff ? <ProgressView /> : <>
                <Text font="caption" foregroundStyle={COLOR_SECONDARY_LABEL}>−{deleted} +{added}</Text>
                {added === 0 && deleted === 0 && controller.content !== versionRef.current?.original ?
                  <Text foregroundStyle={COLOR_SECONDARY_LABEL}>仅换行或文件格式发生变化，无行级增删。</Text> :
                  <DiffViewer key={diffRevision} diff={diff} compact nativeAppearance />}
              </>}
          </VStack>
        </ScrollView> : <Text />}
      /> : controller !== null ? <LocalCodeEditor controller={controller} onBack={back} /> :
        (file.readOnlyReason || editor.error) ? null : <Text foregroundStyle={COLOR_SECONDARY_LABEL}>无法编辑此文件</Text>}
    </VStack>
  </NavigationStack>
}
function extension(path: string): "tsx" | "ts" | "js" | "jsx" | "txt" | "md" | "css" | "html" | "json" {
  const ext = path.split(".").pop()?.toLowerCase() || "txt"
  return (["tsx", "ts", "js", "jsx", "md", "css", "html", "json"].includes(ext) ? ext : "txt") as ReturnType<typeof extension>
}
