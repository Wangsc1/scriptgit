import { Button, DisclosureGroup, Section, Text, HStack, VStack, Image, useRef, useState, useEffect, useMemo } from "scripting"
import { buildFileTree, type FileTreeNode } from "../utils/fileTree"
import { formatBytes, formatDate } from "../utils/format"
import { resolveWorkdir } from "../services/repoStore"
import { readLocalWorktreeFile, openLocalWorktreeFile, copyLocalWorktreeFile, renameLocalWorktreeFile, deleteLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"
import { COLOR_LABEL, COLOR_SECONDARY_LABEL, COLOR_ACCENT, COLOR_ORANGE } from "../constants/colors"
import type { FileChange } from "../types/git"

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

/** 文件列表：左滑 提交(push)/还原/删除 */
function FileTreeNodeView({ node, open, removed, busy, remove, manage, changesByPath, metadata, onPush, onRestore, mergeInProgress }: { node: FileTreeNode; open: (path: string) => void; removed: Set<string>; busy: boolean; remove: (path: string) => void; manage: (path: string, kind: "copy" | "rename") => void; changesByPath: Map<string, FileChange>; metadata: Map<string, { size: number; modified: number }>; onPush: () => void | Promise<void>; onRestore: (filepath: string) => void; mergeInProgress: boolean }) {
  if (node.type === "file") {
    const deleted = removed.has(node.path)
    const change = changesByPath.get(node.path)
    const badge = deleted ? { text: "已删除", color: "systemRed" } : change ? statusBadge(change.status, change.unstaged) : null
    const meta = metadata.get(node.path)
    const metaParts: string[] = []
    if (meta && meta.size != null) metaParts.push(formatBytes(meta.size))
    if (meta && meta.modified != null) metaParts.push(formatDate(meta.modified))
    // trailing 操作从右侧向内排列：视觉从左到右为 删除 / 提交 / 还原。
    const swipeActions: any[] = []
    if (change && !deleted) {
      swipeActions.push(<Button
        key="restore"
        title="还原"
        tint="systemOrange"
        action={() => onRestore(node.path)}
        disabled={busy || mergeInProgress}
      />)
      swipeActions.push(<Button
        key="push"
        title="提交"
        tint="systemGreen"
        action={() => onPush()}
        disabled={busy || mergeInProgress}
      />)
    }
    swipeActions.push(<Button key="delete" title="删除" tint="systemRed" disabled={busy || deleted} action={() => remove(node.path)} />)
    return (
      <Button action={() => open(node.path)} disabled={busy || deleted} frame={{ maxWidth: Infinity, alignment: "leading" }} contextMenu={{ menuItems: <>
        <Button title="复制文件" disabled={busy || deleted} action={() => manage(node.path, "copy")} />
        <Button title="重命名" disabled={busy || deleted} action={() => manage(node.path, "rename")} />
      </> }} trailingSwipeActions={{ allowsFullSwipe: false, actions: swipeActions }}>
        <VStack alignment="leading" spacing={4} frame={{ maxWidth: Infinity, alignment: "leading" }}>
          <HStack alignment="center" spacing={10} frame={{ maxWidth: Infinity, alignment: "leading" }}>
            <Image systemName="doc" foregroundStyle={COLOR_SECONDARY_LABEL} />
            <Text font="body" foregroundStyle={deleted ? COLOR_SECONDARY_LABEL : COLOR_LABEL} lineLimit={1}>{node.name}</Text>
            {badge ? <Text font="caption2" foregroundStyle={badge.color as any}>{badge.text}</Text> : null}
            {deleted ? <Text font="caption2" foregroundStyle={COLOR_SECONDARY_LABEL}>（不可编辑）</Text> : null}
          </HStack>
          {metaParts.length > 0 ? <Text font="caption2" foregroundStyle={COLOR_SECONDARY_LABEL}>{metaParts.join("，")}</Text> : null}
        </VStack>
      </Button>
    )
  }
  return <DisclosureGroup label={<HStack alignment="center" spacing={10}>
    <Image systemName="folder" foregroundStyle={COLOR_ACCENT} /><Text font="body" foregroundStyle={COLOR_LABEL}>{node.name}</Text>
  </HStack>}>
    {node.children.map(child => <FileTreeNodeView key={child.path} node={child} open={open} removed={removed} busy={busy} remove={remove} manage={manage} changesByPath={changesByPath} metadata={metadata} onPush={onPush} onRestore={onRestore} mergeInProgress={mergeInProgress} />)}
  </DisclosureGroup>
}

export function FilesTab({ files, loading, bookmarkName, changes, onWorktreeChanged, onOpen, onPush, onRestore, mergeInProgress }: {
  files: string[]; loading: boolean; bookmarkName: string; changes: FileChange[]
  onOpen: (file: LocalWorktreeFile) => void
  onWorktreeChanged: () => void | Promise<void>
  onPush: () => void | Promise<void>
  onRestore: (filepath: string) => void
  mergeInProgress: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [added, setAdded] = useState<string[]>([])
  const visibleFiles = useMemo(() => [...new Set([...files, ...changes.map(c => c.filepath), ...added])], [files, changes, added])
  const [deleted, setDeleted] = useState<string[]>([])
  const removed = useMemo(() => new Set([...deleted, ...changes.filter(c => c.worktreeDeleted === true).map(c => c.filepath)]), [deleted, changes])
  const changesByPath = useMemo(() => new Map<string, FileChange>(changes.map(c => [c.filepath, c])), [changes])
  const [metadata, setMetadata] = useState<Map<string, { size: number; modified: number }>>(new Map())
  const state = useRef({ alive: true, busy: false })
  useEffect(() => () => { state.current.alive = false }, [])
  useEffect(() => {
    // 外部恢复或撤销删除后，新的改动结果应解除本页的即时删除标记。
    setDeleted(previous => previous.filter(path => changes.some(c => c.filepath === path && c.worktreeDeleted)))
  }, [changes])
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const root = resolveWorkdir(bookmarkName).replace(/\/+$/, "")
        const next = new Map<string, { size: number; modified: number }>()
        await Promise.all(visibleFiles.map(async (path) => {
          if (removed.has(path)) return
          try {
            const absolute = root + "/" + path
            const stat = await FileManager.stat(absolute)
            next.set(path, { size: Number(stat.size ?? 0), modified: Number(stat.modificationDate ?? 0) })
          } catch (_e) {
            // 文件可能刚刚被删除或不可访问，跳过
          }
        }))
        if (!cancelled && state.current.alive) setMetadata(next)
      } catch (e: any) {
        if (state.current.alive) setError("元数据读取失败: " + String(e?.message || e))
      }
    }
    load()
    return () => { cancelled = true }
  }, [bookmarkName, visibleFiles])
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

  // 树只随文件列表或元数据变化重建，避免滑动时反复构建
  const tree = useMemo(() => buildFileTree(visibleFiles, { metadata }), [visibleFiles, metadata])

  return <Section header={<Text>工作区文件{visibleFiles.length > 0 ? `（${visibleFiles.length}）` : ""}</Text>}>
    {error ? <Text foregroundStyle="red">{error}</Text> : null}
    {loading ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>加载中…</Text> : null}
    {visibleFiles.length === 0 && !loading ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>当前工作区没有文件</Text> : tree.map(node => <FileTreeNodeView key={node.path} node={node} open={open} removed={removed} busy={busy || loading || mergeInProgress} remove={remove} manage={manage} changesByPath={changesByPath} metadata={metadata} onPush={onPush} onRestore={onRestore} mergeInProgress={mergeInProgress} />)}
  </Section>
}
