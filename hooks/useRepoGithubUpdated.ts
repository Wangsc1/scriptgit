import { useEffect, useRef, useState } from "scripting"
import { getRepo } from "../api/githubApi"
import { listRepos, updateRepo } from "../services/repoStore"
import type { RepoMeta } from "../types/git"
import { githubRepoFromRemoteUrl } from "../utils/github"
import { githubUpdatedPatch } from "../utils/repoUpdated"

/** 仅后台轻量 GitHub 元数据请求；与工作区/矩阵扫描无关，最多两路，不阻塞首屏。 */
export function useRepoGithubUpdated(setRepos: (repos: RepoMeta[]) => void) {
  const [progress, setProgress] = useState({ running: false, completed: 0, total: 0, failed: 0, error: "" })
  const state = useRef({ active: false, publishTimer: null as ReturnType<typeof setTimeout> | null, pending: null as Promise<void> | null, checked: new Map<string, number>() })
  useEffect(() => stop, [])
  function stop() {
    state.current.active = false
    if (state.current.publishTimer !== null) clearTimeout(state.current.publishTimer)
    state.current.publishTimer = null
  }
  function refresh(force = false): Promise<void> {
    const current = state.current
    current.active = true
    if (current.pending) return current.pending
    // 调用方无需 await；首帧后再取元数据，不在 render 内读持久化或联网。
    current.pending = new Promise<void>(resolve => setTimeout(resolve, 0)).then(async () => {
      if (!current.active) return
      const repos = listRepos()
      const targets = new Map<string, string[]>()
      for (const repo of repos) {
        const name = githubRepoFromRemoteUrl(repo.remoteUrl)?.toLowerCase()
        if (!name || (!force && Date.now() - (current.checked.get(name) ?? -Infinity) < 300_000)) continue
        targets.set(name, [...(targets.get(name) || []), repo.bookmarkName])
      }
      const queue = [...targets]; let cursor = 0, completed = 0, failed = 0, error = ""
      let reposDirty = false
      const publish = () => {
        if (current.publishTimer !== null) clearTimeout(current.publishTimer)
        current.publishTimer = null
        if (!current.active) return
        if (reposDirty) { reposDirty = false; setRepos(listRepos()) }
        setProgress({ running: completed < queue.length, completed, total: queue.length, failed, error })
      }
      const report = () => {
        if (current.active && current.publishTimer === null) current.publishTimer = setTimeout(publish, 150)
      }
      publish()
      async function worker() {
        while (current.active) {
          const target = queue[cursor++]
          if (!target) return
          const [name, keys] = target
          try {
            const detail = await getRepo(name)
            const patch = githubUpdatedPatch(`https://github.com/${name}`, detail.updatedAt)
            if (!patch) throw new Error("GitHub 未返回有效更新时间")
            // 请求期间仓库可被移除或更换 origin；不得把旧响应写到新仓库。
            const latest = listRepos()
            for (const repo of latest) {
              if (keys.includes(repo.bookmarkName) && githubRepoFromRemoteUrl(repo.remoteUrl)?.toLowerCase() === name) updateRepo(repo.bookmarkName, patch)
            }
            current.checked.set(name, Date.now())
            reposDirty = true
          } catch (e: any) { failed++; error = String(e?.message || e) }
          completed++; report()
        }
      }
      await Promise.all([worker(), worker()])
      publish()
    }).catch(e => {
      if (current.active) setProgress(previous => ({ ...previous, running: false, failed: previous.failed + 1, error: String(e?.message || e) }))
    }).finally(() => { current.pending = null })
    return current.pending
  }
  return { progress, refresh, stop }
}
