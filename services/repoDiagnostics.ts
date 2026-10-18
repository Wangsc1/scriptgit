import { resolveRepoPathsReadOnly } from "./repoStore"

const OID = /^[0-9a-f]{40}$/i
const MAX_FILE_BYTES = 1024 * 1024
const MAX_REFS = 2048

type Ref = { value: string; source: string }

/** Metadata is untrusted text. Never print native errors, config, remote URLs or token-shaped values. */
export function diagnosticText(value: string): string {
  return value
    .replace(/(?:https?|ssh|git):\/\/[^\s"<>]+/gi, "[URL omitted]")
    .replace(/(?:gh[pousr]_[a-zA-Z0-9_]+|github_pat_[a-zA-Z0-9_]+|(?:Bearer|Basic)\s+[^\s"<>]+)/gi, "[credential omitted]")
    .replace(/\b(?:token|password|authorization|access_token)\s*[:=]\s*[^\s"<>]+/gi, "[credential omitted]")
}

function failure(error: any): string {
  // No arbitrary error.message/code: native messages can embed a credential-bearing URL.
  const code = String(error?.code || "").toUpperCase()
  if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EIO"].includes(code)) return code
  if (["4", "260"].includes(code)) return "ENOENT"
  return "读取失败（未输出原始异常，避免泄漏敏感信息）"
}

function validRef(ref: string): boolean {
  return ref.startsWith("refs/") && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) && !ref.includes("..") && !ref.includes("@{") && !ref.includes("//") && !ref.endsWith(".") && ref.split("/").every(p => !!p && !p.startsWith(".") && !p.endsWith(".lock"))
}

/** Reads only repository metadata and directory accessibility; never imports getCtx/Git engine. */
export async function collectRepoDiagnostics(bookmarkName: string): Promise<string> {
  const lines = ["ScriptGit 仓库只读诊断", "采集时间：" + new Date().toISOString(), "不初始化/修复/切换/暂存仓库；不读取工作文件内容，不读取 config、远端 URL 或认证信息。", "这是当前读取快照；并发 Git 操作可能使各项不一致。", ""]
  let paths: ReturnType<typeof resolveRepoPathsReadOnly>
  try { paths = resolveRepoPathsReadOnly(bookmarkName) }
  catch (_error) { return lines.concat("仓库元数据未找到或读取失败；未执行路径修复。").join("\n") }
  lines.push("路径来源：" + paths.source, ...paths.bookmarkChecks, "保存的工作路径：" + (paths.storedWorkdir || "（未保存）"), "实际解析工作路径：" + (paths.workdir || "（未解析）"), "Git 元数据目录 gitdir：" + paths.gitdir, "说明：gitdir 独立保存在 App Group，不要求工作目录中存在 .git。", "")

  async function probe(label: string, path: string | null): Promise<void> {
    if (!path) { lines.push(label + "：没有路径"); return }
    try {
      lines.push(label + " exists=" + String(await FileManager.exists(path)))
      if (await FileManager.isLink(path)) { lines.push(label + "：符号链接，未继续读取"); return }
      const directory = await FileManager.isDirectory(path)
      lines.push(label + " isDirectory=" + String(directory))
      if (directory) {
        await FileManager.readDirectory(path)
        lines.push(label + "：目录枚举成功（不导出文件名）")
      }
    } catch (error) { lines.push(label + " 访问检查：" + failure(error)) }
  }
  await probe("工作目录", paths.workdir)
  await probe("gitdir", paths.gitdir)
  // Avoid escaping the app-owned metadata root even with malformed saved repoId.
  const root = FileManager.appGroupDocumentsDirectory.replace(/\/+$/, "") + "/git-repos/"
  const suffix = paths.gitdir.slice(root.length)
  if (!paths.gitdir.startsWith(root) || !suffix || suffix.includes("/") || suffix === "." || suffix === "..") {
    return diagnosticText(lines.concat("gitdir 不在预期的单仓库元数据目录内；停止读取引用。").join("\n"))
  }
  try {
    if (await FileManager.isLink(paths.gitdir)) return diagnosticText(lines.concat("gitdir 为符号链接，停止读取引用。").join("\n"))
  } catch (error) { return diagnosticText(lines.concat("gitdir 无法确认安全访问：" + failure(error)).join("\n")) }

  async function read(relative: string, limit = MAX_FILE_BYTES): Promise<string | null> {
    const path = paths.gitdir + "/" + relative
    try {
      if (await FileManager.isLink(path)) { lines.push(relative + "：符号链接，未读取"); return null }
      const stat = await FileManager.stat(path)
      if (stat.size > limit) { lines.push(relative + "：超过诊断读取上限 " + limit + " 字节，未读取"); return null }
      return await FileManager.readAsString(path, "utf8")
    } catch (error) { lines.push(relative + "：" + failure(error)); return null }
  }

  const head = await read("HEAD", 4096)
  lines.push("", "HEAD 原始值（JSON 转义；敏感模式已过滤）：" + (head === null ? "（未读到）" : JSON.stringify(head)))
  if (head !== null) {
    const symbolic = head.trim().match(/^ref: (refs\/\S+)$/)
    if (symbolic) lines.push("HEAD 形式：符号引用 → " + symbolic[1] + (symbolic[1].startsWith("refs/heads/") ? "（本地分支命名空间）" : "（非本地分支命名空间）"))
    else if (!OID.test(head.trim())) lines.push("HEAD 形式：非标准内容，未推断当前分支")
  }
  const refs = new Map<string, Ref>()
  const packed = await read("packed-refs")
  if (packed !== null) {
    let count = 0, anomalies = 0, previous = false
    const packedLines = packed.split(/\r?\n/)
    for (let i = 0; i < packedLines.length; i++) {
      if (i >= 4096) { lines.push("packed-refs：达到行数上限，结果不完整"); break }
      const line = packedLines[i]
      if (!line || line.startsWith("#")) continue
      if (line.startsWith("^")) {
        if (!previous || !OID.test(line.slice(1))) { lines.push(`packed-refs 第 ${i + 1} 行：无效 peeled 记录（原文未输出）`); anomalies++ }
        previous = false
        continue
      }
      const match = line.match(/^([0-9a-f]{40}) (refs\/\S+)$/i)
      previous = !!match && validRef(match[2])
      if (!match || !previous) { lines.push(`packed-refs 第 ${i + 1} 行：格式异常（原文未输出）`); anomalies++; continue }
      if (refs.has(match[2])) { lines.push(`packed-refs 第 ${i + 1} 行：重复引用`); anomalies++ }
      if (count++ >= MAX_REFS) { lines.push("packed-refs：达到引用数量上限，结果不完整"); break }
      refs.set(match[2], { value: match[1], source: "packed-refs" })
    }
    lines.push(`packed-refs：已解析 ${Math.min(count, MAX_REFS)} 条引用，${anomalies} 处格式异常`)
  }

  let visited = 0
  async function walk(relative: string, depth = 0): Promise<void> {
    if (depth > 32 || visited >= MAX_REFS) { lines.push(relative + "：达到诊断遍历上限，结果不完整"); return }
    const absolute = paths.gitdir + "/" + relative
    try {
      if (await FileManager.isLink(absolute)) { lines.push(relative + "：符号链接，未读取"); return }
      const entries = await FileManager.readDirectory(absolute)
      for (const entry of entries.sort()) {
        if (++visited > MAX_REFS) { lines.push("松散引用：达到数量上限，结果不完整"); break }
        // FileManager may return absolute paths; accept only immediate children of this directory.
        const name = entry.startsWith(absolute + "/") ? entry.slice(absolute.length + 1) : entry
        if (!name || name.includes("/") || name === "." || name === "..") { lines.push(relative + "：目录项无效（未输出原文）"); continue }
        const child = relative + "/" + name, full = paths.gitdir + "/" + child
        if (!validRef(child)) { lines.push(relative + "：引用名无效（未输出原文）"); continue }
        if (await FileManager.isLink(full)) { lines.push(child + "：符号链接，未读取"); continue }
        if (await FileManager.isDirectory(full)) { await walk(child, depth + 1); continue }
        const raw = await read(child, 4096)
        if (raw === null) continue
        const value = raw.trim()
        if (!OID.test(value) && !(value.startsWith("ref: ") && validRef(value.slice(5)))) lines.push(child + "：引用内容无效（原文未输出）")
        refs.set(child, { value, source: "loose" })
      }
    } catch (error) { lines.push(relative + " 枚举：" + failure(error)) }
  }
  // Check every parent before following metadata paths; never follow a ref-directory symlink.
  try {
    if (await FileManager.isLink(paths.gitdir + "/refs")) lines.push("refs 为符号链接，未读取松散引用")
    else {
      await walk("refs/heads")
      if (await FileManager.isLink(paths.gitdir + "/refs/remotes")) lines.push("refs/remotes 为符号链接，未读取 origin")
      else await walk("refs/remotes/origin")
    }
  } catch (error) { lines.push("refs 访问：" + failure(error)) }

  function resolve(value: string, seen = new Set<string>()): string {
    if (OID.test(value)) return value
    const target = value.startsWith("ref: ") ? value.slice(5) : ""
    if (!validRef(target)) return "无效引用内容"
    if (seen.has(target) || seen.size > 16) return "符号引用循环或层数超限"
    seen.add(target)
    const ref = refs.get(target)
    return ref ? resolve(ref.value, seen) : "未在本次读取的引用中找到 " + target
  }
  lines.push("", "HEAD 解析：" + (head === null ? "未知（读取失败或不存在）" : OID.test(head.trim()) ? "OID 形式，未指向命名分支：" + head.trim() : resolve(head.trim())), "注意：仅解析引用，不验证 OID 对象是否存在；未找到引用不等于已确认损坏。")
  for (const [label, prefix] of [["本地分支引用（实际 refs/heads，非界面合成）", "refs/heads/"], ["origin 远端跟踪引用（含 origin/HEAD）", "refs/remotes/origin/"]]) {
    const rows = [...refs].filter(([name]) => name.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
    lines.push("", label + "：" + rows.length)
    for (const [name, ref] of rows) {
      // Invalid raw data may contain arbitrary secrets; output only verified OID or ref structure.
      const value = OID.test(ref.value) || (ref.value.startsWith("ref: ") && validRef(ref.value.slice(5))) ? ref.value : "（无效内容，未输出原文）"
      lines.push(`${name} [${ref.source}] = ${value}; 解析：${resolve(ref.value)}`)
    }
  }
  lines.push("", "只读诊断不更改仓库。请先复制报告供排查，不要因未显示分支而强设 main/master、还原或删除文件。")
  return diagnosticText(lines.join("\n"))
}
