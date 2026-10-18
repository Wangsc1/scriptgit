import { Button, List, NavigationStack, Section, Text, useEffect, useRef, useState } from "scripting"
import { collectRepoDiagnostics } from "../services/repoDiagnostics"

/** Isolated read-only screen: no repo-data hooks/getCtx, mutations, or refresh snapshots. */
export function RepoDiagnosticsPage({ bookmarkName, onClose }: { bookmarkName: string; onClose: () => void }) {
  const [report, setReport] = useState("")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const running = useRef(false)
  const alive = useRef(true)
  async function refresh() {
    if (running.current) return
    running.current = true
    setBusy(true)
    setNotice("")
    try {
      const result = await collectRepoDiagnostics(bookmarkName)
      if (alive.current) setReport(result)
    } catch (_error) {
      if (alive.current) setNotice("诊断读取失败；未修改仓库。为避免泄漏凭据，未显示原始异常。")
    } finally {
      running.current = false
      if (alive.current) setBusy(false)
    }
  }
  useEffect(() => { void refresh(); return () => { alive.current = false } }, [])
  async function copy() {
    if (!report || busy) return
    try {
      // Official Pasteboard.setItems supports localOnly (no Handoff propagation).
      // https://scriptingapp.github.io/guide/Device%20Capabilities/Pasteboard
      await Pasteboard.setItems([{ "public.plain-text": report }], { localOnly: true })
      if (alive.current) setNotice("已复制诊断报告（仅本机剪贴板）；包含实际目录路径，请仅分享给可信排查人员。")
    } catch (_error) {
      if (alive.current) setNotice("复制失败，请重试；仓库未修改。")
    }
  }
  return <NavigationStack>
    <List navigationTitle="仓库诊断（只读）" navigationBarTitleDisplayMode="inline" toolbar={{ topBarTrailing: <Button title="完成" action={onClose} /> }}>
      <Section footer={<Text>仅检查已有路径、目录访问和 Git 引用，不修复任何数据。不会读取/导出工作文件、远端 URL 或 Token。复制前请注意报告包含本机目录路径。</Text>}>
        <Button title={busy ? "正在读取…" : "重新读取诊断"} disabled={busy} action={() => void refresh()} />
        <Button title="复制诊断报告" disabled={busy || !report} action={() => void copy()} />
        {notice ? <Text>{notice}</Text> : null}
      </Section>
      <Section header={<Text>路径、HEAD 与分支引用</Text>}>
        <Text>{report || (busy ? "正在只读检查…" : "暂无报告")}</Text>
      </Section>
    </List>
  </NavigationStack>
}
