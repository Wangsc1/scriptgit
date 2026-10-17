/** 单个/按用户名批量克隆；默认 iCloud Drive/Scripting/git，不静默回落本地。 */
import { List, Section, Text, Button, useState, useEffect, useRef } from "scripting"
import { FormRow } from "../components/FormRow"
import { BusyOverlay } from "../components/BusyOverlay"
import { toastContent } from "../components/Toast"
import { useToast } from "../hooks/useToast"
import type { GitHubRepo, RepoMeta } from "../types/git"
import { pickDirectory } from "../services/repoStore"
import { RemoteCancelToken } from "../services/gitService"
import { cloneRoot, prepareCloneRoot, type CloneDestination } from "../services/cloneWorkspace"
import { runCloneQueue, type CloneRequest, type CloneResult } from "../services/cloneQueue"
import { hasToken } from "../services/authStore"
import { notifySync, notifyError } from "../services/notifyService"
import { listMyRepos, listOwnedRepos } from "../api/githubApi"
import { repoNameFromUrl } from "../utils/format"
import { yieldForUi } from "../utils/remoteProgress"

const STATUS = { cloned: "成功", failed: "失败", skipped: "跳过", cancelled: "取消" }

export function ClonePage({ onCloned }: { onCloned: (repo: RepoMeta, keepOpen?: boolean) => void }) {
  const [url, setUrl] = useState("")
  const [destination, setDestination] = useState<CloneDestination>({ kind: "icloud" })
  const [rootLabel, setRootLabel] = useState("iCloud Drive/Scripting/git")
  const [directoryError, setDirectoryError] = useState("")
  const [cloning, setCloning] = useState(false)
  const [progress, setProgress] = useState("")
  const [cancelling, setCancelling] = useState(false)
  const [myRepos, setMyRepos] = useState<GitHubRepo[]>([])
  const [loadingMyRepos, setLoadingMyRepos] = useState(false)
  const [myReposError, setMyReposError] = useState("")
  const [username, setUsername] = useState("")
  const [loadedUser, setLoadedUser] = useState("")
  const [ownedRepos, setOwnedRepos] = useState<GitHubRepo[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [results, setResults] = useState<CloneResult[]>([])
  const [listError, setListError] = useState("")
  const alive = useRef(true)
  const locked = useRef(false)
  const listRequest = useRef(0)
  const directoryRequest = useRef(0)
  const cancelRef = useRef<RemoteCancelToken | null>(null)
  const { toastState, showToast, handleToastChanged, toastPresented } = useToast()

  useEffect(() => {
    configureDestination({ kind: "icloud" })
    if (hasToken()) loadMyRepos()
    return () => { alive.current = false; listRequest.current++; directoryRequest.current++; cancelRef.current?.cancel() }
  }, [])

  async function loadMyRepos() {
    setLoadingMyRepos(true); setMyReposError("")
    try {
      const repos = await listMyRepos(20)
      if (alive.current) setMyRepos(repos)
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
      if (alive.current && id === directoryRequest.current) setRootLabel(root)
    } catch (e: any) {
      if (alive.current && id === directoryRequest.current) {
        setRootLabel(next.kind === "icloud" ? "iCloud Drive/Scripting/git（不可用）" : next.parentPath + "/git")
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

  async function loadUser() {
    if (locked.current || loadingRepos) return
    const id = ++listRequest.current
    const target = username.trim()
    setLoadingRepos(true); setListError(""); setOwnedRepos([]); setSelected([]); setLoadedUser("")
    try {
      const repos = await listOwnedRepos(target)
      if (!alive.current || id !== listRequest.current) return
      setOwnedRepos(repos); setSelected(repos.map(repo => repo.fullName)); setLoadedUser(target)
    } catch (e: any) {
      if (alive.current && id === listRequest.current) setListError("加载失败，未开始克隆：" + String(e?.message || e))
    } finally { if (alive.current && id === listRequest.current) setLoadingRepos(false) }
  }

  async function execute(requests: CloneRequest[], batch: boolean) {
    if (locked.current || loadingRepos || !requests.length) return
    locked.current = true
    const token = new RemoteCancelToken()
    cancelRef.current = token
    setCloning(true); setCancelling(false); setProgress("检查目标目录")
    try {
      const root = cloneRoot(destination)
      if (batch) {
        const confirmed = await Dialog.confirm({ title: `批量克隆 ${requests.length} 个仓库？`,
          message: `用户：${loadedUser}\n目标：${root}/<repo>\n逐个下载并注册；同名/已存在项目跳过，绝不覆盖。`, confirmLabel: "开始克隆" })
        if (confirmed !== true || !alive.current) return
      }
      setResults([])
      const completed = await runCloneQueue(requests, destination, {
        cancelToken: token,
        onProgress: async (index, total, name, detail) => {
          if (alive.current) setProgress(`${index}/${total} · ${name}\n${detail}`)
          await yieldForUi()
        },
        onResult: result => { if (alive.current) setResults(current => [...current, result]) },
        onRegistered: repo => { if (batch) onCloned(repo, true) },
      })
      if (!alive.current) return
      if (!batch && completed[0]?.repo) {
        await notifySync("clone", requests[0].name, requests[0].url)
        onCloned(completed[0].repo)
      } else if (!batch && completed[0]?.status === "failed") {
        await notifyError("clone", requests[0].name, completed[0].message)
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
    <Section header={<Text>目标目录</Text>} footer={<Text>每个仓库保存到 git/&lt;repo&gt;。更改目录时请选择父目录，其下自动创建 git。默认不会落回本地文稿。</Text>}>
      <Text>{rootLabel}</Text>
      {directoryError ? <Text foregroundStyle="red">{directoryError}</Text> : null}
      <Button title="更改目录" action={changeDirectory} disabled={cloning || loadingRepos} />
      <Button title="使用默认 iCloud/Scripting/git / 重试" action={() => configureDestination({ kind: "icloud" })} disabled={cloning || loadingRepos} />
    </Section>
    <Section header={<Text>单个仓库</Text>}>
      <FormRow label="Git URL" prompt="https://github.com/user/repo.git" value={url} onChanged={setUrl} />
      <Button title="克隆" action={() => cloneSingle()} disabled={cloning || loadingRepos || !url.trim()} />
    </Section>
    <Section header={<Text>按 GitHub 用户名批量添加</Text>} footer={<Text>加载该用户名拥有、且当前 Token 可访问的全部仓库（含本人已授权的私有仓库）。默认全选，加载完整列表后才能开始。</Text>}>
      <FormRow label="用户名" prompt="GitHub 用户名" value={username} onChanged={setUsername} />
      <Button title={loadingRepos ? "正在分页加载全部仓库…" : "加载全部仓库"} action={loadUser} disabled={cloning || loadingRepos || !username.trim()} />
      {listError ? <Text foregroundStyle="red">{listError}</Text> : null}
      {loadedUser ? <>
        <Text>{loadedUser} · 共 {ownedRepos.length} 个 · 已选 {selectedRepos.length} 个</Text>
        <Button title="全选" action={() => setSelected(ownedRepos.map(repo => repo.fullName))} disabled={cloning} />
        <Button title="取消全选" action={() => setSelected([])} disabled={cloning} />
        {ownedRepos.map(repo => <Button key={repo.fullName} title={`${selected.includes(repo.fullName) ? "☑" : "☐"} ${repo.fullName}${repo.private ? "（私有）" : ""}`}
          action={() => setSelected(current => current.includes(repo.fullName) ? current.filter(name => name !== repo.fullName) : [...current, repo.fullName])} disabled={cloning} />)}
        <Button title={`批量克隆所选 ${selectedRepos.length} 个仓库`} action={() => execute(selectedRepos.map(repo => ({ name: repo.name, url: repo.url, githubRepo: repo })), true)} disabled={cloning || loadingRepos || !selectedRepos.length} />
      </> : null}
    </Section>
    {results.length ? <Section header={<Text>本次结果</Text>} footer={<Text>失败可重跑；已完成项目与现有目录自动跳过，不覆盖也不重复注册。取消为协作式，可能等待当前请求结束。</Text>}>
      <Text>{counts}</Text>
      {results.map((item, index) => <Text key={`${index}:${item.url}`} foregroundStyle={item.status === "failed" ? "red" : "label"}>{`${STATUS[item.status]} · ${item.name}\n${item.path}\n${item.message}`}</Text>)}
    </Section> : null}
    {hasToken() ? <Section header={<Text>我的 GitHub 仓库（单个克隆）</Text>}>
      {loadingMyRepos ? <Text>加载中…</Text> : null}
      {myReposError ? <Text foregroundStyle="red">{myReposError}</Text> : null}
      {myRepos.map(repo => <Button key={repo.fullName} title={repo.fullName} action={() => { setUrl(repo.url); cloneSingle(repo.url, repo) }} disabled={cloning || loadingRepos} />)}
      <Button title="重新加载在线仓库" action={loadMyRepos} disabled={cloning || loadingRepos || loadingMyRepos} />
    </Section> : null}
  </List>
}
