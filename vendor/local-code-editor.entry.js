// Source for local-code-editor-bundle.ts. MIT; dependency licenses beside it.
import {EditorState, Compartment} from '@codemirror/state'
import {EditorView, lineNumbers, highlightActiveLine, drawSelection, keymap} from '@codemirror/view'
import {history, historyKeymap, defaultKeymap, indentWithTab} from '@codemirror/commands'
import {syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput} from '@codemirror/language'
import {javascript} from '@codemirror/lang-javascript'
import {json} from '@codemirror/lang-json'
import {css} from '@codemirror/lang-css'
import {html} from '@codemirror/lang-html'
import {markdown} from '@codemirror/lang-markdown'
import {oneDark} from '@codemirror/theme-one-dark'

const config = window.__localCodeEditorConfig
let revision = 0, original = config.content, changed = false
const editable = new Compartment(), theme = new Compartment()
const light = EditorView.theme({
  '&': {color: '#24292f'},
  '&, .cm-scroller, .cm-content, .cm-gutters, .cm-gutterElement': {backgroundColor: '#ffffff'},
  '.cm-gutters': {backgroundColor: '#ffffff', color: '#57606a', border: 'none'},
  '.cm-activeLine': {backgroundColor: '#eff2f6'},
  '.cm-cursor': {borderLeftColor: '#24292f'},
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {background: '#b6d7ff'},
})
const dark = [EditorView.theme({
  '&, .cm-scroller, .cm-content, .cm-gutters, .cm-gutterElement': {backgroundColor: '#242424'},
  '.cm-gutters': {border: 'none'},
}, {dark: true}), oneDark]
function language(ext) {
  switch (ext.toLowerCase().replace(/^\./, '')) {
    case 'js': return javascript()
    case 'jsx': return javascript({jsx: true})
    case 'ts': return javascript({typescript: true})
    case 'tsx': return javascript({typescript: true, jsx: true})
    case 'json': return json()
    case 'css': return css()
    case 'html': return html()
    case 'md': return markdown()
    default: return []
  }
}
function snapshot() {return {content: changed ? view.state.sliceDoc() : original, revision, composing: view.compositionStarted}}
function send(name, value) {
  try {
    const result = window.webkit?.messageHandlers?.[name]?.postMessage(value)
    if (result?.catch) result.catch(() => {})
  } catch (_) { /* Detached bridges must not interrupt editing. */ }
}
const media = window.matchMedia('(prefers-color-scheme: dark)')
const view = new EditorView({
  parent: document.getElementById('editor'),
  state: EditorState.create({
    doc: config.content,
    extensions: [
      // Non-editable until native initialization explicitly activates the document.
      editable.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
      EditorState.lineSeparator.of(config.content.includes('\r\n') ? '\r\n' : '\n'),
      lineNumbers(), highlightActiveLine(), drawSelection(),
      history(), keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      indentOnInput(), bracketMatching(), syntaxHighlighting(defaultHighlightStyle, {fallback: true}),
      language(config.ext), EditorView.lineWrapping, theme.of(media.matches ? dark : light),
      EditorView.theme({
        '&': {height: '100%', fontSize: '14px'},
        '.cm-scroller': {overflow: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', WebkitOverflowScrolling: 'touch'},
        '.cm-content': {minHeight: '100%', paddingBottom: '90px'},
        '&.cm-focused': {outline: 'none'},
      }),
      EditorView.contentAttributes.of({autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': '本地代码编辑器'}),
      EditorView.updateListener.of(update => {
        if (update.docChanged) {changed = true; revision++; send('localCodeEditorChange', snapshot())}
      }),
    ],
  }),
})
function setTheme(isDark) {
  document.documentElement.style.backgroundColor = isDark ? '#242424' : '#ffffff'
  document.body.style.backgroundColor = isDark ? '#242424' : '#ffffff'
  document.getElementById('editor').style.backgroundColor = isDark ? '#242424' : '#ffffff'
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light'
  view.dispatch({effects: theme.reconfigure(isDark ? dark : light)})
}
setTheme(media.matches)
if (media.addEventListener) media.addEventListener('change', event => setTheme(event.matches))
else if (media.addListener) media.addListener(event => setTheme(event.matches))
window.__localCodeEditor = {
  activate(content) {
    if (view.state.sliceDoc() !== content) {
      view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: content}})
      original = content; changed = false
    }
    view.dispatch({effects: editable.reconfigure([EditorState.readOnly.of(config.readOnly), EditorView.editable.of(!config.readOnly)])})
    return snapshot()
  },
  read: snapshot,
  prepareRead() {if (view.compositionStarted) view.contentDOM.blur(); return view.compositionStarted},
  replace(content) {
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: content}})
    return snapshot()
  },
  setTheme,
}
// Only one-finger gestures starting in the left edge; never steal ordinary text drags.
let gesture = null
const selected = () => !view.state.selection.main.empty || !(window.getSelection()?.isCollapsed ?? true)
document.addEventListener('touchstart', event => {
  gesture = null
  if (event.touches.length !== 1 || view.compositionStarted || selected()) return
  const touch = event.touches[0]
  if (touch.clientX <= 24) gesture = {x: touch.clientX, y: touch.clientY, id: touch.identifier}
}, {passive: true})
document.addEventListener('touchmove', event => {
  if (!gesture) return
  if (event.touches.length !== 1 || event.touches[0].identifier !== gesture.id || view.compositionStarted || selected()) {gesture = null; return}
  const dx = event.touches[0].clientX - gesture.x, dy = event.touches[0].clientY - gesture.y
  if (dx < -10 || Math.abs(dy) > 40 && Math.abs(dy) > dx / 1.5) gesture = null
}, {passive: true})
document.addEventListener('touchend', event => {
  const start = gesture; gesture = null
  if (!start || event.touches.length || view.compositionStarted || selected()) return
  const touch = Array.from(event.changedTouches).find(t => t.identifier === start.id)
  if (!touch) return
  const dx = touch.clientX - start.x, dy = touch.clientY - start.y
  if (dx >= 80 && dx > Math.abs(dy) * 1.5) send('localCodeEditorBack', null)
}, {passive: true})
document.addEventListener('touchcancel', () => {gesture = null}, {passive: true})
// No floating controls, network requests, or file operations.
