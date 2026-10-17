import { cloneRoot, type CloneDestination } from "./cloneWorkspace"
import { cleanText, hideSystemDetails } from "../utils/displayPaths"

const LIMIT = 200
const SAFE_NAME = /^[A-Za-z0-9._-]+$/

function failure(error: any): string {
  const kind = cleanText(error?.name || "Error", 40)
  const message = hideSystemDetails(error?.message || error)
  return `抛错 ${kind}${message ? "：" + cleanText(message, 160) : ""}`
}
async function probe(label: string, call: () => unknown | Promise<unknown>): Promise<string> {
  try { return `${label}=${String(await call())}` } catch (e: any) { return `${label}=${failure(e)}` }
}

/**
 * 只读诊断：仅调用 exists/isDirectory/isLink/readDirectory 及官方只读 iCloud 状态判断。
 * 不创建、删除、重命名、下载，也不对任何文件路径做循环修复。
 */
export async function runDirectoryCheck(destination: CloneDestination, names: string[], manualName = ""): Promise<string> {
  const lines = ["目录检查（只读，路径已隐藏）"]
  let root = ""
  try {
    if (destination.kind === "icloud") lines.push(`iCloud 已启用=${String(FileManager.isiCloudEnabled)}`)
    root = cloneRoot(destination)
    lines.push("目标解析=成功（git）")
  } catch (e: any) {
    lines.push("目标解析=失败：" + failure(e))
    return lines.join("\n")
  }
  try {
    const listed = await FileManager.readDirectory(root)
    const shown = listed.slice(0, LIMIT).map(item => cleanText(item, 80))
    lines.push(`git 目录项=${listed.length}${listed.length > LIMIT ? `（仅显示前 ${LIMIT} 项）` : ""}`)
    for (const item of shown) lines.push("- " + item)
  } catch (e: any) { lines.push("git 目录读取=" + failure(e)) }
  const storedApi = typeof FileManager.isFileStoredIniCloud === "function"
  const downloadedApi = typeof FileManager.isiCloudFileDownloaded === "function"
  lines.push(`iCloud 状态接口：存储=${storedApi ? "可用" : "不可用"}，下载=${downloadedApi ? "可用" : "不可用"}`)
  const manual = manualName.trim()
  const unique = [...new Set([...(manual ? [manual] : names), ...[]].map(item => item.trim()).filter(Boolean))]
  if (unique.length > LIMIT) lines.push(`检查名称过多，仅检查前 ${LIMIT} 个`)
  for (const name of unique.slice(0, LIMIT)) {
    const label = cleanText(name, 80)
    if (!SAFE_NAME.test(name) || name === "." || name === "..") { lines.push(`${label}：名称无效，未检查`); continue }
    const path = root + "/" + name
    const parts = [
      await probe("exists", () => FileManager.exists(path)),
      await probe("isDirectory", () => FileManager.isDirectory(path)),
      await probe("isLink", () => FileManager.isLink(path)),
      storedApi ? await probe("iCloud存储", () => FileManager.isFileStoredIniCloud(path)) : "iCloud存储=接口不可用",
      downloadedApi ? await probe("iCloud已下载", () => FileManager.isiCloudFileDownloaded(path)) : "iCloud已下载=接口不可用",
    ]
    lines.push(`${label}：${parts.join("；")}`)
  }
  return lines.join("\n")
}
