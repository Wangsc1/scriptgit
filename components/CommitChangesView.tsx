/**
 * components/CommitChangesView.tsx - 提交详情「更改」视图
 *
 * 连续展示本次提交相对第一父提交的逐文件真实 diff（复用 DiffViewer）。
 * 数据来自 CommitChangesLoader，仅在切到本视图后才开始读取。
 */

import {
  Button,
  HStack,
  NavigationLink,
  ProgressView,
  Section,
  Spacer,
  Text,
  useEffect,
  useState,
} from "scripting"
import { DiffViewer } from "./DiffViewer"
import { CommitDiffPage } from "../pages/CommitDiffPage"
import { truncatePath } from "../utils/format"
import {
  COMMIT_CHANGES_MAX_RENDER_LINES,
  type CommitChangesLoader,
} from "../utils/commitChanges"
import {
  COLOR_GREEN,
  COLOR_RED,
  COLOR_SECONDARY_LABEL,
} from "../constants/colors"

export function CommitChangesSections({
  loader,
  bookmarkName,
  oid,
  parentOid,
  onOpenImage,
}: {
  loader: CommitChangesLoader
  bookmarkName: string
  oid: string
  parentOid: string | null
  onOpenImage: (url: string) => void
}) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const unsubscribe = loader.subscribe(() => setTick((value: number) => value + 1))
    loader.start()
    return () => {
      unsubscribe()
      loader.pause()
    }
  }, [loader])

  const snapshot = loader.snapshot()
  if (snapshot.total === 0) {
    return (
      <Section>
        <Text foregroundStyle={COLOR_SECONDARY_LABEL}>没有文件变更</Text>
      </Section>
    )
  }
  return (
    <>
      {snapshot.failedCount > 0 ? (
        <Section>
          <Button title={`重试失败的文件（${snapshot.failedCount}）`} action={() => loader.retry()} />
        </Section>
      ) : null}
      {snapshot.visible.map((entry) => {
        const diff = entry.diff
        const truncated = diff ? diff.lines.length > COMMIT_CHANGES_MAX_RENDER_LINES : false
        return (
          <Section
            key={entry.filepath}
            header={
              <HStack alignment="center" spacing={8}>
                <Text lineLimit={1}>{truncatePath(entry.filepath, 40)}</Text>
                <Spacer />
                {entry.state === "done" && diff && !diff.binary ? (
                  <>
                    <Text font="caption" foregroundStyle={COLOR_GREEN}>+{entry.added}</Text>
                    <Text font="caption" foregroundStyle={COLOR_RED}>-{entry.deleted}</Text>
                  </>
                ) : null}
                {entry.state === "done" && diff?.binary ? (
                  <Text font="caption" foregroundStyle={COLOR_SECONDARY_LABEL}>二进制文件</Text>
                ) : null}
              </HStack>
            }
          >
            {entry.state === "pending" ? (
              <Text foregroundStyle={COLOR_SECONDARY_LABEL}>等待加载…</Text>
            ) : entry.state === "loading" ? (
              <HStack spacing={10} alignment="center">
                <ProgressView />
                <Text foregroundStyle={COLOR_SECONDARY_LABEL}>计算差异中…</Text>
              </HStack>
            ) : entry.state === "error" ? (
              <>
                <Text foregroundStyle={COLOR_RED}>加载失败：{entry.error}</Text>
                <Button title="重试" action={() => loader.retry(entry.filepath)} />
              </>
            ) : diff ? (
              <>
                {diff.added ? (
                  <Text font="caption" foregroundStyle={COLOR_SECONDARY_LABEL}>新增文件</Text>
                ) : null}
                {diff.deleted ? (
                  <Text font="caption" foregroundStyle={COLOR_SECONDARY_LABEL}>删除文件</Text>
                ) : null}
                <DiffViewer
                  key={entry.filepath}
                  diff={truncated ? { ...diff, lines: diff.lines.slice(0, COMMIT_CHANGES_MAX_RENDER_LINES) } : diff}
                  compact
                  onOpenImage={onOpenImage}
                />
                {truncated ? (
                  <NavigationLink
                    destination={
                      <CommitDiffPage
                        bookmarkName={bookmarkName}
                        oid={oid}
                        parentOid={parentOid}
                        filepath={entry.filepath}
                      />
                    }
                  >
                    <Text foregroundStyle={COLOR_SECONDARY_LABEL}>
                      仅显示前 {COMMIT_CHANGES_MAX_RENDER_LINES} 行，点击查看完整差异
                    </Text>
                  </NavigationLink>
                ) : null}
              </>
            ) : null}
          </Section>
        )
      })}
      {snapshot.remaining > 0 ? (
        <Section>
          <Button
            title={`加载更多（还有 ${snapshot.remaining} 个文件未加载）`}
            action={() => loader.loadMore()}
          />
        </Section>
      ) : null}
    </>
  )
}
