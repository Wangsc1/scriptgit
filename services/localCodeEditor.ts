import { localCodeEditorBundle } from "../vendor/local-code-editor-bundle"

/** Official APIs (checked 2026-10-17):
 * https://scriptingapp.github.io/guide/Device%20Capabilities/WebViewController.md
 * loadHTML -> Promise<boolean>; addScriptMessageHandler -> Promise<void>;
 * evaluateJavaScript MUST explicitly return its result. No native Editor is used.
 */
export type LocalCodeEditorPhase = "idle" | "loading" | "ready" | "error" | "disposed"
type Snapshot = { content: string; revision: number; composing?: boolean }
export interface LocalCodeEditorController {
  content: string
  onContentChanged?: () => void
  getContent(): Promise<string>
  dispose(): void
  /** Component lifecycle only: unmount must NOT dispose the native controller. */
  readonly phase: LocalCodeEditorPhase
  readonly error: string
  readonly webController: InstanceType<typeof WebViewController>
  start(): Promise<void>
  subscribe(listener: () => void): () => void
  attachBack(handler?: () => void | Promise<void>): () => void
  setDark(dark: boolean): void
}

/** Safe in both inline HTML script data and native evaluateJavaScript arguments. */
export function encodeLocalEditorValue(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
}
export function localCodeEditorHTML(options: {content: string; ext: string; readOnly: boolean}): string {
  // Any closing script sequence in third-party strings/comments must not end the HTML element.
  const bundle = localCodeEditorBundle.replace(/<\/script/gi, "<\\/script")
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'"><style>
html,body,#editor{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#ffffff;color-scheme:light dark}
@media(prefers-color-scheme:dark){html,body,#editor{background:#242424}}
#editor-status{padding:12px;font:14px system-ui;white-space:pre-wrap}#editor-fallback{box-sizing:border-box;width:100%;height:85%;background:inherit;color:inherit;font:14px monospace;white-space:pre-wrap}
.cm-editor{height:100%}.cm-scroller{overscroll-behavior:contain}
</style></head><body><div id="editor-status" role="status">正在初始化本地编辑器…</div><textarea id="editor-fallback" aria-label="只读原文" readonly hidden></textarea><div id="editor"></div><script>
window.__localCodeEditorConfig=${encodeLocalEditorValue(options)};
window.__localCodeEditorBootstrap={ready:false,error:""};
window.__localCodeEditorFailure=function(cause){
  var message=String(cause&&cause.message||cause||"未知错误");
  window.__localCodeEditorBootstrap.error=message;
  document.getElementById("editor-status").hidden=false;
  document.getElementById("editor-status").textContent=(window.__localCodeEditorBootstrap.ready?"编辑器运行异常（草稿仍保留）":"编辑器加载失败（只读原文，未修改文件）")+"。请使用右上角刷新重试。\\n"+message;
  // Never replace an activated editor or its draft with the initial snapshot.
  if(!window.__localCodeEditorBootstrap.ready){
    var fallback=document.getElementById("editor-fallback");fallback.value=window.__localCodeEditorConfig.content;fallback.hidden=false;
    document.getElementById("editor").hidden=true;
  }
  try{var reply=window.webkit.messageHandlers.localCodeEditorError.postMessage(message);if(reply&&reply.catch)reply.catch(function(){})}catch(_){}
};
window.addEventListener("error",function(event){window.__localCodeEditorFailure(event.error||event.message)});
window.addEventListener("unhandledrejection",function(event){window.__localCodeEditorFailure(event.reason)});
</script><script>try{${bundle}
if(!window.__localCodeEditor || !document.querySelector(".cm-content"))throw new Error("编辑器未完成初始化");
window.__localCodeEditorBootstrap.ready=true;document.getElementById("editor-status").hidden=true;
}catch(error){window.__localCodeEditorFailure(error)}</script></body></html>`
}
function timed<T>(promise: Promise<T>, label: string, milliseconds = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + "超时；草稿仍保留，请勿放弃当前页面")), milliseconds)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
function detail(error: unknown) { return error instanceof Error ? error.message : String(error) }

/** Prepare one native controller synchronously inside the parent's useMemo factory.
 * Official embedded WebView example binds a stable controller in the FIRST render:
 * https://scriptingapp.github.io/guide/Views/WebView.md
 * Loading is separate; LocalCodeEditor calls start only from WebView.onAppear.
 * No native object is constructed at module evaluation time. */
export function createLocalCodeEditorController(options: {content: string; ext: string; readOnly: boolean}): LocalCodeEditorController {
  let draft = options.content, phase: LocalCodeEditorPhase = "idle", error = ""
  const web = new WebViewController()
  let starting: Promise<void> | null = null, everActivated = false, activationVerified = false, revision = -1
  let back: (() => void | Promise<void>) | undefined, backBusy = false
  let dark: boolean | undefined
  let write: Promise<void> = Promise.resolve(), writeError: unknown = null, writing = 0
  const listeners = new Set<() => void>()
  const alive = () => phase !== "disposed"
  function publish() { if (alive()) for (const listener of listeners) listener() }
  function fail(cause: unknown) {
    if (!alive()) return
    error = detail(cause); phase = "error"; publish()
  }
  function accept(value: unknown, notify = true): Snapshot {
    if (!value || typeof value !== "object" || typeof (value as Snapshot).content !== "string" ||
      !Number.isSafeInteger((value as Snapshot).revision) || (value as Snapshot).revision < 0) {
      throw new Error("编辑器未返回有效草稿；未使用空字符串替代")
    }
    const snapshot = value as Snapshot
    if (alive() && snapshot.revision >= revision) {
      revision = snapshot.revision
      const changed = draft !== snapshot.content
      draft = snapshot.content
      if (changed && notify) controller.onContentChanged?.()
    }
    return snapshot
  }
  async function evaluate<T>(source: string): Promise<T> {
    if (!alive()) throw new Error("本地编辑器已关闭或尚未初始化")
    const value = await timed(web.evaluateJavaScript<T>(source), "读取本地编辑器")
    if (!alive()) throw new Error("本地编辑器已关闭")
    return value
  }
  const controller: LocalCodeEditorController = {
    get content() { return draft },
    set content(value: string) {
      if (!alive()) throw new Error("本地编辑器已关闭")
      if (typeof value !== "string") throw new Error("草稿必须是字符串")
      draft = value
      if (!everActivated) return
      writing++
      write = write.then(async () => {
        if (starting) await starting
        if (!activationVerified) throw new Error("编辑器未确认原文，未写入草稿；请刷新重试")
        const snapshot = await evaluate<Snapshot>(`return window.__localCodeEditor.replace(${encodeLocalEditorValue(value)})`)
        // Newer setter calls already own draft; do not overwrite them with an earlier response.
        if (writing === 1) accept(snapshot, false)
        else revision = Math.max(revision, snapshot.revision)
      }).catch(cause => { writeError = cause; fail(cause) }).finally(() => { writing-- })
    },
    onContentChanged: undefined,
    get phase() { return phase },
    get error() { return error },
    get webController() { return web },
    subscribe(listener) {
      if (!alive()) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    attachBack(handler) {
      back = handler
      return () => { if (back === handler) back = undefined }
    },
    async start() {
      if (!alive()) return
      if (starting) return starting
      // Publish only after assigning starting, so reentrant appearances/listeners
      // cannot launch a second load while handling the initial loading update.
      starting = Promise.resolve().then(async () => {
        if (!alive()) return
        try {
          phase = "loading"; publish()
          // WKWebView may give loadHTML documents an applewebdata: origin.
          // Rejecting that internal navigation can leave loadHTML pending forever.
          // Keep external requests blocked; CSP independently disallows resources.
          web.shouldAllowRequest = async request => /^(?:about:(?:blank|srcdoc)(?:[?#]|$)|applewebdata:)/i.test(request.url)
          publish()
          await timed(web.addScriptMessageHandler("localCodeEditorChange", (value: unknown) => {
            if (!alive() || writing || !activationVerified) return
            try { accept(value) } catch (cause) { fail(cause) }
          }), "连接编辑器")
          if (!alive()) return
          await timed(web.addScriptMessageHandler("localCodeEditorBack", async () => {
            if (!alive() || !back || backBusy) return
            backBusy = true
            try { await back() } catch (cause) { fail(cause) } finally { backBusy = false }
          }), "连接返回手势")
          if (!alive()) return
          await timed(web.addScriptMessageHandler("localCodeEditorError", (message: unknown) => {
            if (alive()) fail(new Error("本地编辑器异常：" + String(message)))
          }), "连接编辑器错误提示")
          if (!alive()) return
          const html = localCodeEditorHTML({content: draft, ext: options.ext, readOnly: options.readOnly})
          const loaded = await timed(web.loadHTML(html, "about:blank"), "初始化本地编辑器", 15000)
          if (!alive()) return
          if (!loaded) throw new Error("本地编辑器加载失败；初始草稿仍保留")
          // loadHTML may resolve before a delayed script/bridge becomes usable.
          // Do not activate (or accept a draft) until the actual HTML bootstrap acknowledges ready.
          await timed((async () => {
            const deadline = Date.now() + 7500
            while (alive() && Date.now() < deadline) {
              const state = await evaluate<{ ready: boolean; error: string } | null>("return window.__localCodeEditorBootstrap || null")
              if (state?.error) throw new Error("本地编辑器初始化失败：" + state.error)
              if (state?.ready) return
              await new Promise(resolve => setTimeout(resolve, 50))
            }
            throw new Error(alive() ? "编辑器未就绪，请刷新重试；原文未修改" : "本地编辑器已关闭")
          })(), "等待编辑器就绪")
          if (!alive()) return
          // Bootstrap was read-only. From here on, a failed read must never fall back to draft.
          everActivated = true
          const initialDraft = draft
          const snapshot = await evaluate<Snapshot>(`return window.__localCodeEditor.activate(${encodeLocalEditorValue(initialDraft)})`)
          if (snapshot?.content !== initialDraft) throw new Error("编辑器初始化原文不一致；未接受空白或截断内容，请刷新重试")
          // A concurrent programmatic setter owns draft, but must wait for activation
          // before replacing the browser document. Bootstrap messages are ignored.
          const latestDraft = draft
          accept(snapshot, false)
          draft = latestDraft
          activationVerified = true
          if (dark !== undefined) await evaluate(`window.__localCodeEditor.setTheme(${dark}); return true`)
          if (!alive()) return
          if (error) throw new Error(error)
          phase = "ready"; error = ""; publish()
        } catch (cause) { fail(cause) }
      })
      return starting
    },
    async getContent() {
      if (!alive()) throw new Error("本地编辑器已关闭")
      if (starting) await starting
      if (!alive()) throw new Error("本地编辑器已关闭")
      // Only safe before any document was made editable (including pre-activation failure).
      if (!everActivated) return draft
      if (!activationVerified) throw new Error(error || "编辑器未确认原文；请刷新重试，未保存空白内容")
      try {
        await write
        if (writeError) throw writeError
        const composing = await evaluate<boolean>("return window.__localCodeEditor.prepareRead()")
        if (composing) await new Promise(resolve => setTimeout(resolve, 60))
        const snapshot = await evaluate<Snapshot>("return window.__localCodeEditor.read()")
        if (snapshot?.composing) throw new Error("中文输入尚未完成，请先确认候选字再返回；未保存旧草稿")
        accept(snapshot)
        return snapshot.content
      } catch (cause) { fail(cause); throw cause }
    },
    setDark(value) {
      dark = value
      if (everActivated && alive()) void evaluate(`window.__localCodeEditor.setTheme(${value}); return true`).catch(fail)
    },
    dispose() {
      if (!alive()) return
      phase = "disposed"; back = undefined; controller.onContentChanged = undefined; listeners.clear()
      web.dispose()
    },
  }
  return controller
}
