import { VStack, Text, ProgressView, WebView, useEffect, useRef, useState } from "scripting"
import type { LocalCodeEditorController } from "../services/localCodeEditor"

/** Temporary, content-free visibility observations for the parent loading row.
 * DOM sizes describe WebKit's viewport, NOT proof of a visible native frame. */
export type LocalEditorDisplayState = { editorVisible?: boolean; webVisible?: boolean; viewport?: string }

/** The parent owns saving and disposal. Tab unmounts only detach listeners. */
export function LocalCodeEditor({ controller, onBack, onDisplayStateChange }: {
  controller: LocalCodeEditorController
  onBack?: () => void | Promise<void>
  onDisplayStateChange?: (state: LocalEditorDisplayState) => void
}) {
  const [, refresh] = useState(0)
  const observation = useRef<{ active: boolean; timer: ReturnType<typeof setTimeout> | null }>({ active: true, timer: null })
  function observeViewport() {
    if (observation.current.timer) clearTimeout(observation.current.timer)
    observation.current.timer = setTimeout(async () => {
      if (!observation.current.active || controller.phase !== "ready" || !controller.webController) return
      try {
        const size = await controller.webController.evaluateJavaScript<{ width: number; height: number }>(
          "return {width: window.innerWidth, height: window.innerHeight}")
        if (observation.current.active && Number.isFinite(size?.width) && Number.isFinite(size?.height)) {
          onDisplayStateChange?.({ viewport: `${Math.round(size.width)}×${Math.round(size.height)}` })
        }
      } catch (_) { if (observation.current.active) onDisplayStateChange?.({ viewport: "无法读取尺寸" }) }
    }, 300)
  }
  function startOnAppear() {
    // Official onAppear is the native visibility hook. start() is idempotent:
    // the effect and repeated tab appearances must never load or activate twice.
    onDisplayStateChange?.({ editorVisible: true })
    void controller.start().then(() => { if (observation.current.active) observeViewport() })
  }
  useEffect(() => {
    let mounted = true
    observation.current.active = true
    const unsubscribe = controller.subscribe(() => { if (mounted) refresh(value => value + 1) })
    void controller.start()
    return () => {
      mounted = false; observation.current.active = false; unsubscribe()
      if (observation.current.timer) clearTimeout(observation.current.timer)
    }
  }, [controller])
  useEffect(() => controller.attachBack(onBack), [controller, onBack])
  // WebKit's media query follows the actual presented WebView appearance.
  // Do not overwrite it with the process-global useColorScheme() value.

  return <VStack onAppear={startOnAppear} onDisappear={() => onDisplayStateChange?.({ editorVisible: false })} spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity", minHeight: 1 }}
    background={{ light: "white", dark: "#242424" }} ignoresSafeArea={{ regions: "container", edges: "bottom" }}>
    {controller.phase === "idle" || controller.phase === "loading" ? <VStack spacing={6} padding={12}>
      <ProgressView /><Text font="caption">正在加载本地编辑器…</Text>
    </VStack> : null}
    {controller.error ? <Text font="caption" foregroundStyle="red" padding={8}>
      {controller.error}
    </Text> : null}
    {controller.webController ? <WebView controller={controller.webController}
      onAppear={() => { onDisplayStateChange?.({ webVisible: true }); observeViewport() }}
      onDisappear={() => onDisplayStateChange?.({ webVisible: false })}
      frame={{ maxWidth: "infinity", maxHeight: "infinity", minHeight: 1 }}
      background={{ light: "white", dark: "#242424" }} ignoresSafeArea={{ regions: "container", edges: "bottom" }} /> : null}
  </VStack>
}
