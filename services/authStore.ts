/**
 * services/authStore.ts - GitHub token 与自动提交作者管理
 *
 * 职责：
 *  1. GitHub PAT 的 Keychain 存取（敏感凭据仍走系统 Keychain）
 *  2. 从当前 Token 已验证的 GitHub 账号生成提交作者（noreply 邮箱）
 *  3. 构造 isomorphic-git 认证对象（{ username, password }）
 *  4. Token 验证状态（GitHub 用户）持久化到 Storage private 域，token 变更/清除时作废
 */

import {
  KC_TOKEN_KEY,
  KC_USERNAME_KEY,
  GITHUB_DEFAULT_USERNAME,
  DEFAULT_GIT_IDENTITY,
} from "../constants/auth"
import {
  readGithubUser,
  writeGithubUser,
} from "./storage"
import type { GitIdentity, VerifiedGithubUser } from "../types/git"

// 重新导出类型，保持调用处 `import type { GitIdentity } from authStore` 可用
export type { GitIdentity }
export { DEFAULT_GIT_IDENTITY }

// === GitHub PAT ===

/** 是否已配置 token */
export function hasToken(): boolean {
  return Keychain.contains(KC_TOKEN_KEY)
}

/** 读取 token（未配置返回 null） */
export function getToken(): string | null {
  return Keychain.get(KC_TOKEN_KEY)
}

/** 保存 token（用户名默认 x-access-token，可覆盖） */
export function setToken(token: string, username?: string): void {
  const tokenSaved = Keychain.set(KC_TOKEN_KEY, token)
  const usernameSaved = Keychain.set(
    KC_USERNAME_KEY,
    username || GITHUB_DEFAULT_USERNAME
  )
  if (!tokenSaved || !usernameSaved) {
    if (tokenSaved) Keychain.remove(KC_TOKEN_KEY)
    if (usernameSaved) Keychain.remove(KC_USERNAME_KEY)
    throw new Error("GitHub Token 保存到 Keychain 失败")
  }
  // 凭据已更换，旧的验证结果作废
  writeGithubUser(null)
}

/** 清除 token */
export function clearToken(): void {
  const tokenRemoved =
    !Keychain.contains(KC_TOKEN_KEY) || Keychain.remove(KC_TOKEN_KEY)
  const usernameRemoved =
    !Keychain.contains(KC_USERNAME_KEY) || Keychain.remove(KC_USERNAME_KEY)
  if (!tokenRemoved || !usernameRemoved) {
    throw new Error("GitHub Token 从 Keychain 清除失败")
  }
  writeGithubUser(null)
}

/** 读取 Token 上次验证成功的 GitHub 用户（未验证/已作废返回 null） */
export function getVerifiedUser(): VerifiedGithubUser | null {
  return readGithubUser()
}

/** 保存 Token 验证成功的 GitHub 用户，供设置页重进时恢复验证状态 */
export function saveVerifiedUser(user: VerifiedGithubUser): void {
  writeGithubUser(user)
}

/**
 * 构造 isomorphic-git 认证对象
 * 未配置 token 时返回 null（由调用方决定是否中止 / 提示配置）
 */
export function getAuth(): { username: string; password: string } | null {
  const token = getToken()
  if (!token) return null
  const username = Keychain.get(KC_USERNAME_KEY) || GITHUB_DEFAULT_USERNAME
  return { username, password: token }
}

// === Git 提交作者：自动使用当前 Token 对应账号 ===

/** 显式 override 供内部操作保留作者；不再读取旧的手工身份设置。 */
export async function resolveAuthor(
  override?: { name?: string; email?: string } | null
): Promise<GitIdentity> {
  const oName = override?.name?.trim()
  const oEmail = override?.email?.trim()
  if (oName && oEmail) return { name: oName, email: oEmail }
  const token = getToken()
  if (!token) throw new Error("请先在设置中配置并验证 GitHub Token，提交作者将自动使用该账号")
  let user = getVerifiedUser()
  if (!user?.login || !Number.isSafeInteger(user.id) || Number(user.id) <= 0) {
    const response = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      timeout: 20,
      debugLabel: "scriptgit commit account",
    })
    if (!response.ok) throw new Error(`无法确认 GitHub 提交账号（HTTP ${response.status}），请在设置中验证 Token`)
    const data = await response.json()
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(String(data.login || "")) || !Number.isSafeInteger(data.id) || data.id <= 0) {
      throw new Error("GitHub 未返回有效账号，未创建提交")
    }
    user = { login: data.login, id: data.id, avatarUrl: String(data.avatar_url || "") }
    if (getToken() !== token) throw new Error("GitHub Token 已更换，请重试提交")
    saveVerifiedUser(user)
  }
  if (getToken() !== token) throw new Error("GitHub Token 已更换，请重试提交")
  return { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` }
}
