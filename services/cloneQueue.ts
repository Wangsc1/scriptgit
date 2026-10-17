/** 单个/批量共用安全队列：仅克隆到本次创建的临时目录，不清理用户已有目标。 */
import type { GitHubRepo, RepoMeta } from "../types/git"
import { getRepo } from "../api/githubApi"
import { clone, RemoteCancelToken, isRemoteOperationCancelled } from "./gitService"
import { createRepoId, getGitdirPath, listRepos, registerRepoByPath, resolveWorkdir } from "./repoStore"
import { prepareCloneRoot, type CloneDestination } from "./cloneWorkspace"
import type { RemoteProgressInfo } from "../utils/remoteProgress"
import { hideSystemDetails, relativeCloneLabel } from "../utils/displayPaths"

export interface CloneRequest { name: string; url: string; githubRepo?: GitHubRepo }
export interface CloneResult {
  name: string; url: string; path: string
  /** 仅展示：git/<repo>，不含系统绝对路径。 */
  displayPath: string
  status: "cloned" | "failed" | "skipped" | "cancelled"
  message: string
  repo?: RepoMeta
}
const activeRoots = new Set<string>()
const key = (path: string) => path.normalize("NFC").replace(/\/+$/, "").toLowerCase()

export async function runCloneQueue(requests: CloneRequest[], destination: CloneDestination, options: {
  cancelToken: RemoteCancelToken
  onProgress?: (index: number, total: number, name: string, detail: string) => void | Promise<void>
  onResult?: (result: CloneResult) => void
  onRegistered?: (repo: RepoMeta) => void
}): Promise<CloneResult[]> {
  const root = await prepareCloneRoot(destination)
  const rootKey = key(root)
  if (activeRoots.has(rootKey)) throw new Error("该目标目录已有克隆任务，请稍后重试")
  activeRoots.add(rootKey)
  const results: CloneResult[] = []
  const seen = new Set<string>()
  try {
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index]
      const path = root + "/" + request.name
      const base = { name: request.githubRepo?.fullName || request.name, url: request.url, path, displayPath: relativeCloneLabel(request.name) }
      let result: CloneResult
      let stage: string | null = null
      let gitdir: string | null = null
      let published = false
      let stageOwned = false
      let gitdirOwned = false
      try {
        options.cancelToken.throwIfCancelled()
        await options.onProgress?.(index + 1, requests.length, base.name, "检查目标目录")
        if (!/^[A-Za-z0-9._-]+$/.test(request.name) || request.name === "." || request.name === "..") throw new Error("仓库目录名称无效")
        const targetKey = key(path)
        const registered = listRepos().some(repo => {
          try { return key(resolveWorkdir(repo.bookmarkName)) === targetKey } catch (_e) { return repo.workdir ? key(repo.workdir) === targetKey : false }
        })
        const names = await FileManager.readDirectory(root)
        const collision = names.some(name => key(name) === key(request.name))
        const diskExists = seen.has(targetKey) || registered || collision ? false : await FileManager.exists(path)
        if (seen.has(targetKey) || registered || collision || diskExists) {
          let message = "磁盘上已有同名项，但没有对应的已注册仓库，未覆盖"
          if (registered) message = "已注册同名仓库，不重复添加"
          else if (seen.has(targetKey)) message = "本批次重复，已跳过"
          else if (collision && !names.includes(request.name)) message = "磁盘上已有仅大小写不同的同名项，但没有对应的已注册仓库，未覆盖"
          else {
            try { message += (await FileManager.isDirectory(path)) ? "（目录）" : "（文件）" } catch (_e) { message += "（类型未知）" }
          }
          result = { ...base, status: "skipped", message }
        } else {
          seen.add(targetKey)
          let upstream: { url: string } | undefined
          let githubUpdatedAt = request.githubRepo?.updatedAt
          if (request.githubRepo) {
            const detail = await getRepo(request.githubRepo.fullName)
            githubUpdatedAt = detail.updatedAt || githubUpdatedAt
            if (detail.fork) {
              if (!detail.parent) throw new Error("无法读取 fork 源仓库信息")
              upstream = { url: detail.parent.url }
            }
          }
          options.cancelToken.throwIfCancelled()
          const repoId = createRepoId()
          stage = root + "/.scriptgit-clone-" + repoId
          gitdir = getGitdirPath({ name: request.name, bookmarkName: repoId, repoId, createdAt: Date.now() })
          // ID 碰撞也不能删除原有内容。创建前同时检查两处，本次只拥有新目录。
          if (await FileManager.exists(stage) || await FileManager.exists(gitdir)) {
            stage = null; gitdir = null
            throw new Error("临时目录 ID 冲突，请重试")
          }
          await FileManager.createDirectory(stage, false)
          stageOwned = true
          gitdirOwned = true
          await clone(request.url, stage, repoId, undefined, undefined, {
            cancelToken: options.cancelToken,
            upstream,
            onProgress: async (info: RemoteProgressInfo) => { await options.onProgress?.(index + 1, requests.length, base.name, info.label) },
          })
          options.cancelToken.throwIfCancelled()
          // 再检查一次，防止下载期间目标被其它操作创建；绝不删除/清理目标路径。
          const latest = await FileManager.readDirectory(root)
          if (latest.some(name => key(name) === key(request.name)) || await FileManager.exists(path)) throw new Error("克隆期间目标已出现，未覆盖；请重试")
          await FileManager.rename(stage, path)
          published = true
          const repo = await registerRepoByPath(path, request.name, request.url, repoId,
            destination.kind === "external" ? destination.accessBookmarkName : null, githubUpdatedAt)
          result = { ...base, status: "cloned", message: "已克隆并加入本地列表", repo }
        }
      } catch (e: any) {
        result = { ...base, status: isRemoteOperationCancelled(e) || options.cancelToken.isCancelled ? "cancelled" : "failed",
          message: hideSystemDetails(e?.message || e) + (published ? "；文件已下载到目标但注册失败，已保留文件和 Git 缓存，请勿直接删除。" : "") }
      } finally {
        // 只有本任务拥有的临时路径允许清理；绝不调用旧 cleanupCloneAttempt 清理最终目标。
        if (!published) {
          for (const owned of [stageOwned ? stage : null, gitdirOwned ? gitdir : null]) {
            if (!owned) continue
            try { if (await FileManager.exists(owned)) await FileManager.remove(owned) }
            catch (e: any) { await options.onProgress?.(index + 1, requests.length, base.name, "临时清理失败：" + String(e?.message || e)) }
          }
        }
      }
      results.push(result)
      options.onResult?.(result)
      if (result.repo) options.onRegistered?.(result.repo)
    }
    return results
  } finally { activeRoots.delete(rootKey) }
}
