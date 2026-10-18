import { Button, List, NavigationStack, Section, Text, useEffect, useRef, useState } from "scripting"
import { collectRepoDiagnostics, diagnosticText } from "../services/repoDiagnostics"
import { inspectHeadAssociation, associateDetachedHead, headAssociationErrorMessage, type HeadAssociationPreview } from "../services/headAssociation"

/** Report stays read-only; the separate HEAD-only action always requires explicit confirmation. */
export function RepoDiagnosticsPage({ bookmarkName, onClose, onAssociated }: { bookmarkName: string; onClose: () => void; onAssociated?: (branch: string) => void }) {
  const [report, setReport] = useState("")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const [candidates, setCandidates] = useState<HeadAssociationPreview | null>(null)
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
  async function findCandidates() {
    if (running.current) return
    running.current = true; setBusy(true); setNotice(""); setCandidates(null)
    try {
      const result = await inspectHeadAssociation(bookmarkName)
      if (alive.current) {
        setCandidates(result)
        if (!result.branches.length) setNotice("没有与当前分离 HEAD 同提交的本地分支，未修改任何数据。")
      }
    } catch (error) { if (alive.current) setNotice(headAssociationErrorMessage(error)) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function associate(branch: string) {
    const preview = candidates
    if (!preview || running.current) return
    running.current = true; setBusy(true); setNotice("")
    try {
      // Official Dialog.confirm returns boolean; cancellation performs no Git writes.
      // https://scriptingapp.github.io/guide/Views/Dialog/
      const confirmed = await Dialog.confirm({
        title: "仅重新关联 HEAD？",
        message: `将 HEAD 关联到现有本地分支「${diagnosticText(branch)}」。\n当前提交：${preview.headOid}\n执行前会重新核验同一提交与 Git 锁。只改 HEAD 文本；不 checkout/reset/stash，不触碰索引、分支引用或工作区，现有改动保留。`,
        cancelLabel: "取消", confirmLabel: "仅关联 HEAD",
      })
      if (!confirmed || !alive.current) return
      const associated = await associateDetachedHead(bookmarkName, branch, preview, true)
      if (alive.current) {
        setCandidates(null)
        onAssociated?.(associated)
        setNotice("已重新关联 HEAD，工作区和索引未操作。")
        try { const next = await collectRepoDiagnostics(bookmarkName); if (alive.current) setReport(next) }
        catch (_error) { if (alive.current) setNotice("HEAD 已关联，但报告刷新失败；请重新读取诊断。") }
      }
    } catch (error) { if (alive.current) { setCandidates(null); setNotice(headAssociationErrorMessage(error)) } }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  return <NavigationStack>
    <List navigationTitle="仓库诊断与 HEAD 关联" navigationBarTitleDisplayMode="inline" toolbar={{ topBarTrailing: <Button title="完成" disabled={busy} action={onClose} /> }}>
      <Section footer={<Text>诊断报告仅检查已有路径、目录访问和 Git 引用，不修复任何数据。不会读取/导出工作文件、远端 URL 或 Token。复制前请注意报告包含本机目录路径；下方 HEAD 关联是独立的确认后写操作。</Text>}>
        <Button title={busy ? "正在读取…" : "重新读取诊断"} disabled={busy} action={() => void refresh()} />
        <Button title="复制诊断报告" disabled={busy || !report} action={() => void copy()} />
        {notice ? <Text>{notice}</Text> : null}
      </Section>
      <Section header={<Text>可选：无损重新关联 HEAD</Text>} footer={<Text>仅适用于分离 HEAD 与现有本地分支处于同一提交。先查找，再明确选择一个分支并确认；不会自动选择 main/master。请勿同时使用其它 Git 客户端。诊断报告本身仍只读。</Text>}>
        <Button title="查找同提交的本地分支（只读）" disabled={busy} action={() => void findCandidates()} />
        {candidates ? <Text>分离 HEAD：{candidates.headOid}；匹配分支：{candidates.branches.length}</Text> : null}
        {candidates?.branches.map(branch => <Button key={branch} title={`关联到「${diagnosticText(branch)}」…`} disabled={busy} action={() => void associate(branch)} />)}
      </Section>
      <Section header={<Text>路径、HEAD 与分支引用</Text>}>
        <Text>{report || (busy ? "正在只读检查…" : "暂无报告")}</Text>
      </Section>
    </List>
  </NavigationStack>
}
