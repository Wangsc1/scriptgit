import { TabView, Tab, type VirtualNode } from "scripting"

/** 与主页“仓库 / 设置”完全相同的系统原生页签，不手绘玻璃或选中背景。 */
export function FileChangeSwitcher({ selection, content, changes, disabled, stats }: {
  stats: { added: number; deleted: number } | null
  selection: Observable<number>; content: VirtualNode; changes: VirtualNode; disabled: boolean
}) {
  return <TabView selection={selection} disabled={disabled}>
    <Tab title="原内容" systemImage="doc.text" value={0}>{content}</Tab>
    <Tab title={stats ? `改动项 -${stats.deleted} +${stats.added}` : "改动项 …"} value={1}>{changes}</Tab>
  </TabView>
}
