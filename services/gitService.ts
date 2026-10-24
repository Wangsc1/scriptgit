import { trackLocalRename } from "./git/localRenameHistory"
export { knownLocalRenameHints } from "./git/localRenameHistory"
/**
 * services/gitService.ts - 高层 Git 操作封装
 *
 * 基于 gitCore（引擎 + fs）与 repoStore，向上提供面向 bookmarkName 的语义化 Git 操作。
 * .git 分离存储：gitdir 放 App Group git-repos/<repoId>/，工作区走安全范围书签解析。
 */

import { runWithBackgroundKeepAlive } from "./git/runtime"
import { prepareRestoreScopeInternal, restoreScopeInternal, type RestoreScopePlan } from "./git/restoreScopeService"
export type { RestoreScopePlan } from "./git/restoreScopeService"
import { autoPullInternal, type AutoPullOptions, type AutoPullOutcome } from "./git/autoPullService"
export type { AutoPullOptions, AutoPullOutcome } from "./git/autoPullService"
import {
  applyStashInternal,
  dropStashInternal,
  listStashes,
} from "./git/stashService"
import {
  compareCommitTrees,
  getCommitDetail,
} from "./git/commitService"
import { compareWithUpstream } from "./git/compareService"
import {
  getBranches,
  getCurrentBranchName,
  getManagedBranches,
  getRemoteBranches,
} from "./git/branchQueryService"
import {
  getChanges,
  getLog,
  getLogPage,
  getHistoryCacheStats,
  getHistoryTotal,
  hasHeadCommit,
  getTrackedFiles,
} from "./git/statusQueryService"
import { getRepoListStatus } from "./git/repoStatusReadService"
import { runStatusMutation, runStatusRead } from "./git/statusScanService"
import { importLocalFilesInternal, moveLocalFileInternal, importLocalDirectoryInternal, createLocalEntryInternal, importLocalFileInternal, copyLocalDirectoryInternal, renameLocalDirectoryInternal, deleteLocalDirectoryInternal, readLocalFileForOpenInternal, copyLocalFileInternal, renameLocalFileInternal, readLocalFileInternal, saveLocalFileInternal, deleteLocalFileInternal, type LocalWorktreeFile } from "./git/localFileService"
export type { LocalWorktreeFile } from "./git/localFileService"
export { getRepoListStatus }
export { getWorktreeEntries, type WorktreeEntries } from "./git/worktreeTreeService"
export { getCachedRepoStatus, statusRevision } from "./git/statusScanService"
import {
  amendHeadCommitInternal,
  revertCommitInternal,
  resetToCommitAndPushInternal,
  softResetHeadInternal,
} from "./git/historyMutationService"
import {
  addRemoteInternal,
  deleteRemoteInternal,
  getBranchUpstream,
  hasRemoteBranch,
  listRemotes,
  setBranchUpstreamInternal,
  setRemoteUrlInternal,
} from "./git/remoteConfigService"
export type { RemoteInfo } from "./git/remoteConfigService"
import {
  checkoutBranchInternal,
  createBranchInternal,
  deleteBranchInternal,
  deleteRemoteBranchInternal,
  renameBranchInternal,
} from "./git/branchService"
import {
  abortMergeInternal,
  autoMarkResolvedConflictsInternal,
  completeMergeInternal,
  getMergeConflictState,
  listConflictFiles,
  resolveConflictFileInternal,
} from "./git/mergeConflictService"
import {
  mergeBranchIntoCurrentInternal,
  pullInternal,
} from "./git/mergeService"
import {
  cloneInternal,
  fetchRemoteInternal,
  syncOriginBranchesInternal,
  pushInternal,
  setOriginAndPushInternal,
  type CloneOptions,
} from "./git/remoteService"
import {
  addFilesInternal,
  commitInternal,
  createStashInternal,
  initRepoInternal,
  isInitialized,
  restoreFileInternal,
  unstageFilesInternal,
} from "./git/worktreeService"
import { getRepoId, removeRepo as removeRepoInternal } from "./repoStore"
import type {
  AutoMarkConflictsResult,
  ConflictResolution,
} from "../utils/mergeConflict"
import type {
  MergeIntoCurrentResult,
  PullResult,
} from "../utils/branchMerge"
import type { RemoteOpOptions } from "../utils/remoteProgress"
import type { RenameBranchResult } from "../types/git"

async function runRepoMutation<T>(
  bookmarkName: string,
  operation: () => Promise<T>,
  refreshSnapshot = true
): Promise<T> {
  let started = false
  try {
    return await runStatusMutation(bookmarkName, () => {
      started = true
      return operation()
    })
  } finally {
    if (started && refreshSnapshot) await refreshRepoSnapshot(bookmarkName)
  }
}

/** 本地文件操作只改工作区；不暂存/提交/推送，也不额外启动收尾全仓扫描。 */
export function createLocalWorktreeEntry(bookmarkName: string, name: string, directory: boolean, expectedRoot?: string): Promise<string> {
  return runRepoMutation(bookmarkName, () => createLocalEntryInternal(bookmarkName, name, directory, expectedRoot), false)
}
export function importLocalWorktreeDirectory(bookmarkName: string, sourcePath: string, expectedRoot?: string) {
  return runRepoMutation(bookmarkName, () => importLocalDirectoryInternal(bookmarkName, sourcePath, expectedRoot), false)
}
export function importLocalWorktreeFile(bookmarkName: string, sourcePath: string, name: string, expectedRoot?: string): Promise<string> {
  return runRepoMutation(bookmarkName, () => importLocalFileInternal(bookmarkName, sourcePath, name, expectedRoot), false)
}

export function importLocalWorktreeFiles(bookmarkName: string, sources: import("./localFileImport").LocalImportSource[], expectedRoot: string, canWrite: () => void) {
  return runRepoMutation(bookmarkName, () => importLocalFilesInternal(bookmarkName, sources, expectedRoot, canWrite), false)
}
export type { LocalImportBatchResult } from "./git/localFileService"

/** Same write barrier as rename; captures the drag's authorized root identity. */
export function moveLocalWorktreeFile(bookmarkName: string, path: string, directory: string, expectedRoot: string): Promise<string> {
  return runRepoMutation(bookmarkName, () => moveLocalFileInternal(bookmarkName, path, directory, expectedRoot), false)
}

export function readLocalWorktreeFile(bookmarkName: string, path: string): Promise<LocalWorktreeFile> {
  return runStatusRead(bookmarkName, () => readLocalFileInternal(bookmarkName, path))
}
export function openLocalWorktreeFile(bookmarkName: string, path: string): Promise<LocalWorktreeFile> {
  return runStatusRead(bookmarkName, () => readLocalFileForOpenInternal(bookmarkName, path))
}
export function copyLocalWorktreeFile(bookmarkName: string, file: LocalWorktreeFile, name: string): Promise<string> {
  return runRepoMutation(bookmarkName, () => copyLocalFileInternal(bookmarkName, file, name), false)
}
export function renameLocalWorktreeFile(bookmarkName: string, file: LocalWorktreeFile, name: string): Promise<string> {
  return runRepoMutation(bookmarkName, () => trackLocalRename(bookmarkName, file.path, false, () => renameLocalFileInternal(bookmarkName, file, name), result => result), false)
}
export function saveLocalWorktreeFile(bookmarkName: string, file: LocalWorktreeFile, text: string): Promise<LocalWorktreeFile> {
  return runRepoMutation(bookmarkName, () => saveLocalFileInternal(bookmarkName, file, text), false)
}
export function deleteLocalWorktreeFile(bookmarkName: string, file: LocalWorktreeFile): Promise<void> {
  return runRepoMutation(bookmarkName, () => deleteLocalFileInternal(bookmarkName, file), false)
}

export function copyLocalWorktreeDirectory(bookmarkName: string, path: string, name: string) {
  return runRepoMutation(bookmarkName, () => copyLocalDirectoryInternal(bookmarkName, path, name), false)
}
export function renameLocalWorktreeDirectory(bookmarkName: string, path: string, name: string) {
  return runRepoMutation(bookmarkName, () => trackLocalRename(bookmarkName, path, true, () => renameLocalDirectoryInternal(bookmarkName, path, name), result => result.path), false)
}

export function deleteLocalWorktreeDirectory(bookmarkName: string, path: string): Promise<void> {
  return runRepoMutation(bookmarkName, () => deleteLocalDirectoryInternal(bookmarkName, path), false)
}

export function removeRepo(bookmarkName: string): Promise<void> {
  return runRepoMutation(bookmarkName, () => removeRepoInternal(bookmarkName), false)
}

async function refreshRepoSnapshot(bookmarkName: string): Promise<void> {
  try {
    await getRepoListStatus(bookmarkName, undefined, { source: "写操作收尾", force: true })
  } catch (e) {
    console.warn("⚠️ 仓库快照刷新失败: " + e)
  }
}

export async function initRepo(bookmarkName: string): Promise<void> {
  return runRepoMutation(bookmarkName, () => initRepoInternal(bookmarkName), false)
}

export async function addFiles(
  bookmarkName: string,
  filepath: string
): Promise<void> {
  return runRepoMutation(
    bookmarkName,
    () => addFilesInternal(bookmarkName, filepath),
    false
  )
}

/** 全部暂存：复用 addFiles(".") 含删除语义 */
export async function stageAll(bookmarkName: string): Promise<void> {
  return addFiles(bookmarkName, ".")
}

/** 取消暂存；filepath="." 或省略表示全部 */
export async function unstageFiles(
  bookmarkName: string,
  filepath: string = "."
): Promise<void> {
  return runRepoMutation(
    bookmarkName,
    () => unstageFilesInternal(bookmarkName, filepath),
    false
  )
}

/** 全部取消暂存 */
export async function unstageAll(bookmarkName: string): Promise<void> {
  return unstageFiles(bookmarkName, ".")
}

/** 创建 Stash */
export async function createStash(
  bookmarkName: string,
  message: string = "",
  paths?: string[]
): Promise<void> {
  return runRepoMutation(bookmarkName, () =>
    createStashInternal(bookmarkName, message, paths)
  )
}

/** 应用 Stash，保留列表项 */
export async function applyStash(
  bookmarkName: string,
  index: number
): Promise<void> {
  return runRepoMutation(bookmarkName, () =>
    applyStashInternal(bookmarkName, index)
  )
}

/** 删除 Stash */
export async function dropStash(
  bookmarkName: string,
  index: number
): Promise<void> {
  return runRepoMutation(bookmarkName, () =>
    dropStashInternal(bookmarkName, index)
  )
}

export async function commit(
  bookmarkName: string,
  message: string,
  author?: { name: string; email: string }
): Promise<string> {
  return runRepoMutation(bookmarkName, () =>
    commitInternal(bookmarkName, message, author)
  )
}

export async function createBranch(
  bookmarkName: string,
  name: string,
  checkout = true
): Promise<void> {
  return runRepoMutation(bookmarkName, () =>
    createBranchInternal(bookmarkName, name, checkout)
  )
}

/** refreshSnapshot=false：成功后调用方会做完整详情刷新（其末尾已写主页快照），不重复全仓扫描；失败仍刷新快照。 */
export async function checkoutBranch(
  bookmarkName: string,
  ref: string,
  options?: { refreshSnapshot?: boolean }
): Promise<void> {
  if (options?.refreshSnapshot !== false) {
    return runRepoMutation(bookmarkName, () => checkoutBranchInternal(bookmarkName, ref))
  }
  try {
    await runRepoMutation(bookmarkName, () => checkoutBranchInternal(bookmarkName, ref), false)
  } catch (error) {
    // 失败路径没有后续刷新：保持原有行为，仍更新主页快照（可能已部分写入）。
    await refreshRepoSnapshot(bookmarkName)
    throw error
  }
}

/** 删除本地分支（不能删当前分支） */
export async function deleteBranch(
  bookmarkName: string,
  target: string
): Promise<void> {
  return runRepoMutation(bookmarkName, () =>
    deleteBranchInternal(bookmarkName, target)
  )
}

/** 重命名本地分支；旧分支发布过时自动同步远端（推新分支 + 删远端旧分支） */
export async function renameBranch(
  bookmarkName: string,
  from: string,
  to: string,
  options?: RemoteOpOptions
): Promise<RenameBranchResult> {
  return runWithBackgroundKeepAlive(() =>
    runRepoMutation(bookmarkName, () =>
      renameBranchInternal(bookmarkName, from, to, pushInternal, options)
    )
  )
}

/** 删除远端分支（push --delete） */
export async function deleteRemoteBranch(
  bookmarkName: string,
  remote: string,
  branch: string,
  options?: RemoteOpOptions
): Promise<void> {
  return runWithBackgroundKeepAlive(() =>
    runRepoMutation(bookmarkName, () =>
      deleteRemoteBranchInternal(bookmarkName, remote, branch, options)
    )
  )
}

export async function restoreFile(
  bookmarkName: string,
  filepath: string
): Promise<void> {
  return runRepoMutation(bookmarkName, () =>
    restoreFileInternal(bookmarkName, filepath)
  )
}

/** Confirmed repository/folder restore. File-level restore retains its original scope. */
export function prepareRestoreScope(bookmarkName: string, scope = "", renameSources: string[] = [], directory = true): Promise<RestoreScopePlan> {
  return runStatusRead(bookmarkName, async () => {
    if (await getMergeConflictState(bookmarkName)) throw new Error("仓库存在未完成合并，请进入仓库处理")
    return prepareRestoreScopeInternal(bookmarkName, scope, renameSources, directory)
  })
}
export function restoreWorktreeScope(bookmarkName: string, plan: RestoreScopePlan): Promise<string> {
  return runRepoMutation(bookmarkName, async () => {
    if (await getMergeConflictState(bookmarkName)) throw new Error("仓库存在未完成合并，请进入仓库处理")
    return restoreScopeInternal(bookmarkName, plan)
  })
}

/** 多文件还原持有同一个写屏障，只在结束时刷新一次摘要。 */
export function restoreFiles(bookmarkName: string, filepaths: string[]): Promise<void> {
  return runRepoMutation(bookmarkName, async () => {
    if (await getMergeConflictState(bookmarkName)) throw new Error("仓库存在未完成合并，请进入仓库处理")
    for (const filepath of [...new Set(filepaths)]) await restoreFileInternal(bookmarkName, filepath)
  })
}

export async function addRemote(
  bookmarkName: string,
  remote: string,
  url: string
): Promise<void> {
  return runRepoMutation(bookmarkName, () =>
    addRemoteInternal(bookmarkName, remote, url)
  )
}

/** 修改已有 remote 的 URL（失败回滚） */
export async function setRemoteUrl(
  bookmarkName: string,
  remote: string,
  url: string
): Promise<void> {
  return runRepoMutation(bookmarkName, () =>
    setRemoteUrlInternal(bookmarkName, remote, url)
  )
}

/** 删除 remote（失败尽量回滚） */
export async function deleteRemote(
  bookmarkName: string,
  remote: string
): Promise<void> {
  return runRepoMutation(bookmarkName, () =>
    deleteRemoteInternal(bookmarkName, remote)
  )
}

/** 设置当前或指定分支的 upstream */
export async function setBranchUpstream(
  bookmarkName: string,
  branch: string,
  remote: string,
  merge?: string
): Promise<void> {
  return runRepoMutation(bookmarkName, () =>
    setBranchUpstreamInternal(bookmarkName, branch, remote, merge)
  )
}

export async function push(
  bookmarkName: string,
  remote = "origin",
  ref?: string,
  force = false,
  options?: RemoteOpOptions
): Promise<void> {
  return runWithBackgroundKeepAlive(() =>
    runRepoMutation(bookmarkName, () =>
      pushInternal(bookmarkName, remote, ref, force, options)
    )
  )
}

/** 安全快进：默认仅 clone；显式刷新可传 includeAllSources。同仓 mutation 全程持锁。 */
export function autoPullFastForward(bookmarkName: string, options?: AutoPullOptions): Promise<AutoPullOutcome> {
  return runRepoMutation(bookmarkName, () => autoPullInternal(bookmarkName, options), false)
}

export async function pull(
  bookmarkName: string,
  remote = "origin",
  ref?: string,
  author?: { name: string; email: string },
  options?: RemoteOpOptions
): Promise<PullResult> {
  return runWithBackgroundKeepAlive(() =>
    runRepoMutation(bookmarkName, () =>
      pullInternal(bookmarkName, remote, ref, author, options)
    )
  )
}

/** 将指定分支合并进当前分支（本地名或 origin/xxx） */
export async function mergeBranchIntoCurrent(
  bookmarkName: string,
  source: string,
  author?: { name: string; email: string }
): Promise<MergeIntoCurrentResult> {
  return runRepoMutation(bookmarkName, () =>
    mergeBranchIntoCurrentInternal(bookmarkName, source, author)
  )
}

/** 解决单个冲突文件：ours / theirs / manual */
export async function resolveConflictFile(
  bookmarkName: string,
  filepath: string,
  resolution: ConflictResolution
): Promise<void> {
  return runRepoMutation(bookmarkName, () =>
    resolveConflictFileInternal(bookmarkName, filepath, resolution)
  )
}

/**
 * 扫描工作区冲突文件并批量标记已解决：
 * 无残留冲突标记（或文件已删除）的自动标记，其余保留并回报。
 */
export async function autoMarkResolvedConflicts(
  bookmarkName: string
): Promise<AutoMarkConflictsResult> {
  return runRepoMutation(bookmarkName, () =>
    autoMarkResolvedConflictsInternal(bookmarkName)
  )
}

/** 冲突全部解决后创建合并提交 */
export async function completeMerge(
  bookmarkName: string,
  message?: string,
  author?: { name: string; email: string }
): Promise<string> {
  return runRepoMutation(
    bookmarkName,
    () => completeMergeInternal(bookmarkName, message, author),
    false
  )
}

/** 中止合并并恢复冲突前工作区 */
export async function abortMerge(bookmarkName: string): Promise<void> {
  return runRepoMutation(bookmarkName, () => abortMergeInternal(bookmarkName))
}

export async function fetchRemote(
  bookmarkName: string,
  remote = "origin",
  ref?: string,
  prune = false,
  options?: RemoteOpOptions
): Promise<void> {
  return runWithBackgroundKeepAlive(() =>
    runRepoMutation(bookmarkName, () =>
      fetchRemoteInternal(bookmarkName, remote, ref, prune, options)
    )
  )
}

/** 刷新仓库页时同步 origin 分支元数据（仅 refs/remotes/origin）；不改写本地分支和工作区。
 * 仍走仓库写锁；快照由随后的详情刷新统一更新。 */
export async function syncOriginBranches(
  bookmarkName: string,
  options?: RemoteOpOptions
): Promise<boolean> {
  return runWithBackgroundKeepAlive(() =>
    runRepoMutation(bookmarkName, () => syncOriginBranchesInternal(bookmarkName, options, 60), false)
  )
}

export async function clone(
  url: string,
  dir: string,
  gitdirKey: string,
  ref?: string,
  depth?: number,
  options?: CloneOptions
): Promise<void> {
  return runWithBackgroundKeepAlive(() =>
    runRepoMutation(gitdirKey, () =>
      cloneInternal(url, dir, gitdirKey, ref, depth, options)
    )
  )
}

/** 重导给 UI：远程操作进度/取消选项 */
export type { RemoteOpOptions } from "../utils/remoteProgress"
export {
  RemoteCancelToken,
  isRemoteOperationCancelled,
} from "../utils/remoteProgress"

export async function revertCommit(
  bookmarkName: string,
  oid: string,
  author?: { name: string; email: string }
): Promise<string> {
  return runRepoMutation(bookmarkName, () =>
    revertCommitInternal(bookmarkName, oid, author)
  )
}

export async function resetToCommitAndForcePush(
  bookmarkName: string,
  oid: string,
  options?: RemoteOpOptions
): Promise<{ branch: string }> {
      return runWithBackgroundKeepAlive(() =>
        runRepoMutation(bookmarkName, async () => {
          const result = await resetToCommitAndPushInternal(
            bookmarkName,
            oid,
            (branch, force) =>
              pushInternal(bookmarkName, "origin", branch, force, options)
          )
          return { branch: result }
        })
      )
}

export async function softResetHead(
  bookmarkName: string
): Promise<{ parentOid: string }> {
  return runRepoMutation(bookmarkName, () => softResetHeadInternal(bookmarkName))
}

export async function amendHeadCommit(
  bookmarkName: string,
  message: string,
  author?: { name: string; email: string }
): Promise<string> {
  return runRepoMutation(bookmarkName, () =>
    amendHeadCommitInternal(bookmarkName, message, author)
  )
}

export async function setOriginAndPush(
  bookmarkName: string,
  remoteUrl: string,
  ref?: string,
  options?: RemoteOpOptions
): Promise<void> {
  return runWithBackgroundKeepAlive(() =>
    runRepoMutation(bookmarkName, () =>
      setOriginAndPushInternal(bookmarkName, remoteUrl, ref, options)
    )
  )
}

/** 导出 repoId 辅助，供 clone 页预分配 gitdir */
export {
  getRepoId,
  listStashes,
  compareCommitTrees,
  getCommitDetail,
  compareWithUpstream,
  getBranches,
  getCurrentBranchName,
  getManagedBranches,
  getRemoteBranches,
  getChanges,
  getLog,
  getLogPage,
  getHistoryCacheStats,
  getHistoryTotal,
  hasHeadCommit,
  getTrackedFiles,
  listRemotes,
  hasRemoteBranch,
  getBranchUpstream,
  getMergeConflictState,
  listConflictFiles,
  isInitialized,
}
