import { checkRemoteCancelled, type RemoteOpOptions } from "../../utils/remoteProgress"

/** Count first-parent commits, preserving cycle, limit and cancellation semantics. */
export async function countCommitsUntil(
  git: any,
  fs: any,
  dir: string,
  gitdir: string,
  tipOid: string,
  stopOid: string | null,
  maxCount = Number.POSITIVE_INFINITY,
  options?: RemoteOpOptions
): Promise<number> {
  if (!tipOid || tipOid === stopOid) return 0
  let count = 0
  let current: string | null = tipOid
  const seen = new Set<string>()
  while (current && current !== stopOid && count < maxCount) {
    checkRemoteCancelled(options)
    if (seen.has(current)) break
    seen.add(current)
    count++
    const result: { commit: { parent?: string[] } } = await git.readCommit({
      fs,
      dir,
      gitdir,
      oid: current,
    })
    current = result.commit.parent?.[0] || null
  }
  return count
}

