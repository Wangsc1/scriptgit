/**
 * pages/RepoListPage.tsx - 仓库列表页
 *
 * 展示仓库来源（本地/克隆）、GitHub 仓库公开/私有标识，
 * 与改动/待推送/待拉取/合并冲突摘要。
 * 待处理仓库置顶，待处理组与普通组内分别按名称 A→Z 展示。
 * 状态优先显示上次快照，再由实时查询逐行覆盖；未有快照的行显示加载图标。
 * 移除仓库时会清理 gitdir 缓存与访问书签（见 repoStore.removeRepo）。
 */

import {
  List,
  ProgressView,
  Section,
  Text,
  HStack,
  VStack,
  Spacer,
  Image,
  Navigation,
  NavigationLink,
  Toolbar,
  ToolbarItem,
  Button,
  Menu,
  useState,
  useMemo,
  useRef,
  useEffect,
} from "scripting"
import type {
  RepoListStatus,
  RepoMeta,
  RepoSnapshot,
} from "../types/git"
import type { GitHubRepoVisibility } from "../types/github"
import {
  listRepos,
  addRepoByPicker,
  sourceLabel,
  updateBranchLastPulledAt,
} from "../services/repoStore"
import { getRepoListStatus, initRepo, removeRepo, autoPullFastForward } from "../services/gitService"
import { BusyOverlay } from "../components/BusyOverlay"
import { RepoDetailPage } from "./RepoDetailPage"
import { ClonePage } from "./ClonePage"
import {
  COLOR_LABEL,
  COLOR_SECONDARY_LABEL,
  COLOR_ORANGE,
  COLOR_RED,
} from "../constants/colors"
import { formatRepoListMergeSummary } from "../utils/mergeConflict"
import { githubRepoFromRemoteUrl } from "../utils/github"
import { yieldForUi } from "../utils/remoteProgress"
import { sortReposByGithubUpdated } from "../utils/repoSort"
import { useRepoListStatus, type RepoRefreshState } from "../hooks/useRepoListStatus"
import { useRepoSyncActions } from "../hooks/useRepoSyncActions"
import { useRepoVisibilities } from "../hooks/useRepoVisibilities"

export function RepoListPage() {
  // 关闭 present 的根界面（设置已独立为 Tab）
  const dismiss = Navigation.useDismiss()
  const [repos, setRepos] = useState<RepoMeta[]>(() => listRepos())
  const [showClone, setShowClone] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<RepoMeta | null>(null)
  const [alertState, setAlertState] = useState<{
    title: string
    message: string
  } | null>(null)
  const {
    statusMap, snapshotMap, repoRefreshMap, githubUpdatedProgress, refreshAll, refreshRepo, forgetRepo, appear, disappear,
  } = useRepoListStatus(setRepos)
  // 移除仓库忙态：删 gitdir 缓存对大仓库可能耗时，用全屏遮罩
  const [removingName, setRemovingName] = useState<string | null>(null)


  function showAlert(title: string, message: string) {
    setAlertState({ title, message })
  }

  function appendRepo(repo: RepoMeta) {
    setRepos((current) =>
      current.some((item) => item.bookmarkName === repo.bookmarkName)
        ? current
        : [...current, repo]
    )
    refreshRepo(repo)
  }

  async function handleAddLocal() {
    try {
      const repo = await addRepoByPicker()
      if (!repo) return
      // 添加后立刻 init，默认分支 main，避免上传 GitHub 时无分支
      try {
        await initRepo(repo.bookmarkName)
      } catch (initErr: any) {
        // init 失败仍保留列表项，进入详情可再试
        showAlert(
          "已添加，但初始化失败",
          String(initErr?.message || initErr)
        )
      }
      appendRepo(repo)
    } catch (e: any) {
      showAlert("添加失败", String(e?.message || e))
    }
  }

  async function doDelete() {
    const repo = pendingDelete
    setPendingDelete(null)
    if (!repo) return
    setRemovingName(repo.name)
    // 让出一帧，先渲染遮罩再执行可能耗时的缓存清理
    await yieldForUi()
    try {
      // removeRepo 会清元数据 + gitdir 缓存 + 访问书签 + 快照
      await removeRepo(repo.bookmarkName)
      setRepos((current) => {
        const next = current.filter(
          (item) => item.bookmarkName !== repo.bookmarkName
        )
        return next
      })
      forgetRepo(repo.bookmarkName)
    } catch (e: any) {
      showAlert("删除失败", String(e?.message || e))
    } finally {
      setRemovingName(null)
    }
  }

  const pulling = useRef<Promise<void> | null>(null)
  const singlePull = useRef<Promise<void> | null>(null)
  const [pullBusy, setPullBusy] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ completed: number; total: number; current: string } | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const [pushTarget, setPushTarget] = useState<RepoMeta | null>(null)
  const pushGate = useRef(false)
  const [pushProgress, setPushProgress] = useState<{ title: string; message?: string; onCancel?: () => void } | null>(null)
  const sync = useRepoSyncActions({
    bookmarkName: pushTarget?.bookmarkName || "",
    displayName: pushTarget?.name || "",
    currentBranch: null,
    hasRemote: false,
    resolvePushContext: async () => {
      if (!pushTarget) throw new Error("未选择仓库")
      const status = await getRepoListStatus(pushTarget.bookmarkName, undefined, { source: "列表提交", force: true })
      if (status.error || !status.workdirOk) throw new Error(status.error || "无法读取仓库")
      if (status.mergeInProgress || status.conflictCount) throw new Error("仓库存在未完成合并，请进入仓库处理")
      return { branch: status.branch || null, hasRemote: status.hasRemote }
    },
    beginOpBusy: async (title, message, onCancel) => { if (alive.current) setPushProgress({ title, message, onCancel }) },
    updateOpBusy: async (title, message) => { if (alive.current) setPushProgress(previous => ({ title, message, onCancel: previous?.onCancel })) },
    endOpBusy: () => { pushGate.current = false; if (alive.current) { setPushProgress(null); setPushTarget(null) } },
    makeSyncCancel: token => () => token.cancel(),
    setPulledAt: (branch, timestamp) => { if (pushTarget) updateBranchLastPulledAt(pushTarget.bookmarkName, branch, timestamp) },
    refreshSyncState: async () => { if (alive.current && pushTarget) refreshRepo(pushTarget) },
    reloadRepo: async () => { if (alive.current && pushTarget) refreshRepo(pushTarget) },
    showToast: message => { if (alive.current) showAlert("提交结果", message) },
    showConflictNotice: message => { if (alive.current) showAlert("合并冲突", message) },
  })
  useEffect(() => { if (pushTarget) void sync.handlePush() }, [pushTarget])
  function pushOne(repo: RepoMeta) {
    if (pushGate.current || pulling.current || singlePull.current) return
    pushGate.current = true
    setPushTarget(repo)
  }

  function pullOne(repo: RepoMeta): Promise<void> {
    if (pulling.current) return pulling.current
    if (pushGate.current) return Promise.resolve()
    if (singlePull.current) return singlePull.current
    setPullBusy(true)
    const pending = Promise.resolve().then(async () => {
      try {
        await yieldForUi()
        if (!alive.current || !listRepos().some(item => item.bookmarkName === repo.bookmarkName)) return
        const result = await autoPullFastForward(repo.bookmarkName, { includeAllSources: true })
        if (!alive.current) return
        refreshRepo(repo)
        showAlert(result.status === "skipped" ? "未拉取" : "拉取完成", `${repo.name}：${result.reason}`)
      } catch (e: any) {
        if (alive.current) showAlert("拉取失败", `${repo.name}：${String(e?.message || e)}`)
      }
    }).finally(() => {
      if (singlePull.current === pending) singlePull.current = null
      if (alive.current && !pulling.current) setPullBusy(false)
    })
    singlePull.current = pending
    return pending
  }

  // 下拉刷新显式拉取所有来源，复用在途任务；不先做一次无用的全仓扫描。
  function refreshAndPullAll(): Promise<void> {
    if (pulling.current) return pulling.current
    if (pushGate.current) return Promise.resolve()
    setPullBusy(true)
    setBatchProgress({ completed: 0, total: 1, current: "准备拉取…" })
    const pending = Promise.resolve().then(async () => {
      if (singlePull.current) await singlePull.current
      const targets = listRepos()
      let completed = 0
      if (alive.current) setBatchProgress({ completed, total: targets.length + 1, current: "准备拉取…" })
      const notes: string[] = []
      let updated = 0, unchanged = 0
      for (const repo of targets) {
        if (!alive.current) break
        // 运行期间被移除的仓库不再启动操作。
        if (!listRepos().some(item => item.bookmarkName === repo.bookmarkName)) { completed++; continue }
        setBatchProgress({ completed, total: targets.length + 1, current: `正在拉取 ${repo.name}` })
        await yieldForUi()
        try {
          const result = await autoPullFastForward(repo.bookmarkName, { includeAllSources: true })
          if (result.status === "updated") updated++
          else if (result.status === "unchanged") unchanged++
          else notes.push(`${repo.name}：${result.reason}`)
        } catch (e: any) {
          notes.push(`${repo.name}：拉取失败，${String(e?.message || e)}`)
        } finally {
          completed++
          if (alive.current) setBatchProgress({ completed, total: targets.length + 1, current: `已处理 ${completed}/${targets.length} 个仓库` })
        }
      }
      if (!alive.current) return
      setBatchProgress({ completed: targets.length, total: targets.length + 1, current: "正在刷新仓库状态…" })
      await refreshAll(true)
      if (alive.current && notes.length) showAlert("批量拉取结果", `已更新 ${updated} 个，已是最新或本地领先 ${unchanged} 个。\n${notes.join("\n")}`)
    }).finally(() => {
      if (pulling.current === pending) pulling.current = null
      if (alive.current) { setPullBusy(false); setBatchProgress(null) }
    })
    pulling.current = pending
    return pending
  }

  const activeAlert =
    pendingDelete != null
      ? {
          title: "移除仓库？",
          message: `将从列表移除「${pendingDelete.name}」，并清除本地 Git 缓存；不会删除工作区文件。`,
          isConfirm: true as const,
        }
      : alertState
        ? {
            title: alertState.title,
            message: alertState.message,
            isConfirm: false as const,
          }
        : null

  const showRemovingOverlay = removingName != null
  // 仅影响展示顺序，持久化的仓库数组仍保持添加顺序
  const sortedRepos = useMemo(() => sortReposByGithubUpdated(repos), [repos])
  // GitHub 仓库行显示公开/私有标识（本地无 GitHub 远端的仓库不显示）
  const visibilityTargets = useMemo(() => sortedRepos.map((repo) => ({
    key: repo.bookmarkName,
    fullName: githubRepoFromRemoteUrl(
      statusMap[repo.bookmarkName]?.originUrl ?? repo.remoteUrl
    ),
  })), [sortedRepos, statusMap])
  const visibilities = useRepoVisibilities(visibilityTargets)

  return (
    <List
      navigationTitle="scriptgit"
      navigationBarTitleDisplayMode="large"
      overlay={
        pushProgress
          ? { alignment: "center", content: <BusyOverlay title={pushProgress.title} message={pushProgress.message} onCancel={pushProgress.onCancel} /> }
          : showRemovingOverlay
          ? {
              alignment: "center",
              content: (
                <BusyOverlay
                  title="正在移除仓库"
                  message={`清理「${removingName}」的 Git 缓存…`}
                />
              ),
            }
          : undefined
      }
      onAppear={appear}
      onDisappear={disappear}
      refreshable={refreshAndPullAll}
      navigationDestination={{
        isPresented: showClone,
        onChanged: setShowClone,
        content: (
          <ClonePage
            onCloned={(repo, keepOpen) => {
              appendRepo(repo)
              if (!keepOpen) setShowClone(false)
            }}
          />
        ),
      }}
      alert={{
        title: activeAlert?.title ?? "",
        message: <Text>{activeAlert?.message ?? ""}</Text>,
        isPresented: activeAlert != null,
        onChanged: (presented: boolean) => {
          if (!presented) {
            setPendingDelete(null)
            setAlertState(null)
          }
        },
        actions: activeAlert?.isConfirm ? (
          <>
            <Button
              title="取消"
              role="cancel"
              action={() => setPendingDelete(null)}
            />
            <Button title="移除" role="destructive" action={doDelete} />
          </>
        ) : (
          <Button title="好" role="cancel" action={() => setAlertState(null)} />
        ),
      }}
      toolbar={
        <Toolbar>
          <ToolbarItem placement="topBarLeading">
            <Button action={dismiss}>
              <Image systemName="xmark" fontWeight="semibold" foregroundStyle="black" />
            </Button>
          </ToolbarItem>
          <ToolbarItem placement="primaryAction">
            <Menu title="添加" fontWeight="semibold" systemImage="plus">
              <Button
                title="添加本地仓库"
                systemImage="folder.badge.plus"
                action={handleAddLocal}
              />
              <Button
                title="克隆仓库"
                systemImage="square.and.arrow.down"
                action={() => setShowClone(true)}
              />
            </Menu>
          </ToolbarItem>
        </Toolbar>
      }
    >
      {batchProgress ? <Section>
        <ProgressView value={batchProgress.completed} total={batchProgress.total} progressViewStyle="linear"
          label={<Text font="caption">{batchProgress.current}</Text>} />
      </Section> : null}
      {repos.length > 0 ? <Section>
        {Object.values(repoRefreshMap).some(item => ["slow", "error", "deferred"].includes(item.phase)) ? <Text foregroundStyle={COLOR_ORANGE}>部分状态尚未确认，已有仓库和功能入口可继续使用；详情见对应仓库行。</Text> : null}
        {githubUpdatedProgress.failed > 0 ? <Text font="caption" foregroundStyle={COLOR_ORANGE}>部分 GitHub 更新时间未刷新，保留已有时间缓存。{githubUpdatedProgress.error}</Text> : null}
      </Section> : null}
      {repos.length === 0 ? (
        <Section>
          <Text font="callout" foregroundStyle={COLOR_SECONDARY_LABEL}>
            还没有仓库，点击右上角「+」添加本地目录或克隆远端。
          </Text>
        </Section>
      ) : (
        <Section>
          {sortedRepos.map((repo) => (
            <HStack
              key={repo.bookmarkName}
              alignment="center"
              trailingSwipeActions={{
                allowsFullSwipe: false,
                actions: [
                  <Button
                    title="拉取"
                    tint="systemBlue"
                    disabled={pullBusy || pushTarget !== null}
                    action={() => pullOne(repo)}
                  />,
                  ...(((statusMap[repo.bookmarkName]?.uncommitted ?? snapshotMap[repo.bookmarkName]?.uncommitted ?? 0) > 0
                    || (statusMap[repo.bookmarkName]?.ahead ?? snapshotMap[repo.bookmarkName]?.ahead ?? 0) > 0)
                    ? [<Button title="提交" tint="systemGreen" disabled={pullBusy || pushTarget !== null} action={() => pushOne(repo)} />] : []),
                  <Button
                    title="删除"
                    tint="systemRed"
                    disabled={pullBusy || pushTarget !== null}
                    action={() => setPendingDelete(repo)}
                  />,
                ],
              }}
            >
              <NavigationLink
                destination={
                  <RepoDetailPage
                    bookmarkName={repo.bookmarkName}
                    name={repo.name}
                  />
                }
              >
                <RepoRow
                  repo={repo}
                  status={statusMap[repo.bookmarkName]}
                  snapshot={snapshotMap[repo.bookmarkName]}
                  refresh={repoRefreshMap[repo.bookmarkName]}
                  visibility={visibilities[repo.bookmarkName]}
                />
              </NavigationLink>
            </HStack>
          ))}
        </Section>
      )}
    </List>
  )
}

/** 单行：左侧名称/来源，右侧（> 左边）加载图标或改动标识上下居中 */
function RepoRow({
  repo,
  status,
  snapshot,
  refresh,
  visibility,
}: {
  repo: RepoMeta
  status?: RepoListStatus
  snapshot?: RepoSnapshot
  refresh?: RepoRefreshState
  visibility?: GitHubRepoVisibility
}) {
  const source = sourceLabel(repo)
  const uncommitted = status?.uncommitted ?? snapshot?.uncommitted ?? 0
  const ahead = status?.ahead ?? snapshot?.ahead ?? 0
  const branch = status?.branch ?? snapshot?.branch

  // 状态就绪后才得出摘要；未就绪时行尾显示加载图标
  let trailing: { text: string; color: string } | null = null
  if (status != null) {
    if (status.workdirOk === false) {
      trailing = { text: "读取失败", color: COLOR_RED }
    } else {
      // 合并冲突优先于普通改动/待推送摘要
      const mergeSummary = formatRepoListMergeSummary({
        conflictCount: status.conflictCount ?? 0,
        mergeInProgress: status.mergeInProgress ?? false,
      })
      if (mergeSummary) {
        trailing = {
          text: mergeSummary,
          color: (status.conflictCount ?? 0) > 0 ? COLOR_RED : COLOR_ORANGE,
        }
      } else if (uncommitted > 0 || ahead > 0 || status.behind > 0) {
        const parts: string[] = []
        if (uncommitted > 0) parts.push(`${uncommitted} 改动`)
        if (ahead > 0) parts.push(`${ahead}推送`)
        if (status.behind > 0) parts.push(`${status.behind}拉取`)
        // 本地改动与同步待处理状态均用橙色。
        trailing = {
          text: parts.join(" · "),
          color: COLOR_ORANGE,
        }
      } else {
        trailing = { text: "无改动", color: COLOR_SECONDARY_LABEL }
      }
    }
  }

  return (
    <HStack alignment="center" spacing={10}>
      <VStack alignment="leading" spacing={2}>
        <Text font="headline" foregroundStyle={COLOR_LABEL}>
          {repo.name}
        </Text>
        <HStack alignment="center" spacing={4}>
          <Text font="caption" foregroundStyle={COLOR_SECONDARY_LABEL}>
            {source}
            {branch ? ` · ${branch}` : ""}
          </Text>
          {visibility ? (
            <HStack alignment="center" spacing={3}>
              <Image
                systemName={visibility === "private" ? "lock.fill" : "globe"}
                font={11}
                imageScale="small"
                foregroundStyle={COLOR_SECONDARY_LABEL}
              />
              <Text font="caption" foregroundStyle={COLOR_SECONDARY_LABEL}>
                {visibility === "private" ? "私有" : "公开"}
              </Text>
            </HStack>
          ) : null}
        </HStack>
        {refresh?.message && ["slow", "error", "deferred"].includes(refresh.phase) ? <Text font="caption" foregroundStyle={refresh.phase === "error" ? COLOR_RED : COLOR_ORANGE}>{refresh.message}</Text> : null}
      </VStack>
      <Spacer />
      {/* 放在 NavigationLink 自带 > 的左侧，整行垂直居中 */}
      {status == null ? (
        <HStack spacing={8}>
          {snapshot &&
          (uncommitted > 0 || ahead > 0 || snapshot.behind > 0) ? (
            <Text font={12} foregroundStyle={COLOR_ORANGE}>
              {[
                uncommitted > 0 ? `${uncommitted} 改动` : "",
                ahead > 0 ? `${ahead}推送` : "",
                snapshot.behind > 0 ? `${snapshot.behind}拉取` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          ) : null}
          {refresh && ["slow", "error", "deferred"].includes(refresh.phase) ? <Text font="caption" foregroundStyle={COLOR_ORANGE}>状态未确认</Text> : null}
        </HStack>
      ) : trailing ? (
        <Text font="caption" foregroundStyle={trailing.color as any}>
          {trailing.text}
        </Text>
      ) : null}
    </HStack>
  )
}
