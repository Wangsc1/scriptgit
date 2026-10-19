import type { RestoreScopePlan } from "../services/git/restoreScopeService"
import type { CommitEntry, StashEntry } from "../types/git"
import { commitTitle } from "./format"

export type RepoPendingAction =
  | { type: "restore"; filepath: string; filepaths?: string[]; restorePlan?: RestoreScopePlan }
  | { type: "revert"; entry: CommitEntry }
  | { type: "softReset"; entry: CommitEntry }
  | { type: "amend" }
  | { type: "dropStash"; entry: StashEntry }
  | { type: "deleteLocalBranch"; branch: string }
  | { type: "deleteRemoteBranch"; branch: string }
  | { type: "rollback"; entry: CommitEntry; branch: string }
  | null

export function getRepoPendingAlert(pending: Exclude<RepoPendingAction, null>): {
  title: string
  message: string
  confirmButton: string
} {
  switch (pending.type) {
    case "restore":
      if (pending.restorePlan) return {
        title: "还原文件并删除新增空目录？",
        message: `范围：${pending.restorePlan.renameSources?.length ? [pending.restorePlan.scope, ...pending.restorePlan.renameSources].join("、") : pending.restorePlan.scope || "仓库全部工作区"}（${pending.filepath}）\n将还原 ${pending.restorePlan.filepaths.length} 个文件到 HEAD，并从叶到父删除 ${pending.restorePlan.empty?.directories.length || 0} 个新增空目录（含本次文件还原后预计清空的目录）。\n仅删除重新检查确实为空且未被跟踪的目录；隐藏/忽略内容、已跟踪目录和范围外目录保留。当前文件改动将丢失，不可撤销。`,
        confirmButton: "还原",
      }
      return {
        title: "还原改动？",
        message: `将「${pending.filepath}」还原到 HEAD，当前改动将丢失，此操作不可撤销。`,
        confirmButton: "还原",
      }
    case "revert":
      return {
        title: "撤销该提交？",
        message: `将为 HEAD 创建反向提交，撤销「${commitTitle(pending.entry.message)}」。`,
        confirmButton: "撤销",
      }
    case "softReset":
      return {
        title: "回退未推送提交？",
        message: "将 soft reset 到上一提交，提交记录移除，文件改动保留。仅限未推送的 HEAD。",
        confirmButton: "回退",
      }
    case "amend":
      return {
        title: "重编提交？",
        message: "将改写最近提交信息。只能用于尚未推送的 HEAD，已推送会被拒绝。",
        confirmButton: "重编",
      }
    case "dropStash":
      return {
        title: "删除 Stash？",
        message: `将永久删除「${pending.entry.message}」。`,
        confirmButton: "删除",
      }
    case "deleteLocalBranch":
      return {
        title: `删除本地分支 ${pending.branch}？`,
        message: "仅删除本地分支引用，不影响远端。未合并的提交可能丢失。",
        confirmButton: "删除",
      }
    case "deleteRemoteBranch":
      return {
        title: `删除远端分支 origin/${pending.branch}？`,
        message: "将从 origin 删除该远端分支，操作不可撤销，需已配置 Token。",
        confirmButton: "删除",
      }
    case "rollback":
      return {
        title: `回滚并强制推送到 ${commitTitle(pending.entry.message)}？`,
        message: `${pending.branch} 将被重置到该提交，并强制覆盖 origin/${pending.branch}。该提交之后的所有提交将从远端历史中移除，操作不可撤销。`,
        confirmButton: "回滚并强推",
      }
  }
}
