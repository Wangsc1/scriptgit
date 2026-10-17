import { Button, DisclosureGroup, Section, Text, HStack, Image, useRef, useState, useEffect } from "scripting"
import { buildFileTree, type FileTreeNode } from "../utils/fileTree"
import type { FileChange } from "../types/git"
import { readLocalWorktreeFile, type LocalWorktreeFile } from "../services/gitService"
import { LocalFileEditor } from "./LocalFileEditor"
import { COLOR_LABEL, COLOR_SECONDARY_LABEL, COLOR_ACCENT } from "../constants/colors"

function FileTreeNodeView({ node, open, removed, busy }: { node: FileTreeNode; open: (path: string) => void; removed: Set<string>; busy: boolean }) {
  if (node.type === "file") return <Button action={() => open(node.path)} disabled={busy || removed.has(node.path)}>
    <HStack alignment="center" spacing={10}>
      <Image systemName="doc" foregroundStyle={COLOR_SECONDARY_LABEL} />
      <Text font="body" foregroundStyle={COLOR_LABEL} lineLimit={2}>{node.name}{removed.has(node.path) ? "（已删除，不可编辑）" : ""}</Text>
    </HStack>
  </Button>
  return <DisclosureGroup label={<HStack alignment="center" spacing={10}>
    <Image systemName="folder" foregroundStyle={COLOR_ACCENT} /><Text font="body" foregroundStyle={COLOR_LABEL}>{node.name}</Text>
  </HStack>}>
    {node.children.map(child => <FileTreeNodeView key={child.path} node={child} open={open} removed={removed} busy={busy} />)}
  </DisclosureGroup>
}

export function FilesTab({ files, loading, bookmarkName, changes, onWorktreeChanged }: {
  files: string[]; loading: boolean; bookmarkName: string; changes: FileChange[]
  onWorktreeChanged: () => void | Promise<void>
}) {
  const [opened, setOpened] = useState<{ file: LocalWorktreeFile; id: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [deleted, setDeleted] = useState<string[]>([])
  const state = useRef({ alive: true, busy: false, id: 0 })
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
      const file = await readLocalWorktreeFile(bookmarkName, path)
      if (state.current.alive) setOpened({ file, id: ++state.current.id })
    } catch (e: any) { if (state.current.alive) setError(String(e?.message || e)) }
    finally { state.current.busy = false; if (state.current.alive) setBusy(false) }
  }
  async function changed(path: string, isDeleted: boolean) {
    if (isDeleted && state.current.alive) setDeleted(previous => [...previous, path])
    await onWorktreeChanged()
  }
  return <Section header={<Text>当前 HEAD 文件{files.length > 0 ? `（${files.length}）` : ""}</Text>}
    fullScreenCover={{ isPresented: opened !== null, onChanged: () => {}, content: opened ? <LocalFileEditor key={`${opened.file.path}:${opened.id}`} bookmarkName={bookmarkName} file={opened.file}
      onClose={() => setOpened(null)} onReload={file => setOpened({ file, id: ++state.current.id })} onChanged={changed} /> : <Text>加载中…</Text> }}>
    <Text font="caption">点文件编辑或删除本地工作区内容；目录可展开。新未跟踪文件请到「改动」页查看。</Text>
    {error ? <Text foregroundStyle="red">{error}</Text> : null}
    {loading || busy ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>加载中…</Text> : null}
    {files.length === 0 ? <Text foregroundStyle={COLOR_SECONDARY_LABEL}>当前分支还没有已跟踪文件</Text> : buildFileTree(files).map(node => <FileTreeNodeView key={node.path} node={node} open={open} removed={removed} busy={busy || loading} />)}
  </Section>
}
