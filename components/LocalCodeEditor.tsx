import { VStack, Text, ProgressView, WebView, useEffect, useState } from "scripting"
import type { LocalCodeEditorController } from "../services/localCodeEditor"

/** The parent owns saving and disposal. Tab unmounts only detach listeners. */
export function LocalCodeEditor({ controller, onBack }: {
  controller: LocalCodeEditorController
  onBack?: () => void | Promise<void>
}) {
  const [, refresh] = useState(0)
  useEffect(() => {
    let mounted = true
    const unsubscribe = controller.subscribe(() => { if (mounted) refresh(value => value + 1) })
    void controller.start()
    return () => { mounted = false; unsubscribe() }
  }, [controller])
  useEffect(() => controller.attachBack(onBack), [controller, onBack])
  // WebKit's media query follows the actual presented WebView appearance.
  // Do not overwrite it with the process-global useColorScheme() value.

  return <VStack spacing={0} frame={{ maxWidth: Infinity, maxHeight: Infinity }}
    background={{ light: "white", dark: "#242424" }} ignoresSafeArea={{ regions: "container", edges: "bottom" }}>
    {controller.phase === "idle" || controller.phase === "loading" ? <VStack spacing={6} padding={12}>
      <ProgressView /><Text font="caption">正在加载本地编辑器…</Text>
    </VStack> : null}
    {controller.error ? <Text font="caption" foregroundStyle="red" padding={8}>
      {controller.error}
    </Text> : null}
    {controller.webController ? <WebView controller={controller.webController}
      frame={{ maxWidth: Infinity, maxHeight: Infinity }}
      background={{ light: "white", dark: "#242424" }} ignoresSafeArea={{ regions: "container", edges: "bottom" }} /> : null}
  </VStack>
}
