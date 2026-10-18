import { resolveRepoPathsReadOnly } from "./repoStore"
import { createFS, loadGitEngine } from "./gitCore"
import { validateBranchName } from "../utils/branch"
import { statusCoordinator } from "./git/matrixScanService"
import { runStatusMutation } from "./git/statusScanService"

const OID = /^[0-9a-f]{40}$/i
const MARKERS = ["HEAD.lock", "index.lock", "packed-refs.lock", "config.lock", "shallow.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "gitgit-merge-state.json", "BISECT_LOG"]
class AssociationError extends Error {}
const reject = (message: string): never => { throw new AssociationError(message) }
export function headAssociationErrorMessage(error: unknown): string {
  return error instanceof AssociationError ? error.message : "读取或写入校验失败；未确认重新关联，请重新读取诊断。"
}
export type HeadAssociationPreview = { gitdir: string; headOid: string; branches: string[] }
type State = HeadAssociationPreview & { headRaw: string; index: Uint8Array | null; observed: Map<string, string | null>; directories: Set<string> }

function validBranch(name: string): boolean {
  try {
    return validateBranchName(name) === name && name !== "HEAD" && name !== "@" && !name.startsWith("-") && name.split("/").every(p => !p.startsWith(".") && !p.endsWith(".lock"))
  } catch (_error) { return false }
}
function pathsFor(bookmarkName: string) {
  const paths = resolveRepoPathsReadOnly(bookmarkName)
  const root = FileManager.appGroupDocumentsDirectory.replace(/\/+$/, "") + "/git-repos/"
  const suffix = paths.gitdir.slice(root.length)
  if (!paths.gitdir.startsWith(root) || !suffix || suffix.includes("/") || suffix === "." || suffix === ".." || !paths.workdir) reject("仓库路径无法安全确认，未重新关联。")
  return paths
}
async function checkMarkers(gitdir: string) {
  for (const marker of MARKERS) if (await FileManager.exists(gitdir + "/" + marker)) reject("存在 Git 锁或未完成的合并/变基等操作，请结束其它操作后重试。")
}

/** No getCtx/resolveWorkdir, config, author, worktree scan, or initialization. */
async function inspect(bookmarkName: string): Promise<State> {
  const { gitdir, workdir } = pathsFor(bookmarkName)
  await checkMarkers(gitdir)
  const observed = new Map<string, string | null>(), directories = new Set<string>()
  async function safeDirectory(relative: string): Promise<boolean> {
    const full = gitdir + (relative ? "/" + relative : "")
    if (!(await FileManager.exists(full))) return false
    if (await FileManager.isLink(full) || !(await FileManager.isDirectory(full))) reject("Git 引用目录不是普通目录，未重新关联。")
    directories.add(full)
    return true
  }
  if (!(await safeDirectory(""))) reject("Git 元数据目录不存在，未重新关联。")
  await safeDirectory("refs")
  async function read(relative: string, optional = false): Promise<string | null> {
    const full = gitdir + "/" + relative
    if (!(await FileManager.exists(full))) {
      if (!optional) reject("所需 Git 引用不存在，未重新关联。")
      observed.set(full, null); return null
    }
    if (await FileManager.isLink(full) || await FileManager.isDirectory(full)) reject("Git 引用文件类型异常，未重新关联。")
    if ((await FileManager.stat(full)).size > (relative === "packed-refs" ? 1024 * 1024 : 4096)) reject("Git 引用超出安全读取上限，未重新关联。")
    const value = await FileManager.readAsString(full, "utf8")
    observed.set(full, value)
    return value
  }
  const headRaw = (await read("HEAD"))!
  const headOid = headRaw.trim()
  if (!OID.test(headOid)) reject("HEAD 当前不是有效的分离 OID；本入口不会修改已关联或异常的 HEAD。")
  const locals = new Map<string, string>(), packedNames = new Set<string>()
  const packed = await read("packed-refs", true)
  if (packed !== null) {
    const lines = packed.split(/\r?\n/)
    if (lines.length > 4096) reject("packed-refs 超出安全解析上限，未重新关联。")
    let previous = false
    for (const line of lines) {
      if (!line || line.startsWith("#")) continue
      if (line.startsWith("^")) {
        if (!previous || !OID.test(line.slice(1))) reject("packed-refs 格式异常，未重新关联。")
        previous = false; continue
      }
      const match = line.match(/^([0-9a-f]{40}) (refs\/\S+)$/i)
      if (!match || !validBranch(match[2].slice(5)) || packedNames.has(match[2])) reject("packed-refs 格式异常或存在重复引用，未重新关联。")
      packedNames.add(match[2]); previous = true
      if (match[2].startsWith("refs/heads/")) locals.set(match[2].slice(11), match[1])
    }
  }
  let count = 0
  async function walk(relative: string, depth = 0): Promise<void> {
    if (depth > 32) reject("本地引用层数异常，未重新关联。")
    if (!(await safeDirectory(relative))) return
    const full = gitdir + "/" + relative
    for (const item of await FileManager.readDirectory(full)) {
      if (++count > 2048) reject("本地引用数量超出上限，未重新关联。")
      const name = item.startsWith(full + "/") ? item.slice(full.length + 1) : item
      if (!name || name.includes("/") || !validBranch(name)) reject("本地引用名称异常或存在引用锁，未重新关联。")
      const child = relative + "/" + name, absolute = gitdir + "/" + child
      if (await FileManager.isLink(absolute)) reject("本地引用存在符号链接，未重新关联。")
      if (await FileManager.isDirectory(absolute)) { await walk(child, depth + 1); continue }
      const value = (await read(child))!.trim(), branch = child.slice(11)
      if (!validBranch(branch) || !OID.test(value)) reject("本地分支引用不是有效的直接 OID，未重新关联。")
      locals.set(branch, value)
    }
  }
  await walk("refs/heads")
  const branches = [...locals].filter(([, oid]) => oid === headOid).map(([name]) => name).sort()
  // Record absence of a loose override for packed-only matches, too.
  for (const branch of branches) if (!observed.has(gitdir + "/refs/heads/" + branch)) await read("refs/heads/" + branch, true)
  const { git } = await loadGitEngine()
  const fs = createFS(gitdir, workdir!)
  const readonly = new Proxy(fs, { get(target, key) {
    if (["writeFile", "mkdir", "rmdir", "unlink", "rename", "symlink"].includes(String(key))) return () => reject("只读校验意外请求写入，已拒绝。")
    return (target as any)[key]
  } })
  // Object existence/type is verified, not just a matching 40-character string.
  await git.readCommit({ fs: readonly, dir: workdir, gitdir, oid: headOid })
  let index: Uint8Array | null = null
  const indexPath = gitdir + "/index"
  if (await FileManager.exists(indexPath)) {
    if (await FileManager.isLink(indexPath) || await FileManager.isDirectory(indexPath) || (await FileManager.stat(indexPath)).size > 16 * 1024 * 1024) reject("索引类型或大小异常，未重新关联。")
    index = await FileManager.readAsBytes(indexPath)
    // Bundled Git validates v2 index structure/checksum, under a write-denying fs.
    await git.walk({ fs: readonly, dir: workdir, gitdir, trees: [git.STAGE()], map: async () => undefined })
    const bytes = index
    const u32 = (offset: number) => bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3]
    if (bytes.length < 32 || String.fromCharCode(...bytes.slice(0, 4)) !== "DIRC" || u32(4) !== 2) reject("索引格式不支持安全核验，未重新关联。")
    let offset = 12
    for (let entry = 0; entry < u32(8); entry++) {
      if (offset + 62 >= bytes.length - 20) reject("索引结构异常，未重新关联。")
      if (((bytes[offset + 60] << 8) | bytes[offset + 61]) & 0x3000) reject("索引仍有未解决冲突，未重新关联。")
      let end = offset + 62
      while (end < bytes.length - 20 && bytes[end] !== 0) end++
      if (end >= bytes.length - 20) reject("索引结构异常，未重新关联。")
      offset += 8 * Math.ceil((end - offset + 1) / 8)
    }
  }
  await checkMarkers(gitdir)
  return { gitdir, headOid, headRaw, index, branches, observed, directories }
}

export async function inspectHeadAssociation(bookmarkName: string): Promise<HeadAssociationPreview> {
  const { gitdir } = pathsFor(bookmarkName)
  if (statusCoordinator.isWriting(gitdir)) reject("仓库正在执行其它 Git 写操作，请稍后重试。")
  const state = await inspect(bookmarkName)
  if (statusCoordinator.isWriting(gitdir)) reject("检查期间出现 Git 写操作，请重新查找候选分支。")
  return { gitdir: state.gitdir, headOid: state.headOid, branches: state.branches }
}

/** The sole write is HEAD. Caller must have obtained an explicit user confirmation. */
export async function associateDetachedHead(bookmarkName: string, branch: string, expected: HeadAssociationPreview, confirmed: boolean): Promise<string> {
  if (!confirmed) reject("用户未确认，未修改 HEAD。")
  if (!validBranch(branch) || !expected.branches.includes(branch)) reject("必须明确选择已列出的同提交本地分支。")
  return runStatusMutation(bookmarkName, async () => {
    const fresh = await inspect(bookmarkName)
    if (fresh.gitdir !== expected.gitdir || fresh.headOid !== expected.headOid || !fresh.branches.includes(branch)) reject("HEAD、仓库路径或目标分支已变化，请重新查找并确认。")
    if (pathsFor(bookmarkName).gitdir !== fresh.gitdir) reject("仓库路径已变化，未修改 HEAD。")
    // Final synchronous checks + single-file write: no await window on the app JS queue.
    for (const marker of [...MARKERS, `refs/heads/${branch}.lock`]) if (FileManager.existsSync(fresh.gitdir + "/" + marker)) reject("出现 Git 锁或未完成操作，未修改 HEAD。")
    for (const directory of fresh.directories) if (FileManager.isLinkSync(directory) || !FileManager.isDirectorySync(directory)) reject("引用目录已变化，未修改 HEAD。")
    for (const [file, raw] of fresh.observed) {
      if (raw === null) { if (FileManager.isLinkSync(file) || FileManager.existsSync(file)) reject("引用已变化，请重新查找并确认。") }
      else if (FileManager.isLinkSync(file) || FileManager.readAsStringSync(file, "utf8") !== raw) reject("引用已变化，请重新查找并确认。")
    }
    const indexPath = fresh.gitdir + "/index"
    if (fresh.index === null) {
      if (FileManager.existsSync(indexPath) || FileManager.isLinkSync(indexPath)) reject("索引已变化，未修改 HEAD。")
    } else {
      if (FileManager.isLinkSync(indexPath)) reject("索引已变化，未修改 HEAD。")
      const bytes = FileManager.readAsBytesSync(indexPath)
      if (bytes.length !== fresh.index.length || bytes.some((byte, i) => byte !== fresh.index![i])) reject("索引已变化，未修改 HEAD。")
    }
    const headPath = fresh.gitdir + "/HEAD", next = `ref: refs/heads/${branch}\n`
    try {
      FileManager.writeAsStringSync(headPath, next, "utf8")
      if (FileManager.readAsStringSync(headPath, "utf8") !== next) throw new Error("HEAD verification failed")
    } catch (_error) {
      try {
        if (FileManager.readAsStringSync(headPath, "utf8") !== fresh.headRaw) FileManager.writeAsStringSync(headPath, fresh.headRaw, "utf8")
        if (FileManager.readAsStringSync(headPath, "utf8") !== fresh.headRaw) throw new Error("rollback verification failed")
      } catch (_rollbackError) { reject("HEAD 写入失败且原文恢复未确认；请停止其它 Git 操作并保留诊断，勿自动还原工作区。") }
      reject("HEAD 写入未成功，已确认保持原分离 HEAD；工作区和索引未操作。")
    }
    return branch
  })
}
