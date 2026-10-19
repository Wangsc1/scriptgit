/** GitHub Raw URL for a branch file; never includes authentication or local bytes. */
export function rawFileUrl(fullName: string | null, branch: string | null, path: string): string {
  if (!fullName || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) || fullName.split("/").some(part => part === "." || part === "..")) {
    throw new Error("未关联 GitHub 仓库，无法复制 Raw 链接")
  }
  if (!branch || !branch.trim() || /[\x00-\x1f\x7f]/.test(branch)) throw new Error("当前没有可用分支，无法复制 Raw 链接")
  const parts = path.split("/")
  if (parts.some(part => !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part))) throw new Error("文件路径无效，无法复制链接")
  // Explicit refs/heads avoids a same-named tag taking precedence over the branch.
  return `https://raw.githubusercontent.com/${fullName}/refs/heads/${encodeURIComponent(branch)}/${parts.map(encodeURIComponent).join("/")}`
}
