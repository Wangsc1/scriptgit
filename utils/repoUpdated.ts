import type { RepoMeta } from "../types/git"
import { githubRepoFromRemoteUrl } from "./github"

export function githubUpdatedPatch(remoteUrl: unknown, updatedAt: unknown): Pick<RepoMeta, "githubUpdatedAt" | "githubUpdatedRepo"> | null {
  const fullName = githubRepoFromRemoteUrl(remoteUrl)?.toLowerCase()
  if (!fullName || typeof updatedAt !== "string" || !updatedAt.trim() || !Number.isFinite(Date.parse(updatedAt))) return null
  return { githubUpdatedAt: updatedAt, githubUpdatedRepo: fullName }
}
export function githubUpdatedTime(repo: RepoMeta): number | null {
  const patch = githubUpdatedPatch(repo.remoteUrl, repo.githubUpdatedAt)
  return patch && patch.githubUpdatedRepo === repo.githubUpdatedRepo?.toLowerCase() ? Date.parse(patch.githubUpdatedAt!) : null
}
