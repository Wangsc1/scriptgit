import { Button, DisclosureGroup, Menu, Spacer, Section, Text, HStack, VStack, Image, useRef, useState, useEffect, useMemo } from "scripting"
import { NameInputSheet } from "../components/NameInputSheet"
import { buildFileTree, type FileTreeNode } from "../utils/fileTree"
import { changedDirectoryPaths, expandedFilePaths, readMetadataBatched } from "../utils/fileListPerformance"
import { formatBytes, formatDate } from "../utils/format"
import { resolveWorkdir } from "../services/repoStore"
import { createLocalWorktreeEntry, importLocalWorktreeFile, copyLocalWorktreeDirectory, renameLocalWorktreeDirectory, readLocalWorktreeFile, openLocalWorktreeFile, copyLocalWorktreeFile, renameLocalWorktreeFile, deleteLocalWorktreeDirectory, deleteLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"
import { COLOR_LABEL, COLOR_SECONDARY_LABEL, COLOR_ORANGE } from "../constants/colors"
import { pickLocalDocument, pickLocalPhoto, type PickedLocalFile } from "../services/localFileImport"
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
function FileTreeNodeView({ node, open, removed, busy, remove, manage, renameHints, addedHints, addedDirectories, deletedDirectories, changesByPath, changedDirectories, expanded, toggleExpanded, metadata, onPush, onRestore, mergeInProgress }: { node: FileTreeNode; open: (path: string) => void; removed: Set<string>; busy: boolean; remove: (path: string, directory?: boolean) => void; manage: (path: string, kind: "copy" | "rename", directory?: boolean) => void; renameHints: Set<string>; addedHints: Set<string>; addedDirectories: Set<string>; deletedDirectories: Set<string>; changesByPath: Map<string, FileChange>; changedDirectories: Set<string>; expanded: Set<string>; toggleExpanded: (path: string, value: boolean) => void; metadata: Map<string, { size: number; modified: number }>; onPush: () => void | Promise<void>; onRestore: (filepath: string, filepaths?: string[]) => void; mergeInProgress: boolean }) {
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
      <Button action={() => open(node.path)} disabled={busy || deleted} frame={{ maxWidth: Infinity, alignment: "leading" }} contextMenu={{ menuItems: <>
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
  return <DisclosureGroup contextMenu={{ menuItems: <>
    <Button title="复制文件夹" disabled={busy} action={() => manage(node.path, "copy", true)} />
    <Button title="重命名" disabled={busy} action={() => manage(node.path, "rename", true)} />
  </> }} isExpanded={expanded.has(node.path)} onChanged={value => toggleExpanded(node.path, value)} trailingSwipeActions={{ allowsFullSwipe: false, actions: folderActions }} label={<HStack alignment="center" spacing={10}>
    <Image systemName="folder" foregroundStyle={folderBadge ? folderBadge.color as any : COLOR_SECONDARY_LABEL} /><Text font="body" foregroundStyle={COLOR_LABEL}>{node.name}</Text>
    {folderBadge ? <Text font="caption2" foregroundStyle={folderBadge.color as any}>{folderBadge.text}</Text> : null}
  </HStack>}>
    {expanded.has(node.path) ? node.children.map(child => <FileTreeNodeView key={child.path} node={child} open={open} removed={removed} busy={busy} remove={remove} manage={manage} renameHints={renameHints} addedHints={addedHints} addedDirectories={addedDirectories} deletedDirectories={deletedDirectories} changesByPath={changesByPath} changedDirectories={changedDirectories} expanded={expanded} toggleExpanded={toggleExpanded} metadata={metadata} onPush={onPush} onRestore={onRestore} mergeInProgress={mergeInProgress} />) : null}
  </DisclosureGroup>
}

export function FilesTab({ files, loading, bookmarkName, changes, onWorktreeChanged, onOpen, onPush, onRestore, mergeInProgress }: {
  files: string[]; loading: boolean; bookmarkName: string; changes: FileChange[]
  onOpen: (file: LocalWorktreeFile) => void
  onWorktreeChanged: () => void | Promise<void>
  onPush: () => void | Promise<void>
  onRestore: (filepath: string, filepaths?: string[]) => void
  mergeInProgress: boolean
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
  const [renamedFiles, setRenamedFiles] = useState<{ path: string; before: FileChange[]; directory?: boolean }[]>([])
  const hasRenameChange = (entry: { path: string; directory?: boolean }) => changes.some(c =>
    !c.worktreeDeleted && (entry.directory ? c.filepath.startsWith(entry.path + "/") : c.filepath === entry.path))
  // 即时提示仅覆盖尚未刷新或仍有真实工作区改动的新目标；不伪造 Git rename 状态。
  const renameHints = useMemo(() => new Set(renamedFiles.filter(entry => entry.before === changes || hasRenameChange(entry)).map(entry => entry.path)), [renamedFiles, changes])
  useEffect(() => {
    setRenamedFiles(previous => previous.filter(hasRenameChange))
  }, [changes])
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
    return new Set([...added].filter(path => !existing.has(path) && !other.has(path)))
  }, [files, changes, activeCopies])
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
  const state = useRef({ alive: true, busy: false })
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
        if (!cancelled && state.current.alive) setMetadata(next)
      } catch (e: any) {
        if (!cancelled && state.current.alive) setError("元数据读取失败: " + String(e?.message || e))
      }
    }
    load()
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

  const [creation, setCreation] = useState<{ directory: boolean; root: string } | null>(null)
  const [creationError, setCreationError] = useState("")
  function startCreation(directory: boolean) {
    if (state.current.busy || loading || mergeInProgress) return
    try {
      setCreationError(""); setError("")
      setCreation({ directory, root: resolveWorkdir(bookmarkName).replace(/\/+$/, "") })
    } catch (e: any) { setError(String(e?.message || e)) }
  }
  function cancelCreation() { if (!state.current.busy) setCreation(null) }
  function showAddition(path: string, directory: boolean) {
    if (!state.current.alive) return
    if (directory) setDirectories(previous => [...new Set([...previous, path])])
    else setAdded(previous => [...new Set([...previous, path])])
    setDeleted(previous => previous.filter(value => value !== path))
    setRenamedFiles(previous => previous.filter(entry => entry.path !== path))
    setCopied(previous => [...previous.filter(entry => entry.path !== path), { path, before: changes, directory }])
  }
  async function confirmCreation(name: string) {
    if (!creation || state.current.busy || mergeInProgress) return
    state.current.busy = true; setBusy(true); setCreationError(""); setError("")
    try {
      const path = await createLocalWorktreeEntry(bookmarkName, name, creation.directory, creation.root)
      showAddition(path, creation.directory)
      if (state.current.alive) setCreation(null)
      await onWorktreeChanged()
    } catch (e: any) {
      if (state.current.alive) { setCreationError(String(e?.message || e)); setError(String(e?.message || e)) }
      try { await onWorktreeChanged() } catch (_) { /* Preserve the original failure, including partial results. */ }
    } finally { state.current.busy = false; if (state.current.alive) setBusy(false) }
  }
  async function importSelection(photo: boolean) {
    if (state.current.busy || loading || mergeInProgress) return
    state.current.busy = true; setBusy(true); setError("")
    let picked: PickedLocalFile | null = null
    try {
      const expectedRoot = resolveWorkdir(bookmarkName).replace(/\/+$/, "")
      picked = await (photo ? pickLocalPhoto() : pickLocalDocument())
      if (!picked || !state.current.alive) return // Cancellation is a zero-write operation.
      const path = await importLocalWorktreeFile(bookmarkName, picked.sourcePath, picked.name, expectedRoot)
      showAddition(path, false)
      await onWorktreeChanged()
    } catch (e: any) {
      if (state.current.alive) setError(String(e?.message || e))
      try { await onWorktreeChanged() } catch (_) { /* Partial imports must be reflected without removing them. */ }
    } finally {
      if (picked) {
        try { await picked.release() } catch (_) { if (state.current.alive) setError("导入流程已结束，但照片临时副本清理失败；请核对工作区结果") }
      }
      state.current.busy = false; if (state.current.alive) setBusy(false)
    }
  }

  // 元数据只更新行文案，不再触发整棵目录树的重建和排序。

  return <Section sheet={{
    isPresented: directoryForm !== null || creation !== null,
    onChanged: (presented: boolean) => { if (!presented) { cancelDirectoryForm(); cancelCreation() } },
    content: creation ? <NameInputSheet key={creation.directory ? "create-directory" : "create-file"} title={creation.directory ? "创建目录" : "创建文件"} initialName="" message="添加到仓库工作区根目录。不覆盖同名目标；文件初始为空，扩展名不限；空目录仅在当前会话可见，Git 不跟踪。" busy={busy} error={creationError} onCancel={cancelCreation} onConfirm={confirmCreation} /> : directoryForm ? <NameInputSheet key={`${directoryForm.kind}-${directoryForm.path}`} title={directoryForm.kind === "copy" ? "复制文件夹到当前目录" : "重命名文件夹"} initialName={(directoryForm.path.split("/").pop() || "") + (directoryForm.kind === "copy" ? " 副本" : "")} message="包含全部子目录内容；仅修改本地工作区，不覆盖同名目标，不暂存、提交或推送。" busy={busy} error={directoryError} onCancel={cancelDirectoryForm} onConfirm={confirmDirectory} /> : <Text />,
  }} header={<HStack frame={{ maxWidth: Infinity }}>
    <Text>工作区文件{visibleFiles.length > 0 ? `（${visibleFiles.length}）` : ""}</Text><Spacer />
    <Menu label={<Image systemName="plus" />} disabled={busy || loading || mergeInProgress}>
      <Section header={<Text>添加到仓库</Text>}>
        <Button title="创建文件" systemImage="doc.text" disabled={busy || loading || mergeInProgress} action={() => startCreation(false)} />
        <Button title="创建目录" systemImage="folder" disabled={busy || loading || mergeInProgress} action={() => startCreation(true)} />
      </Section>
      <Section>
        <Button title="导入文件" systemImage="doc.text" disabled={busy || loading || mergeInProgress} action={() => importSelection(false)} />
        <Button title="导入图片" systemImage="photo" disabled={busy || loading || mergeInProgress} action={() => importSelection(true)} />
      </Section>
    </Menu>
  </HStack>}>
    {error ? <Text foregroundStyle="red">{error}</Text> : null}
    {loading ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>加载中…</Text> : null}
    {tree.length === 0 && !loading ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>当前工作区没有文件</Text> : tree.map(node => <FileTreeNodeView key={node.path} node={node} open={open} removed={removed} busy={busy || loading || mergeInProgress} remove={remove} manage={manage} renameHints={renameHints} addedHints={addedHints} addedDirectories={addedDirectories} deletedDirectories={deletedDirectories} changesByPath={changesByPath} changedDirectories={changedDirectories} expanded={expanded} toggleExpanded={toggleExpanded} metadata={metadata} onPush={onPush} onRestore={restore} mergeInProgress={mergeInProgress} />)}
  </Section>
}
