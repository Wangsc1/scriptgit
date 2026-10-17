import { useEffect, useRef, useState } from "scripting"
import { createLocalWorktreeEntry } from "../services/gitService"
import { resolveWorkdir } from "../services/repoStore"
import { localImportStep } from "../services/localImportExecution"

/** Same centered system input mechanism as handleCreateBranch. Parent owns the
 * prompt lifecycle so changing FilesTab does not lose its in-flight busy guard. */
export function useLocalEntryCreation({ bookmarkName, unavailable, onChanged, onError }: {
  bookmarkName: string
  unavailable: boolean
  onChanged: () => void | Promise<void>
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const state = useRef({ alive: true, busy: false, bookmarkName, unavailable })
  state.current.bookmarkName = bookmarkName
  state.current.unavailable = unavailable
  useEffect(() => () => { state.current.alive = false }, [])
  async function open(directory: boolean, onCreated: (path: string) => void) {
    if (!state.current.alive || state.current.busy || unavailable) return
    state.current.busy = true; setBusy(true)
    let started = false
    try {
      const root = resolveWorkdir(bookmarkName).replace(/\/+$/, "")
      const name = await localImportStep("创建输入弹窗", () => Dialog.prompt({
        title: directory ? "创建目录" : "创建文件",
        message: "创建在当前仓库根目录；不覆盖已有名称，不暂存、提交或推送。",
        defaultValue: "", placeholder: directory ? "目录名称" : "文件名称",
        cancelLabel: "取消", confirmLabel: "创建",
      }))
      if (name == null) return
      const path = await localImportStep("创建工作区条目", () => {
        if (!state.current.alive || state.current.bookmarkName !== bookmarkName || state.current.unavailable) throw new Error("页面或工作区状态已变化，未开始创建")
        started = true
        return createLocalWorktreeEntry(bookmarkName, name, directory, root)
      })
      await localImportStep("创建结果", () => { if (state.current.alive) onCreated(path) })
      await localImportStep("创建后刷新", onChanged)
    } catch (error: any) {
      await localImportStep("创建错误提示", () => { if (state.current.alive) onError(String(error?.message || error)) })
      if (started) {
        try { await localImportStep("创建失败后刷新", onChanged) } catch (_) { /* Keep original error; never rollback by deleting. */ }
      }
    } finally {
      state.current.busy = false
      await localImportStep("创建UI收尾", () => { if (state.current.alive) setBusy(false) })
    }
  }
  return { busy, open }
}
