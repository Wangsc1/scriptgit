import { Button, GeometryReader, HStack, RoundedRectangle, Text, ZStack } from "scripting"

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
  return <GeometryReader frame={{ height: 44 }} listRowInsets={0} listRowSeparator="hidden">
    {proxy => {
      const width = Math.max(0, proxy.size.width)
      const segmentWidth = options.length ? width / options.length : 0
      return <HStack spacing={0} frame={{ width, height: 44 }}>
        {options.map(option => <Button key={option.value} buttonStyle="plain" disabled={disabled}
          frame={{ width: segmentWidth, height: 44 }}
          accessibilityLabel={option.title} accessibilityAddTraits={option.value === value ? "isSelected" : undefined}
          action={() => { if (!disabled && option.value !== value) onChanged(option.value) }}>
          <ZStack frame={{ width: segmentWidth, height: 44 }} contentShape={{ type: "rect" }}>
            {option.value === value ? <RoundedRectangle fill="systemGray4" cornerRadius={8}
              frame={{ width: segmentWidth, height: 44 }} /> : null}
            <Text font="subheadline" fontWeight="semibold" foregroundStyle="label">{option.title}</Text>
          </ZStack>
        </Button>)}
      </HStack>
    }}
  </GeometryReader>
}
