import { Button, HStack, Text } from "scripting"

/** 外层白色大框由所在 List Section 的原生卡片提供；这里不再有内层轨道/小胶囊。
 * 每段是等分的按钮，选中项仅用灰色圆角底标出；不自定义行高或行边距，沿用系统 List 行。 */
/** 日间沿用原灰；夜间卡片底约 #1C1C1E，系统 gray5 与其太接近，改用明确更亮的灰。 */
const SELECTED_FILL = { light: "#E5E5EA", dark: "#48484A" }

export function FilledSegmentedControl<T extends string | number>({ value, options, onChanged, disabled = false }: {
  value: T
  options: { value: T; title: string }[]
  onChanged(value: T): void
  disabled?: boolean
}) {
  return <HStack spacing={4} frame={{ maxWidth: "infinity" }}>
    {options.map(option => {
      const selected = option.value === value
      return <Button key={String(option.value)} buttonStyle="plain" disabled={disabled}
        frame={{ maxWidth: "infinity" }}
        accessibilityLabel={option.title} accessibilityAddTraits={selected ? "isSelected" : undefined}
        action={() => { if (!disabled && !selected) onChanged(option.value) }}>
        <Text font="subheadline" fontWeight={selected ? "semibold" : "regular"} foregroundStyle="label"
          frame={{ maxWidth: "infinity", minHeight: 40, alignment: "center" }}
          background={selected ? { style: SELECTED_FILL, shape: { type: "rect", cornerRadius: 10 } } : undefined}
          contentShape={{ type: "rect" }}>{option.title}</Text>
      </Button>
    })}
  </HStack>
}
