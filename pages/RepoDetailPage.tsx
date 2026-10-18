/**
 * pages/RepoDetailPage.tsx - 仓库详情页
 *
 * 只负责声明式 UI 与各编排 hook 的接线：
 * - 数据加载与 Tab 懒加载：hooks/useRepoDetailData
 * - 全屏操作遮罩：hooks/useOpBusy
 * - 子页导航：hooks/useRepoDetailNavigation
 * - 工作区（暂存 / Stash / 提交）：hooks/useRepoWorktreeActions
 * - 需确认的操作（丢弃 / 删分支 / 撤销 / 回退 / 重编 / 回滚）：hooks/useRepoPendingActions
 * - 分支与同步动作：hooks/useRepoBranchActions、hooks/useRepoSyncActions
 */

import { List, Text, Button, Menu, useState, useRef, useEffect } from "scripting"
import { RepoDiagnosticsPage } from "./RepoDiagnosticsPage"
import { LocalImagePreview } from "../components/LocalImagePreview"
import { LocalFileEditor } from "./LocalFileEditor"
import type { LocalWorktreeFile } from "../services/gitService"
import { BusyOverlay } from "../components/BusyOverlay"
import { toastContent } from "../components/Toast"
import { useToast } from "../hooks/useToast"
import { RepoBranchSection } from "../components/RepoBranchSection"
import { RepoRemoteSections } from "../components/RepoRemoteSections"
import {
  MergeConflictSection,
  RepoDetailTabContent,
} from "../components/RepoDetailContent"
import { RepoDetailDestination } from "../components/RepoDetailDestination"
import { useLocalEntryCreation } from "../hooks/useLocalEntryCreation"
import { CommitMessageSheet } from "../components/CommitMessageSheet"
import { useOpBusy } from "../hooks/useOpBusy"
import { useRepoDetailData } from "../hooks/useRepoDetailData"
import { useRepoDetailNavigation } from "../hooks/useRepoDetailNavigation"
import type { RepoDetailPageKey } from "../hooks/useRepoDetailNavigation"
import { useRepoWorktreeActions } from "../hooks/useRepoWorktreeActions"
import { useRepoPendingActions } from "../hooks/useRepoPendingActions"
import { useRepoBranchActions } from "../hooks/useRepoBranchActions"
import { useRepoSyncActions } from "../hooks/useRepoSyncActions"
import { updateBranchLastPulledAt } from "../services/repoStore"
import { buildCommitMessage, shortOid, suggestCommitTitle } from "../utils/format"
import { getRepoPendingAlert } from "../utils/repoDetailAlerts"

type AlertState = {
  title: string
  message: string
  /** 关闭提示后要打开的子页（如合并冲突 → 冲突页），保证提示在跳转前可见 */
  nextPage?: RepoDetailPageKey
} | null

export function RepoDetailPage({
  bookmarkName,
  name,
}: {
  bookmarkName: string
  name: string
}) {
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [localFile, setLocalFile] = useState<{ file: LocalWorktreeFile; id: number } | null>(null)
  const localSession = useRef(0)
  const [localImage, setLocalImage] = useState<{ file: LocalWorktreeFile; id: number } | null>(null)
  const activeImage = useRef<number | null>(null)
  useEffect(() => () => { activeImage.current = null }, [])
  function closeLocalImage(id: number) {
    if (activeImage.current !== id) return
    activeImage.current = null
    setLocalImage(null)
  }
  function openLocalFile(file: LocalWorktreeFile) {
    const id = ++localSession.current
    if (file.previewDataUrl || file.previewImage) {
      activeImage.current = id
      setLocalImage({ file, id })
    } else {
      activeImage.current = null
      setLocalImage(null)
      setLocalFile({ file, id })
    }
  }
  const [alertState, setAlertState] = useState<AlertState>(null)
  const { toastState, showToast, handleToastChanged, toastPresented } = useToast()

  function showAlert(title: string, message: string, nextPage?: RepoDetailPageKey) {
    setAlertState({ title, message, nextPage })
  }

  // 关闭提示后再跳转：提示挂在详情页，先跳转就会被推入的页面遮住
  function handleAlertDismiss() {
    const next = alertState?.nextPage
    pendingActions.clearPending()
    setAlertState(null)
    if (next) setTimeout(() => nav.openPage(next), 350)
  }

  // 合并冲突：先在详情页提示，用户确认后再打开冲突页
  function showConflictNotice(message: string) {
    showAlert(
      "合并冲突",
      message + "\n关闭后将打开「合并冲突」页处理。",
      "conflicts"
    )
  }

  const data = useRepoDetailData({ bookmarkName, name, showToast })
  const { opBusy, beginOpBusy, updateOpBusy, endOpBusy, makeSyncCancel } =
    useOpBusy()
  const nav = useRepoDetailNavigation()

  const worktree = useRepoWorktreeActions({
    bookmarkName,
    displayName: data.displayName,
    changes: data.changes,
    mergeInProgress: data.mergeInProgress,
    beginOpBusy,
    endOpBusy,
    clearChanges: () => data.setChanges([]),
    reloadRepo: data.loadAll,
    refreshChangesAndSnapshot: data.refreshChangesAndSnapshot,
    loadChanges: data.loadChanges,
    loadStashes: data.loadStashes,
    setPending: (action) => pendingActions.setPending(action),
    showToast,
  })

  const pendingActions = useRepoPendingActions({
    bookmarkName,
    hasRemote: data.hasRemote,
    currentBranch: data.branchInfo.current,
    remoteOnlyBranches: data.remoteOnlyBranches,
    mergeInProgress: data.mergeInProgress,
    beginOpBusy,
    updateOpBusy,
    endOpBusy,
    makeSyncCancel,
    reloadRepo: data.loadAll,
    loadStashes: data.loadStashes,
    setStashBusy: worktree.setStashBusy,
    openAmendSheet: () => worktree.setCommitSheetMode("amend"),
    closeCommitSheet: worktree.closeCommitSheet,
    closeRollbackPage: () => nav.closePage("rollback"),
    showAlert,
    showToast,
  })

  // 仓库级互斥：任一写操作进行中时禁用分支切换、暂存、提交、同步、合并、撤销等
  const mutating =
    worktree.committing ||
    worktree.stagingBusy ||
    worktree.stashBusy ||
    opBusy != null

  const branchUnavailable = data.branchStateKnown === false

  const localCreation = useLocalEntryCreation({
    bookmarkName, unavailable: mutating || data.mergeInProgress,
    onChanged: data.refreshChangesAndSnapshot,
    onError: message => showToast(message, "error"),
  })

  const {
    handleMergeIntoCurrent,
    handleSwitchBranch,
    handleRenameBranch,
    handleCreateBranch,
  } = useRepoBranchActions({
    bookmarkName,
    currentBranch: data.branchInfo.current,
    hasCommits: data.hasCommits,
    hasRemote: data.hasRemote,
    mutating: mutating || branchUnavailable,
    mergeInProgress: data.mergeInProgress,
    beginOpBusy,
    endOpBusy,
    reloadRepo: data.loadAll,
    showAlert,
    showToast,
    showConflictNotice,
  })

  const { handlePush: performPush, handlePull: performPull } = useRepoSyncActions({
    bookmarkName,
    displayName: data.displayName,
    currentBranch: data.branchInfo.current,
    hasRemote: data.hasRemote,
    beginOpBusy,
    updateOpBusy,
    endOpBusy,
    makeSyncCancel,
    setPulledAt: (branch, timestamp) => {
      updateBranchLastPulledAt(bookmarkName, branch, timestamp)
      data.setLastPulledAt(timestamp)
    },
    refreshSyncState: data.refreshSyncState,
    reloadRepo: data.loadAll,
    showToast,
    showConflictNotice,
  })

  async function handlePush() {
    if (branchUnavailable) { showToast("分支信息未确认，请下拉重试", "warning"); return }
    await performPush()
  }
  /** 左滑/文件夹的「推送」：有改动 → 弹出提交说明，确认后全部暂存、提交并推送；无改动 → 只推送已有提交。 */
  function requestCommitAndPush() {
    if (branchUnavailable) { showToast("分支信息未确认，请下拉重试", "warning"); return }
    if (mutating || data.mergeInProgress) return
    if (data.changes.length === 0) { void performPush(); return }
    worktree.setCommitSheetMode("push")
  }
  async function confirmCommitAndPush(title: string, description: string) {
    const message = buildCommitMessage(title, description)
    if (!title.trim()) { setPushSheetError("请填写提交信息（标题）"); return }
    setPushSheetError(null)
    worktree.closeCommitSheet()
    await performPush(message)
  }
  async function handlePull() {
    if (branchUnavailable) { showToast("分支信息未确认，请下拉重试", "warning"); return }
    await performPull()
  }

  async function handleRefresh() {
    // 写操作完成后已有统一刷新，此时不再并发读取其它 Tab 的中间状态。
    if (mutating) return
    await data.loadAll("详情下拉", true)
  }

  const confirmAlert = pendingActions.pending
    ? getRepoPendingAlert(pendingActions.pending)
    : null

  const activeAlert =
    confirmAlert != null
      ? { ...confirmAlert, isConfirm: true as const }
      : alertState
        ? {
            title: alertState.title,
            message: alertState.message,
            isConfirm: false as const,
            confirmButton: alertState.nextPage ? "去处理" : "好",
          }
        : null

  const [pushSheetError, setPushSheetError] = useState<string | null>(null)
  const canUpload = !data.hasRemote && data.repoSource !== "clone"

  return (
    <List
      fullScreenCover={[{
        isPresented: localFile !== null,
        // 与远端编辑器一致：由稳定 List 承载，不由条件 Tab 下的 Section 承载。
        // 全屏不使用交互式下拉关闭；关闭按钮检查未保存草稿。
        onChanged: () => {},
        content: localFile ? <LocalFileEditor key={`${localFile.file.path}:${localFile.id}`} bookmarkName={bookmarkName} file={localFile.file} initialHasChanges={data.changes.some(change => change.filepath === localFile.file.path)}
          onClose={() => setLocalFile(null)} onReload={openLocalFile} onChanged={async () => {
            try { await data.refreshChangesAndSnapshot() }
            catch (error: any) { showToast(`文件已保存，但状态刷新失败：${String(error?.message || error)}`, "warning"); throw error }
          }} /> : <Text>加载中…</Text>,
      }, {
        // Same presentation family as the existing diff/GitHub image viewers
        // (fullScreenCover), separate from the editor entry: the system owns the
        // modal dismissal motion; no custom drag/edge gesture is installed.
        isPresented: localImage !== null,
        onChanged: (presented: boolean) => { if (!presented && localImage) closeLocalImage(localImage.id) },
        content: localImage ? <LocalImagePreview key={localImage.id} sessionId={localImage.id} file={localImage.file}
          onClose={() => closeLocalImage(localImage.id)} /> : <Text>加载中…</Text>,
      }, {
        isPresented: showDiagnostics,
        onChanged: setShowDiagnostics,
        content: showDiagnostics ? <RepoDiagnosticsPage bookmarkName={bookmarkName} onAssociated={data.acceptHeadAssociation} onClose={() => setShowDiagnostics(false)} /> : <Text>加载中…</Text>,
      }]}
      navigationTitle={data.displayName}
      navigationBarTitleDisplayMode="inline"
      tabBarVisibility="hidden"
      overlay={
        opBusy
          ? {
            alignment: "center",
            content: (
              <BusyOverlay
                title={opBusy.title}
                message={opBusy.message}
                onCancel={opBusy.onCancel}
                cancelling={opBusy.cancelling}
              />
            ),
          }
          : undefined
      }
      toast={
        toastState
          ? {
              isPresented: toastPresented,
              onChanged: handleToastChanged,
              content: toastContent(toastState.message, toastState.type),
              duration: toastState.duration,
              position: "top",
            }
          : undefined
      }
      onAppear={() => {
        if (nav.consumeSkipNextAppearLoad()) return
        data.loadAll("详情出现", false)
      }}
      refreshable={handleRefresh}
      toolbar={{
        topBarTrailing: data.githubFullName ? (
          <Menu title="GitHub" systemImage="rectangle.stack">
            <Button title="Edit Remote Files" systemImage="doc.text" action={() => nav.openGitHubWorkPage(3)} />
            <Button
              title="Issues"
              systemImage="smallcircle.filled.circle"
              action={() => nav.openGitHubWorkPage(0)}
            />
            <Button
              title="Pull Requests"
              systemImage="arrow.triangle.merge"
              action={() => nav.openGitHubWorkPage(1)}
            />
            <Button
              title="Actions"
              systemImage="hammer.fill"
              action={() => nav.openGitHubWorkPage(2)}
            />
          </Menu>
        ) : undefined,
      }}
      navigationDestination={{
        isPresented: nav.isPresented,
        onChanged: (presented: boolean) => {
          if (!presented) {
            nav.closeAll()
            // 从冲突页返回时刷新合并状态
            data.loadMergeState()
          }
        },
        content: (
          <RepoDetailDestination
            bookmarkName={bookmarkName}
            displayName={data.displayName}
            showUpload={nav.page === "upload"}
            showRemotes={nav.page === "remotes"}
            showConflicts={nav.page === "conflicts"}
            showCompare={nav.page === "compare"}
            showRollback={nav.page === "rollback"}
            currentBranch={data.branchInfo.current}
            githubFullName={
              nav.page === "githubWork" ? data.githubFullName : null
            }
            githubWorkKind={nav.githubWorkKind}
            commitGithubFullName={data.githubFullName}
            selectedCommitOid={nav.selectedCommitOid}
            onRollbackSelect={pendingActions.handleRollbackSelect}
            onUploaded={(repo) => {
              data.setDisplayName(repo.name)
              data.setRepoSource(repo.source || "clone")
              data.setHasRemote(true)
              nav.closePage("upload")
              data.loadAll().then(() => {
                showToast("上传成功：已上传到 " + repo.name, "success")
              })
            }}
            onRemotesChanged={() => {
              data.refreshRemoteConfig()
            }}
            onConflictsChanged={(reason) => {
              if (reason === "completed") {
                // 完成合并后避免返回详情页时再做一次全树扫描（P2.42）
                nav.skipNextAppearLoad()
              }
              data.loadMergeState()
              data.loadChanges()
              data.refreshHistoryIfLoaded()
            }}
          />
        ),
      }}
      sheet={{
        isPresented: worktree.commitSheetMode != null,
        onChanged: (presented: boolean) => {
          if (!presented) worktree.closeCommitSheet()
        },
        content: worktree.commitSheetMode === "push" ? (
          <CommitMessageSheet
            key="push"
            navigationTitle="提交并推送"
            confirmTitle="推送"
            footer="将暂存全部改动并提交，再推送到远端。"
            initialTitle={`更新 ${data.changes.length} 个文件`}
            initialDescription=""
            error={pushSheetError}
            onCancel={() => { setPushSheetError(null); worktree.closeCommitSheet() }}
            onConfirm={confirmCommitAndPush}
          />
        ) : worktree.commitSheetMode === "amend" ? (
          <CommitMessageSheet
            key={`amend-${pendingActions.amendDraft.title}`}
            navigationTitle="重编提交"
            confirmTitle="提交"
            footer="确认后将改写最近一次提交。只能用于尚未推送的 HEAD，已推送会被拒绝。"
            initialTitle={pendingActions.amendDraft.title}
            initialDescription={pendingActions.amendDraft.description}
            error={pendingActions.amendError}
            onCancel={worktree.closeCommitSheet}
            onConfirm={pendingActions.handleAmendFormConfirm}
          />
        ) : (
          <CommitMessageSheet
            navigationTitle="提交改动"
            confirmTitle="提交"
            initialTitle={suggestCommitTitle(data.changes)}
            initialDescription=""
            busy={worktree.committing}
            error={worktree.commitError}
            onCancel={worktree.closeCommitSheet}
            onConfirm={worktree.handleCommit}
          />
        ),
      }}
      alert={{
        title: activeAlert?.title ?? "",
        message: <Text>{activeAlert?.message ?? ""}</Text>,
        isPresented: activeAlert != null,
        onChanged: (presented: boolean) => {
          if (!presented) {
            pendingActions.clearPending()
            setAlertState(null)
          }
        },
        actions: activeAlert?.isConfirm ? (
          <>
            <Button
              title="取消"
              role="cancel"
              action={pendingActions.clearPending}
            />
            <Button
              title={activeAlert.confirmButton}
              role="destructive"
              action={pendingActions.runPending}
            />
          </>
        ) : (
          <Button
            title={activeAlert?.confirmButton ?? "好"}
            role={alertState?.nextPage ? undefined : "cancel"}
            action={handleAlertDismiss}
          />
        ),
      }}
    >
      <Button title="仓库诊断与 HEAD 关联" systemImage="info.circle" action={() => { nav.skipNextAppearLoad(); setShowDiagnostics(true) }} />
      <RepoBranchSection
        branchInfo={data.branchInfo}
        branchesLoaded={data.branchesLoaded}
        branchLoading={data.branchLoading}
        branchError={data.branchError}
        remoteOnlyBranches={data.remoteOnlyBranches}
        remoteBranchNames={data.remoteBranchNames}
        mergeSources={data.mergeSources}
        deletableBranches={data.deletableBranches}
        hasCommits={data.hasCommits}
        hasRemote={data.hasRemote}
        mergeInProgress={data.mergeInProgress}
        mutating={mutating}
        onDelete={pendingActions.requestDeleteBranch}
        onMerge={handleMergeIntoCurrent}
        onRename={handleRenameBranch}
        onCreate={handleCreateBranch}
        onSwitch={handleSwitchBranch}
      />

      {data.mergeInProgress ? (
        <MergeConflictSection
          conflictCount={data.conflictCount}
          mutating={mutating}
          onOpen={nav.openConflictsPage}
        />
      ) : null}

      <RepoRemoteSections
        branchInfo={data.branchInfo}
        branchUnavailable={branchUnavailable}
        upstream={data.upstream}
        pulledLabel={data.pulledLabel}
        hasRemote={data.hasRemote}
        canUpload={canUpload}
        mergeInProgress={data.mergeInProgress}
        mutating={mutating}
        hasCommits={data.hasCommits}
        onCompare={() => nav.openPage("compare", { skipReload: true })}
        onRollback={() => nav.openPage("rollback")}
        onManageRemotes={() => nav.openPage("remotes")}
        onUpload={() => nav.openPage("upload")}
        onPush={handlePush}
        onPull={handlePull}
      />

      <RepoDetailTabContent
        tab={data.tab}
        onTabChange={data.handleTabChange}
        bookmarkName={bookmarkName}
        changes={data.changes}
        stashes={data.stashes}
        log={data.log}
        trackedFiles={data.trackedFiles}
        onOpenLocalFile={openLocalFile}
        creationActive={localCreation.busy}
        onCreateLocalEntry={localCreation.open}
        onWorktreeChanged={async () => { await data.refreshChangesAndSnapshot() }}
        loading={data.loading}
        mergeInProgress={data.mergeInProgress}
        onPush={requestCommitAndPush}
        onStage={worktree.handleStagePaths}
        onRestore={worktree.handleRestore}
        committing={worktree.committing}
        stagingBusy={worktree.stagingBusy}
        stashBusy={worktree.stashBusy}
        onCreateStash={worktree.handleCreateStash}
        onApplyStash={worktree.handleApplyStash}
        onDropStash={worktree.handleDropStash}
        onCopyCommit={async (entry) => {
          try {
            // 只复制完整 oid，不要其它信息
            await Pasteboard.setString(entry.oid)
            showToast("已复制：" + shortOid(entry.oid), "success")
          } catch (e: any) {
            showToast("复制失败：" + String(e?.message || e), "error")
          }
        }}
        onSelectCommit={(entry) => nav.openCommitDetail(entry.oid)}
        onRevert={pendingActions.handleRevertRequest}
        onSoftReset={pendingActions.handleSoftResetRequest}
        onAmend={pendingActions.handleAmendRequest}
        onSearch={data.handleHistorySearch}
        onLoadMore={data.handleHistoryLoadMore}
        historyHasMore={data.historyHasMore}
        historySearchBusy={data.historySearchBusy}
        historyTotalMatches={data.historyTotalMatches}
        historyLoading={data.historyLoading}
        historyLimited={data.historyLimited}
        githubFullName={data.githubFullName}
      />
    </List>
  )
}
