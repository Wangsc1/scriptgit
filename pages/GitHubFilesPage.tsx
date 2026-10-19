/** 远端文件浏览，无需克隆；分支与路径固定后才打开编辑会话。 */
import { Button, List, Picker, Section, Text, TextField, HStack, VStack, Image, useEffect, useRef, useState } from "scripting"
import { getRepo, listMyRepos, listRepoBranches, listRepoContents, loadRepoTextFile, type GitHubContentEntry } from "../api/githubApi"
import type { GitHubRepo } from "../types/git"
import type { RemoteTextFile } from "../services/githubFileSession"
import { formatBytes, formatISODate } from "../utils/format"
import { COLOR_LABEL, COLOR_SECONDARY_LABEL } from "../constants/colors"
import { GitHubFileEditor } from "./GitHubFileEditor"
import { rawFileUrl } from "../utils/rawFileUrl"

export function GitHubFilesPage({ fullName: initialRepo = "" }: { fullName?: string }) {
  const [input, setInput] = useState(initialRepo)
  const [repo, setRepo] = useState("")
  const [branches, setBranches] = useState<string[]>([])
  const [branch, setBranch] = useState("")
  const [path, setPath] = useState("")
  const [entries, setEntries] = useState<GitHubContentEntry[]>([])
  const [myRepos, setMyRepos] = useState<GitHubRepo[]>([])
  const [repoPage, setRepoPage] = useState(0)
  const [moreRepos, setMoreRepos] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copyStatus, setCopyStatus] = useState("")
  const [file, setFile] = useState<RemoteTextFile | null>(null)
  const request = useRef(0)
  const busyRef = useRef(false)

  useEffect(() => {
    if (initialRepo) openRepo(initialRepo)
    return () => { request.current++ }
  }, [])

  // 所有浏览请求共享序号；旧响应与卸载后的响应均不能写入新上下文。
  async function run(work: (id: number) => Promise<void>) {
    const id = ++request.current
    busyRef.current = true
    setBusy(true)
    setCopyStatus("")
    setError("")
    try { await work(id) }
    catch (e: any) { if (id === request.current) setError(String(e?.message || e)) }
    finally { if (id === request.current) { busyRef.current = false; setBusy(false) } }
  }

  async function openRepo(name: string) {
    if (busyRef.current) return
    await run(async (id) => {
      setRepo(""); setEntries([]); setBranches([]); setBranch(""); setPath("")
      const detail = await getRepo(name.trim())
      const names = await listRepoBranches(detail.fullName)
      if (id !== request.current) return
      setInput(detail.fullName); setRepo(detail.fullName); setBranches(names)
      if (!names.length) { setError("仓库没有分支，可能尚未提交文件。"); return }
      const selected = names.includes(detail.defaultBranch) ? detail.defaultBranch : names[0]
      setBranch(selected)
      const items = await listRepoContents(detail.fullName, selected)
      if (id === request.current) setEntries(items)
    })
  }

  async function loadDirectory(nextPath: string, nextBranch = branch) {
    if (busyRef.current || !repo) return
    await run(async (id) => {
      setEntries([]); setPath(nextPath); setBranch(nextBranch)
      const items = await listRepoContents(repo, nextBranch, nextPath)
      if (id === request.current) setEntries(items)
    })
  }

  async function openFile(entry: GitHubContentEntry) {
    if (busyRef.current) return
    await run(async (id) => {
      const loaded: RemoteTextFile = entry.type === "file"
        ? await loadRepoTextFile(repo, branch, entry.path)
        : { path: entry.path, sha: entry.sha, text: null, readOnlyReason: "符号链接、子模块或非普通文件，只读" }
      if (id === request.current) setFile(loaded)
    })
  }

  async function copyLink(entry: GitHubContentEntry) {
    if (busyRef.current || entry.type !== "file") return
    const id = request.current
    setCopyStatus("")
    try {
      await Pasteboard.setString(rawFileUrl(repo, branch, entry.path))
      if (id === request.current) setCopyStatus("已复制 Raw 链接")
    } catch (e: any) {
      if (id === request.current) setCopyStatus("复制链接失败：" + String(e?.message || e))
    }
  }

  async function loadMyRepos() {
    if (busyRef.current) return
    await run(async (id) => {
      const page = repoPage + 1
      const items = await listMyRepos(30, page)
      if (id !== request.current) return
      setMyRepos((current) => [...current, ...items]); setRepoPage(page); setMoreRepos(items.length === 30)
    })
  }

  return <List navigationTitle="GitHub 文件" navigationBarTitleDisplayMode="inline" tabBarVisibility="hidden"
    fullScreenCover={{
      isPresented: file !== null,
      // 全屏覆盖无下拉关闭；只允许编辑器内显式关闭并确认未保存修改。
      onChanged: () => {},
      content: file ? <GitHubFileEditor key={`${repo}:${branch}:${file.path}:${file.sha}`} fullName={repo} branch={branch} file={file} onClose={() => setFile(null)} /> : <Text>加载中…</Text>,
    }}>
    <Section header={<Text>远端仓库</Text>} footer={<Text>在设置中配置 Token。无需克隆，直接修改 GitHub 上的现有文件。</Text>}>
      <TextField title="仓库" value={input} onChanged={setInput} prompt="owner/repo" />
      <Button title="打开仓库" action={() => openRepo(input)} disabled={busy || !input.trim()} />
      {myRepos.map((item) => <Button key={item.fullName} title={item.fullName} action={() => openRepo(item.fullName)} disabled={busy} />)}
      {moreRepos ? <Button title={repoPage ? "加载更多我的仓库" : "加载我的 GitHub 仓库"} action={loadMyRepos} disabled={busy} /> : null}
    </Section>
    {busy ? <Section><Text>加载中…</Text></Section> : null}
    {error ? <Section><Text foregroundStyle="red">{error}</Text></Section> : null}
    {copyStatus ? <Section><Text>{copyStatus}</Text></Section> : null}
    {repo && branches.length ? <Section header={<Text>{repo}</Text>}>
      <Picker title="分支" value={branch} onChanged={(value: string) => { if (value !== branch) loadDirectory("", value) }} disabled={busy}>
        {branches.map((name) => <Text key={name} tag={name}>{name}</Text>)}
      </Picker>
      <Text>{path || "/"}</Text>
      {path ? <Button title="上一级目录" action={() => loadDirectory(path.split("/").slice(0, -1).join("/"))} disabled={busy} /> : null}
      <Button title="刷新目录 / 重试" action={() => loadDirectory(path)} disabled={busy} />
      {!busy && !error && !entries.length ? <Text>空目录</Text> : null}
      {entries.map((entry) => {
        const isDir = entry.type === "dir"
        const metaParts: string[] = []
        if (!isDir && entry.size > 0) metaParts.push(formatBytes(entry.size))
        if (!isDir && entry.lastModified) metaParts.push(formatISODate(entry.lastModified))
        return (
          <Button key={entry.path} action={() => isDir ? loadDirectory(entry.path) : openFile(entry)} disabled={busy}
            contextMenu={entry.type === "file" ? { menuItems: <Button title="复制链接" systemImage="link" action={() => copyLink(entry)} disabled={busy} /> } : undefined}>
            <HStack alignment="center" spacing={10} frame={{ maxWidth: Infinity, alignment: "leading" }}>
              <Text font="body">{isDir ? "📁" : "📄"}</Text>
              <VStack alignment="leading" spacing={2} frame={{ maxWidth: Infinity, minWidth: 0, alignment: "leading" }}>
                <Text font="body" foregroundStyle={COLOR_LABEL} lineLimit={1}>{entry.name}</Text>
                {metaParts.length > 0 ? <Text font="caption2" foregroundStyle={COLOR_SECONDARY_LABEL}>{metaParts.join(", ")}</Text> : null}
              </VStack>
            </HStack>
          </Button>
        )
      })}
      {entries.length >= 1000 ? <Text>GitHub Contents API 每个目录最多返回 1000 项，列表可能不完整。</Text> : null}
    </Section> : null}
  </List>
}
