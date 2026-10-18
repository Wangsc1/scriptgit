import { scanMutationMatrix } from "./matrixScanService"
import type { StashEntry } from "../../types/git"
import {
  collectGhostStashIndices,
  dropStashReflogAtIndex,
  isStatusMatrixClean,
  isValidOid,
  pairStashEntriesWithOids,
  parseStashEntries,
  repairStashReflogLines,
  stashOidsNewestFirst,
} from "../../utils/stash"
import { getCtx } from "./runtime"
import { PATH_STASH_INDEX_MESSAGE } from "./pathStashService"

const STASH_REFLOG = "logs/refs/stash"
const STASH_REF = "refs/stash"

async function readStashReflogRaw(fs: any): Promise<string> {
  try {
    if (!(await fs.exists(STASH_REFLOG))) return ""
    const raw = await fs.readFile(STASH_REFLOG, "utf8")
    return typeof raw === "string" ? raw : String(raw || "")
  } catch (_e) {
    return ""
  }
}

async function writeStashReflogAndTip(
  fs: any,
  lines: string[],
  tipOid: string | null
): Promise<void> {
  if (lines.length === 0) {
    if (await fs.exists(STASH_REFLOG)) await fs.unlink(STASH_REFLOG)
    if (await fs.exists(STASH_REF)) await fs.unlink(STASH_REF)
    return
  }
  await fs.writeFile(STASH_REFLOG, lines.join("\n") + "\n", "utf8")
  if (tipOid && isValidOid(tipOid)) {
    await fs.writeFile(STASH_REF, tipOid + "\n", "utf8")
  } else if (await fs.exists(STASH_REF)) {
    await fs.unlink(STASH_REF)
  }
}

export async function repairStashReflog(fs: any): Promise<void> {
  const raw = await readStashReflogRaw(fs)
  if (!raw) {
    if (await fs.exists(STASH_REF)) {
      try {
        const tip = String(await fs.readFile(STASH_REF, "utf8")).trim()
        if (!isValidOid(tip)) await fs.unlink(STASH_REF)
      } catch (_e) {
        try {
          await fs.unlink(STASH_REF)
        } catch (__e) {
          // 清理失败不覆盖原始读取结果
        }
      }
    }
    return
  }
  const repaired = repairStashReflogLines(raw)
  let tipBroken = false
  if (await fs.exists(STASH_REF)) {
    try {
      const tip = String(await fs.readFile(STASH_REF, "utf8")).trim()
      tipBroken = !isValidOid(tip)
    } catch (_e) {
      tipBroken = true
    }
  }
  if (!repaired.changed && !tipBroken) return
  await writeStashReflogAndTip(fs, repaired.lines, repaired.tipOid)
}

async function safeDropStash(fs: any, index: number): Promise<void> {
  await repairStashReflog(fs)
  const raw = await readStashReflogRaw(fs)
  if (!raw.trim()) throw new Error("没有可删除的 Stash")
  const chronological = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
  const { lines, tipOid } = dropStashReflogAtIndex(chronological, index)
  await writeStashReflogAndTip(fs, lines, tipOid)
}

async function withStashOids(
  fs: any,
  entries: StashEntry[]
): Promise<StashEntry[]> {
  if (entries.length === 0) return entries
  const raw = await readStashReflogRaw(fs)
  if (!raw.trim()) return entries
  const chronological = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
  return pairStashEntriesWithOids(entries, stashOidsNewestFirst(chronological))
}

export async function listStashes(bookmarkName: string): Promise<StashEntry[]> {
  const { git, fs, dir, gitdir } = await getCtx(bookmarkName)
  await repairStashReflog(fs)
  const entries = await git.stash({ fs, dir, gitdir, op: "list" })
  const ghostIndices = collectGhostStashIndices(entries)
  if (ghostIndices.length === 0) {
    return withStashOids(fs, parseStashEntries(entries))
  }

  for (const refIdx of ghostIndices) {
    try {
      await safeDropStash(fs, refIdx)
    } catch (error) {
      console.warn("清理幽灵 Stash 失败 (index=" + refIdx + "): " + error)
    }
  }
  const cleaned = await git.stash({ fs, dir, gitdir, op: "list" })
  return withStashOids(fs, parseStashEntries(cleaned))
}

export async function applyStashInternal(
  bookmarkName: string,
  index: number
): Promise<void> {
  if (!Number.isInteger(index) || index < 0) throw new Error("无效的 Stash 索引")
  const { git, fs, dir, gitdir } = await getCtx(bookmarkName)
  await repairStashReflog(fs)
  const matrix = await scanMutationMatrix({ git, fs, dir, gitdir }, "写操作应用Stash前检查")
  if (!isStatusMatrixClean(matrix)) {
    throw new Error("请先提交、暂存到 Stash 或丢弃当前改动，再应用 Stash")
  }
  const entries = await withStashOids(fs, parseStashEntries(await git.stash({ fs, dir, gitdir, op: "list" })))
  const oid = entries[index]?.oid
  if (oid) {
    const { commit } = await git.readCommit({ fs, dir, gitdir, oid })
    if (commit.parent.length === 2) {
      const indexCommit = await git.readCommit({ fs, dir, gitdir, oid: commit.parent[1] })
      if (indexCommit.commit.message.trim() === PATH_STASH_INDEX_MESSAGE) {
        // Bundled stash.apply ignores the main worktree tree of a standard stash.
        // Never overwrite newer history: cross-base application needs a real merge.
        const head = await git.resolveRef({ fs, dir, gitdir, ref: "HEAD" })
        if (head !== commit.parent[0]) throw new Error("此 Stash 的基线已改变；请切回原提交后应用，或使用原生 Git 合并应用")
        const tracked = new Set(await git.listFiles({ fs, dir, gitdir, ref: head }))
        for (const filepath of await git.listFiles({ fs, dir, gitdir, ref: oid })) {
          if (!tracked.has(filepath) && await fs.exists(dir + "/" + filepath)) {
            throw new Error("应用 Stash 会覆盖未跟踪或忽略的文件：" + filepath)
          }
        }
        await git.checkout({ fs, dir, gitdir, ref: oid, force: true, noUpdateHead: true })
        const changed = await scanMutationMatrix({ git, fs, dir, gitdir }, "恢复 Stash 索引")
        const paths = new Set(changed.map(row => row[0]))
        for (const path of await git.listFiles({ fs, dir, gitdir, ref: commit.parent[1] })) paths.add(path)
        for (const filepath of paths) await git.resetIndex({ fs, dir, gitdir, filepath, ref: commit.parent[1] })
        return
      }
    }
  }
  await git.stash({ fs, dir, gitdir, op: "apply", refIdx: index })
}

export async function dropStashInternal(
  bookmarkName: string,
  index: number
): Promise<void> {
  if (!Number.isInteger(index) || index < 0) throw new Error("无效的 Stash 索引")
  const { fs } = await getCtx(bookmarkName)
  await safeDropStash(fs, index)
}
