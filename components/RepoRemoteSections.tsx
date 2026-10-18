import { Button, HStack, Image, Section, Spacer, Text } from "scripting"
import {
  COLOR_ACCENT,
  COLOR_ORANGE,
  COLOR_SECONDARY_LABEL,
} from "../constants/colors"
import { DEFAULT_BRANCH } from "../constants/git"
import type { BranchInfo } from "../types/git"
import type { UpstreamConfig } from "../utils/remote"
import { pullActionFooterHint } from "../utils/branchMerge"

export function RepoRemoteSections({
  branchInfo,
  branchUnavailable = false,
  upstream,
  pulledLabel,
  hasRemote,
  canUpload,
  mergeInProgress,
  mutating,
  hasCommits,
  onCompare,
  onRollback,
  onManageRemotes,
  onUpload,
  onPush,
  onPull,
}: {
  branchInfo: BranchInfo
  branchUnavailable?: boolean
  upstream: UpstreamConfig | null
  pulledLabel: string
  hasRemote: boolean
  canUpload: boolean
  mergeInProgress: boolean
  mutating: boolean
  hasCommits: boolean
  onCompare: () => void
  onRollback: () => void
  onManageRemotes: () => void
  onUpload: () => void
  onPush: () => void
  onPull: () => void
}) {
  if (hasRemote) {
    return (
      <Section
        header={
          <HStack alignment="center" spacing={8}>
            <Text>同步</Text>
            <Spacer />
            <Button
              action={onRollback}
              disabled={branchUnavailable || mutating || mergeInProgress || !hasCommits}
            >
              <HStack alignment="center" spacing={4}>
                <Image
                  systemName="arrow.uturn.backward"
                  font="caption"
                  foregroundStyle={COLOR_ORANGE}
                />
                <Text font="caption" foregroundStyle={COLOR_ORANGE}>回滚</Text>
              </HStack>
            </Button>
            <Button action={onCompare} disabled={branchUnavailable || mutating}>
              <HStack alignment="center" spacing={4}>
                <Image
                  systemName="arrow.left.arrow.right"
                  font="caption"
                  foregroundStyle={COLOR_ACCENT}
                />
                <Text font="caption" foregroundStyle={COLOR_ACCENT}>对比差异</Text>
              </HStack>
            </Button>
            <Button action={onManageRemotes} disabled={mutating}>
              <HStack alignment="center" spacing={4}>
                <Image systemName="network" font="caption" foregroundStyle={COLOR_ACCENT} />
                <Text font="caption" foregroundStyle={COLOR_ACCENT}>远端管理</Text>
              </HStack>
            </Button>
          </HStack>
        }
        footer={
          // 两段文字同为 footnote、单行，字号一致。
          <HStack alignment="center">
            <Text font="footnote" lineLimit={1} foregroundStyle={COLOR_SECONDARY_LABEL}>
              {branchUnavailable ? "分支信息未确认，读取成功后再操作" : pullActionFooterHint(branchInfo.current, upstream)}
            </Text>
            <Spacer />
            {branchUnavailable ? null : <Text font="footnote" lineLimit={1} foregroundStyle={COLOR_SECONDARY_LABEL}>{pulledLabel}</Text>}
          </HStack>
        }
      >
        <HStack alignment="center">
          <Button buttonStyle="plain" action={onPush} disabled={branchUnavailable || mutating || mergeInProgress}>
            <HStack alignment="center" spacing={6}>
              <Image systemName="arrow.up.circle" foregroundStyle={COLOR_ACCENT} />
              <Text foregroundStyle={COLOR_ACCENT}>推送 Push</Text>
            </HStack>
          </Button>
          <Spacer />
          <Button buttonStyle="plain" action={onPull} disabled={branchUnavailable || mutating || mergeInProgress}>
            <HStack alignment="center" spacing={6}>
              <Image systemName="arrow.down.circle" foregroundStyle={COLOR_ACCENT} />
              <Text foregroundStyle={COLOR_ACCENT}>拉取 Pull</Text>
            </HStack>
          </Button>
        </HStack>
      </Section>
    )
  }

  if (canUpload) {
    return (
      <Section
        header={<Text>上传</Text>}
        footer={
          <Text font="footnote" foregroundStyle={COLOR_SECONDARY_LABEL}>
            {branchUnavailable ? "分支信息未确认，读取成功后再上传" : `本地仓库 · 默认分支 ${branchInfo.current || DEFAULT_BRANCH} · 需至少一次提交后再上传`}
          </Text>
        }
      >
        <Button
          title="上传到 GitHub"
          disabled={branchUnavailable || mutating}
          systemImage="arrow.up.circle"
          action={onUpload}
        />
        <Button title="远端管理" systemImage="network" action={onManageRemotes} />
      </Section>
    )
  }

  return (
    <Section
      header={<Text>远端</Text>}
      footer={
        <Text font="footnote" foregroundStyle={COLOR_SECONDARY_LABEL}>
          可手动添加 origin，或克隆/上传后自动出现同步区
        </Text>
      }
    >
      <Button title="远端管理" systemImage="network" action={onManageRemotes} />
    </Section>
  )
}
