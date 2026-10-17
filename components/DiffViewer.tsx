/**
 * components/DiffViewer.tsx - 行级 + 行内 diff 渲染组件
 *
 * +/- 行着色，适配暗黑模式。
 * 配对 del/add 行有 segments 时，对 changed 片段叠加更深背景（GitHub 风格）。
 */

import {
  VStack,
  HStack,
  Text,
  Button,
  Image,
  useState,
  useColorScheme,
  type Color,
  type ShapeStyle,
} from "scripting"
import type { DiffLine, FileDiff, InlineSegment } from "../services/diffService"
import { wrapSegments } from "../utils/inlineDiff"
import { ImageDiffPreview } from "./ImageDiffPreview"

/** 新增/删除/折叠/行内高亮颜色（按明暗模式区分） */
interface DiffColors {
  addBg: ShapeStyle
  delBg: ShapeStyle
  addInlineBg: ShapeStyle
  delInlineBg: ShapeStyle
  skipBg: ShapeStyle
  skipFg: Color
  addFg: Color
  delFg: Color
  gutter: ShapeStyle
  lineNoFg: Color
  codeFg: Color
}

/**
 * 颜色取自 GitHub Primer `diffBlob` token
 * @see https://primer.style/product/getting-started/react/theme-reference/
 * light: line #e6ffec / #ffebe9，word #abf2bc / rgba(255,129,130,0.4)
 * dark:  line #2ea04326 / #f8514926，word #2ea04366 / #f8514966
 */
function useDiffColors(appearance?: "light" | "dark"): DiffColors {
  const scheme = useColorScheme()
  const isDark = (appearance ?? scheme) === "dark"
  return {
    // dark 行底 alpha 从 GitHub 0.15 提到 0.22（OLED 纯黑更可辨）
    addBg: (isDark ? "rgba(46, 160, 67, 0.22)" : "#e6ffec") as ShapeStyle,
    delBg: (isDark ? "rgba(248, 81, 73, 0.22)" : "#ffebe9") as ShapeStyle,
    addInlineBg: (isDark ? "rgba(46, 160, 67, 0.48)" : "#abf2bc") as ShapeStyle,
    delInlineBg: (isDark
      ? "rgba(248, 81, 73, 0.48)"
      : "rgba(255, 129, 130, 0.4)") as ShapeStyle,
    skipBg: (isDark
      ? "rgba(120, 130, 150, 0.22)"
      : "rgba(120, 130, 150, 0.1)") as ShapeStyle,
    skipFg: (isDark ? "#8b949e" : "#656d76") as Color,
    // +/- 标记：Primer success / danger emphasis
    addFg: (isDark ? "#3fb950" : "#1a7f37") as Color,
    delFg: (isDark ? "#f85149" : "#cf222e") as Color,
    gutter: (isDark ? "rgba(120,120,120,0.25)" : "rgba(180,180,180,0.25)") as ShapeStyle,
    lineNoFg: (appearance ? (isDark ? "#8b949e" : "#656d76") : "secondaryLabel") as Color,
    // 正文用默认色（与 GitHub 一致，不整行染绿/红）
    codeFg: (appearance ? (isDark ? "#e6edf3" : "#24292f") : "label") as Color,
  }
}

/** 折叠区：仅有 hiddenLines 时显示，点击展开 */
function DiffSkipLineView({
  line,
  colors,
  onExpand,
}: {
  line: DiffLine
  colors: DiffColors
  onExpand: () => void
}) {
  const count = line.hiddenLines?.length ?? 0
  // 无可展开内容则不渲染（避免空按钮）
  if (count === 0) return null
  return (
    <Button action={onExpand} buttonStyle="plain">
      <HStack
        spacing={6}
        alignment="center"
        background={colors.skipBg}
        frame={{ maxWidth: Infinity, minHeight: 28, alignment: "center" }}
        padding={{ leading: 10, trailing: 10, top: 6, bottom: 6 }}
      >
        <Image
          systemName="chevron.down"
          font={10}
          foregroundStyle={colors.skipFg}
        />
        <Text
          font="caption"
          foregroundStyle={colors.skipFg}
          frame={{ maxWidth: Infinity, alignment: "center" }}
        >
          {`展开 ${count} 行`}
        </Text>
        <Image
          systemName="chevron.down"
          font={10}
          foregroundStyle={colors.skipFg}
        />
      </HStack>
    </Button>
  )
}

/** Menlo 11 约 7pt/半角；保守估算避免 HStack 再被系统折成多列 */
function estimateContentMaxWidth(compact = false): number {
  const screenW = Device.screen?.width ?? 390
  // 行号 56 + 符号 14 + List/边距约 48
  const contentPts = Math.max(100, screenW - (compact ? 60 : 118))
  return Math.max(12, Math.floor(contentPts / (compact ? 7.8 : 7)))
}

/** 行内容：有 segments 时按片段渲染行内高亮 */
function DiffLineContent({
  content,
  segments,
  fg,
  inlineBg,
  compact = false,
}: {
  content: string
  segments?: InlineSegment[]
  fg: Color
  inlineBg: ShapeStyle
  compact?: boolean
}) {
  const font = { name: "Menlo", size: compact ? 13 : 11 } as const
  const pad = { trailing: 6, top: 2, bottom: 2 }

  if (!segments || segments.length === 0) {
    return (
      <Text
        font={font}
        foregroundStyle={fg}
        frame={{ maxWidth: Infinity, alignment: "leading" }}
        padding={pad}
      >
        {content || " "}
      </Text>
    )
  }

  // Text 不支持嵌套子节点；用软换行 + 每行 HStack 保持「单列文本流」
  const rows = wrapSegments(segments, estimateContentMaxWidth(compact))
  return (
    <VStack
      spacing={0}
      alignment="leading"
      frame={{ maxWidth: Infinity, alignment: "leading" }}
      padding={pad}
    >
      {rows.map((row, ri) => (
        <HStack key={ri} spacing={0} alignment="firstTextBaseline">
          {row.map((seg, si) => (
            <Text
              key={si}
              font={font}
              foregroundStyle={fg}
              background={seg.type === "changed" ? inlineBg : undefined}
              lineLimit={1}
            >
              {seg.text}
            </Text>
          ))}
        </HStack>
      ))}
    </VStack>
  )
}

/** 渲染单行 diff */
function DiffLineView({
  line,
  colors,
  onExpandSkip,
  compact = false,
}: {
  line: DiffLine
  colors: DiffColors
  onExpandSkip?: () => void
  compact?: boolean
}) {
  if (line.type === "skip") {
    if (compact) return <Button buttonStyle="plain" action={onExpandSkip ?? (() => {})}>
      <Text font="caption" foregroundStyle={colors.lineNoFg}
        frame={{ maxWidth: Infinity, alignment: "leading" }} padding={{ leading: 18, vertical: 6 }}>⋮</Text>
    </Button>
    return (
      <DiffSkipLineView
        line={line}
        colors={colors}
        onExpand={onExpandSkip ?? (() => {})}
      />
    )
  }

  const isAdd = line.type === "add"
  const isDel = line.type === "del"
  const sign = isAdd ? "+" : isDel ? "-" : " "
  const bg = isAdd ? colors.addBg : isDel ? colors.delBg : undefined
  // 与 GitHub 一致：正文用默认字色，仅 +/- 用绿/红
  const signFg = isAdd ? colors.addFg : isDel ? colors.delFg : colors.codeFg
  const inlineBg = isAdd ? colors.addInlineBg : colors.delInlineBg

  return (
    <HStack
      spacing={0}
      alignment="top"
      background={bg}
      frame={{ maxWidth: Infinity, alignment: "leading" }}
    >
      {/* 编辑器内对照采用截图式单行号；其他差异页保持双行号。 */}
      {compact ? <Text font="caption" foregroundStyle={colors.lineNoFg}
        frame={{ width: 34, alignment: "trailing" }} padding={{ trailing: 10, top: 2, bottom: 2 }}>
        {String(line.type === "del" ? line.oldLineNo ?? "" : line.newLineNo ?? "")}
      </Text> : <>
      <Text
        font="caption2"
        foregroundStyle={colors.lineNoFg}
        frame={{ width: 28, alignment: "trailing" }}
        padding={{ leading: 2, trailing: 2, top: 2, bottom: 2 }}
      >
        {line.oldLineNo ? String(line.oldLineNo) : " "}
      </Text>
      {/* 新行号 gutter */}
      <Text
        font="caption2"
        foregroundStyle={colors.lineNoFg}
        frame={{ width: 28, alignment: "trailing" }}
        padding={{ leading: 2, trailing: 4, top: 2, bottom: 2 }}
      >
        {line.newLineNo ? String(line.newLineNo) : " "}
      </Text>
      {/* +/- 标记 */}
      <Text
        font="caption"
        foregroundStyle={signFg}
        frame={{ width: 14, alignment: "center" }}
        padding={{ top: 2, bottom: 2 }}
      >
        {sign}
      </Text>
      </>}
      <DiffLineContent
        content={line.content}
        segments={isAdd || isDel ? line.segments : undefined}
        fg={colors.codeFg}
        inlineBg={inlineBg}
        compact={compact}
      />
    </HStack>
  )
}

/** 渲染整个文件的 diff，支持展开折叠区 */
export function DiffViewer({
  diff,
  onOpenImage,
  compact = false,
  appearance,
}: {
  diff: FileDiff
  compact?: boolean
  appearance?: "light" | "dark"
  /** 点击图片时上抛 data URL，由页面全屏展示 */
  onOpenImage?: (dataUrl: string) => void
}) {
  const colors = useDiffColors(appearance)
  // 用 lines state 实现展开：点击 skip 时将其 hiddenLines 插入并移除 skip
  const [lines, setLines] = useState(diff.lines)

  if (diff.binary) {
    const preview = diff.binaryPreview
    if (preview && (preview.old || preview.new)) {
      return (
        <>
          <Text font="callout" foregroundStyle={colors.lineNoFg}>
            二进制图片文件，点击图片可全屏查看
          </Text>
          <ImageDiffPreview
            filepath={diff.filepath}
            oldVersion={preview.old}
            newVersion={preview.new}
            onOpen={onOpenImage ?? (() => {})}
          />
        </>
      )
    }
    return (
      <Text font="callout" foregroundStyle={colors.lineNoFg}>
        二进制文件，无法显示行级差异
      </Text>
    )
  }

  if (lines.length === 0) {
    return (
      <Text font="callout" foregroundStyle={colors.lineNoFg}>
        无差异
      </Text>
    )
  }

  function handleExpand(skipIndex: number) {
    setLines((prev) => {
      const target = prev[skipIndex]
      if (target.type !== "skip" || !target.hiddenLines?.length) return prev
      const next = [...prev]
      next.splice(skipIndex, 1, ...target.hiddenLines)
      return next
    })
  }

  return (
    <VStack spacing={0} alignment="leading" frame={{ maxWidth: Infinity }}>
      {lines.map((line, idx) => (
        <DiffLineView
          key={idx}
          line={line}
          colors={colors}
          compact={compact}
          onExpandSkip={
            line.type === "skip" ? () => handleExpand(idx) : undefined
          }
        />
      ))}
    </VStack>
  )
}
