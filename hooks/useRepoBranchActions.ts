import { useRef, useState } from "scripting"
import {
  checkoutBranch,
  createBranch,
  mergeBranchIntoCurrent,
  renameBranch,
} from "../services/gitService"
import { validateBranchName } from "../utils/branch"
import { formatMergeSuccessAlert } from "../utils/branchMerge"
import type { ToastType } from "../hooks/useToast"

type UseRepoBranchActionsProps = {
  bookmarkName: string
  currentBranch: string | null
  hasCommits: boolean
  hasRemote: boolean
  mutating: boolean
  mergeInProgress: boolean
  beginOpBusy: (title: string, message?: string) => Promise<void>
  endOpBusy: () => void
  reloadRepo: () => Promise<void>
  showAlert: (title: string, message: string) => void
  showToast: (message: string, type?: ToastType, duration?: number) => void
  /** 合并冲突提醒：先在本页提示，关闭后再由详情页打开冲突页，避免提示被推入的页面遮住 */
  showConflictNotice: (message: string) => void
}

export function useRepoBranchActions({
  bookmarkName,
  currentBranch,
  hasCommits,
  hasRemote,
  mutating,
  mergeInProgress,
  beginOpBusy,
  endOpBusy,
  reloadRepo,
  showAlert,
  showToast,
  showConflictNotice,
}: UseRepoBranchActionsProps) {
  async function handleMergeIntoCurrent(source: string) {
    if (mutating || mergeInProgress) return
    try {
      await beginOpBusy(
        "正在合并",
        `${source} → ${currentBranch || "当前分支"}`
      )
      const result = await mergeBranchIntoCurrent(bookmarkName, source)
      const alert = formatMergeSuccessAlert(result)
      showToast(`${alert.title}：${alert.message}`, "success")
    } catch (error: any) {
      const code = String(error?.code || "")
      const message = String(error?.message || error)
      if (code === "MergeConflictError" || message.includes("合并冲突")) {
        try {
          await reloadRepo()
        } catch (_e) {
          // 冲突页仍应允许打开
        }
        showConflictNotice(message)
      } else {
        showToast(`合并失败：${message}`, "error")
      }
    } finally {
      try {
        await reloadRepo()
      } catch (_e) {
        // 刷新失败不覆盖合并结果
      }
      endOpBusy()
    }
  }

  async function handleSwitchBranch(ref: string) {
    if (mutating) return
    try {
      await beginOpBusy("正在切换分支", ref)
      await checkoutBranch(bookmarkName, ref)
      await reloadRepo()
      showToast(`已切换到 ${ref}`, "success")
    } catch (error: any) {
      showToast(`切换失败：${String(error?.message || error)}`, "error")
    } finally {
      endOpBusy()
    }
  }

  const [renameFrom, setRenameFrom] = useState<string | null>(null)
  const [renameError, setRenameError] = useState("")
  const renameBusy = useRef(false)

  function handleRenameBranch() {
    if (mutating || mergeInProgress || !hasCommits || renameBusy.current) return
    if (!currentBranch) {
      showToast("当前没有可重命名的分支", "warning")
      return
    }
    setRenameError("")
    setRenameFrom(currentBranch)
  }
  function cancelRenameBranch() {
    if (!renameBusy.current) setRenameFrom(null)
  }
  async function confirmRenameBranch(input: string) {
    if (!renameFrom || mutating || mergeInProgress || renameBusy.current) return
    const from = renameFrom
    let to: string
    try { to = validateBranchName(input) }
    catch (error: any) { setRenameError(`名称无效：${String(error?.message || error)}`); return }
    if (to === from) { setRenameFrom(null); return }
    if (currentBranch !== from) { setRenameError("当前分支已变化，请取消后重试"); return }
    renameBusy.current = true
    setRenameError("")
    try {
      await beginOpBusy("正在重命名分支", `${from} → ${to}`)
      const result = await renameBranch(bookmarkName, from, to)
      setRenameFrom(null)
      try { await reloadRepo() }
      catch (error: any) { showToast(`分支已重命名，刷新失败：${String(error?.message || error)}`, "warning") }
      if (!result.oldRemote) {
        showToast(`已重命名：${from} → ${to}`, "success")
      } else if (result.remoteError) {
        showAlert(
          "本地已重命名，远端同步失败",
          `${from} → ${to}。${result.pushedNewBranch ? "新分支已推送，但删除远端旧分支失败" : "推送新分支失败"}：${result.remoteError}`
        )
      } else {
        showToast(`已重命名并同步远端：${from} → ${to}`, "success")
      }
    } catch (error: any) {
      setRenameError(`重命名失败：${String(error?.message || error)}`)
    } finally {
      renameBusy.current = false
      endOpBusy()
    }
  }

  async function handleCreateBranch() {
    try {
      const input = await Dialog.prompt({
        title: "新建分支",
        message: "输入新分支名称，将创建并切换到该分支",
        placeholder: "feature/xxx",
        cancelLabel: "取消",
        confirmLabel: "创建",
      })
      if (input == null) return
      const name = input.trim()
      if (!name) {
        showToast("分支名称不能为空", "warning")
        return
      }
      const emptyBefore = !hasCommits
      await beginOpBusy("正在新建分支", name)
      await createBranch(bookmarkName, name)
      await reloadRepo()
      showToast(
        emptyBefore
          ? `空仓库目标分支已设为 ${name}，首次提交后生效`
          : hasRemote
            ? `已创建并切换到 ${name}，点击「推送」发布到 GitHub`
            : `已创建并切换到 ${name}`,
        "success"
      )
    } catch (error: any) {
      showToast(`创建失败：${String(error?.message || error)}`, "error")
    } finally {
      endOpBusy()
    }
  }

  return {
    handleMergeIntoCurrent,
    handleSwitchBranch,
    handleRenameBranch,
    renameFrom, renameError, cancelRenameBranch, confirmRenameBranch,
    handleCreateBranch,
  }
}
