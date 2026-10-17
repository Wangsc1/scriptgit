import { TabView, VStack, Image, Text, ImageRenderer, useEffect, useState, useColorScheme, type VirtualNode } from "scripting"
import { COLOR_ORANGE } from "../constants/colors"

/** 系统原生底部页签：将真实数字放入原生上方图像槽，标题仍单独在下方。
 * 数字由 Text 渲染，不使用加减 SF Symbol；original 模式保留“已修改”的语义橙色。
 */
export function FileChangeSwitcher({ selection, content, changes, disabled, stats }: {
  stats: { added: number; deleted: number } | null
  selection: Observable<number>; content: VirtualNode; changes: VirtualNode; disabled: boolean
}) {
  const scheme = useColorScheme()
  const label = stats ? `-${stats.deleted} +${stats.added}` : "…"
  const stamp = `${scheme}:${label}`
  const [rendered, setRendered] = useState<{ stamp: string; image: UIImage } | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setFailed(false)
    ImageRenderer.toUIImage(<Text font={{ name: "Menlo", size: 13 }} fontWeight="semibold"
      foregroundStyle={COLOR_ORANGE} padding={{ horizontal: 2, vertical: 3 }}>{label}</Text>)
      .then(image => {
        // Native tab bars can template UIImage even when Image asks for original.
        // Bake the shared status orange into the native image itself.
        const original = image.withTintColor(COLOR_ORANGE, "alwaysOriginal")
        if (!original) throw new Error("无法生成原色改动数量")
        if (alive) setRendered({ stamp, image: original })
      })
      .catch(e => { console.warn("改动数量标签渲染失败: " + String(e)); if (alive) setFailed(true) })
    return () => { alive = false }
  }, [stamp])
  return <TabView tabIndex={selection.value} onTabIndexChanged={value => selection.setValue(value)} disabled={disabled}>
    <VStack spacing={0} frame={{ maxWidth: Infinity, maxHeight: Infinity }} tag={0}
      ignoresSafeArea={{ regions: "container", edges: "bottom" }}
      toolbarBackgroundVisibility={{ visibility: "hidden", bars: ["tabBar"] }}
      tabItem={<VStack><Image systemName="doc.text" /><Text>原内容</Text></VStack>}>
      {content}
    </VStack>
    <VStack spacing={0} frame={{ maxWidth: Infinity, maxHeight: Infinity }} tag={1}
      ignoresSafeArea={{ regions: "container", edges: "bottom" }}
      toolbarBackgroundVisibility={{ visibility: "hidden", bars: ["tabBar"] }}
      tabItem={<VStack>
        {rendered?.stamp === stamp ? <Image image={rendered.image} renderingMode="original" foregroundStyle={COLOR_ORANGE} /> : null}
        <Text>{failed ? `改动项 ${label}` : "改动项"}</Text>
      </VStack>}>
      {changes}
    </VStack>
  </TabView>
}
