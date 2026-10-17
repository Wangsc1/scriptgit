import { Button, DisclosureGroup, Section, Text, HStack, Image, useRef, useState, useEffect } from "scripting"
import { buildFileTree, type FileTreeNode } from "../utils/fileTree"
import type { FileChange } from "../types/git"
import { readLocalWorktreeFile, openLocalWorktreeFile, copyLocalWorktreeFile, renameLocalWorktreeFile, deleteLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"
import { COLOR_LABEL, COLOR_SECONDARY_LABEL, COLOR_ACCENT, COLOR_ORANGE } from "../constants/colors"

function statusBadge(status: FileChange["status"], unstaged?: boolean): { text: string; color: string } | null {
  switch (status) {
    case "added":
    case "*added": return { text: "新增", color: "systemPurple" }
    case "modified":
    case "*modified": return { text: "已修改", color: COLOR_ORANGE }
    case "deleted":
    case "*deleted": return { text: "已删除", color: "systemRed" }
    default:
      if (unstaged) return { text: "已修改", color: COLOR_ORANGE }
      return null
  }
}

function FileTreeNodeView({ node, open, removed, busy, remove, manage, changesByPath }: { node: FileTreeNode; open: (path: string) => void; removed: Set<string>; busy: boolean; remove: (path: string) => void; manage: (path: string, kind: "copy" | "rename") => void; changesByPath: Map<string, FileChange> }) {
  if (node.type === "file") {
    const deleted = removed.has(node.path)
    const change = changesByPath.get(node.path)
    const badge = deleted ? { text: "已删除", color: "systemRed" } : change ? statusBadge(change.status, change.unstaged) : null
    return (
      <HStack
        alignment="center"
        contextMenu={{ menuItems: <>
          <Button title="复制文件" disabled={busy || deleted} action={() => manage(node.path, "copy")} />
          <Button title="重命名" disabled={busy || deleted} action={() => manage(node.path, "rename")} />
        </> }}
        trailingSwipeActions={{ allowsFullSwipe: false, actions: [
          <Button title="删除" systemImage="trash" tint="systemRed" disabled={busy || deleted} action={() => remove(node.path)} />,
        ] }}>
        <Button action={() => open(node.path)} disabled={busy || deleted} frame={{ maxWidth: Infinity, alignment: "leading" }}>
          <HStack alignment="center" spacing={10} frame={{ maxWidth: Infinity }}>
            <Image systemName="doc" foregroundStyle={COLOR_SECONDARY_LABEL} />
            <Text font="body" foregroundStyle={deleted ? COLOR_SECONDARY_LABEL : COLOR_LABEL} lineLimit={2}>{node.name}</Text>
            {badge ? <Text font="caption2" foregroundStyle={badge.color as any}>{badge.text}</Text> : null}
            {deleted ? <Text font="caption2" foregroundStyle={COLOR_SECONDARY_LABEL}>（不可编辑）</Text> : null}
          </HStack>
        </Button>
      </HStack>
    )
  }
  return <DisclosureGroup label={<HStack alignment="center" spacing={10}>
    <Image systemName="folder" foregroundStyle={COLOR_ACCENT} /><Text font="body" foregroundStyle={COLOR_LABEL}>{node.name}</Text>
  </HStack>}>
    {node.children.map(child => <FileTreeNodeView key={child.path} node={child} open={open} removed={removed} busy={busy} remove={remove} manage={manage} changesByPath={changesByPath} />)}
  </DisclosureGroup>
}

export function FilesTab({ files, loading, bookmarkName, changes, onWorktreeChanged, onOpen }: {
  files: string[]; loading: boolean; bookmarkName: string; changes: FileChange[]
  onOpen: (file: LocalWorktreeFile) => void
  onWorktreeChanged: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [added, setAdded] = useState<string[]>([])
  const visibleFiles = [...new Set([...files, ...changes.map(c => c.filepath), ...added])]
  const [deleted, setDeleted] = useState<string[]>([])
  const state = useRef({ alive: true, busy: false })
  useEffect(() => () => { state.current.alive = false }, [])
  useEffect(() => {
    // 外部恢复或撤销删除后，新的改动结果应解除本页的即时删除标记。
    setDeleted(previous => previous.filter(path => changes.some(c => c.filepath === path && c.worktreeDeleted)))
  }, [changes])
  const removed = new Set([...deleted, ...changes.filter(c => c.worktreeDeleted === true).map(c => c.filepath)])
  const changesByPath = new Map<string, FileChange>(changes.map(c => [c.filepath, c]))
  async function open(path: string) {
    if (state.current.busy || removed.has(path)) return
    setError("")
    try {
      const file = await openLocalWorktreeFile(bookmarkName, path)
      if (state.current.alive) onOpen(file)
    } catch (e: any) { if (state.current.alive) setError(String(e?.message || e)) }
  }
  async function changed(path: string, isDeleted: boolean) {
    if (isDeleted && state.current.alive) {
      setDeleted(previous => [...previous, path])
      setAdded(previous => previous.filter(p => p !== path))
    }
    await onWorktreeChanged()
  }
  async function remove(path: string) {
    if (state.current.busy || removed.has(path)) return
    state.current.busy = true; setBusy(true); setError("")
    try {
      // 先安全读取版本基线；确认期间外部变化由删除 facade 再检查。
      const file = await readLocalWorktreeFile(bookmarkName, path)
      if (!state.current.alive) return
      if (await Dialog.confirm({ title: "删除此本地文件？", message: `${path}\n只删除当前工作区这个文件，不删除目录，也不会暂存、提交或推送。`, confirmLabel: "删除文件" }) !== true || !state.current.alive) return
      await deleteLocalWorktreeFile(bookmarkName, file)
      await changed(path, true)
    } catch (e: any) { if (state.current.alive) setError(String(e?.message || e)) }
    finally { state.current.busy = false; if (state.current.alive) setBusy(false) }
  }
  async function manage(path: string, kind: "copy" | "rename") {
    if (state.current.busy || removed.has(path)) return
    state.current.busy = true; setBusy(true); setError("")
    try {
      const file = await readLocalWorktreeFile(bookmarkName, path)
      if (!state.current.alive) return
      const name = path.split("/").pop() || ""
      const dot = name.lastIndexOf(".")
      const defaultValue = kind === "rename" ? name : dot > 0 ? name.slice(0, dot) + " 副本" + name.slice(dot) : name + " 副本"
      const next = await Dialog.prompt({ title: kind === "copy" ? "复制文件到当前目录" : "重命名文件", message: "只修改本地工作区，不覆盖已有文件，不会暂存、提交或推送。", defaultValue, confirmLabel: "确认", cancelLabel: "取消" })
      if (next == null || !state.current.alive) return
      const target = await (kind === "copy" ? copyLocalWorktreeFile : renameLocalWorktreeFile)(bookmarkName, file, next)
      if (state.current.alive) setAdded(previous => [...previous.filter(p => kind !== "rename" || p !== path), target])
      await changed(path, kind === "rename")
    } catch (e: any) { if (state.current.alive) setError(String(e?.message || e)) }
    finally { state.current.busy = false; if (state.current.alive) setBusy(false) }
  }
  return <Section header={<Text>工作区文件{visibleFiles.length > 0 ? `（${visibleFiles.length}）` : ""}</Text>}>
    {error ? <Text foregroundStyle="red">{error}</Text> : null}
    {loading ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>加载中…</Text> : null}
    {visibleFiles.length === 0 && !loading ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>当前工作区没有文件</Text> : buildFileTree(visibleFiles).map(node => <FileTreeNodeView key={node.path} node={node} open={open} removed={removed} busy={busy || loading} remove={remove} manage={manage} changesByPath={changesByPath} />)}
  </Section>
}
