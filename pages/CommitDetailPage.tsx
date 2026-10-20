import { FilledSegmentedControl } from "../components/FilledSegmentedControl"
import {
  List,
  Section,
  Text,
  HStack,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "scripting"
import type { CommitDetail } from "../types/git"
import { buildFileTree } from "../utils/fileTree"
import { getCommitDetail } from "../services/gitService"
import { CommitFileTreeNode } from "../components/CommitFileTree"
import { CommitChangesSections } from "../components/CommitChangesView"
import { ImageViewer } from "../components/ImageViewer"
import { getCommitFileDiff } from "../services/diffService"
import { CommitChangesLoader } from "../utils/commitChanges"
import { AvatarView } from "../components/AvatarView"
import { resolvedGitAuthorAvatarUrl } from "../utils/github"
import { getCommitAvatarUrls } from "../api/githubApi"
import { shortOid, commitTitle, commitBody } from "../utils/format"
import {
  COLOR_LABEL,
  COLOR_SECONDARY_LABEL,
} from "../constants/colors"

export function CommitDetailPage({
  bookmarkName,
  oid,
  title = "提交详情",
  githubFullName = null,
}: {
  bookmarkName: string
  oid: string
  /** 导航栏标题，Stash 详情可传「Stash 详情」 */
  title?: string
  githubFullName?: string | null
}) {
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [githubAvatarUrl, setGithubAvatarUrl] = useState("")
  const [error, setError] = useState<string | null>(null)
  // 默认打开「更改」；「文件」树保持原有展示
  const [mode, setMode] = useState<"changes" | "files">("changes")
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const loaderRef = useRef<CommitChangesLoader | null>(null)

  const detailToken = useRef<{ cancelled: boolean } | null>(null)
  const refreshing = useRef(false)

  async function loadDetail(token: { cancelled: boolean }) {
    try {
      const next = await getCommitDetail(bookmarkName, oid, token)
      if (!token.cancelled) { setError(null); setDetail(next) }
    } catch (e: any) {
      if (!token.cancelled) setError(String(e?.message || e))
    }
  }

  // 必须随 oid 变化重新拉取；导航 content 复用时 [] 会一直显示首次打开的提交
  useEffect(() => {
    const token = { cancelled: false }
    detailToken.current = token
    setDetail(null)
    setError(null)
    setMode("changes")
    void loadDetail(token)
    return () => {
      token.cancelled = true
      if (detailToken.current === token) detailToken.current = null
      // 离开或切换提交：释放旧加载器，迟到的 diff 结果不再写入
      loaderRef.current?.dispose()
      loaderRef.current = null
    }
  }, [bookmarkName, oid])

  const loader = useMemo(() => {
    loaderRef.current?.dispose()
    loaderRef.current = null
    if (!detail) return null
    const next = new CommitChangesLoader(
      detail.files.map((file) => file.filepath),
      (filepath) => getCommitFileDiff(bookmarkName, detail.oid, detail.parentOid, filepath)
    )
    loaderRef.current = next
    return next
  }, [detail, bookmarkName])

  useEffect(() => {
    setGithubAvatarUrl("")
    if (!githubFullName) return
    let cancelled = false
    getCommitAvatarUrls(githubFullName, [oid])
      .then((avatars) => {
        if (!cancelled) setGithubAvatarUrl(avatars[oid.toLowerCase()] || "")
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [githubFullName, oid])

  // 顶部继续下拉会触发弹出页面的系统关闭；用下拉刷新接管。提交内容不可变，已加载内容不重算。
  async function handleRefresh() {
    if (refreshing.current) return
    refreshing.current = true
    try {
      if (!detail || error) {
        const token = detailToken.current
        if (token) { setError(null); await loadDetail(token) }
      } else {
        loaderRef.current?.retry()
      }
    } finally { refreshing.current = false }
  }

  const changeTree = detail
    ? buildFileTree(detail.files.map((file) => file.filepath))
    : []
  // 提交补充说明（首行标题之后的正文）
  const body = detail ? commitBody(detail.message) : ""
  const statusByPath = new Map(
    detail?.files.map((file) => [file.filepath, file.status] as const) || []
  )

  return (
    <List
      navigationTitle={title}
      navigationBarTitleDisplayMode="inline"
      tabBarVisibility="hidden"
      refreshable={handleRefresh}
      fullScreenCover={{
        isPresented: previewUrl != null,
        onChanged: (isPresented: boolean) => {
          if (!isPresented) setPreviewUrl(null)
        },
        content: previewUrl ? (
          <ImageViewer key={previewUrl} url={previewUrl} onClose={() => setPreviewUrl(null)} />
        ) : <></>,
      }}
    >
      {error ? (
        <Section>
          <Text foregroundStyle={COLOR_SECONDARY_LABEL}>加载失败：{error}</Text>
        </Section>
      ) : !detail ? (
        <Section>
          <Text foregroundStyle={COLOR_SECONDARY_LABEL}>加载中…</Text>
        </Section>
      ) : (
        <>
          <Section header={<Text>提交信息</Text>}>
            <Text font="headline" foregroundStyle={COLOR_LABEL}>
              {commitTitle(detail.message) || "(无提交信息)"}
            </Text>
            {body ? (
              <Text font="subheadline" foregroundStyle={COLOR_LABEL}>
                {body}
              </Text>
            ) : null}
            <Text font="caption" foregroundStyle={COLOR_SECONDARY_LABEL}>
              完整 ID：{detail.oid}
            </Text>
            <HStack alignment="center" spacing={4}>
              <Text font="caption" foregroundStyle={COLOR_SECONDARY_LABEL}>
                作者：
              </Text>
              <AvatarView
                url={resolvedGitAuthorAvatarUrl(
                  detail.author.email,
                  githubAvatarUrl
                )}
                size={14}
              />
              <Text font="caption" foregroundStyle={COLOR_SECONDARY_LABEL}>
                {detail.author.name || "unknown"}{" "}
                {detail.author.email ? `<${detail.author.email}>` : ""}
              </Text>
            </HStack>
            <Text font="caption" foregroundStyle={COLOR_SECONDARY_LABEL}>
              时间：{new Date(detail.date).toLocaleString()} · 父提交：
              {detail.parentOid ? shortOid(detail.parentOid) : "根提交"}
            </Text>
          </Section>
          <Section>
            <FilledSegmentedControl value={mode} options={[{ value: "changes", title: "更改" }, { value: "files", title: "文件" }]}
              onChanged={(value: string) => setMode(value === "changes" ? "changes" : "files")} />
          </Section>
          {mode === "changes" && loader ? (
            <CommitChangesSections
              key={detail.oid}
              loader={loader}
              bookmarkName={bookmarkName}
              oid={detail.oid}
              parentOid={detail.parentOid}
              onOpenImage={setPreviewUrl}
            />
          ) : (
          <Section header={<Text>文件变更（{detail.files.length}）</Text>}>
            {detail.files.length === 0 ? (
              <Text foregroundStyle={COLOR_SECONDARY_LABEL}>没有文件变更</Text>
            ) : (
              changeTree.map((node) => (
                <CommitFileTreeNode
                  key={node.path}
                  node={node}
                  statusByPath={statusByPath}
                  commitDetailStyle
                  bookmarkName={bookmarkName}
                  oid={detail.oid}
                  parentOid={detail.parentOid}
                />
              ))
            )}
          </Section>
          )}
        </>
      )}
    </List>
  )
}
