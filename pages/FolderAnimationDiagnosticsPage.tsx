import { Button, DisclosureGroup, HStack, Image, List, Section, Text, useEffect, useRef, useState } from "scripting"

import { fileTreeRowTransition } from "../utils/fileTreeAnimation"

const MODES = ["① 官方非受控", "② 官方受控", "③ 递归受控", "④ 递归＋异步更新", "⑤ 局部取消淡化（生产方案）"]
type Node = { path: string; name: string; children: Node[] }
// Synthetic folders only. No repository, filesystem, Storage or network dependencies.
const TREE: Node[] = [
  { path: "app", name: "app", children: ["admin", "agent", "bot"].map(name => ({
    path: "app/" + name, name, children: ["one", "two"].map(child => ({ path: "app/" + name + "/" + child, name: child, children: [] })),
  })) },
  { path: "docs", name: "docs", children: ["guide", "reference"].map(name => ({ path: "docs/" + name, name, children: [] })) },
]

function DiagnosticTreeRow({ node, expanded, toggle, corrected = false }: { node: Node; expanded: Set<string>; corrected?: boolean; toggle(path: string, value: boolean): void }) {
  return <DisclosureGroup transition={corrected ? fileTreeRowTransition : undefined} isExpanded={expanded.has(node.path)} onChanged={value => toggle(node.path, value)} label={<HStack spacing={10}>
    <Image systemName="folder" foregroundStyle="secondaryLabel" /><Text>{node.name}</Text>
  </HStack>}>
    {node.children.map(child => <DiagnosticTreeRow key={child.path} node={child} expanded={expanded} toggle={toggle} corrected={corrected} />)}
  </DisclosureGroup>
}

/** Each selected group is separately keyed/mounted. Parent never observes its toggles. */
export function FolderAnimationDiagnosticGroup({ mode }: { mode: number }) {
  const [state, setState] = useState(() => ({ expanded: new Set<string>(), opens: 0, extra: new Map<string, number>(), extraUpdates: 0 }))
  const alive = useRef(true)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => {
    alive.current = false
    timers.current.forEach(timer => clearTimeout(timer))
    timers.current = []
  }, [])
  function toggle(path: string, value: boolean) {
    if (!alive.current) return
    // Counter and expansion share the SAME update; no counter-only rerender.
    setState(previous => {
      const expanded = new Set(previous.expanded)
      if (value) expanded.add(path)
      else expanded.delete(path)
      return { ...previous, expanded, opens: previous.opens + (path === "app" && value ? 1 : 0) }
    })
    if (mode === 3) {
      const timer = setTimeout(() => {
        timers.current = timers.current.filter(item => item !== timer)
        if (alive.current) setState(previous => ({ ...previous, extra: new Map<string, number>(), extraUpdates: previous.extraUpdates + 1 }))
      }, 0)
      timers.current.push(timer)
    }
  }
  return <>
    <Section>
      <Text>{MODES[mode]}</Text>
      <Text font="caption">{mode === 0 ? "展开次数：原生自管，不监听事件" : `app 展开：${state.opens} 次`}；额外更新：{state.extraUpdates} 次</Text>
    </Section>
    <Section header={<Text>固定文件夹（无真实文件）</Text>}>
      {mode <= 1 ? <>
        <DisclosureGroup title="app" {...(mode === 1 ? { isExpanded: state.expanded.has("app"), onChanged: (value: boolean) => toggle("app", value) } : {})}>
          <DisclosureGroup title="admin"><DisclosureGroup title="one" /><DisclosureGroup title="two" /></DisclosureGroup>
          <DisclosureGroup title="agent"><DisclosureGroup title="one" /><DisclosureGroup title="two" /></DisclosureGroup>
          <DisclosureGroup title="bot"><DisclosureGroup title="one" /><DisclosureGroup title="two" /></DisclosureGroup>
        </DisclosureGroup>
        <DisclosureGroup title="docs"><DisclosureGroup title="guide" /><DisclosureGroup title="reference" /></DisclosureGroup>
      </> : TREE.map(node => <DiagnosticTreeRow key={node.path} node={node} expanded={state.expanded} toggle={toggle} corrected={mode === 4} />)}
    </Section>
  </>
}

export function FolderAnimationDiagnosticsPage() {
  const [mode, setMode] = useState(0)
  return <List navigationTitle="文件夹动画诊断" navigationBarTitleDisplayMode="inline">
    <Section>
      <Text>先对比③与⑤，每组将 app 展开、收拢三次并录屏。①至④保留作原方案对照。切组重置；左上返回。</Text>
      <Text font="caption">仅固定假数据，不访问仓库。①不统计点击，避免干扰原生行为。</Text>
      {MODES.map((title, index) => <Button key={title} title={(index === mode ? "✓ " : "") + title} action={() => { if (index !== mode) setMode(index) }} />)}
    </Section>
    <FolderAnimationDiagnosticGroup key={mode} mode={mode} />
  </List>
}
