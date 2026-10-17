import { Button, HStack, VStack, Image, Text } from "scripting"
import { COLOR_ACCENT } from "../constants/colors"

/** 编辑器底部双按钮，旧系统使用材质胶囊，iOS 26 使用原生玻璃。 */
export function FileChangeSwitcher({ selected, added, deleted, disabled, onSelect }: {
  selected: "content" | "changes"; added: number; deleted: number; disabled: boolean
  onSelect: (kind: "content" | "changes") => void
}) {
  const surface = Number.parseInt(String(Device.systemVersion), 10) >= 26
    ? { glassEffect: { glass: UIGlass.clear().interactive(true), shape: "capsule" as const } }
    : { background: { style: "ultraThinMaterial" as const, shape: "capsule" as const }, clipShape: "capsule" as const }
  return <HStack frame={{ maxWidth: Infinity, alignment: "center" }} padding={{ horizontal: 24, top: 8, bottom: 8 }}>
    <HStack spacing={6} padding={6} {...surface}
      shadow={{ color: "rgba(72,88,120,0.15)", radius: 10, y: 3 }}>
      {(["content", "changes"] as const).map(kind => <Button key={kind} buttonStyle="plain" disabled={disabled} action={() => onSelect(kind)}>
        <VStack spacing={3} padding={{ horizontal: 24, vertical: 9 }}
          background={selected === kind ? { style: "ultraThinMaterial", shape: "capsule" } : undefined}
          foregroundStyle={selected === kind ? COLOR_ACCENT : "label"}>
          <HStack spacing={5}>
            <Image systemName={kind === "content" ? "doc.text" : "plusminus.square"} font={22} />
            {kind === "changes" ? <Text font="caption2" fontWeight="semibold" foregroundStyle="white"
              background={{ style: "systemOrange", shape: "capsule" }} padding={{ horizontal: 6, vertical: 3 }}>−{deleted} +{added}</Text> : null}
          </HStack>
          <Text font="caption">{kind === "content" ? "原内容" : "改动项"}</Text>
        </VStack>
      </Button>)}
    </HStack>
  </HStack>
}
