import type { RepoMeta } from "../types/git"
import { githubRepoFromRemoteUrl } from "./github"

/** 只用本地已注册的 origin 元数据；不按目录名猜测，也不访问工作区或网络。 */
export function registeredGithubRepos(repos: readonly RepoMeta[]): Set<string> {
  const names = new Set<string>()
  for (const repo of repos) {
    const fullName = githubRepoFromRemoteUrl(repo.remoteUrl)
    if (fullName) names.add(fullName.toLowerCase())
  }
  return names
}
