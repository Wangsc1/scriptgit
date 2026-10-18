/** 单个/按用户名批量克隆；默认本地 Scripting/git，手动选择目录仍保留。 */
import { List, Section, Text, Button, HStack, useState, useEffect, useRef } from "scripting"
import { AvatarView } from "../components/AvatarView"
import { useGitHubUserSearch } from "../hooks/useGitHubUserSearch"
import { FormRow } from "../components/FormRow"
import { BusyOverlay } from "../components/BusyOverlay"
import { toastContent } from "../components/Toast"
import { useToast } from "../hooks/useToast"
import type { GitHubRepo, RepoMeta } from "../types/git"
import { listRepos, pickDirectory } from "../services/repoStore"
import { RemoteCancelToken } from "../services/gitService"
import { cloneRoot, prepareCloneRoot, type CloneDestination } from "../services/cloneWorkspace"
import { runCloneQueue, type CloneRequest, type CloneResult } from "../services/cloneQueue"
import { hasToken } from "../services/authStore"
import { notifySync, notifyError } from "../services/notifyService"
import { listMyRepos, listOwnedRepos } from "../api/githubApi"
import { repoNameFromUrl } from "../utils/format"
import { yieldForUi } from "../utils/remoteProgress"
import { registeredGithubRepos } from "../utils/clonedGithubRepos"
import { hideSystemDetails } from "../utils/displayPaths"
import { runDirectoryCheck } from "../services/cloneDiagnostics"

const STATUS = { cloned: "成功", failed: "失败", skipped: "跳过", cancelled: "取消" }

export function ClonePage({ onCloned, initialUsername = "" }: { onCloned: (repo: RepoMeta, keepOpen?: boolean) => void; initialUsername?: string }) {
  const [url, setUrl] = useState("")
  const [destination, setDestination] = useState<CloneDestination>({ kind: "local" })
  const [rootLabel, setRootLabel] = useState("在我的 iPhone / Scripting / git")
  const [directoryError, setDirectoryError] = useState("")
  const [cloning, setCloning] = useState(false)
  const [progress, setProgress] = useState("")
  const [cancelling, setCancelling] = useState(false)
  const [myRepos, setMyRepos] = useState<GitHubRepo[]>([])
  const [loadingMyRepos, setLoadingMyRepos] = useState(false)
  const [myReposError, setMyReposError] = useState("")
  const [username, setUsername] = useState(initialUsername)
  const [loadedUser, setLoadedUser] = useState("")
  const [publicOnly, setPublicOnly] = useState(!hasToken())
  const [ownedRepos, setOwnedRepos] = useState<GitHubRepo[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [clonedRepos, setClonedRepos] = useState<Set<string>>(new Set())
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [results, setResults] = useState<CloneResult[]>([])
  const [listError, setListError] = useState("")
  const alive = useRef(true)
  const locked = useRef(false)
  const listRequest = useRef(0)
  const usernameRef = useRef(initialUsername)
  const autoLoad = useRef({ timer: null as ReturnType<typeof setTimeout> | null, busy: false, requestId: 0, loaded: "", ready: null as { target: string; id: number } | null })
  const directoryRequest = useRef(0)
  const cancelRef = useRef<RemoteCancelToken | null>(null)
  const { toastState, showToast, handleToastChanged, toastPresented } = useToast()
  const userSearch = useGitHubUserSearch()

  useEffect(() => {
    configureDestination({ kind: "local" })
    if (hasToken()) loadMyRepos()
    changeUsername(initialUsername)
    return () => {
      alive.current = false; listRequest.current++; directoryRequest.current++; cancelRef.current?.cancel()
      if (autoLoad.current.timer !== null) clearTimeout(autoLoad.current.timer)
      autoLoad.current.ready = null
    }
  }, [])

  async function loadMyRepos() {
    setLoadingMyRepos(true); setMyReposError("")
    try {
      const repos = await listMyRepos(20)
      // 列表加载完成后才读取一次注册表；render 不读 Storage，也不逐仓联网。
      if (alive.current) { setMyRepos(repos); setClonedRepos(current => new Set([...current, ...registeredGithubRepos(listRepos())])) }
    } catch (e: any) {
      if (alive.current) setMyReposError("在线仓库加载失败：" + String(e?.message || e))
    } finally { if (alive.current) setLoadingMyRepos(false) }
  }

  async function configureDestination(next: CloneDestination) {
    const id = ++directoryRequest.current
    setDestination(next)
    setDirectoryError("")
    try {
      const root = await prepareCloneRoot(next)
      if (alive.current && id === directoryRequest.current) setRootLabel(next.kind === "local" ? "在我的 iPhone / Scripting / git" : next.kind === "icloud" ? "iCloud Drive / Scripting / git" : "所选父目录 / git")
    } catch (e: any) {
      if (alive.current && id === directoryRequest.current) {
        setRootLabel(next.kind === "local" ? "在我的 iPhone / Scripting / git（不可用）" : next.kind === "icloud" ? "iCloud Drive / Scripting / git（不可用）" : "所选父目录 / git（不可用）")
        setDirectoryError(String(e?.message || e))
      }
    }
  }

  async function changeDirectory() {
    if (locked.current) return
    try {
      const picked = await pickDirectory()
      if (picked && alive.current) await configureDestination({ kind: "external", parentPath: picked.path, accessBookmarkName: picked.accessBookmarkName })
    } catch (e: any) { showToast("选择目录失败：" + String(e?.message || e), "error") }
  }

  function changeUsername(value: string, selectedCandidate = false) {
    if (locked.current) return
    const target = value.trim()
    const current = autoLoad.current
    if (selectedCandidate) {
      userSearch.selectUser(value)
      // 重复点同一候选不清空结果，也不堆叠全量请求。
      if (target.toLowerCase() === usernameRef.current.trim().toLowerCase() && ((current.busy && current.requestId === listRequest.current) || current.ready?.id === listRequest.current || current.loaded === target.toLowerCase())) return
    } else userSearch.changeQuery(value)
    usernameRef.current = value
    const id = ++listRequest.current
    if (current.timer !== null) clearTimeout(current.timer)
    current.timer = null; current.ready = null; current.loaded = ""
    const valid = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(target)
    setUsername(value); setOwnedRepos([]); setSelected([]); setLoadedUser(""); setLoadingRepos(valid); setListError(""); setResults([])
    if (!valid) return
    if (selectedCandidate) void loadUser(target, id)
    else current.timer = setTimeout(() => { current.timer = null; void loadUser(target, id) }, 650)
  }

  async function loadUser(target: string, id: number) {
    const current = autoLoad.current
    if (!alive.current || locked.current || id !== listRequest.current) return
    // 无法取消的旧分页完成前只记住最新用户名，最多一个全量分页请求在途。
    if (current.busy) { current.ready = { target, id }; return }
    current.busy = true; current.requestId = id
    const onlyPublic = !hasToken()
    setLoadingRepos(true); setListError("")
    try {
      const repos = await listOwnedRepos(target)
      if (!alive.current || id !== listRequest.current) return
      // 用户主动加载完成后只读一次注册表；首屏/render 不为标记读 Storage 或工作区。
      const cloned = registeredGithubRepos(listRepos())
      setClonedRepos(cloned)
      current.loaded = target.toLowerCase()
      setOwnedRepos(repos); setSelected(repos.filter(repo => !cloned.has(repo.fullName.toLowerCase())).map(repo => repo.fullName)); setLoadedUser(target); setPublicOnly(onlyPublic)
    } catch (e: any) {
      if (alive.current && id === listRequest.current) setListError("加载失败，未开始克隆：" + String(e?.message || e))
    } finally {
      current.busy = false
      if (alive.current && id === listRequest.current) setLoadingRepos(false)
      const ready = current.ready; current.ready = null
      if (ready && alive.current && ready.id === listRequest.current) void loadUser(ready.target, ready.id)
    }
  }

  function retryUser() {
    if (autoLoad.current.busy || !usernameRef.current.trim()) return
    void loadUser(usernameRef.current.trim(), listRequest.current)
  }

  async function execute(requests: CloneRequest[], batch: boolean) {
    if (locked.current || loadingRepos || !requests.length) return
    if (batch && (!loadedUser || loadedUser !== usernameRef.current.trim())) return
    locked.current = true
    const token = new RemoteCancelToken()
    cancelRef.current = token
    setCloning(true); setCancelling(false); setProgress("检查目标目录")
    try {
      cloneRoot(destination)
      if (batch) {
        const confirmed = await Dialog.confirm({ title: `批量克隆 ${requests.length} 个仓库？`,
          message: `用户：${loadedUser}\n范围：${publicOnly ? "仅公开仓库" : "含当前 Token 已授权仓库"}\n目标：git/<repo>\n逐个下载并注册；同名/已存在项目跳过，绝不覆盖。`, confirmLabel: "开始克隆" })
        if (confirmed !== true || !alive.current || loadedUser !== usernameRef.current.trim()) return
      }
      setResults([])
      const completed = await runCloneQueue(requests, destination, {
        cancelToken: token,
        onProgress: async (index, total, name, detail) => {
          if (alive.current) setProgress(`${index}/${total} · ${name}\n${detail}`)
          await yieldForUi()
        },
        onResult: result => { if (alive.current) setResults(current => [...current, result]) },
        onRegistered: repo => {
          if (alive.current) setClonedRepos(current => new Set([...current, ...registeredGithubRepos([repo])]))
          if (batch) onCloned(repo, true)
        },
      })
      if (!alive.current) return
      if (!batch && completed[0]?.repo) {
        await notifySync("clone", requests[0].name, requests[0].url)
        onCloned(completed[0].repo)
      } else if (!batch && completed[0]?.status === "failed") {
        await notifyError("clone", requests[0].name, completed[0].message)
      } else if (!batch && completed[0]?.status === "skipped") {
        showToast("已跳过：" + completed[0].message, "warning")
      }
    } catch (e: any) {
      if (alive.current) showToast("克隆未完成：" + String(e?.message || e), "error")
    } finally {
      locked.current = false; cancelRef.current = null
      if (alive.current) { setCloning(false); setProgress(""); setCancelling(false) }
    }
  }

  function cloneSingle(cloneUrl = url, repo?: GitHubRepo) {
    if (!cloneUrl.trim()) return
    return execute([{ name: repo?.name || repoNameFromUrl(cloneUrl.trim()), url: cloneUrl.trim(), githubRepo: repo }], false)
  }
  function cancel() { cancelRef.current?.cancel(); setCancelling(true); setProgress("取消中…已完成仓库保留，等待当前网络检查点") }
  const selectedRepos = ownedRepos.filter(repo => selected.includes(repo.fullName))
  const counts = Object.entries(STATUS).map(([status, label]) => `${label} ${results.filter(item => item.status === status).length}`).join(" · ")

  return <List navigationTitle="克隆仓库" navigationBarTitleDisplayMode="inline" tabBarVisibility="hidden"
    navigationBarBackButtonHidden={cloning}
    overlay={cloning ? { alignment: "center", content: <BusyOverlay title="正在克隆" message={progress} onCancel={cancel} cancelling={cancelling} /> } : undefined}
    toast={toastState ? { isPresented: toastPresented, onChanged: handleToastChanged, content: toastContent(toastState.message, toastState.type), duration: toastState.duration, position: "top" } : undefined}>
    <Section header={<Text>目标目录</Text>} footer={<Text>新克隆默认保存在本机，无需启用 iCloud。更改目录可选择 iCloud 或其它位置；不会迁移或修改已有仓库。</Text>}>
      <Text>{rootLabel}</Text>
      {directoryError ? <Text foregroundStyle="red">{hideSystemDetails(directoryError)}</Text> : null}
      <Button title="使用默认本地目录" action={() => configureDestination({ kind: "local" })} disabled={cloning || loadingRepos} tint="label" />
      <Button title="更改目录" action={changeDirectory} disabled={cloning || loadingRepos} />
    </Section>
    <Section header={<Text>单个仓库</Text>}>
      <FormRow label="Git URL" prompt="https://github.com/user/repo.git" value={url} onChanged={setUrl} />
      <Button title="克隆" action={() => cloneSingle()} disabled={cloning || loadingRepos || !url.trim()} />
    </Section>
    <Section header={<Text>按 GitHub 用户名添加</Text>}>
      {!hasToken() ? <Text>未配置 Token：仅公开仓库，可匿名加载与克隆。</Text> : null}
      <FormRow label="用户名" prompt="输入至少 2 个字符搜索用户，或填写完整 login" value={username} onChanged={(value: string) => changeUsername(value)} />
      {userSearch.loading ? <Text>搜索用户中…</Text> : null}
      {userSearch.error ? <Text foregroundStyle="red">{userSearch.error}</Text> : null}
      {userSearch.error ? <Button title="重试用户搜索" action={userSearch.retry} disabled={cloning || userSearch.loading} /> : null}
      {userSearch.candidates.map(candidate => <Button key={candidate.login} action={() => changeUsername(candidate.login, true)} disabled={cloning}>
        <HStack spacing={8}><AvatarView url={candidate.avatarUrl} size={28} /><Text>{candidate.login}</Text></HStack>
      </Button>)}
      {userSearch.hasMore ? <Button title="加载更多用户候选" action={userSearch.loadMore} disabled={cloning || userSearch.loading} /> : null}
      {userSearch.total === 0 ? <Text>没有匹配用户，可继续输入更完整的 login。</Text> : null}
      {userSearch.limited ? <Text>GitHub 搜索最多显示前 1000 个匹配结果，请细化用户名。</Text> : null}
      {userSearch.incomplete ? <Text>GitHub 返回了不完整的搜索结果，可细化关键词后重试。</Text> : null}
      {loadingRepos ? <Text>正在自动分页加载全部仓库…</Text> : null}
      {listError ? <Text foregroundStyle="red">{listError}</Text> : null}
      {listError ? <Button title="重试仓库加载" action={retryUser} disabled={cloning || loadingRepos} /> : null}
      {loadedUser ? <>
        <Text>{loadedUser} · 共 {ownedRepos.length} 个 · 已选 {selectedRepos.length} 个</Text>
        <Text>{publicOnly ? "本次列表仅包含公开仓库" : "本次列表包含当前 Token 已授权的仓库"}</Text>
        <Button title="全选" action={() => setSelected(ownedRepos.map(repo => repo.fullName))} disabled={cloning} />
        <Button title="取消全选" action={() => setSelected([])} disabled={cloning} />
        {ownedRepos.map(repo => <Button key={repo.fullName} title={`${selected.includes(repo.fullName) ? "☑" : "☐"} ${repo.fullName}${clonedRepos.has(repo.fullName.toLowerCase()) ? "（已克隆）" : ""}${repo.private ? "（私有）" : ""}`}
          action={() => setSelected(current => current.includes(repo.fullName) ? current.filter(name => name !== repo.fullName) : [...current, repo.fullName])} disabled={cloning} />)}
        <Button title="克隆所选仓库" action={() => execute(selectedRepos.map(repo => ({ name: repo.name, url: repo.url, githubRepo: repo })), true)} disabled={cloning || loadingRepos || !selectedRepos.length || loadedUser !== username.trim()} />
      </> : null}
    </Section>
    {results.length ? <Section header={<Text>本次结果</Text>} footer={<Text>失败可重跑；已完成项目与现有目录自动跳过，不覆盖也不重复注册。取消为协作式，可能等待当前请求结束。</Text>}>
      <Text>{counts}</Text>
      {results.map((item, index) => <Text key={`${index}:${item.url}`} foregroundStyle={item.status === "failed" ? "red" : "label"}>{`${STATUS[item.status]} · ${item.name}\n${item.displayPath}\n${hideSystemDetails(item.message)}`}</Text>)}
    </Section> : null}
    {hasToken() ? <Section header={<Text>我的 GitHub 仓库（单个克隆）</Text>}>
      {loadingMyRepos ? <Text>加载中…</Text> : null}
      {myReposError ? <Text foregroundStyle="red">{myReposError}</Text> : null}
      {myRepos.map(repo => <Button key={repo.fullName} title={repo.fullName + (clonedRepos.has(repo.fullName.toLowerCase()) ? "（已克隆）" : "")} action={() => {
        if (clonedRepos.has(repo.fullName.toLowerCase())) { showToast("已克隆：" + repo.fullName + "，未加入克隆队列", "info"); return }
        setUrl(repo.url); cloneSingle(repo.url, repo)
      }} disabled={cloning || loadingRepos} />)}
      <Button title="重新加载在线仓库" action={loadMyRepos} disabled={cloning || loadingRepos || loadingMyRepos} />
    </Section> : null}
  </List>
}
