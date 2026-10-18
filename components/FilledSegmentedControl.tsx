import { Button, HStack, Rectangle, Text } from "scripting"

/** A single List row: each segment fills its share of the original rounded
 * group. No native segmented-control inset track or per-button capsule. */
export function FilledSegmentedControl<T extends string | number>({ value, options, onChanged, disabled = false }: {
  value: T
  options: { value: T; title: string }[]
  onChanged(value: T): void
  disabled?: boolean
}) {
  return <HStack spacing={0} frame={{ maxWidth: Infinity }}
    listRowInsets={0} listRowSeparator="hidden" listRowBackground={<Rectangle fill="clear" />}
    background="secondarySystemGroupedBackground" clipShape={{ type: "rect", cornerRadius: 10 }}>
    {options.map(option => <Button key={option.value} buttonStyle="plain" disabled={disabled}
      frame={{ maxWidth: Infinity }}
      accessibilityLabel={option.title} accessibilityAddTraits={option.value === value ? "isSelected" : undefined}
      action={() => { if (!disabled && option.value !== value) onChanged(option.value) }}>
      <Text font="subheadline" fontWeight="semibold" foregroundStyle="label"
        frame={{ maxWidth: Infinity, height: 44 }}
        background={option.value === value ? "systemGray4" : "secondarySystemGroupedBackground"}
        contentShape={{ type: "rect" }}>{option.title}</Text>
    </Button>)}
  </HStack>
}
