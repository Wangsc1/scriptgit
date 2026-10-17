import { Button, DisclosureGroup, Section, Text, HStack, Image, useRef, useState, useEffect } from "scripting"
import { buildFileTree, type FileTreeNode } from "../utils/fileTree"
import type { FileChange } from "../types/git"
import { readLocalWorktreeFile, openLocalWorktreeFile, copyLocalWorktreeFile, renameLocalWorktreeFile, deleteLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"
import { COLOR_LABEL, COLOR_SECONDARY_LABEL, COLOR_ACCENT } from "../constants/colors"

function FileTreeNodeView({ node, open, removed, busy, remove, manage }: { node: FileTreeNode; open: (path: string) => void; removed: Set<string>; busy: boolean; remove: (path: string) => void; manage: (path: string, kind: "copy" | "rename") => void }) {
  if (node.type === "file") return <HStack contextMenu={{ menuItems: <>
    <Button title="复制文件" disabled={busy || removed.has(node.path)} action={() => manage(node.path, "copy")} />
    <Button title="重命名" disabled={busy || removed.has(node.path)} action={() => manage(node.path, "rename")} />
  </> }} trailingSwipeActions={{ allowsFullSwipe: false, actions: [
    <Button title="删除" systemImage="trash" tint="systemRed" disabled={busy || removed.has(node.path)} action={() => remove(node.path)} />,
  ] }}>
    <Button action={() => open(node.path)} disabled={busy || removed.has(node.path)}>
      <HStack alignment="center" spacing={10}>
        <Image systemName="doc" foregroundStyle={COLOR_SECONDARY_LABEL} />
        <Text font="body" foregroundStyle={COLOR_LABEL} lineLimit={2}>{node.name}{removed.has(node.path) ? "（已删除，不可编辑）" : ""}</Text>
      </HStack>
    </Button>
  </HStack>
  return <DisclosureGroup label={<HStack alignment="center" spacing={10}>
    <Image systemName="folder" foregroundStyle={COLOR_ACCENT} /><Text font="body" foregroundStyle={COLOR_LABEL}>{node.name}</Text>
  </HStack>}>
    {node.children.map(child => <FileTreeNodeView key={child.path} node={child} open={open} removed={removed} busy={busy} remove={remove} manage={manage} />)}
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
  async function open(path: string) {
    if (state.current.busy || removed.has(path)) return
    state.current.busy = true; setBusy(true); setError("")
    try {
      const file = await openLocalWorktreeFile(bookmarkName, path)
      if (state.current.alive) onOpen(file)
    } catch (e: any) { if (state.current.alive) setError(String(e?.message || e)) }
    finally { state.current.busy = false; if (state.current.alive) setBusy(false) }
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
    {loading || busy ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>加载中…</Text> : null}
    {visibleFiles.length === 0 ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>当前工作区没有文件</Text> : buildFileTree(visibleFiles).map(node => <FileTreeNodeView key={node.path} node={node} open={open} removed={removed} busy={busy || loading} remove={remove} manage={manage} />)}
  </Section>
}
