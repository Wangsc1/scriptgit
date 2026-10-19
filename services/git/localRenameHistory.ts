import { resolveWorkdir } from "../repoStore"
import { getCtx } from "./runtime"

export type RestoreSelection = { path: string; directory: boolean; related?: boolean }
export type LocalRename = { from: string; to: string; directory: boolean }
type History = { root: string; gitdir: string; head: string | null; events: LocalRename[] }
const KEY = "gitgit.localRenameHistory.v1"
const memory = new Map<string, History>()
const safe = (path: string) => !!path && !path.startsWith("/") && !/[\\\x00-\x1f\x7f]/.test(path) && path.split("/").every(p => !!p && p !== "." && p !== ".." && p.toLowerCase() !== ".git")
function read(root: string): History | undefined {
  const cached = memory.get(root)
  if (cached) return cached
  if (typeof Storage === "undefined") return undefined
  const records = Storage.get<Record<string, History>>(KEY)
  const value = records?.[root]
  if (!value || value.root !== root || !Array.isArray(value.events) || !value.events.every(e => safe(e.from) && safe(e.to) && typeof e.directory === "boolean")) return undefined
  memory.set(root, value)
  return value
}
function save(value: History) {
  memory.set(value.root, value)
  if (typeof Storage === "undefined") return
  const records = Storage.get<Record<string, History>>(KEY) || {}
  if (!Storage.set(KEY, { ...records, [value.root]: value })) throw new Error("重命名记录保存失败；若文件已改名，请勿重复操作，先刷新检查。")
}
async function identity(bookmarkName: string, context?: Awaited<ReturnType<typeof getCtx>>) {
  const ctx = context || await getCtx(bookmarkName)
  let head: string | null = null
  try { head = await ctx.git.resolveRef({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, ref: "HEAD" }) }
  catch (error: any) { if (error?.code !== "NotFoundError") throw error }
  return { root: ctx.dir.replace(/\/+$/, ""), gitdir: ctx.gitdir, head }
}
/** Record only actual native rename results, never guess a Git delete/add pairing. */
export async function trackLocalRename<T>(bookmarkName: string, from: string, directory: boolean, operation: () => Promise<T>, destination: (result: T) => string): Promise<T> {
  const id = await identity(bookmarkName)
  const previous = read(id.root)
  const events = previous?.gitdir === id.gitdir && previous.head === id.head ? previous.events : []
  // Check that the app-state store is writable before touching user files.
  save({ ...id, events })
  const result = await operation()
  const to = destination(result)
  if (from !== to) save({ ...id, events: [...events, { from, to, directory }] })
  return result
}
export async function validatedLocalRenames(bookmarkName: string, context?: Awaited<ReturnType<typeof getCtx>>): Promise<LocalRename[]> {
  const root = (context?.dir || resolveWorkdir(bookmarkName)).replace(/\/+$/, "")
  const value = read(root)
  if (!value?.events.length) return []
  const id = await identity(bookmarkName, context)
  if (value.gitdir === id.gitdir && value.head === id.head) return value.events
  // A commit/checkout replaces the baseline. Never apply old rename facts to it.
  memory.set(root, { ...id, events: [] })
  return []
}
/** For remounted file pages; actual restore always checks root/gitdir/HEAD again. */
export function knownLocalRenames(bookmarkName: string): LocalRename[] {
  return read(resolveWorkdir(bookmarkName).replace(/\/+$/, ""))?.events || []
}
const inside = (path: string, directory: string) => path === directory || path.startsWith(directory + "/")
/** Old-name entry points (e.g. status tab) must also find the current destination. */
export function forwardRenameSelection(selection: RestoreSelection[], events: LocalRename[]): RestoreSelection[] {
  const selected = new Map(selection.map(scope => [(scope.directory ? "d:" : "f:") + scope.path, scope]))
  for (const event of events) for (const scope of [...selected.values()]) {
    if (scope.path === event.from || (event.directory && inside(scope.path, event.from))) {
      const path = event.to + scope.path.slice(event.from.length)
      selected.set((scope.directory ? "d:" : "f:") + path, { path, directory: scope.directory })
    } else if (scope.directory && inside(event.from, scope.path)) {
      selected.set((event.directory ? "d:" : "f:") + event.to, { path: event.to, directory: event.directory })
    }
  }
  return [...selected.values()]
}

/** Walk actual operations backwards, including file-then-parent and parent-then-file chains. */
export function expandRenameSelection(selection: RestoreSelection[], events: LocalRename[]): RestoreSelection[] {
  const selected = new Map(selection.map(s => [(s.directory ? "d:" : "f:") + s.path, s]))
  for (const event of [...events].reverse()) {
    for (const scope of [...selected.values()]) {
      if (scope.path === event.to || (event.directory && inside(scope.path, event.to))) {
        const path = event.from + scope.path.slice(event.to.length)
        if (!selected.has((scope.directory ? "d:" : "f:") + path)) selected.set((scope.directory ? "d:" : "f:") + path, { path, directory: scope.directory, related: true })
      } else if (scope.directory && inside(event.to, scope.path)) {
        if (!selected.has((event.directory ? "d:" : "f:") + event.from)) selected.set((event.directory ? "d:" : "f:") + event.from, { path: event.from, directory: event.directory, related: true })
      }
    }
  }
  return [...selected.values()]
}

/** A completed restore consumes only whole rename operations, not sibling/subtree operations. */
export function consumeRestoredRenames(root: string, gitdir: string, scopes: RestoreSelection[]) {
  const value = read(root)
  if (!value || value.gitdir !== gitdir) return
  const covered = (path: string, directory: boolean) => scopes.some(scope => scope.directory ? !scope.path || inside(path, scope.path) : !directory && scope.path === path)
  const events = value.events.filter(event => !covered(event.from, event.directory) || !covered(event.to, event.directory))
  if (events.length !== value.events.length) save({ ...value, events })
}

/** Display only explicit rename roots/files, not every descendant moved with a folder. */
export function knownLocalRenameHints(bookmarkName: string): { path: string; sources: string[]; directory: boolean }[] {
  const events = knownLocalRenames(bookmarkName)
  const hints = new Map<string, { path: string; sources: string[]; directory: boolean }>()
  events.forEach((event, index) => {
    let path = event.to
    for (const next of events.slice(index + 1)) if (path === next.from || (next.directory && inside(path, next.from))) path = next.to + path.slice(next.from.length)
    const sources = expandRenameSelection([{ path, directory: event.directory }], events).filter(scope => scope.path !== path).map(scope => scope.path)
    hints.set(path, { path, sources: [...new Set(sources)], directory: event.directory })
  })
  return [...hints.values()]
}
