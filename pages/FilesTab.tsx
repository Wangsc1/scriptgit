import { useModalBackGuard } from "../hooks/useEdgeBack"
import { Button, DisclosureGroup, Menu, Spacer, Section, Text, HStack, VStack, Image, useRef, useState, useEffect, useMemo } from "scripting"
import { NameInputSheet } from "../components/NameInputSheet"
import { buildFileTree, type FileTreeNode } from "../utils/fileTree"
import { changedDirectoryPaths, expandedFilePaths, readMetadataBatched } from "../utils/fileListPerformance"
import { formatBytes, formatDate } from "../utils/format"
import { resolveWorkdir } from "../services/repoStore"
import { knownLocalRenameHints, moveLocalWorktreeFile, importLocalWorktreeDirectory, importLocalWorktreeFiles, copyLocalWorktreeDirectory, renameLocalWorktreeDirectory, readLocalWorktreeFile, openLocalWorktreeFile, copyLocalWorktreeFile, renameLocalWorktreeFile, deleteLocalWorktreeDirectory, deleteLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"
import { COLOR_LABEL, COLOR_SECONDARY_LABEL, COLOR_ORANGE, COLOR_PURPLE } from "../constants/colors"
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


/** 文件列表：左滑 提交(push)/还原/删除 */
function FileTreeNodeView({ node, copyLink, moveTo, open, removed, busy, remove, manage, displayChanges, renameHints, addedHints, addedDirectories, directoryRestorePaths, deletedDirectories, changesByPath, changedDirectories, expanded, toggleExpanded, metadata, onPush, onStage, onRestore, mergeInProgress }: { node: FileTreeNode; copyLink?: (path: string) => void | Promise<void>; moveTo: (path: string) => void; open: (path: string) => void; removed: Set<string>; busy: boolean; remove: (path: string, directory?: boolean) => void; manage: (path: string, kind: "copy" | "rename", directory?: boolean) => void; displayChanges: Map<string, FileChange>; renameHints: Set<string>; addedHints: Set<string>; addedDirectories: Set<string>; directoryRestorePaths: Set<string>; deletedDirectories: Set<string>; changesByPath: Map<string, FileChange>; changedDirectories: Set<string>; expanded: Set<string>; toggleExpanded: (path: string, value: boolean) => void; metadata: Map<string, { size: number; modified: number }>; onPush: () => void | Promise<void>; onStage: (filepaths: string[]) => void | Promise<void>; onRestore: (filepath: string, filepaths?: string[], directory?: boolean) => void; mergeInProgress: boolean }) {
  if (node.type === "file") {
    const deleted = removed.has(node.path)
    const change = changesByPath.get(node.path)
    const displayChange = displayChanges.get(node.path)
    const badge = deleted ? { text: "已删除", color: "systemRed" } : renameHints.has(node.path) ? { text: "已重命名", color: COLOR_ORANGE } : addedHints.has(node.path) ? { text: "新增", color: "systemGreen" } : displayChange ? statusBadge(displayChange.status, displayChange.unstaged) : null
    const meta = metadata.get(node.path)
    const metaParts: string[] = []
    if (meta && meta.size != null) metaParts.push(formatBytes(meta.size))
    if (meta && meta.modified != null) metaParts.push(formatDate(meta.modified))
    // trailing 从右向左展开；声明 推送 / 还原 / 暂存 / 删除，视觉顺序相反。
    const swipeActions: any[] = []
    if (change && !deleted) {
      swipeActions.push(<Button
        key="push"
        title="推送"
        tint="systemGreen"
        action={() => onPush()}
        disabled={busy || mergeInProgress}
      />)
      swipeActions.push(<Button
        key="restore"
        title="还原"
        tint="systemOrange"
        action={() => onRestore(node.path)}
        disabled={busy || mergeInProgress}
      />)
      swipeActions.push(<Button
        key="stage"
        title="暂存"
        tint={COLOR_PURPLE}
        action={() => onStage([node.path])}
        disabled={busy || mergeInProgress}
      />)
    }
    swipeActions.push(<Button key="delete" title="删除" tint="systemRed" disabled={busy || deleted} action={() => remove(node.path)} />)
    return (
      <Button action={() => open(node.path)} disabled={busy || deleted} frame={{ maxWidth: Infinity, alignment: "leading" }} contextMenu={{ menuItems: <>
        <Button title="重命名" disabled={busy || deleted} action={() => manage(node.path, "rename")} />
        <Button title="复制文件" disabled={busy || deleted} action={() => manage(node.path, "copy")} />
        <Button title="复制链接" disabled={busy || deleted || !copyLink} action={() => copyLink?.(node.path)} />
        <Button title="移动到…" disabled={busy || deleted} action={() => moveTo(node.path)} />
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
  // 文件夹「暂存」：将其下所有改动路径保存到 Stash。
  const changesUnder = (directory: string) => [...changesByPath.keys()].filter(path => path.startsWith(directory + "/"))
  const hasChanges = [...changesByPath.keys()].some(path => path.startsWith(node.path + "/"))
  const folderBadge = renameHints.has(node.path) ? { text: "已重命名", color: COLOR_ORANGE }
    : deletedDirectories.has(node.path) ? { text: "已删除", color: "systemRed" }
    : addedDirectories.has(node.path) ? { text: "新增", color: "systemGreen" }
    : changedDirectories.has(node.path) ? { text: "已修改", color: COLOR_ORANGE } : null
  const folderActions: any[] = []
  const hasNewDirectories = directoryRestorePaths.has(node.path)
  if (hasChanges) folderActions.push(<Button title="推送" tint="systemGreen" disabled={busy || mergeInProgress} action={() => onPush()} />)
  if (hasChanges || hasNewDirectories) folderActions.push(<Button title="还原" tint="systemOrange" disabled={busy || mergeInProgress} action={() => onRestore(node.path, undefined, true)} />)
  if (hasChanges) folderActions.push(<Button title="暂存" tint={COLOR_PURPLE} disabled={busy || mergeInProgress} action={() => onStage(changesUnder(node.path))} />)
  folderActions.push(<Button title="删除" tint="systemRed" disabled={busy} action={() => remove(node.path, true)} />)
  // Scope swipe actions to the folder label; attaching to DisclosureGroup also decorates descendant rows.
  // Target the full-width visible label, not DisclosureGroup's expandable subtree.
  // Official contentShape interaction/rect: /guide/View%20Modifiers/contentShape.md
  return <DisclosureGroup contextMenu={{ menuItems: <>
    <Button title="重命名" disabled={busy} action={() => manage(node.path, "rename", true)} />
    <Button title="复制文件夹" disabled={busy} action={() => manage(node.path, "copy", true)} />
  </> }} isExpanded={expanded.has(node.path)} onChanged={value => toggleExpanded(node.path, value)} label={<HStack trailingSwipeActions={{ allowsFullSwipe: false, actions: folderActions }} frame={{ maxWidth: Infinity, alignment: "leading" }} contentShape={{ kind: "interaction", shape: "rect" }} alignment="center" spacing={10}>
    <Image systemName="folder" foregroundStyle={folderBadge ? folderBadge.color as any : COLOR_SECONDARY_LABEL} /><Text font="body" foregroundStyle={COLOR_LABEL}>{node.name}</Text>
    {folderBadge ? <Text font="caption2" foregroundStyle={folderBadge.color as any}>{folderBadge.text}</Text> : null}
  </HStack>}>
    {expanded.has(node.path) ? node.children.map(child => <FileTreeNodeView key={child.path} node={child} copyLink={copyLink} moveTo={moveTo} open={open} removed={removed} busy={busy} remove={remove} manage={manage} displayChanges={displayChanges} renameHints={renameHints} addedHints={addedHints} addedDirectories={addedDirectories} directoryRestorePaths={directoryRestorePaths} deletedDirectories={deletedDirectories} changesByPath={changesByPath} changedDirectories={changedDirectories} expanded={expanded} toggleExpanded={toggleExpanded} metadata={metadata} onPush={onPush} onStage={onStage} onRestore={onRestore} mergeInProgress={mergeInProgress} />) : null}
  </DisclosureGroup>
}

export function FilesTab({ files, worktreeEntries, loading, bookmarkName, changes, onWorktreeChanged, onOpen, onPush, onStage, onRestore, mergeInProgress, creationActive = false, onCreateEntry, onCopyLink }: {
  onCopyLink?: (path: string) => void | Promise<void>
  worktreeEntries?: import("../services/gitService").WorktreeEntries
  files: string[]; loading: boolean; bookmarkName: string; changes: FileChange[]
  onOpen: (file: LocalWorktreeFile) => void
  onWorktreeChanged: () => void | Promise<void>
  onPush: () => void | Promise<void>
  onStage: (filepaths: string[]) => void | Promise<void>
  onRestore: (filepath: string, filepaths?: string[], directory?: boolean, renameSources?: string[]) => void
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [renamedFiles, setRenamedFiles] = useState<{ path: string; sources?: string[]; inventoryBefore?: typeof worktreeEntries; before: FileChange[]; originalChanges?: FileChange[]; directory?: boolean }[]>(() => (knownLocalRenameHints?.(bookmarkName) || []).map(entry => ({ ...entry, before: [] })))
  const hasRenameChange = (entry: { path: string; directory?: boolean }) => changes.some(c =>
    !c.worktreeDeleted && (entry.directory ? c.filepath.startsWith(entry.path + "/") : c.filepath === entry.path))
  // 即时提示仅覆盖尚未刷新或仍有真实工作区改动的新目标；不伪造 Git rename 状态。
  const activeRenames = useMemo(() => renamedFiles.filter(entry => entry.before === changes || hasRenameChange(entry)), [renamedFiles, changes])
  const renameHints = useMemo(() => new Set(activeRenames.map(entry => entry.path)), [activeRenames])
  // Collapse only known local rename sources, never unrelated real deletions or recreated sources.
  const hiddenRenameSource = (path: string) => activeRenames.some(entry => path !== entry.path && !(entry.directory && path.startsWith(entry.path + "/")) && entry.sources?.some(source =>
    (path === source || (entry.directory && path.startsWith(source + "/"))) &&
    (entry.before === changes || ((worktreeEntries === entry.inventoryBefore || (!worktreeEntries?.files.includes(path) && !worktreeEntries?.directories.includes(path))) &&
    !changes.some(c => c.filepath === path && !c.worktreeDeleted)))))
  // Descendants changed location, not name. Keep their pre-existing edits visible,
  // without treating Git's destination additions as newly named/added children.
  const displayChanges = useMemo(() => new Map<string, FileChange>(changes.flatMap(change => {
    const entry = activeRenames.find(entry => entry.directory && change.filepath.startsWith(entry.path + "/"))
    if (!entry || (change.status !== "added" && change.status !== "*added")) return [[change.filepath, change] as [string, FileChange]]
    const previous = (entry.originalChanges || entry.before).find(c => entry.sources?.some(source => c.filepath === source + change.filepath.slice(entry.path.length)))
    return previous ? [[change.filepath, { ...previous, filepath: change.filepath }] as [string, FileChange]] : []
  })), [changes, activeRenames])
  const changedDirectories = useMemo(() => changedDirectoryPaths([...displayChanges.keys()]), [displayChanges])
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
    const added = changedDirectoryPaths([...displayChanges.values()].filter(c => !c.worktreeDeleted && (c.status === "added" || c.status === "*added")).map(c => c.filepath))
    const other = changedDirectoryPaths(changes.filter(c => c.worktreeDeleted || (c.status !== "added" && c.status !== "*added")).map(c => c.filepath))
    for (const entry of activeCopies) if (entry.directory) added.add(entry.path)
    for (const path of sessionCreatedDirectories) added.add(path)
    for (const path of worktreeEntries?.untrackedDirectories || []) added.add(path)
    return new Set([...added].filter(path => !existing.has(path) && !other.has(path) && !activeRenames.some(entry => entry.directory && path.startsWith(entry.path + "/"))))
  }, [files, changes, displayChanges, activeCopies, sessionCreatedDirectories, worktreeEntries, activeRenames])
  const directoryRestorePaths = useMemo(() => new Set([...addedDirectories, ...changedDirectoryPaths([...addedDirectories])]), [addedDirectories])
  const [added, setAdded] = useState<string[]>([])
  const fileSignature = [...new Set([...files, ...(worktreeEntries?.files || []), ...changes.map(c => c.filepath), ...added])].filter(path => !hiddenRenameSource(path)).join("\0")
  const visibleFiles = useMemo(() => fileSignature ? fileSignature.split("\0") : [], [fileSignature])
  const [directories, setDirectories] = useState<string[]>([])
  // Disk inventory is refreshed on entry/refresh, while local results fill the brief
  // gap before that refresh. No Git placeholder files or persistent hint store.
  const tree = useMemo(() => buildFileTree(visibleFiles, { directories: [...new Set([...(worktreeEntries?.directories || []), ...directories])].filter(path => !hiddenRenameSource(path)) }), [visibleFiles, directories, worktreeEntries, activeRenames, changes])
  useEffect(() => {
    if (!worktreeEntries) return
    const present = new Set(worktreeEntries.directories)
    setDirectories(previous => previous.filter(path => present.has(path)))
    setSessionCreatedDirectories(previous => previous.filter(path => present.has(path)))
    const presentFiles = new Set([...worktreeEntries.files, ...files, ...changes.map(change => change.filepath)])
    setAdded(previous => previous.filter(path => presentFiles.has(path)))
  }, [worktreeEntries])
  const metadataPaths = useMemo(() => expandedFilePaths(tree, expanded), [tree, expanded])
  const [deleted, setDeleted] = useState<string[]>([])
  const deletionEpoch = useRef(changes)
  const removed = useMemo(() => new Set([...deleted.filter(path => deletionEpoch.current === changes || changes.some(change => change.filepath === path && change.worktreeDeleted)), ...changes.filter(c => c.worktreeDeleted === true).map(c => c.filepath)]), [deleted, changes])
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
      deletionEpoch.current = changes
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
          deletionEpoch.current = changes
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
  function restore(path: string, _filepaths?: string[], directory = false) {
    if (state.current.busy || mergeInProgress) return
    const targets = changes.filter(change => change.filepath.startsWith(path + "/"))
    // 单文件和目录均交由详情页同一个 alert 展示，保持文案、按钮颜色及确认行为一致。
    onRestore(path, directory ? targets.map(change => change.filepath) : undefined, directory)
  }
  useModalBackGuard(busy || creationActive)
  const [directoryForm, setDirectoryForm] = useState<{ path: string; kind: "copy" | "rename" } | null>(null)
  const [directoryError, setDirectoryError] = useState("")
  function cancelDirectoryForm() { if (!state.current.busy) setDirectoryForm(null) }
  async function confirmDirectory(next: string, request = directoryForm) {
    if (!request || !state.current.alive || state.current.busy || mergeInProgress) return
    const { path, kind } = request
    if (kind === "rename" && next === path.split("/").pop()) { setDirectoryForm(null); return }
    state.current.busy = true; setBusy(true); setDirectoryError("")
    try {
      checkQueuedWrite()
      const result = await (kind === "copy" ? copyLocalWorktreeDirectory : renameLocalWorktreeDirectory)(bookmarkName, path, next)
      if (state.current.alive) {
        if (kind === "rename") {
          setSessionCreatedDirectories(previous => previous.map(p => p === path || p.startsWith(path + "/") ? result.path + p.slice(path.length) : p))
          setRenamedFiles(previous => (knownLocalRenameHints(bookmarkName)).map(entry => ({ ...entry,
            before: changes,
            originalChanges: previous.find(old => old.path === entry.path || entry.sources.includes(old.path))?.originalChanges || previous.find(old => old.path === entry.path || entry.sources.includes(old.path))?.before || changes,
            inventoryBefore: worktreeEntries,
          })))
        }
        setAdded(previous => [...previous.filter(p => kind !== "rename" || !p.startsWith(path + "/")), ...result.files])
        setDirectories(previous => [...previous.filter(p => kind !== "rename" || (p !== path && !p.startsWith(path + "/"))), ...result.directories])
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
      if (!state.current.alive || state.current.busy || loading || mergeInProgress || creationActive) return
      if (kind === "copy") { setDirectoryError(""); setDirectoryForm({ path, kind }); return }
      // Rename matches file rename: a centered system prompt, never a sheet
      // presented by an expandable/replaceable Section subtree.
      state.current.busy = true; setBusy(true); setError("")
      try {
        const root = resolveWorkdir(bookmarkName)
        const next = await Dialog.prompt({ title: "重命名文件夹", message: "包含全部子目录内容；仅修改本地工作区，不覆盖同名目标，不暂存、提交或推送。", defaultValue: path.split("/").pop() || "", confirmLabel: "确认", cancelLabel: "取消" })
        if (next == null || !state.current.alive) return
        checkQueuedWrite()
        if (resolveWorkdir(bookmarkName) !== root) throw new Error("工作区路径已变化，未重命名文件夹")
        state.current.busy = false
        await confirmDirectory(next, { path, kind })
      } catch (e: any) { if (state.current.alive) setError(String(e?.message || e)) }
      finally { state.current.busy = false; if (state.current.alive) setBusy(false) }
      return
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
      if (next == null || !state.current.alive || (kind === "rename" && next === name)) return
      const target = await (kind === "copy" ? copyLocalWorktreeFile : renameLocalWorktreeFile)(bookmarkName, file, next)
      if (state.current.alive) {
        if (kind === "rename") setRenamedFiles(previous => knownLocalRenameHints(bookmarkName).map(entry => ({ ...entry,
          before: changes,
            originalChanges: previous.find(old => old.path === entry.path || entry.sources.includes(old.path))?.originalChanges || previous.find(old => old.path === entry.path || entry.sources.includes(old.path))?.before || changes,
          inventoryBefore: worktreeEntries,
        })))
        setAdded(previous => [...previous.filter(p => kind !== "rename" || p !== path), target])
        if (kind === "copy") setCopied(previous => [...previous, { path: target, before: changes }])
      }
      await onWorktreeChanged()
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
  // 长按菜单「移动到…」：选择一个已存在的文件夹（或仓库根目录），沿用原有的安全移动（路径检查、协调锁、不覆盖）。
  function collectDirectories(nodes: FileTreeNode[], out: string[] = []): string[] {
    for (const node of nodes) if (node.type === "directory") { out.push(node.path); collectDirectories(node.children, out) }
    return out
  }
  async function moveTo(path: string) {
    if (state.current.busy || loading || mergeInProgress || creationActive || directoryForm !== null || removed.has(path)) return
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
    const targets = collectDirectories(tree).filter(directory => directory !== parent && !deletedDirectories.has(directory)).sort()
    if (targets.length === 0) { setError("没有可移动到的文件夹"); return }
    const choice = await Dialog.actionSheet({ title: "移动到…", message: path, actions: targets.map(label => ({ label })) })
    if (choice == null || !state.current.alive) return
    const directory = targets[choice]
    state.current.busy = true; setBusy(true); setError("")
    let enteredWrite = false
    try {
      const root = resolveWorkdir(bookmarkName).replace(/\/+$/, "")
      const target = await localImportStep("移动到/协调锁", () => { checkQueuedWrite(); enteredWrite = true; return moveLocalWorktreeFile(bookmarkName, path, directory, root) })
      await localImportOnMain("移动UI结果", () => {
        if (!state.current.alive) return
        setAdded(previous => [...previous.filter(value => value !== path), target])
        deletionEpoch.current = changes
        setDeleted(previous => [...previous.filter(value => value !== target), path])
        // 标签全部来自真实 Git 状态：新位置 *added → 绿色「新增」，源位置 → 红色「已删除」，目标文件夹 → 橙色「已修改」。
        // 不再写入「重命名/复制」提示，否则会盖住真实状态。
        setRenamedFiles(previous => previous.filter(entry => entry.path !== path && entry.path !== target))
        setCopied(previous => previous.filter(entry => entry.path !== path && entry.path !== target))
      })
      await localImportStep("移动后刷新改动", () => onWorktreeChanged())
    } catch (e: any) {
      let message = String(e?.message || e)
      if (enteredWrite) {
        try { await localImportStep("移动失败后刷新", () => onWorktreeChanged()) }
        catch (refreshError: any) { message += "\n" + String(refreshError?.message || refreshError) }
      }
      await localImportOnMain("移动错误结果", () => { if (state.current.alive) setError(message) })
    } finally {
      state.current.busy = false
      await localImportOnMain("移动UI收尾", () => { if (state.current.alive) setBusy(false) })
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
          // Import creates these directories exclusively (existing targets are refused).
          // Empty directories have no Git row, so copied hints alone are pruned on
          // refresh. Keep the same mount-local hint used by 「创建目录」 instead.
          setSessionCreatedDirectories(previous => [...new Set([...previous, ...result.directories])])
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
  type AdditionKind = "file" | "directory" | "document" | "import-directory" | "photo"
  const [additionRequest, setAdditionRequest] = useState<{ kind: AdditionKind; bookmarkName: string } | null>(null)
  const additionPending = useRef(false)
  function requestAddition(kind: AdditionKind) {
    if (!state.current.alive || state.current.busy || additionPending.current || loading || mergeInProgress || creationActive || directoryForm) return
    additionPending.current = true
    setAdditionRequest({ kind, bookmarkName })
  }
  useEffect(() => {
    if (additionRequest === null) return
    additionPending.current = false
    if (!state.current.alive) return
    setAdditionRequest(null)
    if (additionRequest.bookmarkName !== bookmarkName || state.current.busy || loading || mergeInProgress || creationActive || directoryForm) return
    const kind = additionRequest.kind
    if (kind === "file" || kind === "directory") startCreation(kind === "directory")
    else void importSelection(kind).catch(error => console.error(error))
  }, [additionRequest])
  const additionDisabled = busy || loading || mergeInProgress || additionRequest !== null || creationActive || directoryForm !== null

  // 元数据只更新行文案，不再触发整棵目录树的重建和排序。

  return <Section fullScreenCover={{
    isPresented: directoryForm !== null,
    onChanged: (presented: boolean) => { if (!presented) cancelDirectoryForm() },
    content: directoryForm ? <NameInputSheet key={`${directoryForm.kind}-${directoryForm.path}`} title={directoryForm.kind === "copy" ? "复制文件夹到当前目录" : "重命名文件夹"} initialName={(directoryForm.path.split("/").pop() || "") + (directoryForm.kind === "copy" ? " 副本" : "")} message="包含全部子目录内容；仅修改本地工作区，不覆盖同名目标，不暂存、提交或推送。" busy={busy} error={directoryError} onCancel={cancelDirectoryForm} onConfirm={confirmDirectory} /> : <Text />,
  }} header={<HStack frame={{ maxWidth: Infinity }}>
    <Text>仓库文件{visibleFiles.length > 0 ? `（${visibleFiles.length}）` : ""}</Text><Spacer />
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
    </Menu>
  </HStack>}>
    {error ? <Text foregroundStyle="red">{error}</Text> : null}
    {loading ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>加载中…</Text> : null}
    {tree.length === 0 && !loading ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>当前工作区没有文件</Text> : tree.map(node => <FileTreeNodeView key={node.path} node={node} copyLink={onCopyLink} moveTo={moveTo} open={open} removed={removed} busy={busy || loading || mergeInProgress || creationActive} remove={remove} manage={manage} displayChanges={displayChanges} renameHints={renameHints} addedHints={addedHints} addedDirectories={addedDirectories} directoryRestorePaths={directoryRestorePaths} deletedDirectories={deletedDirectories} changesByPath={changesByPath} changedDirectories={changedDirectories} expanded={expanded} toggleExpanded={toggleExpanded} metadata={metadata} onPush={onPush} onStage={onStage} onRestore={restore} mergeInProgress={mergeInProgress} />)}
  </Section>
}
