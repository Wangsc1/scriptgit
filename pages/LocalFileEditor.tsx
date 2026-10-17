import { Button, Editor, NavigationStack, Text, VStack, HStack, List, Section, useEffect, useMemo, useRef, useState } from "scripting"
import { COLOR_SECONDARY_LABEL, COLOR_ACCENT } from "../constants/colors"
import { readLocalWorktreeFile, saveLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"
import { getFileVersions, type FileVersions } from "../services/diffService"

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
  // 原文/改动后 查看
  const [versions, setVersions] = useState<FileVersions | null>(null)
  const [viewKind, setViewKind] = useState<"original" | "current" | null>(null)
  const [versionsError, setVersionsError] = useState("")
  useEffect(() => () => { alive.current = false; controller?.dispose() }, [])
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
  async function viewVersion(kind: "original" | "current") {
    setViewKind(kind)
    setVersionsError("")
    if (versions) return
    try {
      const v = await getFileVersions(bookmarkName, file.path)
      if (alive.current) setVersions(v)
    } catch (e: any) {
      if (alive.current) setVersionsError(String(e?.message || e))
    }
  }
  const viewText = viewKind === "original" ? versions?.original : viewKind === "current" ? versions?.current : null

  return <NavigationStack>
    <VStack spacing={0} navigationTitle={file.path.split("/").pop() || "本地文件"} navigationBarTitleDisplayMode="inline"
      fullScreenCover={{
        isPresented: viewKind != null,
        onChanged: () => { if (viewKind != null) setViewKind(null) },
        content: viewKind ? (
          <NavigationStack>
            <List navigationTitle={viewKind === "original" ? "原内容" : "改动后内容"} navigationBarTitleDisplayMode="inline" tabBarVisibility="hidden">
              <Section>
                {versionsError ? <Text foregroundStyle="red">{versionsError}</Text> : null}
                {viewKind === "original" && versions?.added ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>该文件为新增，无原内容。</Text> : null}
                {viewKind === "current" && versions?.deleted ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>该文件已删除。</Text> : null}
                {versions?.binary ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>二进制文件，无法显示原文。</Text> : null}
                {viewText != null ? <Text font="caption" selectable>{viewText}</Text> : (versionsError || versions?.binary || versions?.added || versions?.deleted) ? null : <Text foregroundStyle={COLOR_SECONDARY_LABEL}>加载中…</Text>}
              </Section>
            </List>
          </NavigationStack>
        ) : <></>,
      }}
      toolbar={{
        topBarLeading: <Button title="返回" action={back} disabled={busy} />,
        topBarTrailing: <Button title="刷新" action={reload} disabled={busy} />,
      }}>
      {file.readOnlyReason ? <Text>{file.readOnlyReason}</Text> : null}
      {editor.error ? <Text foregroundStyle="red">{editor.error}</Text> : null}
      {status ? <Text font="caption">{status}</Text> : null}
      {controller !== null ? <Editor controller={controller} scriptName="scriptgit" showAccessoryView /> : (file.readOnlyReason || editor.error) ? null : <Text foregroundStyle={COLOR_SECONDARY_LABEL}>无法编辑此文件</Text>}
      <HStack alignment="center" spacing={10} padding={{ horizontal: 12, vertical: 8 }} frame={{ maxWidth: Infinity, alignment: "center" }}>
        <Button action={() => viewVersion("original")} tint={COLOR_ACCENT} disabled={busy}>
          <Text font="caption" foregroundStyle={COLOR_ACCENT}>原内容</Text>
        </Button>
        <Button action={() => viewVersion("current")} tint={COLOR_ACCENT} disabled={busy}>
          <Text font="caption" foregroundStyle={COLOR_ACCENT}>改动后</Text>
        </Button>
      </HStack>
    </VStack>
  </NavigationStack>
}
function extension(path: string): "tsx" | "ts" | "js" | "jsx" | "txt" | "md" | "css" | "html" | "json" {
  const ext = path.split(".").pop()?.toLowerCase() || "txt"
  return (["tsx", "ts", "js", "jsx", "md", "css", "html", "json"].includes(ext) ? ext : "txt") as ReturnType<typeof extension>
}
