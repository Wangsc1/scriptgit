import { scanMutationMatrix } from "./matrixScanService"
import { DEFAULT_BRANCH } from "../../constants/git"
import {
  normalizeMatrixPath,
  pathsNeedingUnstage,
  stageActionForRow,
} from "../../utils/stageSelection"
import { sanitizeStashMessage } from "../../utils/stash"
import { DEFAULT_GIT_IDENTITY, resolveAuthor } from "../authStore"
import {
  checkoutWithEmptyDirCleanup,
  ensureGitConfigAuthor,
  getCtx,
  hasAnyCommit,
  readSymbolicHeadBranch,
  writeUnbornHead,
} from "./runtime"
import { createPathStash } from "./pathStashService"

export async function isInitialized(bookmarkName: string): Promise<boolean> {
  try {
    const { fs, gitdir } = await getCtx(bookmarkName)
    return (await fs.exists("HEAD")) || (await FileManager.exists(gitdir + "/HEAD"))
  } catch (_e) {
    return false
  }
}

async function ensureUnbornDefaultBranch(
  fs: any,
  git: any,
  dir: string,
  gitdir: string
): Promise<void> {
  if (await hasAnyCommit(git, fs, dir, gitdir)) return
  const existing = await readSymbolicHeadBranch(fs)
  if (existing && existing !== "master") return
  await writeUnbornHead(fs, DEFAULT_BRANCH)
}

export async function initRepoInternal(bookmarkName: string): Promise<void> {
  const { git, fs, dir, gitdir } = await getCtx(bookmarkName)
  if (!(await isInitialized(bookmarkName))) {
    try {
      await git.init({ fs, dir, gitdir, defaultBranch: DEFAULT_BRANCH })
    } catch (_e) {
      await git.init({ fs, dir, gitdir })
    }
    await writeUnbornHead(fs, DEFAULT_BRANCH)
  } else {
    await ensureUnbornDefaultBranch(fs, git, dir, gitdir)
  }
  const existingName = await git
    .getConfig({ fs, dir, gitdir, path: "user.name" })
    .catch(() => undefined)
  const existingEmail = await git
    .getConfig({ fs, dir, gitdir, path: "user.email" })
    .catch(() => undefined)
  if (!existingName) {
    await git.setConfig({
      fs,
      dir,
      gitdir,
      path: "user.name",
      value: DEFAULT_GIT_IDENTITY.name,
    })
  }
  if (!existingEmail) {
    await git.setConfig({
      fs,
      dir,
      gitdir,
      path: "user.email",
      value: DEFAULT_GIT_IDENTITY.email,
    })
  }
}

export async function addFilesInternal(
  bookmarkName: string,
  filepath: string
): Promise<void> {
  const { git, fs, dir, gitdir } = await getCtx(bookmarkName)
  if (filepath === ".") {
    const matrix = await scanMutationMatrix({ git, fs, dir, gitdir }, "写操作全部暂存")
    for (const row of matrix) {
      const path = normalizeMatrixPath(row[0])
      const action = stageActionForRow(row)
      if (!path || action === "skip") continue
      if (action === "remove") {
        await git.remove({ fs, dir, gitdir, filepath: path })
      } else {
        await git.add({ fs, dir, gitdir, filepath: path })
      }
    }
    return
  }
  if (!(await fs.exists(filepath))) {
    try {
      await git.remove({ fs, dir, gitdir, filepath })
      return
    } catch (_e) {
      // remove 失败时回退 add
    }
  }
  await git.add({ fs, dir, gitdir, filepath })
}

async function hasResolvedHead(
  git: any,
  fs: any,
  dir: string,
  gitdir: string
): Promise<boolean> {
  try {
    await git.resolveRef({ fs, dir, gitdir, ref: "HEAD" })
    return true
  } catch (_e) {
    return false
  }
}

async function unstagePath(
  git: any,
  fs: any,
  dir: string,
  gitdir: string,
  filepath: string,
  hasHead: boolean
): Promise<void> {
  if (hasHead) {
    await git.resetIndex({ fs, dir, gitdir, filepath, ref: "HEAD" })
    return
  }
  await git.remove({ fs, dir, gitdir, filepath }).catch(() => undefined)
}

export async function unstageFilesInternal(
  bookmarkName: string,
  filepath = "."
): Promise<void> {
  const { git, fs, dir, gitdir } = await getCtx(bookmarkName)
  const hasHead = await hasResolvedHead(git, fs, dir, gitdir)
  if (filepath !== ".") {
    await unstagePath(git, fs, dir, gitdir, filepath, hasHead)
    return
  }
  const matrix = await scanMutationMatrix({ git, fs, dir, gitdir }, "写操作全部取消暂存")
  for (const path of pathsNeedingUnstage(matrix)) {
    await unstagePath(git, fs, dir, gitdir, path, hasHead)
  }
}

async function safeCurrentBranch(
  git: any,
  fs: any,
  dir: string,
  gitdir: string
): Promise<string | null> {
  try {
    const branch = await git.currentBranch({ fs, dir, gitdir, fullname: false })
    return typeof branch === "string" && branch.trim() ? branch.trim() : null
  } catch (_e) {
    return null
  }
}

export async function createStashInternal(
  bookmarkName: string,
  message = "",
  paths?: string[]
): Promise<void> {
  const ctx = await getCtx(bookmarkName)
  const { git, fs, dir, gitdir } = ctx
  if (!(await hasResolvedHead(git, fs, dir, gitdir))) {
    throw new Error("首次提交前无法创建 Stash")
  }
  const author = await resolveAuthor()
  const branch = await safeCurrentBranch(git, fs, dir, gitdir)
  const safeMessage = sanitizeStashMessage(message) || (branch ? `WIP on ${branch}` : "WIP")
  await createPathStash(ctx, safeMessage, author, paths)
}

export async function commitInternal(
  bookmarkName: string,
  message: string,
  author?: { name: string; email: string }
): Promise<string> {
  const { git, fs, dir, gitdir } = await getCtx(bookmarkName)
  const resolvedAuthor = await resolveAuthor(author)
  await ensureGitConfigAuthor(git, fs, dir, gitdir, resolvedAuthor)
  return git.commit({ fs, dir, gitdir, message, author: resolvedAuthor })
}

export async function restoreFileInternal(
  bookmarkName: string,
  filepath: string
): Promise<void> {
  const { git, fs, dir, gitdir } = await getCtx(bookmarkName)
  let hasHead = true
  try {
    await git.resolveRef({ fs, dir, gitdir, ref: "HEAD" })
  } catch (_e) {
    hasHead = false
  }
  if (!hasHead) {
    const fullPath = dir + "/" + filepath
    if (await FileManager.exists(fullPath)) await FileManager.remove(fullPath)
    await git.remove({ fs, dir, gitdir, filepath }).catch(() => undefined)
    return
  }
  await checkoutWithEmptyDirCleanup(git, fs, {
    dir,
    gitdir,
    filepaths: [filepath],
    ref: "HEAD",
    force: true,
  })
}
