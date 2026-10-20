import { useHorizontalExit, useHorizontalActive } from "../hooks/useHorizontalRoute"
/** 官方 Editor + EditorController；右滑与关闭按钮共用放弃确认，只有提交保存按钮写入远端。 */
import { Button, Editor, HStack, Text, TextField, VStack, useEffect, useMemo, useRef, useState } from "scripting"
import { saveRepoTextFile } from "../api/githubApi"
import { GitHubFileSession, type RemoteTextFile } from "../services/githubFileSession"
import { useEdgeBack } from "../hooks/useEdgeBack"

export function GitHubFileEditor({ fullName, branch, file, onClose }: {
  fullName: string; branch: string; file: RemoteTextFile; onClose: () => void
}) {
  const session = useMemo(() => new GitHubFileSession(file, branch), [])
  const controller = useMemo(() => new EditorController({
    content: file.text ?? "",
    ext: editorExtension(file.path),
    readOnly: !!session.readOnlyReason,
  }), [])
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  const closing = useRef(false)
  const alive = useRef(true)
  const exited = useRef(false)
  useEffect(() => () => { alive.current = false; controller.dispose() }, [controller])

  const isActive = useHorizontalActive()
  const exit = useHorizontalExit(() => { exited.current = true; onClose() })
  async function close() {
    if (!isActive() || !alive.current || session.saving || closing.current || exited.current) return
    closing.current = true
    try {
      // 直接读取控制器，不能依赖有约 100ms 延迟的 onContentChanged。
      if (session.isDirty(controller.content)) {
        const discard = await Dialog.confirm({ title: "放弃未保存的修改？", message: "尚未提交到 GitHub 的内容将丢失。可先取消并复制草稿。", confirmLabel: "放弃修改" })
        if (discard !== true) return
      }
      if (alive.current) await exit()
    } finally { closing.current = false }
  }

  async function save() {
    if (!isActive() || !alive.current || session.saving || closing.current || exited.current) return
    setBusy(true)
    setStatus("")
    try {
      const text = controller.content
      await session.save(text, message, (input) => saveRepoTextFile(fullName, input))
      if (alive.current) setStatus("已提交到 GitHub。" + (session.isDirty(controller.content) ? "仍有新的未保存修改。" : ""))
    } catch (e: any) {
      if (alive.current) setStatus(String(e?.message || e) + "（草稿未清除）")
    } finally { if (alive.current) setBusy(false) }
  }

  const backGesture = useEdgeBack(close, !busy)
  return <>
    <VStack simultaneousGesture={backGesture} navigationTitle={file.path.split("/").pop() || "编辑文件"}
      navigationBarTitleDisplayMode="inline"
      toolbar={{ topBarLeading: <Button title="关闭" action={close} disabled={busy} /> }}>
      <Text font="caption">{fullName} · {branch} · {file.path}</Text>
      {session.readOnlyReason ? <Text>{session.readOnlyReason}</Text> : <>
        <HStack>
          <TextField title="提交消息" value={message} onChanged={setMessage} prompt="必填：描述本次修改" />
          <Button title={busy ? "保存中…" : "提交保存"} action={save} disabled={busy || !message.trim()} />
        </HStack>
        <Text font="caption">直接提交到所选远端分支，不会同步本地工作区。</Text>
      </>}
      {status ? <Text font="caption" foregroundStyle={status.startsWith("已提交") ? "green" : "red"}>{status}</Text> : null}
      {file.text !== null ? <Editor controller={controller} scriptName="scriptgit" showAccessoryView /> : null}
    </VStack>
  </>
}

function editorExtension(path: string): "tsx" | "ts" | "js" | "jsx" | "txt" | "md" | "css" | "html" | "json" {
  const ext = path.split(".").pop()?.toLowerCase() || "txt"
  return (["tsx", "ts", "js", "jsx", "md", "css", "html", "json"].includes(ext) ? ext : "txt") as ReturnType<typeof editorExtension>
}
