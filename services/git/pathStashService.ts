import { scanMutationMatrix } from "./matrixScanService"

const INDEX_MESSAGE = "scriptgit-path-stash index"
export { INDEX_MESSAGE as PATH_STASH_INDEX_MESSAGE }

type Entry = { mode: string; oid: string; type: "blob"; path: string }

/** Build a full tree without ever staging unrelated worktree content. */
async function writeFlatTree(ctx: any, files: Map<string, Entry>): Promise<string> {
  const root: any = new Map()
  for (const [path, entry] of files) {
    const parts = path.split("/")
    let node = root
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map())
      node = node.get(part)
      if (!(node instanceof Map)) throw new Error("Stash 路径存在文件/目录冲突")
    }
    node.set(parts[parts.length - 1], entry)
  }
  async function write(node: Map<string, any>): Promise<string> {
    const tree = []
    for (const [path, value] of node) {
      tree.push(value instanceof Map
        ? { path, mode: "040000", type: "tree", oid: await write(value) }
        : { ...value, path })
    }
    return ctx.git.writeTree({ ...ctx, tree })
  }
  return write(root)
}

/** A normal two-parent Git stash. Only selected paths are reset; all other index entries survive. */
export async function createPathStash(ctx: any, message: string, author: any, paths?: string[]): Promise<void> {
  const { git, fs, dir, gitdir } = ctx
  const head = await git.resolveRef({ ...ctx, ref: "HEAD" })
  const matrix = await scanMutationMatrix(ctx, "写操作路径 Stash")
  if (paths?.some(path => !path || path.startsWith("/") || path.split("/").some(p => !p || p === "." || p === "..") || path.includes("\\"))) {
    throw new Error("无效的 Stash 路径")
  }
  const selected = new Set<string>(matrix.filter(([path, h, w, s]: any) =>
    (h !== w || h !== s) && (!paths || paths.some(prefix => path === prefix || path.startsWith(prefix + "/")))
  ).map((row: any) => row[0]))
  if (!selected.size) throw new Error("没有可保存的改动")
  const base = new Map<string, Entry>()
  const staged = new Map<string, Entry>()
  const working = new Map<string, Entry>()
  const snapshots = new Map<string, any>()
  await git.walk({ ...ctx, trees: [git.TREE({ ref: head }), git.STAGE(), git.WORKDIR()], map: async (path: string, entries: any[]) => {
    if (path === ".") return
    const [h, s, w] = entries
    if (h && await h.type() !== "tree") base.set(path, { path, mode: (await h.mode()).toString(8), oid: await h.oid(), type: await h.type() })
    if (!selected.has(path)) return
    // Avoid following symlinks or overwriting submodules / file-directory transitions.
    for (const entry of entries) {
      if (entry && (await entry.type() !== "blob" || await entry.mode() !== 0o100644)) {
        throw new Error("Stash 暂不支持可执行文件、符号链接、子模块或文件/目录类型切换：" + path)
      }
    }
    for (const [entry, target] of [[s, staged], [w, working]] as any) {
      if (!entry) continue
      const blob = entry === w ? await fs.readFile(dir + "/" + path) : null
      const oid = entry === w ? await git.writeBlob({ fs, gitdir, blob }) : await entry.oid()
      target.set(path, { path, mode: (await entry.mode()).toString(8), oid, type: "blob" })
      if (entry === w) snapshots.set(path, blob)
    }
  } })
  const indexTree = new Map(base), workTree = new Map(base)
  for (const path of selected) {
    indexTree.delete(path); workTree.delete(path)
    if (staged.has(path)) indexTree.set(path, staged.get(path)!)
    if (working.has(path)) workTree.set(path, working.get(path)!)
  }
  const identity = { ...author, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: new Date().getTimezoneOffset() }
  const indexOid = await git.writeCommit({ fs, gitdir, commit: { tree: await writeFlatTree(ctx, indexTree), parent: [head], author: identity, committer: identity, message: INDEX_MESSAGE } })
  const oid = await git.writeCommit({ fs, gitdir, commit: { tree: await writeFlatTree(ctx, workTree), parent: [head, indexOid], author: identity, committer: identity, message } })
  const metadata = [gitdir + "/index", gitdir + "/refs/stash", gitdir + "/logs/refs/stash"]
  const before = await Promise.all(metadata.map(async path => await fs.exists(path) ? await fs.readFile(path) : null))
  async function restoreMetadata() {
    for (let i = 0; i < metadata.length; i++) {
      if (before[i] !== null) await fs.writeFile(metadata[i], before[i])
      else if (await fs.exists(metadata[i])) await fs.unlink(metadata[i])
    }
  }
  try {
    // Publish recovery objects before touching selected worktree/index paths.
    await git.writeRef({ ...ctx, ref: "refs/stash", value: oid, force: true })
    const old = before[1] ? String(before[1]).trim() : "0".repeat(40)
    const offset = identity.timezoneOffset
    const zone = (offset <= 0 ? "+" : "-") + String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0") + String(Math.abs(offset) % 60).padStart(2, "0")
    await fs.writeFile(metadata[2], (before[2] ? String(before[2]) : "") + `${old} ${oid} ${author.name} <${author.email}> ${identity.timestamp} ${zone}\t${message}\n`)
    for (const path of selected) {
      if (base.has(path)) {
        await git.checkout({ ...ctx, ref: head, filepaths: [path], force: true, noUpdateHead: true })
      } else {
        if (await fs.exists(dir + "/" + path)) await fs.unlink(dir + "/" + path)
        await git.remove({ ...ctx, filepath: path })
      }
    }
  } catch (error) {
    // Restore exact original bytes/index; if rollback itself fails retain the stash as recovery.
    try {
      for (const path of selected) {
        if (snapshots.has(path)) await fs.writeFile(dir + "/" + path, snapshots.get(path))
        else if (await fs.exists(dir + "/" + path)) await fs.unlink(dir + "/" + path)
      }
      await restoreMetadata()
    } catch (rollbackError) {
      throw new Error(`Stash 失败且恢复未完成；恢复对象 ${oid}，请保留并核对工作区：${String(error)}；${String(rollbackError)}`)
    }
    throw error
  }
}
