import { Button, NavigationStack, Text, VStack, useEffect, useRef, useState } from "scripting"
import { localImportOnMain } from "../services/localImportExecution"

/** Minimal native reproduction: no List/DisclosureGroup/contextMenu, repository
 * dependencies, file paths, or persistence. Official onDrag/onDrop contract:
 * https://scriptingapp.github.io/guide/View%20Modifiers/onDrag%20and%20onDrop%20View%20Modifiers.md
 * The native gesture itself can only be verified on a device.
 */
export function DragDropTestPage({ onClose }: { onClose(): void }) {
  const state = useRef({ alive: true, generation: 0, token: "", entries: [] as string[], pending: false, callback: "", decision: "" })
  const [trace, setTrace] = useState("等待测试：将测试块拖到接收区松手")
  const types = ["public.utf8-plain-text", "public.plain-text"]
  function report(message: string) {
    try {
      const s = state.current
      if (!s.alive || s.entries[s.entries.length - 1] === message) return
      s.entries = [...s.entries, message].slice(-12)
      if (s.pending) return
      s.pending = true
      void localImportOnMain("拖放测试轨迹", () => {
        s.pending = false
        if (s.alive) setTrace(s.entries.join("\n"))
      }).catch(() => { s.pending = false })
    } catch (_) { /* Diagnostics never change a native return value. */ }
  }
  function entry(name: string) {
    const s = state.current
    if (s.callback === name) return false
    s.callback = name
    report(`${name} 入口`)
    return true
  }
  function decision(message: string, first: boolean) {
    if (first || state.current.decision !== message) report(message)
    state.current.decision = message
  }
  function accepts(info: DropInfo, name: string, first: boolean) {
    if (!state.current.alive) return false
    try {
      const supported = info.hasItemsConforming(types)
      decision(`${name}.hasItemsConforming=${supported}`, first)
      return supported
    } catch (_) {
      decision(`${name}.hasItemsConforming 异常`, first)
      return false
    }
  }
  function invalidate() {
    const s = state.current
    s.alive = false; s.generation++; s.token = ""; s.entries = []
  }
  useEffect(() => invalidate, [])
  function close() {
    invalidate()
    void localImportOnMain("关闭拖放测试", onClose).catch(() => {})
  }
  function start(): ItemProvider {
    const s = state.current
    s.generation++; s.entries = []; s.callback = ""; s.decision = ""
    s.token = `drag-test-${Math.random().toString(36).slice(2)}-${Date.now()}`
    report("onDrag.data 入口")
    // Synchronous native provider: do not dispatch or return a Promise here.
    const provider = ItemProvider.fromText(s.token)
    try { report(`已开始；源类型=${provider.registeredTypes.join(", ")}`) }
    catch (_) { report("已开始；源类型读取异常") }
    return provider
  }
  const drop = {
    types,
    validateDrop: (info: DropInfo) => accepts(info, "validateDrop", entry("validateDrop")),
    dropEntered: (info: DropInfo) => { accepts(info, "dropEntered", entry("dropEntered")) },
    dropUpdated: (info: DropInfo): "copy" | "forbidden" => accepts(info, "dropUpdated", entry("dropUpdated")) ? "copy" : "forbidden",
    dropExited: (_info: DropInfo) => { entry("dropExited") },
    performDrop(info: DropInfo): boolean {
      if (!accepts(info, "performDrop", entry("performDrop"))) return false
      let stage = "itemProviders"
      try {
        const providers = info.itemProviders(types)
        report(`performDrop.itemProviders=${providers.length}`)
        if (providers.length !== 1) return false
        stage = "loadText"
        // Official lifetime rule: get providers and START loading before return.
        const loaded = providers[0].loadText()
        report("performDrop.loadText 已启动")
        const generation = state.current.generation
        void loaded.then(value => {
          if (!state.current.alive || generation !== state.current.generation) return
          report(value && value === state.current.token ? "loadText 完成：本页测试文本匹配，测试成功（未访问仓库）" : "loadText 完成：不是本轮测试文本，未执行任何操作")
        }, () => {
          if (state.current.alive && generation === state.current.generation) report("loadText 异步失败")
        })
        return true
      } catch (_) { report(`performDrop.${stage} 同步异常`); return false }
    },
  }
  return <NavigationStack>
    <VStack spacing={18} padding frame={{ maxWidth: Infinity, maxHeight: Infinity }}
      navigationTitle="拖放测试（不改仓库）" navigationBarTitleDisplayMode="inline"
      toolbar={{ topBarLeading: <Button title="返回" action={close} /> }}>
      <Text>仅测试系统拖放，不访问或修改仓库。将测试块拖到接收区松手。</Text>
      <Text onDrag={{ data: start, preview: <Text>测试块</Text> }} padding
        frame={{ maxWidth: Infinity, minHeight: 80 }} background="systemBlue" foregroundStyle="white">长按拖动此测试块</Text>
      <VStack onDrop={drop} padding frame={{ maxWidth: Infinity, minHeight: 160 }}
        background="systemGray5" contentShape={{ kind: "interaction", shape: "rect" }}>
        <Text>接收区：拖到这里松手</Text>
        <Text font="caption">接收 public.utf8-plain-text / public.plain-text</Text>
      </VStack>
      <Text font="caption2">{trace}</Text>
    </VStack>
  </NavigationStack>
}
