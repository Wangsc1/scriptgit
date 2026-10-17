/**
 * api/githubApi.ts - GitHub API 客户端
 *
 * 用于 GitHub REST 与 GraphQL 数据查询。
 * 认证：Bearer token（来自 authStore）。
 */

import { getToken } from "../services/authStore"
import { setLruEntry } from "../utils/lru"
import type { GitHubUser, GitHubRepo } from "../types/git"
import type {
  CreateGitHubIssueInput,
  GitHubComment,
  GitHubIssueFilter,
  GitHubIssueItem,
  GitHubIssuePage,
  GitHubCommitAvatarMap,
  GitHubRepoVisibility,
  CommitCheckState,
  CommitCheckStatusMap,
  ActionRun,
  ActionRunPage,
  ActionJob,
  ActionJobLog,
  ActionWorkflow,
  DispatchWorkflowInput,
  ActionArtifact,
  ActionAnnotation,
  AnnotationLevel,
} from "../types/github"

const API_BASE = "https://api.github.com"
const GRAPHQL_URL = "https://api.github.com/graphql"
const COMMIT_AVATAR_CACHE_LIMIT = 500
const commitAvatarCache = new Map<string, string>()

/** 创建仓库时的表单字段（对齐 GitHub 新建仓库页） */
export interface CreateRepoInput {
  name: string
  description?: string
  private?: boolean
  homepage?: string
}

function mapRepo(data: any): GitHubRepo {
  const parent = data.parent || data.source
  return {
    name: data.name,
    fullName: data.full_name,
    url: data.clone_url,
    private: data.private,
    description: data.description,
    defaultBranch: data.default_branch || "main",
    updatedAt: data.updated_at,
    stargazersCount: data.stargazers_count || 0,
    fork: !!data.fork,
    parent: parent
      ? {
          fullName: parent.full_name,
          url: parent.clone_url,
          defaultBranch: parent.default_branch || "main",
        }
      : undefined,
  }
}

function encodeRepo(fullName: string): string {
  const normalized = String(fullName || "").trim()
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new Error("GitHub 仓库名称无效")
  }
  return normalized.split("/").map(encodeURIComponent).join("/")
}

function mapActor(data: any) {
  return {
    login: String(data?.login || "unknown"),
    avatarUrl: String(data?.avatar_url || ""),
  }
}

function mapIssue(data: any): GitHubIssueItem {
  return {
    number: Number(data.number),
    title: String(data.title || ""),
    body: String(data.body || ""),
    state: data.state === "closed" ? "closed" : "open",
    author: mapActor(data.user),
    labels: Array.isArray(data.labels)
      ? data.labels.map((label: any) => ({
          name: String(label?.name || ""),
          color: String(label?.color || ""),
        })).filter((label: { name: string }) => label.name)
      : [],
    comments: Number(data.comments || 0),
    createdAt: String(data.created_at || ""),
    updatedAt: String(data.updated_at || ""),
    closedAt: data.closed_at ? String(data.closed_at) : null,
    htmlUrl: String(data.html_url || ""),
    isPullRequest: !!data.pull_request || (!!data.head && !!data.base),
    draft: !!data.draft,
    merged: !!data.merged_at,
  }
}

function mapComment(data: any): GitHubComment {
  return {
    id: Number(data.id),
    body: String(data.body || ""),
    author: mapActor(data.user),
    createdAt: String(data.created_at || ""),
    updatedAt: String(data.updated_at || ""),
    htmlUrl: String(data.html_url || ""),
  }
}

/** 默认要求认证；仅明确标记的公开 GET 可匿名，已有 Token 失败绝不降级。 */
async function githubFetch(
  url: string,
  options?: { method?: string; body?: unknown; requireToken?: boolean }
): Promise<any> {
  const token = getToken()
  const method = options?.method || "GET"
  if (!token && (options?.requireToken !== false || method !== "GET")) {
    throw new Error("未配置 GitHub Token")
  }
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
  if (token) headers.Authorization = `Bearer ${token}`
  let body: string | undefined
  if (options?.body !== undefined) {
    headers["Content-Type"] = "application/json"
    body = JSON.stringify(options.body)
  }
  const res = await fetch(url, {
    method,
    headers,
    body,
    timeout: 20,
    debugLabel: "scriptgit GitHub API",
  })
  if (!res.ok) {
    // 解析 GitHub 返回的错误信息
    let msg = `HTTP ${res.status}`
    try {
      const err = await res.json()
      if (err.message) msg = err.message
      // 字段级错误更可读
      if (err.errors && Array.isArray(err.errors) && err.errors.length > 0) {
        const details = err.errors
          .map((e: any) => e.message || `${e.resource}: ${e.code}`)
          .join("; ")
        if (details) msg = `${msg}（${details}）`
      }
    } catch (_e) {
      // 响应不是 JSON 时保留 HTTP 状态信息
    }
    let hint = ""
    if (res.status === 401) hint = token ? "Token 无效或已过期，请在设置更新；未降级为匿名访问。" : "匿名访问被拒绝，请检查仓库是否公开。"
    else if (res.status === 429 || (res.status === 403 && /rate.?limit/i.test(msg))) hint = token ? "GitHub API 限流，请稍后重试；未降级为匿名访问。" : "匿名 GitHub API 限流，请稍后重试或配置 Token 提高限额。"
    else if (res.status === 403) hint = token ? "请检查 Token 权限、组织策略或 API 限流；未降级为匿名访问。" : "匿名访问受限或触发限流，请稍后重试或配置 Token。"
    else if (res.status === 404) hint = "用户名/仓库不存在或当前凭据无权访问。"
    const error = new Error(`GitHub API 请求失败（HTTP ${res.status}）：${msg}${hint ? "；" + hint : ""}`) as Error & { status: number }
    error.status = res.status
    throw error
  }
  // 204 No Content
  if (res.status === 204) return null
  return await res.json()
}

async function ghFetch(
  path: string,
  options?: { method?: string; body?: unknown; requireToken?: boolean }
): Promise<any> {
  return await githubFetch(API_BASE + path, options)
}

function commitAvatarCacheKey(fullName: string, oid: string): string {
  return `${fullName.toLowerCase()}:${oid.toLowerCase()}`
}

/** 批量查询 GitHub 已关联账号的提交作者头像；未关联的提交不返回。 */
export async function getCommitAvatarUrls(
  fullName: string,
  oids: string[]
): Promise<GitHubCommitAvatarMap> {
  const encoded = encodeRepo(fullName)
  const [owner, name] = encoded.split("/").map(decodeURIComponent)
  const uniqueOids = Array.from(
    new Set(
      oids
        .map((oid) => oid.trim().toLowerCase())
        .filter((oid) => /^[0-9a-f]{40}$/.test(oid))
    )
  ).slice(0, 100)
  const result: GitHubCommitAvatarMap = {}
  const missing: string[] = []
  for (const oid of uniqueOids) {
    const cached = commitAvatarCache.get(commitAvatarCacheKey(fullName, oid))
    if (cached !== undefined) result[oid] = cached
    else missing.push(oid)
  }
  if (missing.length === 0) return result

  const fields = missing
    .map(
      (oid, index) =>
        `c${index}: object(expression: "${oid}") { ... on Commit { oid author { user { avatarUrl } } } }`
    )
    .join("\n")
  const query = `query CommitAvatars($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${fields}
    }
  }`
  const data = await githubFetch(GRAPHQL_URL, {
    method: "POST",
    body: { query, variables: { owner, name } },
  })
  const repository = data?.data?.repository
  if (!repository) {
    const message = Array.isArray(data?.errors)
      ? data.errors[0]?.message
      : "GraphQL 查询失败"
    throw new Error(`GitHub API 请求失败：${String(message || "仓库不可用")}`)
  }
  missing.forEach((oid, index) => {
    const avatarUrl = String(
      repository[`c${index}`]?.author?.user?.avatarUrl || ""
    )
    if (avatarUrl) {
      setLruEntry(
        commitAvatarCache,
        commitAvatarCacheKey(fullName, oid),
        avatarUrl,
        COMMIT_AVATAR_CACHE_LIMIT
      )
      result[oid] = avatarUrl
    }
  })
  return result
}

const COMMIT_CHECK_CACHE_LIMIT = 500
const commitCheckCache = new Map<string, CommitCheckState>()

function commitCheckCacheKey(fullName: string, oid: string): string {
  return `${fullName.toLowerCase()}:${oid.toLowerCase()}`
}

/**
 * 批量查询提交的 GitHub Actions / Checks 合并状态（StatusState rollup）。
 * 仅 success/failure/pending/queued 会被缓存；无 rollup 的提交返回空且不缓存，
 * 避免对未配置 CI 的仓库错误缓存。无 Token、网络失败返回空映射不阻断。
 */
export async function getCommitCheckStatuses(
  fullName: string,
  oids: string[]
): Promise<CommitCheckStatusMap> {
  const encoded = encodeRepo(fullName)
  const [owner, name] = encoded.split("/").map(decodeURIComponent)
  const uniqueOids = Array.from(
    new Set(
      oids
        .map((oid) => oid.trim().toLowerCase())
        .filter((oid) => /^[0-9a-f]{40}$/.test(oid))
    )
  ).slice(0, 100)
  const result: CommitCheckStatusMap = {}
  const missing: string[] = []
  for (const oid of uniqueOids) {
    const cached = commitCheckCache.get(commitCheckCacheKey(fullName, oid))
    if (cached !== undefined) result[oid] = cached
    else missing.push(oid)
  }
  if (missing.length === 0) return result

  // 没有 Token 时直接返回缓存部分，其余空位不缓存
  const token = getToken()
  if (!token) return result

  const fields = missing
    .map(
      (oid, index) =>
        `c${index}: object(expression: "${oid}") { ... on Commit { oid statusCheckRollup { state } } }`
    )
    .join("\n")
  const query = `query CommitChecks($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${fields}
    }
  }`
  try {
    const data = await githubFetch(GRAPHQL_URL, {
      method: "POST",
      body: { query, variables: { owner, name } },
    })
    const repository = data?.data?.repository
    if (!repository) {
      // GraphQL 出错时不缓存，下次请求保留缓存部分
      return result
    }
    missing.forEach((oid, index) => {
      const raw = String(
        repository[`c${index}`]?.statusCheckRollup?.state || ""
      ).toUpperCase()
      let state: CommitCheckState | null = null
      switch (raw) {
        case "SUCCESS":
          state = "success"
          break
        case "FAILURE":
        case "ERROR":
          state = "failure"
          break
        case "PENDING":
          state = "pending"
          break
        case "EXPECTED":
          state = "queued"
          break
        default:
          state = null
      }
      if (state) {
        setLruEntry(
          commitCheckCache,
          commitCheckCacheKey(fullName, oid),
          state,
          COMMIT_CHECK_CACHE_LIMIT
        )
        result[oid] = state
      }
    })
  } catch (_e) {
    // 有 Token 但请求失败时不缓存剩余查询，仅返回已缓存结果
  }
  return result
}

/** 获取当前认证用户信息 */
export async function getCurrentUser(): Promise<GitHubUser> {
  const data = await ghFetch("/user")
  return {
    login: data.login,
    name: data.name,
    avatarUrl: data.avatar_url,
    bio: data.bio,
    publicRepos: data.public_repos,
    followers: data.followers,
  }
}

/** 获取当前用户的仓库列表（按更新时间倒序） */
export async function listMyRepos(
  perPage = 30,
  page = 1
): Promise<GitHubRepo[]> {
  const data = await ghFetch(
    `/user/repos?sort=updated&per_page=${perPage}&page=${page}`
  )
  return (data as any[]).map(mapRepo)
}

/** 获取仓库详情；fork 仓库包含 parent/source 信息 */
export async function getRepo(fullName: string): Promise<GitHubRepo> {
  return mapRepo(await ghFetch(`/repos/${encodeRepo(fullName)}`, { requireToken: false }))
}

/**
 * 读取仓库可见性（列表行的公开/私有标识用）。
 * REST 接口不支持字段裁剪，只从完整响应里取 private/visibility。
 */
export async function getRepoVisibility(
  fullName: string
): Promise<GitHubRepoVisibility> {
  const data = await ghFetch(`/repos/${encodeRepo(fullName)}`)
  // 组织内部仓库 visibility 为 internal，同样属于非公开
  return data?.private || data?.visibility === "internal" ? "private" : "public"
}

/** 在 GitHub 上为当前用户创建仓库 */
export async function createRepo(input: CreateRepoInput): Promise<GitHubRepo> {
  const name = input.name.trim()
  if (!name) throw new Error("仓库名称不能为空")
  // 对齐 GitHub：仅允许字母数字 . _ -，不能以 . 开头
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) {
    throw new Error("仓库名称仅允许字母、数字、.、_、-，且不能以 . 开头")
  }
  const data = await ghFetch("/user/repos", {
    method: "POST",
    body: {
      name,
      description: (input.description || "").trim() || undefined,
      homepage: (input.homepage || "").trim() || undefined,
      private: !!input.private,
      auto_init: false,
    },
  })
  return mapRepo(data)
}

/** 验证 token 是否有效（返回当前用户，无效则抛错） */
export async function verifyToken(): Promise<GitHubUser> {
  return await getCurrentUser()
}

/** Token 校验结果：区分有效 / 无效（被撤销或过期）/ 无法校验（网络等） */
export type TokenCheckResult =
  | { status: "valid"; user: GitHubUser }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string }

/**
 * 校验当前 Token 是否仍有效。
 * 直接读 HTTP 状态码区分：401/403 为无效（凭据错误/权限不足），
 * 其余非 2xx 与 fetch 抛异常（超时/断网）归为无法校验，不误删已验证状态。
 */
export async function checkTokenValidity(): Promise<TokenCheckResult> {
  const token = getToken()
  if (!token) return { status: "invalid", message: "未配置 Token" }
  try {
    const res = await fetch(`${API_BASE}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      timeout: 20,
      debugLabel: "scriptgit token check",
    })
    if (res.status === 401 || res.status === 403) {
      let msg = res.status === 401 ? "Token 无效或已过期" : "Token 权限不足或已被撤销"
      try {
        const err = await res.json()
        if (err?.message) msg = String(err.message)
      } catch (_e) {
        // 响应非 JSON 时保留默认文案
      }
      return { status: "invalid", message: msg }
    }
    if (!res.ok) {
      return { status: "error", message: `HTTP ${res.status}` }
    }
    const data = await res.json()
    return {
      status: "valid",
      user: {
        login: data.login,
        name: data.name,
        avatarUrl: data.avatar_url,
        bio: data.bio,
        publicRepos: data.public_repos,
        followers: data.followers,
      },
    }
  } catch (e: any) {
    return { status: "error", message: String(e?.message || e) }
  }
}

export async function listIssuesOrPulls(
  fullName: string,
  kind: "issue" | "pr",
  state: GitHubIssueFilter = "open",
  page = 1,
  perPage = 30
): Promise<GitHubIssuePage> {
  const safePage = Math.max(1, Math.floor(page))
  const safePerPage = Math.min(100, Math.max(1, Math.floor(perPage)))
  encodeRepo(fullName)
  const qualifiers = [`repo:${fullName.trim()}`, `is:${kind}`]
  if (state !== "all") qualifiers.push(`state:${state}`)
  const query = encodeURIComponent(qualifiers.join(" "))
  const data = await ghFetch(
    `/search/issues?q=${query}&sort=updated&order=desc&per_page=${safePerPage}&page=${safePage}`
  )
  const items = Array.isArray(data.items) ? data.items.map(mapIssue) : []
  const total = Number(data.total_count || 0)
  return { items, hasMore: safePage * safePerPage < total }
}

export async function getIssueOrPull(
  fullName: string,
  number: number
): Promise<GitHubIssueItem> {
  const issue = await ghFetch(
    `/repos/${encodeRepo(fullName)}/issues/${Math.floor(number)}`
  )
  if (!issue.pull_request) return mapIssue(issue)
  return mapIssue(
    await ghFetch(`/repos/${encodeRepo(fullName)}/pulls/${Math.floor(number)}`)
  )
}

export async function listIssueComments(
  fullName: string,
  number: number
): Promise<GitHubComment[]> {
  const comments: GitHubComment[] = []
  let page = 1
  while (true) {
    const data = await ghFetch(
      `/repos/${encodeRepo(fullName)}/issues/${Math.floor(number)}/comments?per_page=100&page=${page}`
    )
    const batch = (data as any[]).map(mapComment)
    comments.push(...batch)
    if (batch.length < 100) return comments
    page += 1
  }
}

export async function createIssue(
  fullName: string,
  input: CreateGitHubIssueInput
): Promise<GitHubIssueItem> {
  const title = input.title.trim()
  if (!title) throw new Error("Issue 标题不能为空")
  return mapIssue(
    await ghFetch(`/repos/${encodeRepo(fullName)}/issues`, {
      method: "POST",
      body: {
        title,
        body: (input.body || "").trim() || undefined,
      },
    })
  )
}

// ===== GitHub Actions API =====

/** 将状态字符串映射为联合类型 */
function mapRunStatus(value: unknown): ActionRun["status"] {
  return value === "completed" ? "completed" : value === "in_progress" ? "in_progress" : "queued"
}

/** 将结论字符串映射为联合类型或 null */
function mapRunConclusion(value: unknown): ActionRun["conclusion"] {
  if (!value) return null
  const v = String(value)
  const valid = ["success", "failure", "cancelled", "neutral", "skipped", "timed_out", "action_required", "stale"]
  return (valid.includes(v) ? v : null) as ActionRun["conclusion"]
}

function mapRun(data: any): ActionRun {
  const sha = String(data.head_sha || "")
  return {
    id: Number(data.id),
    name: String(data.name || ""),
    workflowName: String(data.workflow_name || data.display_title || ""),
    headBranch: String(data.head_branch || ""),
    displayTitle: String(data.display_title || data.name || ""),
    status: mapRunStatus(data.status),
    conclusion: mapRunConclusion(data.conclusion),
    event: String(data.event || ""),
    actorLogin: String(data.actor?.login || ""),
    actorAvatarUrl: String(data.actor?.avatar_url || ""),
    createdAt: String(data.created_at || ""),
    updatedAt: String(data.updated_at || ""),
    htmlUrl: String(data.html_url || ""),
    headShaShort: sha.slice(0, 7),
  }
}

function mapJob(data: any): ActionJob {
  const steps = Array.isArray(data.steps)
    ? data.steps.map((s: any) => ({
        name: String(s.name || ""),
        status: mapRunStatus(s.status),
        conclusion: mapRunConclusion(s.conclusion),
        number: Number(s.number || 0),
        startedAt: String(s.started_at || ""),
        completedAt: String(s.completed_at || ""),
      }))
    : []
  // 从 check_run_url 中提取 check-run ID（用于获取注解）
  let checkRunId: number | undefined
  const checkRunUrl = String(data.check_run_url || "")
  const match = checkRunUrl.match(/\/check-runs\/(\d+)/)
  if (match) checkRunId = Number(match[1])
  return {
    id: Number(data.id),
    name: String(data.name || ""),
    status: mapRunStatus(data.status),
    conclusion: mapRunConclusion(data.conclusion),
    startedAt: String(data.started_at || ""),
    completedAt: String(data.completed_at || ""),
    steps,
    checkRunId,
  }
}

/** 列出仓库的工作流运行列表
 *  可选按工作流 ID 筛选。
 */
export async function listWorkflowRuns(
  fullName: string,
  page = 1,
  perPage = 30,
  workflowId?: number
): Promise<ActionRunPage> {
  const safePage = Math.max(1, Math.floor(page))
  const safePerPage = Math.min(100, Math.max(1, Math.floor(perPage)))
  // 按工作流 ID 筛选使用 /actions/workflows/{id}/runs 端点
  const basePath = workflowId
    ? `/repos/${encodeRepo(fullName)}/actions/workflows/${Math.floor(workflowId)}/runs`
    : `/repos/${encodeRepo(fullName)}/actions/runs`
  const data = await ghFetch(
    `${basePath}?per_page=${safePerPage}&page=${safePage}`
  )
  const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs.map(mapRun) : []
  const total = Number(data.total_count || 0)
  return { runs, hasMore: safePage * safePerPage < total }
}

/** 获取单个工作流运行详情 */
export async function getWorkflowRun(
  fullName: string,
  runId: number
): Promise<ActionRun> {
  return mapRun(
    await ghFetch(`/repos/${encodeRepo(fullName)}/actions/runs/${Math.floor(runId)}`)
  )
}

/** 获取工作流运行下的 Jobs 列表 */
export async function listWorkflowJobs(
  fullName: string,
  runId: number
): Promise<ActionJob[]> {
  const data = await ghFetch(
    `/repos/${encodeRepo(fullName)}/actions/runs/${Math.floor(runId)}/jobs`
  )
  return Array.isArray(data.jobs) ? data.jobs.map(mapJob) : []
}

/** 获取 Job 日志（纯文本） */
export async function getJobLog(
  fullName: string,
  jobId: number
): Promise<ActionJobLog> {
  // 日志端点返回 text/plain 且可能 302 重定向到下载链接
  const token = getToken()
  if (!token) throw new Error("未配置 GitHub Token")
  const url = `${API_BASE}/repos/${encodeRepo(fullName)}/actions/jobs/${Math.floor(jobId)}/logs`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    timeout: 20,
    debugLabel: "scriptgit GitHub Actions log",
  })
  if (!res.ok) {
  if (res.status === 410) throw new Error("日志已过期或已被删除")
    throw new Error(`获取日志失败：HTTP ${res.status}`)
  }
  return await res.text()
}

/** 获取 Job 的注解列表（类似 GitHub 网页 Annotations 区域）
 *  需要传入 Job 的 checkRunId（从 mapJob 解析）。
 *  端点：GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations
 */
export async function getJobAnnotations(
  fullName: string,
  checkRunId: number
): Promise<ActionAnnotation[]> {
  const data = await ghFetch(
    `/repos/${encodeRepo(fullName)}/check-runs/${Math.floor(checkRunId)}/annotations`
  )
  if (!Array.isArray(data)) return []
  return data.map(mapAnnotation)
}

function mapAnnotation(data: any): ActionAnnotation {
  const level = String(data.annotation_level || "notice") as AnnotationLevel
  return {
    level: (level === "warning" || level === "failure") ? level : "notice",
    title: data.title ? String(data.title) : undefined,
    message: String(data.message || ""),
    path: data.path ? String(data.path) : undefined,
    startLine: data.start_line != null ? Number(data.start_line) : undefined,
    endLine: data.end_line != null ? Number(data.end_line) : undefined,
    rawDetails: data.raw_details ? String(data.raw_details) : undefined,
  }
}

function mapWorkflow(data: any): ActionWorkflow {
  return {
    id: Number(data.id),
    name: String(data.name || ""),
    displayName: String(data.display_name || data.name || ""),
    path: String(data.path || ""),
    state: String(data.state || "active"),
  }
}

/** 列出仓库的工作流定义（用于筛选与手动触发） */
export async function listWorkflows(
  fullName: string
): Promise<ActionWorkflow[]> {
  const data = await ghFetch(`/repos/${encodeRepo(fullName)}/actions/workflows?per_page=100`)
  return Array.isArray(data.workflows) ? data.workflows.map(mapWorkflow) : []
}

/** 手动触发工作流（workflow_dispatch）
 *  GitHub dispatch 端点使用工作流 ID（数字）。
 *  返回 true 表示触发成功（HTTP 204）。
 */
export async function dispatchWorkflow(
  fullName: string,
  workflowId: number,
  input: DispatchWorkflowInput
): Promise<boolean> {
  if (!input.ref.trim()) throw new Error("必须指定目标分支或标签")
  await ghFetch(
    `/repos/${encodeRepo(fullName)}/actions/workflows/${Math.floor(workflowId)}/dispatches`,
    {
      method: "POST",
      body: {
        ref: input.ref.trim(),
        inputs: input.inputs || undefined,
      },
    }
  )
  return true
}

function mapArtifact(data: any): ActionArtifact {
  return {
    id: Number(data.id),
    name: String(data.name || ""),
    sizeInBytes: Number(data.size_in_bytes || 0),
    archiveDownloadUrl: String(data.archive_download_url || ""),
    expired: !!data.expired,
    createdAt: String(data.created_at || ""),
    expiresAt: String(data.expires_at || ""),
  }
}

/** 列出工作流运行的工件 */
export async function listArtifacts(
  fullName: string,
  runId: number
): Promise<ActionArtifact[]> {
  const data = await ghFetch(
    `/repos/${encodeRepo(fullName)}/actions/runs/${Math.floor(runId)}/artifacts`
  )
  return Array.isArray(data.artifacts) ? data.artifacts.map(mapArtifact) : []
}

/** 统计某个运行的工件数量（列表页标识用：只取 total_count，不拉取明细） */
export async function countRunArtifacts(
  fullName: string,
  runId: number
): Promise<number> {
  const data = await ghFetch(
    `/repos/${encodeRepo(fullName)}/actions/runs/${Math.floor(runId)}/artifacts?per_page=1`
  )
  return Math.max(0, Number(data?.total_count || 0))
}

/** 获取工件下载 URL 和请求头（用于 BackgroundURLSession 下载） */
export function getArtifactDownloadInfo(
  fullName: string,
  artifactId: number
): { url: string; headers: Record<string, string> } {
  const token = getToken()
  if (!token) throw new Error("未配置 GitHub Token")
  return {
    url: `${API_BASE}/repos/${encodeRepo(fullName)}/actions/artifacts/${Math.floor(artifactId)}/zip`,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  }
}

/** 删除工作流运行 */
export async function deleteWorkflowRun(
  fullName: string,
  runId: number
): Promise<boolean> {
  await ghFetch(
    `/repos/${encodeRepo(fullName)}/actions/runs/${Math.floor(runId)}`,
    { method: "DELETE" }
  )
  return true
}

/**
 * 重新运行工作流的全部 Job。
 * 仅对已结束的运行有效，进行中的运行 GitHub 会返回 403。
 */
export async function rerunWorkflowRun(
  fullName: string,
  runId: number
): Promise<boolean> {
  await ghFetch(
    `/repos/${encodeRepo(fullName)}/actions/runs/${Math.floor(runId)}/rerun`,
    { method: "POST" }
  )
  return true
}

/**
 * 仅重新运行工作流中失败的 Job（含其依赖 Job）。
 * 运行中没有失败 Job 时 GitHub 会返回 403。
 */
export async function rerunFailedJobs(
  fullName: string,
  runId: number
): Promise<boolean> {
  await ghFetch(
    `/repos/${encodeRepo(fullName)}/actions/runs/${Math.floor(runId)}/rerun-failed-jobs`,
    { method: "POST" }
  )
  return true
}

// ===== GitHub 远端文件（Contents API；不触碰本地工作区） =====
export const REMOTE_TEXT_LIMIT = 512 * 1024
export interface GitHubContentEntry {
  name: string
  path: string
  type: string
  sha: string
  size: number
}

function contentPath(path: string): string {
  if (path.split("/").some((part) => part === "." || part === ".." || !part) && path !== "") {
    throw new Error("文件路径无效")
  }
  return path.split("/").map(encodeURIComponent).join("/")
}

export async function listRepoBranches(fullName: string): Promise<string[]> {
  const branches: string[] = []
  for (let page = 1; ; page++) {
    const data = await ghFetch(`/repos/${encodeRepo(fullName)}/branches?per_page=100&page=${page}`)
    if (!Array.isArray(data)) throw new Error("分支响应格式无效")
    branches.push(...data.map((item: any) => String(item.name)))
    if (data.length < 100) return branches
  }
}

async function readContents(fullName: string, branch: string, path: string): Promise<any> {
  if (!branch) throw new Error("请选择分支")
  return await ghFetch(`/repos/${encodeRepo(fullName)}/contents/${contentPath(path)}?ref=${encodeURIComponent(branch)}`)
}

export async function listRepoContents(fullName: string, branch: string, path = ""): Promise<GitHubContentEntry[]> {
  const data = await readContents(fullName, branch, path)
  if (!Array.isArray(data)) throw new Error("该路径不是目录")
  return data.map((item: any) => ({ name: String(item.name), path: String(item.path), type: String(item.type), sha: String(item.sha), size: Number(item.size || 0) }))
    .sort((a, b) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || a.name.localeCompare(b.name))
}

export async function loadRepoTextFile(fullName: string, branch: string, path: string): Promise<import("../services/githubFileSession").RemoteTextFile> {
  const data = await readContents(fullName, branch, path)
  const result = { path, sha: String(data.sha || ""), text: null as string | null, readOnlyReason: undefined as string | undefined }
  if (data.type !== "file" || data.submodule_git_url || data.target) result.readOnlyReason = "符号链接、子模块或非普通文件，只读"
  else if (!result.sha) throw new Error("文件响应缺少 SHA")
  else if (Number(data.size) > REMOTE_TEXT_LIMIT || data.encoding !== "base64" || typeof data.content !== "string") result.readOnlyReason = "文件过大或 API 未提供文本内容，只读（上限 512 KiB）"
  else {
    const raw = Data.fromBase64String(data.content.replace(/\s/g, ""))
    if (!raw) throw new Error("文件 Base64 解码失败")
    const text = raw.toRawString("utf-8")
    // 严格 UTF-8 且编码往返一致，防止替换字符或 BOM/编码转换损坏原文件。
    const roundTrip = text === null ? null : Data.fromRawString(text, "utf-8")
    if (text === null || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || roundTrip?.toBase64String() !== raw.toBase64String()) {
      result.readOnlyReason = "二进制或非无损 UTF-8 文本，只读"
    } else result.text = text
  }
  return result
}

export async function saveRepoTextFile(fullName: string, input: {
  path: string; branch: string; sha: string; text: string; message: string
}): Promise<string> {
  if (!input.path || !input.branch || !input.sha || !input.message.trim()) throw new Error("保存需要文件路径、分支、原 SHA 和提交消息")
  const content = Data.fromRawString(input.text, "utf-8")
  if (!content) throw new Error("文本无法编码为 UTF-8")
  if (content.size > REMOTE_TEXT_LIMIT) throw new Error("文本超过 512 KiB 编辑上限")
  try {
    const data = await ghFetch(`/repos/${encodeRepo(fullName)}/contents/${contentPath(input.path)}`, {
      method: "PUT",
      body: { message: input.message.trim(), content: content.toBase64String(), branch: input.branch, sha: input.sha },
    })
    if (!data?.content?.sha) throw new Error("保存响应缺少文件 SHA，请核对远端状态后重新加载")
    return String(data.content.sha)
  } catch (e: any) {
    if (e?.status === 409 || e?.status === 422) throw new Error("保存冲突或提交被拒绝：远端文件可能已更新，或分支有保护规则。草稿已保留，请复制草稿后关闭并重新加载比较。" + String(e.message))
    throw e
  }
}

/** 用户拥有且当前凭据可访问的全部仓库；分页完成才发布列表。 */
export async function listOwnedRepos(username: string): Promise<GitHubRepo[]> {
  const login = username.trim()
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) throw new Error("请输入有效 GitHub 用户名")
  const authenticated = !!getToken()
  // 不配置 Token 才走公开列表；配置了但无效必须报错，不能隐藏私有仓库。
  const current = authenticated ? await getCurrentUser() : null
  const owned = new Map<string, GitHubRepo>()
  async function collect(base: string) {
    for (let page = 1; ; page++) {
      const data = await ghFetch(`${base}&per_page=100&page=${page}`, { requireToken: authenticated })
      if (!Array.isArray(data)) throw new Error("仓库列表响应格式无效")
      for (const item of data) {
        if (String(item.owner?.login || String(item.full_name || "").split("/")[0]).toLowerCase() !== login.toLowerCase()) continue
        const repo = mapRepo(item)
        owned.set(repo.fullName.toLowerCase(), repo)
      }
      if (data.length < 100) break
    }
  }
  if (!current) {
    await collect(`/users/${encodeURIComponent(login)}/repos?type=owner&sort=full_name`)
  } else if (current.login.toLowerCase() === login.toLowerCase()) {
    // /users/{user}/repos 只返回公开仓库；本人必须使用认证接口才能含私有仓库。
    await collect("/user/repos?affiliation=owner&visibility=all&sort=full_name")
  } else {
    await collect(`/users/${encodeURIComponent(login)}/repos?type=owner&sort=full_name`)
    // 补齐本人作为协作者/组织成员可访问、但归目标用户名所有的私有仓库。
    await collect("/user/repos?affiliation=owner,collaborator,organization_member&visibility=all&sort=full_name")
  }
  return Array.from(owned.values()).sort((a, b) => a.fullName.localeCompare(b.fullName))
}

export interface GitHubUserCandidate { login: string; avatarUrl: string }
export interface GitHubUserSearchPage {
  items: GitHubUserCandidate[]
  total: number
  hasMore: boolean
  limited: boolean
  incomplete: boolean
}

/** 公开用户候选搜索，不是关联账号查询；GitHub 搜索最多可访问前 1000 条。 */
export async function searchGitHubUsers(query: string, page = 1): Promise<GitHubUserSearchPage> {
  const value = query.trim()
  if (!/^[A-Za-z0-9-]{2,39}$/.test(value)) throw new Error("输入至少 2 个用户名字符（字母、数字、-，最多 39 个）")
  if (!Number.isInteger(page) || page < 1 || page > 50) throw new Error("GitHub 用户搜索最多访问前 1000 个结果")
  const q = encodeURIComponent(`${value} in:login type:user`)
  const data = await ghFetch(`/search/users?q=${q}&per_page=20&page=${page}`, { requireToken: false })
  if (!Array.isArray(data.items)) throw new Error("GitHub 用户搜索响应格式无效")
  const total = Math.max(0, Number(data.total_count || 0))
  return {
    items: data.items.map((item: any) => ({ login: String(item.login || ""), avatarUrl: String(item.avatar_url || "") })).filter((item: GitHubUserCandidate) => item.login),
    total,
    hasMore: page * 20 < Math.min(total, 1000),
    limited: total > 1000,
    incomplete: !!data.incomplete_results,
  }
}
