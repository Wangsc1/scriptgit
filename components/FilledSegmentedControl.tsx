import { Button, HStack, Text } from "scripting"
import { COLOR_ACCENT } from "../constants/colors"

/** 外层大框由所在 List Section 的原生卡片提供，无内层轨道。
 * 选中样式与主页底部悬浮栏一致：整段圆角（胶囊）浅灰底 + 蓝色文字。
 * 行边距用官方 listRowInsets 设为上下 8pt，内容高 36pt，整框约 52pt，与「更改分支」行同高。 */
const SELECTED_FILL = { light: "#E2E3E5", dark: "#48484A" }
const SEGMENT_HEIGHT = 36

export function FilledSegmentedControl<T extends string | number>({ value, options, onChanged, disabled = false }: {
  value: T
  options: { value: T; title: string }[]
  onChanged(value: T): void
  disabled?: boolean
}) {
  return <HStack spacing={4} frame={{ maxWidth: "infinity" }}
    listRowInsets={{ top: 8, bottom: 8, leading: 8, trailing: 8 }}>
    {options.map(option => {
      const selected = option.value === value
      return <Button key={String(option.value)} buttonStyle="plain" disabled={disabled}
        frame={{ maxWidth: "infinity" }}
        accessibilityLabel={option.title} accessibilityAddTraits={selected ? "isSelected" : undefined}
        action={() => { if (!disabled && !selected) onChanged(option.value) }}>
        <Text font="subheadline" fontWeight={selected ? "semibold" : "regular"}
          foregroundStyle={selected ? COLOR_ACCENT : "label"}
          frame={{ maxWidth: "infinity", minHeight: SEGMENT_HEIGHT, alignment: "center" }}
          background={selected ? { style: SELECTED_FILL, shape: { type: "rect", cornerRadius: SEGMENT_HEIGHT / 2 } } : undefined}
          contentShape={{ type: "rect" }}>{option.title}</Text>
      </Button>
    })}
  </HStack>
}
