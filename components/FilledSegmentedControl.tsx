import { Button, GeometryReader, HStack, RoundedRectangle, Text, ZStack, modifiers } from "scripting"

/** Remains one native List row. List owns the card background/corner clipping.
 * Measure the proposed row width once per layout, then give every button,
 * label container and selection SHAPE an explicit equal width. Do not rely on
 * a Text's flexible frame or modifier ordering to size its background. */
export function FilledSegmentedControl<T extends string | number>({ value, options, onChanged, disabled = false }: {
  value: T
  options: { value: T; title: string }[]
  onChanged(value: T): void
  disabled?: boolean
}) {
  // Explicit nonzero EdgeInsets, not numeric 0. The screenshot showed native
  // default insets still present with numeric 0 and a 44pt child overflowing.
  // Give List a 64pt row: 48pt content + equal 8pt edges. The native card's
  // system radius no longer has to clamp to half of a short 44pt row.
  return <GeometryReader modifiers={modifiers().frame({ height: 48 })
    .listRowInsets({ top: 8, bottom: 8, leading: 8, trailing: 8 }).listRowSeparator("hidden")}>

    {proxy => {
      const width = Math.max(0, proxy.size.width)
      const segmentWidth = options.length ? width / options.length : 0
      return <HStack spacing={0} alignment="center" frame={{ width, height: 48, alignment: "center" }}>
        {options.map(option => <Button key={option.value} buttonStyle="plain" disabled={disabled}
          frame={{ width: segmentWidth, height: 48 }}
          accessibilityLabel={option.title} accessibilityAddTraits={option.value === value ? "isSelected" : undefined}
          action={() => { if (!disabled && option.value !== value) onChanged(option.value) }}>
          <ZStack alignment="center" frame={{ width: segmentWidth, height: 48, alignment: "center" }} contentShape={{ type: "rect" }}>
            {option.value === value ? <RoundedRectangle fill="systemGray4" cornerRadius={8}
              frame={{ width: segmentWidth, height: 48 }} /> : null}
            <Text font="subheadline" fontWeight="semibold" foregroundStyle="label">{option.title}</Text>
          </ZStack>
        </Button>)}
      </HStack>
    }}
  </GeometryReader>
}
