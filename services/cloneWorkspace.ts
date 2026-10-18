/** 新克隆默认本地「在我的 iPhone / Scripting / git」；已有路径不迁移。
 * Official: https://scriptingapp.github.io/guide/Utilities/FileManager.md
 * documentsDirectory is local Documents, visible in Files (not accessible to widgets).
 */
export type CloneDestination =
  | { kind: "local" }
  | { kind: "icloud" }
  | { kind: "external"; parentPath: string; accessBookmarkName: string | null }

export function cloneRoot(destination: CloneDestination): string {
  if (destination.kind === "local") {
    const root = FileManager.documentsDirectory
    if (!root) throw new Error("无法访问 Scripting 本地文稿目录，请更改目录")
    return root.replace(/\/+$/, "") + "/git"
  }
  if (destination.kind === "icloud") {
    if (!FileManager.isiCloudEnabled) throw new Error("iCloud 未启用或未授权 Scripting。请启用 iCloud Drive，或点「更改目录」选择父目录；不会改存本地。")
    try {
      const root = FileManager.iCloudDocumentsDirectory
      if (!root) throw new Error("iCloud 路径为空")
      return root.replace(/\/+$/, "") + "/git"
    } catch (e: any) {
      throw new Error("无法访问 Scripting iCloud 目录，请检查 iCloud 或重新选择目录：" + String(e?.message || e))
    }
  }
  let parent = destination.parentPath
  if (destination.accessBookmarkName) {
    const restored = FileManager.bookmarkedPath(destination.accessBookmarkName)
    if (!restored) throw new Error("目标父目录授权已失效，请点「更改目录」重新授权")
    parent = restored
  }
  return parent.replace(/\/+$/, "") + "/git"
}

export async function prepareCloneRoot(destination: CloneDestination): Promise<string> {
  const path = cloneRoot(destination)
  try {
    if (await FileManager.exists(path)) {
      if (await FileManager.isLink(path) || !(await FileManager.isDirectory(path))) throw new Error("git 路径不是普通文件夹")
    } else await FileManager.createDirectory(path, true)
    await FileManager.readDirectory(path)
    return path
  } catch (e: any) {
    throw new Error("无法使用目标 git 文件夹，请检查目录访问和写入权限，或更改目录：" + String(e?.message || e))
  }
}

/** App 自有文稿不依赖外部安全范围书签。 */
export function isAppOwnedWorkdir(path: string): boolean {
  const roots = [FileManager.documentsDirectory, FileManager.appGroupDocumentsDirectory]
  try { if (FileManager.isiCloudEnabled) roots.push(FileManager.iCloudDocumentsDirectory) } catch (_e) { /* iCloud 暂不可用 */ }
  return roots.filter(Boolean).some(root => path === root || path.startsWith(root.replace(/\/+$/, "") + "/"))
}
