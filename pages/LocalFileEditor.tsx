import { Button, Editor, HStack, NavigationStack, Text, VStack, useEffect, useMemo, useRef, useState } from "scripting"
import { readLocalWorktreeFile, saveLocalWorktreeFile, deleteLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"

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
  useEffect(() => () => { alive.current = false; controller?.dispose() }, [])
  const dirty = () => controller !== null && controller.content !== baseline.current.text

  async function discard(title: string) {
    return !dirty() || await Dialog.confirm({ title, message: "尚未保存的本地草稿将丢失。可取消后复制草稿。", confirmLabel: "放弃草稿" }) === true
  }
  async function close() {
    if (lock.current) return
    lock.current = true
    try { if (await discard("放弃未保存的修改？")) onClose() } finally { lock.current = false }
  }
  async function operate(kind: "save" | "reload" | "delete") {
    if (lock.current) return
    lock.current = true; setBusy(true); setStatus("")
    try {
      if (kind === "reload") {
        if (!await discard("重新加载并放弃草稿？")) return
        const latest = await readLocalWorktreeFile(bookmarkName, file.path)
        if (alive.current) onReload(latest)
        return
      }
      if (kind === "delete") {
        if (await Dialog.confirm({ title: "删除此本地文件？", message: `${file.path}\n只删除当前工作区这个文件，不删除目录，也不会提交或推送。${dirty() ? "未保存草稿也将丢失。" : ""}`, confirmLabel: "删除文件" }) !== true) return
        await deleteLocalWorktreeFile(bookmarkName, baseline.current)
        await notifyChanged(true)
        if (alive.current) onClose()
        return
      }
      if (!controller) throw new Error("编辑器不可用，请关闭后重新打开")
      const text = controller.content
      baseline.current = await saveLocalWorktreeFile(bookmarkName, baseline.current, text)
      if (alive.current) setStatus("已保存到本地工作区，未暂存、未提交。" + (dirty() ? "仍有新的未保存修改。" : ""))
      await notifyChanged(false)
    } catch (e: any) {
      if (alive.current) setStatus(String(e?.message || e) + "（草稿未清除；可复制草稿后重载）")
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  async function notifyChanged(deleted: boolean) {
    try { await onChanged(file.path, deleted) }
    catch (e: any) { if (alive.current) setStatus("工作区已修改，但状态刷新失败：" + String(e?.message || e) + "；请刷新改动页核对") }
  }
  return <NavigationStack>
    <VStack navigationTitle={file.path.split("/").pop() || "本地文件"} navigationBarTitleDisplayMode="inline"
      toolbar={{ topBarLeading: <Button title="关闭" action={close} disabled={busy} /> }}>
      <Text font="caption">{file.path}</Text>
      <Text font="caption">修改仅保存到本地工作区。请到「改动」页手动暂存、提交，再推送。</Text>
      {file.readOnlyReason ? <Text>{file.readOnlyReason}</Text> : null}
      <HStack>
        {controller !== null && !file.readOnlyReason ? <Button title="保存到本地" action={() => operate("save")} disabled={busy} /> : null}
        <Button title="重新加载文件" action={() => operate("reload")} disabled={busy} />
        <Button title="删除文件" role="destructive" action={() => operate("delete")} disabled={busy} />
      </HStack>
      {editor.error ? <Text foregroundStyle="red">{editor.error}</Text> : null}
      {status ? <Text font="caption">{status}</Text> : null}
      {controller !== null ? <Editor controller={controller} scriptName="scriptgit" showAccessoryView /> : null}
    </VStack>
  </NavigationStack>
}
function extension(path: string): "tsx" | "ts" | "js" | "jsx" | "txt" | "md" | "css" | "html" | "json" {
  const ext = path.split(".").pop()?.toLowerCase() || "txt"
  return (["tsx", "ts", "js", "jsx", "md", "css", "html", "json"].includes(ext) ? ext : "txt") as ReturnType<typeof extension>
}
