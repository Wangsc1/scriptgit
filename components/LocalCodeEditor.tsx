import { VStack, Text, ProgressView, WebView, useEffect, useRef, useState } from "scripting"
import type { LocalCodeEditorController } from "../services/localCodeEditor"

/** Temporary, content-free visibility observations for the parent loading row.
 * DOM sizes describe WebKit's viewport, NOT proof of a visible native frame. */
export type LocalEditorDisplayState = { editorVisible?: boolean; webVisible?: boolean; viewport?: string; webEvent?: "appear" | "disappear"; webAppearCount?: number; webDisappearCount?: number }

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
  function startOnWebAppear() {
    // Only the bound native WebView starts loading, not its root or an effect.
    // First render already contains this stable controller, as in the official
    // embedded WebView example. Reappearances retain the page/draft.
    onDisplayStateChange?.({ webVisible: true, webEvent: "appear" })
    void controller.start().then(() => { if (observation.current.active) observeViewport() })
  }
  useEffect(() => {
    let mounted = true
    observation.current.active = true
    const unsubscribe = controller.subscribe(() => { if (mounted) refresh(value => value + 1) })
    // Take a fresh snapshot if appearance preceded effect subscription.
    refresh(value => value + 1)
    return () => {
      mounted = false; observation.current.active = false; unsubscribe()
      if (observation.current.timer) clearTimeout(observation.current.timer)
    }
  }, [controller])
  useEffect(() => controller.attachBack(onBack), [controller, onBack])
  // WebKit's media query follows the actual presented WebView appearance.
  // Do not overwrite it with the process-global useColorScheme() value.

  return <VStack onAppear={() => onDisplayStateChange?.({ editorVisible: true })} onDisappear={() => onDisplayStateChange?.({ editorVisible: false })} spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity", minHeight: 1 }}
    background={{ light: "white", dark: "#242424" }} ignoresSafeArea={{ regions: "container", edges: "bottom" }}>
    {/* Keep this native child first and unconditional. Loading/error publications
        must never insert, replace or move the bound WebView in the child list. */}
    <WebView key="local-code-webview" controller={controller.webController}
      onAppear={startOnWebAppear}
      onDisappear={() => onDisplayStateChange?.({ webVisible: false, webEvent: "disappear" })}
      frame={{ maxWidth: "infinity", maxHeight: "infinity", minHeight: 1 }}
      background={{ light: "white", dark: "#242424" }} ignoresSafeArea={{ regions: "container", edges: "bottom" }} />
    {controller.phase === "idle" || controller.phase === "loading" ? <VStack spacing={6} padding={12}>
      <ProgressView /><Text font="caption">正在加载本地编辑器…</Text>
    </VStack> : null}
    {controller.error ? <Text font="caption" foregroundStyle="red" padding={8}>
      {controller.error}
    </Text> : null}
  </VStack>
}
