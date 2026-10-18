import { FilledSegmentedControl } from "./FilledSegmentedControl"
import { Button, Section, Text } from "scripting"
import type { LocalWorktreeFile } from "../services/gitService"
import type { CommitEntry, FileChange, StashEntry } from "../types/git"
import { COLOR_SECONDARY_LABEL } from "../constants/colors"
import { FilesTab } from "../pages/FilesTab"
import { HistoryTab } from "../pages/HistoryTab"
import { StashTab } from "../pages/StashTab"

export type RepoDetailTab = 0 | 1 | 2

export function MergeConflictSection({
  conflictCount,
  mutating,
  onOpen,
}: {
  conflictCount: number
  mutating: boolean
  onOpen: () => void
}) {
  return (
    <Section
      header={<Text>合并冲突</Text>}
      footer={
        <Text font="footnote" foregroundStyle={COLOR_SECONDARY_LABEL}>
          {conflictCount > 0
            ? `仍有 ${conflictCount} 个文件待解决`
            : "冲突已解决，请完成合并提交或中止合并"}
        </Text>
      }
    >
      <Button
        title={
          conflictCount > 0
            ? `处理冲突（${conflictCount}）`
            : "完成或中止合并"
        }
        systemImage="exclamationmark.triangle"
        action={onOpen}
        disabled={mutating}
      />
    </Section>
  )
}

export function RepoDetailTabContent({
  tab,
  onTabChange,
  bookmarkName,
  changes,
  stashes,
  log,
  trackedFiles,
  worktreeEntries,
  loading,
  mergeInProgress,
  committing,
  stagingBusy,
  stashBusy,
  onPush,
  onStage,
  onRestore,
  onCreateStash,
  onApplyStash,
  onDropStash,
  onCopyCommit,
  onSelectCommit,
  onRevert,
  onSoftReset,
  onAmend,
  onSearch,
  onLoadMore,
  historyHasMore,
  historySearchBusy,
  historyTotalMatches,
  historyLoading,
  historyLimited,
  githubFullName,
  onWorktreeChanged,
  onOpenLocalFile,
  creationActive, onCreateLocalEntry,
}: {
  tab: RepoDetailTab
  onTabChange: (tab: RepoDetailTab) => void | Promise<void>
  bookmarkName: string
  changes: FileChange[]
  stashes: StashEntry[]
  log: CommitEntry[]
  trackedFiles: string[]
  worktreeEntries?: import("../services/gitService").WorktreeEntries
  loading: boolean
  mergeInProgress: boolean
  committing: boolean
  stagingBusy: boolean
  stashBusy: boolean
  onPush: () => void | Promise<void>
  onStage: (filepaths: string[]) => void | Promise<void>
  onRestore: (filepath: string) => void
  onCreateStash: () => void | Promise<void>
  onApplyStash: (entry: StashEntry) => void | Promise<void>
  onDropStash: (entry: StashEntry) => void
  onCopyCommit: (entry: CommitEntry) => void | Promise<void>
  onSelectCommit: (entry: CommitEntry) => void
  onRevert: (entry: CommitEntry) => void
  onSoftReset: (entry: CommitEntry) => void
  onAmend: (entry: CommitEntry) => void | Promise<void>
  onSearch: (query: string) => void | Promise<void>
  onLoadMore: () => void | Promise<void>
  historyHasMore: boolean
  historySearchBusy: boolean
  historyTotalMatches: number | null
  historyLoading: boolean
  historyLimited: boolean
  githubFullName: string | null
  onOpenLocalFile: (file: LocalWorktreeFile) => void
  onWorktreeChanged: () => void | Promise<void>
  creationActive: boolean
  onCreateLocalEntry: (directory: boolean, onCreated: (path: string) => void) => void
}) {
  return (
    <>
      <Section>
        <FilledSegmentedControl value={tab} options={[{ value: 0, title: "文件" }, { value: 1, title: "Stash" }, { value: 2, title: "状态" }]}
          onChanged={(value: number) => onTabChange(value as RepoDetailTab)} />
      </Section>
      {tab === 0 ? (
        <FilesTab creationActive={creationActive} onCreateEntry={onCreateLocalEntry} files={trackedFiles} worktreeEntries={worktreeEntries} loading={loading} bookmarkName={bookmarkName} changes={changes} onWorktreeChanged={onWorktreeChanged} onOpen={onOpenLocalFile} onPush={onPush} onStage={onStage} onRestore={onRestore} mergeInProgress={mergeInProgress} />
      ) : tab === 1 ? (
        <StashTab
          bookmarkName={bookmarkName}
          changes={changes}
          stashes={stashes}
          loading={loading}
          committing={committing}
          stagingBusy={stagingBusy}
          stashBusy={stashBusy}
          mergeInProgress={mergeInProgress}
          onCreateStash={onCreateStash}
          onApplyStash={onApplyStash}
          onDropStash={onDropStash}
        />
      ) : (
        <HistoryTab
          log={log}
          loading={historyLoading}
          mergeInProgress={mergeInProgress}
          onCopy={onCopyCommit}
          onSelect={onSelectCommit}
          onRevert={onRevert}
          onSoftReset={onSoftReset}
          onAmend={onAmend}
          onSearch={onSearch}
          onLoadMore={onLoadMore}
          hasMore={historyHasMore}
          searchBusy={historySearchBusy}
          totalMatches={historyTotalMatches}
          limited={historyLimited}
          githubFullName={githubFullName}
        />
      )}
    </>
  )
}
