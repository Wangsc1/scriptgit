/**
 * hooks/useRepoDetailNavigation.ts - 仓库详情页子页导航编排
 *
 * 详情页所有子页（本地编辑/上传/远端/冲突/对比/回滚/GitHub 工作项/提交详情）共用一个受控
 * navigationDestination。这里集中管理互斥的打开状态，避免页面里散落多组
 * setShowXxx(false) 清理代码。
 *
 * skipNextAppearLoad：只读子页或自行刷新状态的编辑页返回时跳过一次全量 loadAll，减少大仓库重复全树扫描。
 */

import { useRef, useState } from "scripting"

export type RepoDetailPageKey =
  | "upload"
  | "remotes"
  | "conflicts"
  | "compare"
  | "rollback"
  | "githubWork"
  | "localEditor"

export function useRepoDetailNavigation() {
  const [page, setPage] = useState<RepoDetailPageKey | null>(null)
  const [githubWorkKind, setGithubWorkKind] = useState(0)
  const [selectedCommitOid, setSelectedCommitOid] = useState<string | null>(null)
  const destinationId = useRef(0)
  const activePage = useRef<RepoDetailPageKey | "commit" | null>(null)
  const skipNextAppearLoadRef = useRef(false)

  // 已有专用刷新链路的子页返回时跳过下一次 onAppear 全量刷新
  function skipNextAppearLoad() {
    skipNextAppearLoadRef.current = true
  }

  function consumeSkipNextAppearLoad(): boolean {
    if (!skipNextAppearLoadRef.current) return false
    skipNextAppearLoadRef.current = false
    return true
  }

  // 打开子页：所有互斥状态一次性收敛，只读子页顺带跳过返回后的全量刷新
  function openPage(target: RepoDetailPageKey, options?: { skipReload?: boolean }) {
    // A pending/stale action behind the editor must not bypass save-first exit.
    if (activePage.current === "localEditor") return
    activePage.current = target
    destinationId.current++
    if (options?.skipReload) skipNextAppearLoad()
    setSelectedCommitOid(null)
    setPage(target)
  }

  function openConflictsPage() {
    openPage("conflicts")
  }

  function openGitHubWorkPage(kind = 0) {
    setGithubWorkKind(kind)
    openPage("githubWork", { skipReload: true })
  }

  function openCommitDetail(oid: string) {
    if (activePage.current === "localEditor") return
    activePage.current = "commit"
    destinationId.current++
    skipNextAppearLoad()
    setPage(null)
    setSelectedCommitOid(oid)
  }

  function closeAll(expectedId = destinationId.current): boolean {
    // A delayed native dismissal from a prior destination cannot close its successor.
    if (expectedId !== destinationId.current) return false
    activePage.current = null
    destinationId.current++
    setPage(null)
    setSelectedCommitOid(null)
    return true
  }

  return {
    page,
    destinationId: destinationId.current,
    githubWorkKind,
    selectedCommitOid,
    // 任一子页处于打开状态
    isPresented: page != null || selectedCommitOid != null,
    openPage,
    openConflictsPage,
    openGitHubWorkPage,
    openCommitDetail,
    closePage: (target: RepoDetailPageKey) => {
      if (activePage.current !== target) return
      activePage.current = null
      destinationId.current++
      setPage(null)
    },
    closeAll,
    skipNextAppearLoad,
    consumeSkipNextAppearLoad,
  }
}
