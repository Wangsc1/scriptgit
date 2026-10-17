import { Button, DisclosureGroup, Menu, Spacer, Section, Text, HStack, VStack, Image, useRef, useState, useEffect, useMemo } from "scripting"
import { NameInputSheet } from "../components/NameInputSheet"
import { LocalFileDragSession } from "../utils/localFileDrag"
import { buildFileTree, type FileTreeNode } from "../utils/fileTree"
import { changedDirectoryPaths, expandedFilePaths, readMetadataBatched } from "../utils/fileListPerformance"
import { formatBytes, formatDate } from "../utils/format"
import { resolveWorkdir } from "../services/repoStore"
import { moveLocalWorktreeFile, importLocalWorktreeDirectory, importLocalWorktreeFiles, copyLocalWorktreeDirectory, renameLocalWorktreeDirectory, readLocalWorktreeFile, openLocalWorktreeFile, copyLocalWorktreeFile, renameLocalWorktreeFile, deleteLocalWorktreeDirectory, deleteLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"
import { COLOR_LABEL, COLOR_SECONDARY_LABEL, COLOR_ORANGE } from "../constants/colors"
import { localImportStep, localImportOnMain } from "../services/localImportExecution"
import { pickLocalDirectory, pickLocalDocuments, pickLocalPhotos, type PickedLocalFile } from "../services/localFileImport"
import { localImportBatchSummary } from "../services/localImportBatchSummary"
import type { FileChange } from "../types/git"

function statusBadge(status: FileChange["status"], unstaged?: boolean): { text: string; color: string } | null {
  switch (status) {
    case "added":
    case "*added": return { text: "新增", color: "systemGreen" }
    case "modified":
    case "*modified": return { text: "已修改", color: COLOR_ORANGE }
    case "deleted":
    case "*deleted": return { text: "已删除", color: "systemRed" }
    default:
      if (unstaged) return { text: "已修改", color: COLOR_ORANGE }
      return null
  }
}

const DRAG_CALLBACKS = ["onDrag", "validateDrop", "dropEntered", "dropUpdated", "dropExited", "performDrop"] as const
function newDragCounts(): Record<string, number> { return { onDrag: 0, validateDrop: 0, dropEntered: 0, dropUpdated: 0, dropExited: 0, performDrop: 0 } }

const DROP_ZONE_CALLBACKS = ["dropZone.validate", "dropZone.entered", "dropZone.updated", "dropZone.exited", "dropZone.perform"] as const
interface DropZoneTrace { entries: string[]; counts: Record<string, number>; lastCallback: string; lastDecision: string }
export interface FileDropDiagnosticBridge { current: DropZoneTrace | null }

/** List safe-area sibling, not a list row. Ref-only probe: never load or move payload. */
export function FileDropDiagnosticZone({ bridge }: { bridge: FileDropDiagnosticBridge }) {
  function record(name: string): boolean {
    const trace = bridge.current
    if (!trace) return false
    trace.counts[name] = (trace.counts[name] || 0) + 1
    if (trace.lastCallback !== name) {
      trace.lastCallback = name
      trace.entries = [...trace.entries, `拖动：${name} 入口（仅诊断，不移动）`].slice(-8)
    }
    return true
  }
  return <VStack padding={8} spacing={2} frame={{ maxWidth: "infinity", minHeight: 60 }}
    background="systemGray5" contentShape={{ kind: "interaction", shape: "rect" }}
    onDrop={{
      types: ["public.utf8-plain-text", "public.plain-text"],
      validateDrop: (_info: DropInfo) => record("dropZone.validate"),
      dropEntered: (_info: DropInfo) => { record("dropZone.entered") },
      dropUpdated: (_info: DropInfo) => record("dropZone.updated") ? "copy" : "forbidden",
      dropExited: (_info: DropInfo) => { record("dropZone.exited") },
      performDrop: (_info: DropInfo) => { record("dropZone.perform"); return false },
    }}>
    <Text font="caption">拖放接收区（诊断）</Text>
    <Text font="caption2">拖到这里松手，不移动；再点菜单查看拖动记录</Text>
  </VStack>
}

/** 文件列表：左滑 提交(push)/还原/删除 */
function FileTreeNodeView({ node, dragFile, dropFolder, open, removed, busy, remove, manage, renameHints, addedHints, addedDirectories, deletedDirectories, changesByPath, changedDirectories, expanded, toggleExpanded, metadata, onPush, onRestore, mergeInProgress }: { node: FileTreeNode; dragFile: (path: string) => ItemProvider; dropFolder: (path: string) => any; open: (path: string) => void; removed: Set<string>; busy: boolean; remove: (path: string, directory?: boolean) => void; manage: (path: string, kind: "copy" | "rename", directory?: boolean) => void; renameHints: Set<string>; addedHints: Set<string>; addedDirectories: Set<string>; deletedDirectories: Set<string>; changesByPath: Map<string, FileChange>; changedDirectories: Set<string>; expanded: Set<string>; toggleExpanded: (path: string, value: boolean) => void; metadata: Map<string, { size: number; modified: number }>; onPush: () => void | Promise<void>; onRestore: (filepath: string, filepaths?: string[]) => void; mergeInProgress: boolean }) {
  if (node.type === "file") {
    const deleted = removed.has(node.path)
    const change = changesByPath.get(node.path)
    const badge = deleted ? { text: "已删除", color: "systemRed" } : renameHints.has(node.path) ? { text: "已重命名", color: COLOR_ORANGE } : addedHints.has(node.path) ? { text: "新增", color: "systemGreen" } : change ? statusBadge(change.status, change.unstaged) : null
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
      <Button onDrag={!busy && !deleted && typeof ItemProvider !== "undefined" && typeof ItemProvider.fromText === "function" && typeof UUID !== "undefined" && typeof UUID.string === "function" ? { data: () => dragFile(node.path), preview: <Text>{node.name}</Text> } : undefined} action={() => open(node.path)} disabled={busy || deleted} frame={{ maxWidth: Infinity, alignment: "leading" }} contextMenu={{ menuItems: <>
        <Button title="复制文件" disabled={busy || deleted} action={() => manage(node.path, "copy")} />
        <Button title="重命名" disabled={busy || deleted} action={() => manage(node.path, "rename")} />
      </> }} trailingSwipeActions={{ allowsFullSwipe: false, actions: swipeActions }}>
        <VStack alignment="leading" spacing={4} frame={{ maxWidth: Infinity, alignment: "leading" }}>
          <HStack alignment="center" spacing={10} frame={{ maxWidth: Infinity, alignment: "leading" }}>
            <Image systemName={/\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(node.path) ? "photo" : "doc.text"} foregroundStyle={badge ? badge.color as any : COLOR_SECONDARY_LABEL} />
            <Text font="body" foregroundStyle={deleted ? COLOR_SECONDARY_LABEL : COLOR_LABEL} lineLimit={1}>{node.name}</Text>
            {badge ? <Text font="caption2" foregroundStyle={badge.color as any}>{badge.text}</Text> : null}
          </HStack>
          {metaParts.length > 0 ? <Text font="caption2" foregroundStyle={COLOR_SECONDARY_LABEL}>{metaParts.join("，")}</Text> : null}
        </VStack>
      </Button>
    )
  }
  const hasChanges = changedDirectories.has(node.path)
  const folderBadge = renameHints.has(node.path) ? { text: "已重命名", color: COLOR_ORANGE }
    : deletedDirectories.has(node.path) ? { text: "已删除", color: "systemRed" }
    : addedDirectories.has(node.path) ? { text: "新增", color: "systemGreen" }
    : hasChanges ? { text: "已修改", color: COLOR_ORANGE } : null
  const folderActions: any[] = []
  if (hasChanges) {
    folderActions.push(<Button title="还原" tint="systemOrange" disabled={busy || mergeInProgress} action={() => onRestore(node.path)} />)
    folderActions.push(<Button title="提交" tint="systemGreen" disabled={busy || mergeInProgress} action={() => onPush()} />)
  }
  folderActions.push(<Button title="删除" tint="systemRed" disabled={busy} action={() => remove(node.path, true)} />)
  // Target the full-width visible label, not DisclosureGroup's expandable subtree.
  // Official contentShape interaction/rect: /guide/View%20Modifiers/contentShape.md
  return <DisclosureGroup contextMenu={{ menuItems: <>
    <Button title="复制文件夹" disabled={busy} action={() => manage(node.path, "copy", true)} />
    <Button title="重命名" disabled={busy} action={() => manage(node.path, "rename", true)} />
  </> }} isExpanded={expanded.has(node.path)} onChanged={value => toggleExpanded(node.path, value)} trailingSwipeActions={{ allowsFullSwipe: false, actions: folderActions }} label={<HStack onDrop={!busy && !deletedDirectories.has(node.path) && typeof ItemProvider !== "undefined" && typeof ItemProvider.fromText === "function" && typeof UUID !== "undefined" && typeof UUID.string === "function" ? dropFolder(node.path) : undefined} frame={{ maxWidth: Infinity, alignment: "leading" }} contentShape={{ kind: "interaction", shape: "rect" }} alignment="center" spacing={10}>
    <Image systemName="folder" foregroundStyle={folderBadge ? folderBadge.color as any : COLOR_SECONDARY_LABEL} /><Text font="body" foregroundStyle={COLOR_LABEL}>{node.name}</Text>
    {folderBadge ? <Text font="caption2" foregroundStyle={folderBadge.color as any}>{folderBadge.text}</Text> : null}
  </HStack>}>
    {expanded.has(node.path) ? node.children.map(child => <FileTreeNodeView key={child.path} node={child} dragFile={dragFile} dropFolder={dropFolder} open={open} removed={removed} busy={busy} remove={remove} manage={manage} renameHints={renameHints} addedHints={addedHints} addedDirectories={addedDirectories} deletedDirectories={deletedDirectories} changesByPath={changesByPath} changedDirectories={changedDirectories} expanded={expanded} toggleExpanded={toggleExpanded} metadata={metadata} onPush={onPush} onRestore={onRestore} mergeInProgress={mergeInProgress} />) : null}
  </DisclosureGroup>
}

export function FilesTab({ files, loading, bookmarkName, changes, onWorktreeChanged, onOpen, onPush, onRestore, mergeInProgress, creationActive = false, onCreateEntry, dropDiagnosticBridge }: {
  dropDiagnosticBridge?: FileDropDiagnosticBridge
  files: string[]; loading: boolean; bookmarkName: string; changes: FileChange[]
  onOpen: (file: LocalWorktreeFile) => void
  onWorktreeChanged: () => void | Promise<void>
  onPush: () => void | Promise<void>
  onRestore: (filepath: string, filepaths?: string[]) => void
  mergeInProgress: boolean
  creationActive?: boolean
  onCreateEntry: (directory: boolean, onCreated: (path: string) => void) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  function toggleExpanded(path: string, value: boolean) {
    setExpanded(previous => {
      const next = new Set(previous)
      if (value) next.add(path)
      else next.delete(path)
      return next
    })
  }
  const changedDirectories = useMemo(() => changedDirectoryPaths(changes.map(change => change.filepath)), [changes])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [dragStatus, setDragStatus] = useState("")
  // Ref-only bounded trace: native drag callbacks never set state or dispatch UI work for diagnostics.
  const dragTrace = useRef({ entries: [] as string[], counts: newDragCounts(), lastCallback: "", lastDecision: "" })
  useEffect(() => {
    if (!dropDiagnosticBridge) return
    dropDiagnosticBridge.current = dragTrace.current
    return () => { if (dropDiagnosticBridge.current === dragTrace.current) dropDiagnosticBridge.current = null }
  }, [dropDiagnosticBridge])
  const [renamedFiles, setRenamedFiles] = useState<{ path: string; before: FileChange[]; directory?: boolean }[]>([])
  const hasRenameChange = (entry: { path: string; directory?: boolean }) => changes.some(c =>
    !c.worktreeDeleted && (entry.directory ? c.filepath.startsWith(entry.path + "/") : c.filepath === entry.path))
  // 即时提示仅覆盖尚未刷新或仍有真实工作区改动的新目标；不伪造 Git rename 状态。
  const renameHints = useMemo(() => new Set(renamedFiles.filter(entry => entry.before === changes || hasRenameChange(entry)).map(entry => entry.path)), [renamedFiles, changes])
  useEffect(() => {
    setRenamedFiles(previous => previous.filter(hasRenameChange))
  }, [changes])
  // A newly created empty directory has no Git row. Keep its badge for this session.
  const [sessionCreatedDirectories, setSessionCreatedDirectories] = useState<string[]>([])
  const [copied, setCopied] = useState<{ path: string; before: FileChange[]; directory?: boolean }[]>([])
  const hasAddedChange = (entry: { path: string; directory?: boolean }) => changes.some(c =>
    !c.worktreeDeleted && (c.status === "added" || c.status === "*added") &&
    (entry.directory ? c.filepath.startsWith(entry.path + "/") : c.filepath === entry.path))
  const activeCopies = useMemo(() => copied.filter(entry => entry.before === changes || hasAddedChange(entry)), [copied, changes])
  useEffect(() => { setCopied(previous => previous.filter(hasAddedChange)) }, [changes])
  const addedHints = useMemo(() => new Set(activeCopies.filter(entry => !entry.directory).map(entry => entry.path)), [activeCopies])
  const addedDirectories = useMemo(() => {
    // files is the existing HEAD list from getTrackedFiles: no additional Git/disk scan.
    const existing = changedDirectoryPaths(files)
    const added = changedDirectoryPaths(changes.filter(c => !c.worktreeDeleted && (c.status === "added" || c.status === "*added")).map(c => c.filepath))
    const other = changedDirectoryPaths(changes.filter(c => c.worktreeDeleted || (c.status !== "added" && c.status !== "*added")).map(c => c.filepath))
    for (const entry of activeCopies) if (entry.directory) added.add(entry.path)
    for (const path of sessionCreatedDirectories) added.add(path)
    return new Set([...added].filter(path => !existing.has(path) && !other.has(path)))
  }, [files, changes, activeCopies, sessionCreatedDirectories])
  const [added, setAdded] = useState<string[]>([])
  const fileSignature = [...new Set([...files, ...changes.map(c => c.filepath), ...added])].join("\0")
  const visibleFiles = useMemo(() => fileSignature ? fileSignature.split("\0") : [], [fileSignature])
  const [directories, setDirectories] = useState<string[]>([])
  const tree = useMemo(() => buildFileTree(visibleFiles, { directories }), [visibleFiles, directories])
  const metadataPaths = useMemo(() => expandedFilePaths(tree, expanded), [tree, expanded])
  const [deleted, setDeleted] = useState<string[]>([])
  const removed = useMemo(() => new Set([...deleted, ...changes.filter(c => c.worktreeDeleted === true).map(c => c.filepath)]), [deleted, changes])
  const deletedDirectories = useMemo(() => {
    // A missing child alone does not delete its parent: every visible descendant must be absent.
    const missing = changedDirectoryPaths(visibleFiles.filter(path => removed.has(path)))
    const remaining = changedDirectoryPaths(visibleFiles.filter(path => !removed.has(path)))
    return new Set([...missing].filter(path => !remaining.has(path)))
  }, [visibleFiles, removed])
  const changesByPath = useMemo(() => new Map<string, FileChange>(changes.map(c => [c.filepath, c])), [changes])
  const [metadata, setMetadata] = useState<Map<string, { size: number; modified: number }>>(new Map())
  const state = useRef({ alive: true, busy: false, context: { bookmarkName, loading, mergeInProgress, creationActive } })
  state.current.context = { bookmarkName, loading, mergeInProgress, creationActive }
  function checkQueuedWrite() {
    const current = state.current.context
    if (!state.current.alive || current.bookmarkName !== bookmarkName || current.loading || current.mergeInProgress || current.creationActive) throw new Error("页面或工作区状态已变化，未开始写入")
  }
  useEffect(() => () => { state.current.alive = false }, [])
  useEffect(() => {
    // 外部恢复或撤销删除后，新的改动结果应解除本页的即时删除标记。
    setDeleted(previous => {
      const next = previous.filter(path => changes.some(c => c.filepath === path && c.worktreeDeleted))
      return next.length === previous.length ? previous : next
    })
  }, [changes])
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const root = resolveWorkdir(bookmarkName).replace(/\/+$/, "")
        const next = await readMetadataBatched(metadataPaths.filter(path => !removed.has(path)), async path => {
          const stat = await FileManager.stat(root + "/" + path)
          return { size: Number(stat.size ?? 0), modified: Number(stat.modificationDate ?? 0) }
        }, () => cancelled || !state.current.alive)
        if (!cancelled && state.current.alive) await localImportOnMain("UI元数据结果", () => { if (!cancelled && state.current.alive) setMetadata(next) })
      } catch (e: any) {
        if (!cancelled && state.current.alive) await localImportOnMain("UI元数据错误", () => { if (!cancelled && state.current.alive) setError("元数据读取失败: " + String(e?.message || e)) })
      }
    }
    void load().catch(error => console.error(error))
    return () => { cancelled = true }
  }, [bookmarkName, metadataPaths, changes, removed])
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
  async function remove(path: string, directory = false) {
    if (state.current.busy || removed.has(path)) return
    state.current.busy = true; setBusy(true); setError("")
    try {
      if (directory) {
        if (await Dialog.confirm({ title: "删除此本地文件夹？", message: `${path}\n将删除此文件夹及其全部内容（含未跟踪文件），不可撤销；不会自动暂存、提交或推送。`, confirmLabel: "删除文件夹" }) !== true || !state.current.alive) return
        await deleteLocalWorktreeDirectory(bookmarkName, path)
        if (state.current.alive) {
          setDeleted(previous => [...previous, ...visibleFiles.filter(p => p.startsWith(path + "/"))])
          setAdded(previous => previous.filter(p => !p.startsWith(path + "/")))
          setDirectories(previous => previous.filter(p => p !== path && !p.startsWith(path + "/")))
          setSessionCreatedDirectories(previous => previous.filter(p => p !== path && !p.startsWith(path + "/")))
        }
        await onWorktreeChanged()
        return
      }
      const file = await readLocalWorktreeFile(bookmarkName, path)
      if (!state.current.alive) return
      if (await Dialog.confirm({ title: "删除此本地文件？", message: `${path}\n只删除当前工作区这个文件，不删除目录，也不会暂存、提交或推送。`, confirmLabel: "删除文件" }) !== true || !state.current.alive) return
      await deleteLocalWorktreeFile(bookmarkName, file)
      await changed(path, true)
    } catch (e: any) { if (state.current.alive) setError(String(e?.message || e)) }
    finally { state.current.busy = false; if (state.current.alive) setBusy(false) }
  }
  function restore(path: string) {
    if (state.current.busy || mergeInProgress) return
    const targets = changes.filter(change => change.filepath.startsWith(path + "/"))
    // 单文件和目录均交由详情页同一个 alert 展示，保持文案、按钮颜色及确认行为一致。
    onRestore(path, targets.length ? targets.map(change => change.filepath) : undefined)
  }
  const [directoryForm, setDirectoryForm] = useState<{ path: string; kind: "copy" | "rename" } | null>(null)
  const [directoryError, setDirectoryError] = useState("")
  function cancelDirectoryForm() { if (!state.current.busy) setDirectoryForm(null) }
  async function confirmDirectory(next: string) {
    if (!directoryForm || state.current.busy || mergeInProgress) return
    const { path, kind } = directoryForm
    if (kind === "rename" && next === path.split("/").pop()) { setDirectoryForm(null); return }
    state.current.busy = true; setBusy(true); setDirectoryError("")
    try {
      const result = await (kind === "copy" ? copyLocalWorktreeDirectory : renameLocalWorktreeDirectory)(bookmarkName, path, next)
      if (state.current.alive) {
        setAdded(previous => [...previous.filter(p => kind !== "rename" || !p.startsWith(path + "/")), ...result.files])
        setDirectories(previous => [...previous.filter(p => kind !== "rename" || (p !== path && !p.startsWith(path + "/"))), ...result.directories])
        if (kind === "rename") {
          setSessionCreatedDirectories(previous => previous.map(p => p === path || p.startsWith(path + "/") ? result.path + p.slice(path.length) : p))
          setDeleted(previous => [...previous, ...visibleFiles.filter(p => p.startsWith(path + "/"))])
          const targets = new Set([result.path, ...result.directories, ...result.files])
          setRenamedFiles(previous => [
            ...previous.filter(entry => entry.path !== path && !entry.path.startsWith(path + "/") && !targets.has(entry.path)),
            ...[...new Set([result.path, ...result.directories])].map(target => ({ path: target, before: changes, directory: true })),
            ...result.files.map(target => ({ path: target, before: changes })),
          ])
        }
        if (kind === "copy") setCopied(previous => [...previous,
          ...[...new Set([result.path, ...result.directories])].map(target => ({ path: target, before: changes, directory: true })),
          ...result.files.map(target => ({ path: target, before: changes })),
        ])
        setDirectoryForm(null)
      }
      await onWorktreeChanged()
    } catch (e: any) {
      if (state.current.alive) { setDirectoryError(String(e?.message || e)); setError(String(e?.message || e)) }
      // 部分复制也可能产生改动，刷新但绝不清理原件/目标。
      try { await onWorktreeChanged() } catch (_e) { /* 保留原始错误 */ }
    } finally { state.current.busy = false; if (state.current.alive) setBusy(false) }
  }
  async function manage(path: string, kind: "copy" | "rename", directory = false) {
    if (directory) {
      if (state.current.busy || mergeInProgress) return
      setDirectoryError(""); setDirectoryForm({ path, kind }); return
    }
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
      if (state.current.alive) {
        setAdded(previous => [...previous.filter(p => kind !== "rename" || p !== path), target])
        if (kind === "copy") setCopied(previous => [...previous, { path: target, before: changes }])
        if (kind === "rename") setRenamedFiles(previous => [...previous.filter(entry => entry.path !== path && entry.path !== target), { path: target, before: changes }])
      }
      await changed(path, kind === "rename")
    } catch (e: any) { if (state.current.alive) setError(String(e?.message || e)) }
    finally { state.current.busy = false; if (state.current.alive) setBusy(false) }
  }

  function startCreation(directory: boolean) {
    if (state.current.busy || loading || mergeInProgress || creationActive) return
    // The stable parent List owns the presentation and operation lifecycle.
    onCreateEntry(directory, path => showAddition(path, directory))
  }
  function showAddition(path: string, directory: boolean) {
    if (!state.current.alive) return
    if (directory) {
      setDirectories(previous => [...new Set([...previous, path])])
      setSessionCreatedDirectories(previous => [...new Set([...previous, path])])
    }
    else setAdded(previous => [...new Set([...previous, path])])
    setDeleted(previous => previous.filter(value => value !== path))
    setRenamedFiles(previous => previous.filter(entry => entry.path !== path))
    setCopied(previous => [...previous.filter(entry => entry.path !== path), { path, before: changes, directory }])
  }
  const dragSession = useRef(new LocalFileDragSession())
  // Repo switches, merge/other operations and unmount invalidate any old capability.
  useEffect(() => { dragSession.current.clear(); return () => dragSession.current.clear() }, [bookmarkName, loading, mergeInProgress, creationActive])
  function dragUnavailable() { return !state.current.alive || state.current.busy || loading || mergeInProgress || creationActive || directoryForm !== null }
  // Bounded diagnostic trace only: never let rendering/dispatch failure change
  // the synchronous native callback result or defer provider loading.
  function reportDrag(message: string) {
    try {
      const trace = dragTrace.current
      if (!state.current.alive || trace.entries[trace.entries.length - 1] === message) return
      trace.entries = [...trace.entries, message].slice(-8)
    } catch (_) { /* Diagnostic failure must not affect drag/drop. */ }
  }
  function dragLogSnapshot(): string {
    const trace = dragTrace.current
    const counts = [...DRAG_CALLBACKS, ...DROP_ZONE_CALLBACKS].map(name => `${name}=${trace.counts[name] || 0}`).join(" ")
    return `拖动记录（查看时快照）：回调计数 ${counts}` + (trace.entries.length ? "\n" + trace.entries.join("\n") : "\n尚无拖动记录")
  }
  // Counts every native entry; only distinct consecutive callbacks add a trace line.
  function enterDropCallback(name: string): boolean {
    const trace = dragTrace.current
    trace.counts[name] = (trace.counts[name] || 0) + 1
    if (trace.lastCallback === name) return false
    trace.lastCallback = name
    reportDrag(`拖动：${name} 入口`)
    return true
  }
  function dragFile(path: string): ItemProvider {
    dragTrace.current.entries = []
    dragTrace.current.counts = newDragCounts()
    dragTrace.current.counts.onDrag = 1
    dragTrace.current.lastCallback = ""
    dragTrace.current.lastDecision = ""
    dragSession.current.clear()
    try {
      if (dragUnavailable() || removed.has(path)) { reportDrag("拖动：当前不可拖动（忙碌、加载、合并或表单占用）"); return ItemProvider.fromText("") }
      const root = resolveWorkdir(bookmarkName).replace(/\/+$/, "")
      const provider = ItemProvider.fromText(dragSession.current.begin(bookmarkName, root, path))
      let types = "未报告"
      try { types = provider.registeredTypes?.join(", ") || "未报告" } catch (_) { /* Diagnostics cannot change a successful drag. */ }
      reportDrag(`拖动：已开始；源类型=${types}`)
      return provider
    } catch (e: any) {
      reportDrag(`拖动：开始异常：${String(e?.message || e)}`)
      return ItemProvider.fromText("")
    }
  }
  // Official API: https://scriptingapp.github.io/guide/View%20Modifiers/onDrag%20and%20onDrop%20View%20Modifiers.md
  // The published page gives no minimum app/iOS version; real gesture support
  // (including coexistence with contextMenu) must be checked on the device.
  function dropFolder(directory: string) {
    // Device evidence: fromText advertises public.utf8-plain-text + public.url.
    // Include the exact text UTI without relying on bridge subtype matching;
    // URL representations are never accepted as workspace paths.
    const types = ["public.utf8-plain-text", "public.plain-text"]
    const accepts = (info: DropInfo, callback: string, record: boolean) => {
      let reason: string
      try {
        reason = dragUnavailable() ? "忙碌、合并或表单占用" : deletedDirectories.has(directory) ? "目标目录已删除" :
          !dragSession.current.eligible(bookmarkName, directory) ? "会话无效、过期、仓库变化或文件已在此目录" :
          !info.hasItemsConforming(types) ? "文本类型不匹配" : "可接收，松手后移动"
      } catch (error: any) {
        const message = `拖动：${callback}.hasItemsConforming 异常：${String(error?.message || error)}`
        if (record || dragTrace.current.lastDecision !== message) reportDrag(message)
        dragTrace.current.lastDecision = message
        return false
      }
      const message = `拖动：${callback} → ${reason}`
      if (record || dragTrace.current.lastDecision !== message) reportDrag(message)
      dragTrace.current.lastDecision = message
      return reason === "可接收，松手后移动"
    }
    return {
      types,
      validateDrop: (info: DropInfo) => accepts(info, "validateDrop", enterDropCallback("validateDrop")),
      dropUpdated: (info: DropInfo) => accepts(info, "dropUpdated", enterDropCallback("dropUpdated")) ? "move" : "forbidden",
      dropEntered: (info: DropInfo) => { accepts(info, "dropEntered", enterDropCallback("dropEntered")) },
      dropExited: (_info: DropInfo) => { enterDropCallback("dropExited") },
      performDrop(info: DropInfo): boolean {
        const record = enterDropCallback("performDrop")
        if (!accepts(info, "performDrop", record)) return false
        let stage = "performDrop.itemProviders"
        try {
          const providers = info.itemProviders(types)
          reportDrag(`拖动：performDrop.itemProviders 返回${providers.length}项`)
          if (providers.length !== 1) { dragSession.current.clear(); return false }
          // Mandatory official lifetime rule: start loading NOW, before returning.
          stage = "performDrop.loadText"
          const text = providers[0].loadText()
          reportDrag("拖动：performDrop.loadText 已启动")
          state.current.busy = true
          void finishDrop(text, directory).catch(error => console.error(error))
          return true
        } catch (e: any) {
          reportDrag(`拖动：${stage} 异常：${String(e?.message || e)}`)
          dragSession.current.clear(); state.current.busy = false
          return false
        }
      },
    }
  }
  async function finishDrop(text: Promise<string | null>, directory: string) {
    // Observe native load rejection immediately, even if UI dispatch is delayed.
    const loaded = text.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
    let enteredWrite = false
    try {
      await localImportOnMain("拖动UI开始", () => { if (state.current.alive) { setBusy(true); setError("") } })
      const result = await loaded
      if (result.ok === false) throw result.error
      const payload = result.value
      reportDrag("拖动：loadText完成，正在校验内部会话")
      if (!state.current.alive) return
      const root = await localImportStep("拖动工作区授权", () => resolveWorkdir(bookmarkName).replace(/\/+$/, ""))
      const drag = dragSession.current.consume(payload, bookmarkName, root, directory)
      if (!drag) throw new Error("仅允许本页当前工作区的有效文件拖动；外来或过期内容未移动")
      if (!state.current.alive || mergeInProgress || creationActive) return
      const target = await localImportStep("拖动移动/协调锁", () => { checkQueuedWrite(); enteredWrite = true; reportDrag("拖动：校验通过，正在执行移动"); return moveLocalWorktreeFile(bookmarkName, drag.path, directory, drag.root) })
      await localImportOnMain("拖动UI结果", () => {
        if (!state.current.alive) return
        setAdded(previous => [...previous.filter(path => path !== drag.path), target])
        setDeleted(previous => [...previous.filter(path => path !== target), drag.path])
        setRenamedFiles(previous => [...previous.filter(entry => entry.path !== drag.path && entry.path !== target), { path: target, before: changes }])
        setCopied(previous => previous.filter(entry => entry.path !== drag.path && entry.path !== target))
      })
      await localImportStep("拖动刷新改动", () => onWorktreeChanged())
      reportDrag("拖动：移动成功，已刷新工作区")
    } catch (e: any) {
      let message = String(e?.message || e)
      reportDrag(enteredWrite ? "拖动：移动或刷新失败，详见错误" : "拖动：未进入写入，详见错误")
      if (enteredWrite) {
        try { await localImportStep("拖动失败后刷新", () => onWorktreeChanged()) }
        catch (refreshError: any) { message += "\n" + String(refreshError?.message || refreshError) }
      }
      await localImportOnMain("拖动错误结果", () => { if (state.current.alive) setError(message) })
    } finally {
      dragSession.current.clear(); state.current.busy = false
      await localImportOnMain("拖动UI收尾", () => { if (state.current.alive) setBusy(false) })
    }
  }

  async function importSelection(kind: "document" | "import-directory" | "photo") {
    if (state.current.busy || loading || mergeInProgress) return
    state.current.busy = true
    let picked: PickedLocalFile | null = null
    let enteredWrite = false
    let failure = ""
    try {
      await localImportOnMain("UI开始", () => { if (state.current.alive) { setBusy(true); setError("") } })
      const expectedRoot = await localImportStep("工作区授权", () => resolveWorkdir(bookmarkName).replace(/\/+$/, ""))
      if (!state.current.alive) return
      if (kind !== "import-directory") {
        const sources = await (kind === "photo" ? pickLocalPhotos() : pickLocalDocuments())
        if (!sources.length || !state.current.alive) return
        const result = await localImportStep("批量文件写入/协调锁", () => {
          checkQueuedWrite()
          return importLocalWorktreeFiles(bookmarkName, sources, expectedRoot, checkQueuedWrite)
        })
        await localImportOnMain("UI批量结果", () => {
          if (!state.current.alive || state.current.context.bookmarkName !== bookmarkName) return
          const paths = result.entries.filter(entry => entry.status === "success" && entry.path).map(entry => entry.path!)
          setAdded(previous => [...new Set([...previous, ...paths])])
          setDeleted(previous => previous.filter(path => !paths.includes(path)))
          setRenamedFiles(previous => previous.filter(entry => !paths.includes(entry.path)))
          setCopied(previous => [...previous.filter(entry => !paths.includes(entry.path)), ...paths.map(path => ({ path, before: changes }))])
          const failure = localImportBatchSummary(result)
          if (failure) setError(failure)
        })
        // Exactly one requested refresh for the whole batch, including partial
        // writes; refresh failure must never trigger a second copy or scan.
        enteredWrite = false
        if (result.writeAttempted) await localImportStep("批量刷新改动", () => onWorktreeChanged())
        return
      }
      picked = await pickLocalDirectory()
      if (!picked || !state.current.alive) return
      if (kind === "import-directory") {
        const result = await localImportStep("目录写入/协调锁", () => { checkQueuedWrite(); enteredWrite = true; return importLocalWorktreeDirectory(bookmarkName, picked!.sourcePath, expectedRoot) })
        await localImportOnMain("UI目录结果", () => {
          if (!state.current.alive) return
          setAdded(previous => [...new Set([...previous, ...result.files])])
          setDirectories(previous => [...new Set([...previous, ...result.directories])])
          setCopied(previous => [...previous,
            ...result.directories.map(path => ({ path, before: changes, directory: true })),
            ...result.files.map(path => ({ path, before: changes })),
          ])
        })
      }
      await localImportStep("刷新改动", () => onWorktreeChanged())
    } catch (e: any) {
      failure = String(e?.message || e)
      if (enteredWrite) {
        try { await localImportStep("失败后刷新", () => onWorktreeChanged()) }
        catch (refreshError: any) { failure += "\n" + String(refreshError?.message || refreshError) }
      }
    } finally {
      if (picked) {
        try { await localImportStep("释放临时资源", () => picked!.release()) }
        catch (cleanupError: any) { failure += (failure ? "\n" : "") + String(cleanupError?.message || cleanupError) }
      }
      state.current.busy = false
      await localImportOnMain("UI收尾", () => {
        if (!state.current.alive) return
        if (failure) setError(failure)
        setBusy(false)
      })
    }
  }

  // Keep Menu actions lightweight: record an intent, then hand off after commit.
  // This boundary alone does not establish the cause of a native crash.
  // No Timer/Promise-delay masquerading as a main-JS-queue dispatcher.
  type AdditionKind = "file" | "directory" | "document" | "import-directory" | "photo" | "drag-log"
  const [additionRequest, setAdditionRequest] = useState<{ kind: AdditionKind; bookmarkName: string } | null>(null)
  const additionPending = useRef(false)
  function requestAddition(kind: AdditionKind) {
    if (kind === "drag-log") {
      if (state.current.alive && !additionPending.current) { additionPending.current = true; setAdditionRequest({ kind, bookmarkName }) }
      return
    }
    if (!state.current.alive || state.current.busy || additionPending.current || loading || mergeInProgress || creationActive || directoryForm) return
    additionPending.current = true
    setAdditionRequest({ kind, bookmarkName })
  }
  useEffect(() => {
    if (additionRequest === null) return
    additionPending.current = false
    if (!state.current.alive) return
    setAdditionRequest(null)
    if (additionRequest.kind === "drag-log") { setDragStatus(dragLogSnapshot()); return }
    if (additionRequest.bookmarkName !== bookmarkName || state.current.busy || loading || mergeInProgress || creationActive || directoryForm) return
    const kind = additionRequest.kind
    if (kind === "file" || kind === "directory") startCreation(kind === "directory")
    else void importSelection(kind).catch(error => console.error(error))
  }, [additionRequest])
  const additionDisabled = busy || loading || mergeInProgress || additionRequest !== null || creationActive || directoryForm !== null

  // 元数据只更新行文案，不再触发整棵目录树的重建和排序。

  return <Section sheet={{
    isPresented: directoryForm !== null,
    onChanged: (presented: boolean) => { if (!presented) cancelDirectoryForm() },
    content: directoryForm ? <NameInputSheet key={`${directoryForm.kind}-${directoryForm.path}`} title={directoryForm.kind === "copy" ? "复制文件夹到当前目录" : "重命名文件夹"} initialName={(directoryForm.path.split("/").pop() || "") + (directoryForm.kind === "copy" ? " 副本" : "")} message="包含全部子目录内容；仅修改本地工作区，不覆盖同名目标，不暂存、提交或推送。" busy={busy} error={directoryError} onCancel={cancelDirectoryForm} onConfirm={confirmDirectory} /> : <Text />,
  }} header={<HStack frame={{ maxWidth: Infinity }}>
    <Text>工作区文件{visibleFiles.length > 0 ? `（${visibleFiles.length}）` : ""}</Text><Spacer />
    <Menu label={<Image systemName="plus" />} disabled={additionDisabled}>
      <Section header={<Text>添加到仓库</Text>}>
        <Button title="创建文件" systemImage="doc.text" disabled={additionDisabled} action={() => requestAddition("file")} />
        <Button title="创建目录" systemImage="folder" disabled={additionDisabled} action={() => requestAddition("directory")} />
      </Section>
      <Section>
        <Button title="导入文件" systemImage="doc.text" disabled={additionDisabled} action={() => requestAddition("document")} />
        <Button title="导入目录" systemImage="folder" disabled={additionDisabled} action={() => requestAddition("import-directory")} />
        <Button title="导入图片" systemImage="photo" disabled={additionDisabled} action={() => requestAddition("photo")} />
      </Section>
      <Section header={<Text>仅诊断，不改仓库</Text>}>
        <Button title="查看拖动记录" systemImage="list.bullet.rectangle" disabled={additionDisabled} action={() => requestAddition("drag-log")} />
      </Section>
    </Menu>
  </HStack>}>
    {error ? <Text foregroundStyle="red">{error}</Text> : null}
    {dragStatus ? <Text font="caption2" foregroundStyle={COLOR_SECONDARY_LABEL}>{dragStatus}</Text> : null}
    {loading ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>加载中…</Text> : null}
    {tree.length === 0 && !loading ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>当前工作区没有文件</Text> : tree.map(node => <FileTreeNodeView key={node.path} node={node} dragFile={dragFile} dropFolder={dropFolder} open={open} removed={removed} busy={busy || loading || mergeInProgress || creationActive} remove={remove} manage={manage} renameHints={renameHints} addedHints={addedHints} addedDirectories={addedDirectories} deletedDirectories={deletedDirectories} changesByPath={changesByPath} changedDirectories={changedDirectories} expanded={expanded} toggleExpanded={toggleExpanded} metadata={metadata} onPush={onPush} onRestore={restore} mergeInProgress={mergeInProgress} />)}
  </Section>
}
