/** 展示用：目录检查和克隆结果不暴露系统绝对路径或凭据。内部实际路径不变。 */
export function relativeCloneLabel(name: string): string {
  return "git/" + cleanText(name)
}
export function cleanText(value: unknown, limit = 120): string {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, "?").slice(0, limit)
}
export function hideSystemDetails(value: unknown): string {
  return String(value ?? "")
    .replace(/(^|[\s(（:：=])((?:\/[^\s/"'()，。；]+){2,})/g, "$1<路径>")
    .replace(/((?:^|[\s?&;,])(?:token|access_token|auth|authorization|password)\s*[=:]\s*)[^&#\s;,]+/gi, "$1***")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "***")
}
