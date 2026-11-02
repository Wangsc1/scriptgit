"""Offline Chromium regression tests, not a substitute for iPhone WKWebView/IME testing.
Run with Playwright Python installed and NODE_PATH pointing to esbuild's parent directory.
"""
import pathlib
import subprocess
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]

def html(ext="tsx", content="const 中文: number = 1\n", readonly=False):
    return subprocess.check_output([
        "node", "tests/localCodeEditor.test.cjs", "--html-stdin", ext, "unused",
        "true" if readonly else "false",
    ], input=content, cwd=ROOT, text=True)

BOOT = """window.events=[];window.backs=0;window.errors=[];window.webkit={messageHandlers:{
localCodeEditorError:{postMessage:v=>{errors.push(v);return Promise.resolve()}},
localCodeEditorChange:{postMessage:v=>{events.push(v);return Promise.resolve()}},
localCodeEditorBack:{postMessage:()=>{backs++;return Promise.resolve()}}
}}"""

def open_editor(page, ext, content, readonly=False):
    page.set_content(html(ext, content, readonly).replace("<script>", "<script>" + BOOT + ";", 1))
    page.wait_for_function("() => !!window.__localCodeEditor")
    page.evaluate("content => window.__localCodeEditor.activate(content)", content)

def read(page):
    return page.evaluate("window.__localCodeEditor.read()")

def swipe(page, x=12, dx=100, dy=3, multi=False):
    page.evaluate("""({x,dx,dy,multi})=>{
      const touch=(a,b,id=1)=>({clientX:a,clientY:b,identifier:id});
      const send=(type,touches,changedTouches=touches)=>{const e=new Event(type,{bubbles:true});
        Object.defineProperties(e,{touches:{value:touches},changedTouches:{value:changedTouches}});document.dispatchEvent(e)};
      const start=[touch(x,100)];if(multi)start.push(touch(x+10,110,2));
      send('touchstart',start);send('touchmove',[touch(x+dx,100+dy)]);
      send('touchend',[],[touch(x+dx,100+dy)]);
    }""", dict(x=x, dx=dx, dy=dy, multi=multi))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width":390,"height":700}, is_mobile=True, has_touch=True)
    # iPhone WKWebView uses the standard contenteditable composition event path.
    page.evaluate("window.EditContext = undefined")
    requests=[]
    page.on("request", lambda request: requests.append(request.url))
    page.route("**/*", lambda route: route.abort())
    samples={"js":"const value = true", "ts":"const value: number = 1", "jsx":"const node = <div>text</div>",
             "tsx":"const node: JSX.Element = <div>text</div>", "json":'{"value":true}',
             "css":"body { color: red; }", "html":"<div class='x'>text</div>", "md":"# Heading\n**bold**", "txt":"plain text 中文"}
    for ext, content in samples.items():
        open_editor(page, ext, content)
        assert read(page)["content"] == content, ext
        assert page.locator(".cm-lineNumbers .cm-gutterElement").count() >= 1
        if ext != "txt":
            page.wait_for_function("!!document.querySelector('.cm-line span[class]')")
        assert page.locator("button, .cm-panels, .cm-tooltip").count() == 0
    print("PASS nine language modes, line numbers, no menu/buttons or network resources")

    payload='</script><script>window.PWN=1</script>\u2028\u2029中文 & <b>'
    open_editor(page, "txt", payload)
    assert read(page)["content"] == payload
    assert page.evaluate("window.PWN") is None
    page.locator(".cm-content").click()
    page.keyboard.press("ControlOrMeta+End")
    page.keyboard.insert_text("输入中文")
    page.wait_for_function("window.__localCodeEditor.read().content.endsWith('输入中文')")
    page.keyboard.press("ControlOrMeta+z")
    page.wait_for_function("!window.__localCodeEditor.read().content.endsWith('输入中文')")
    page.keyboard.press("ControlOrMeta+Shift+z")
    page.wait_for_function("window.__localCodeEditor.read().content.endsWith('输入中文')")
    page.keyboard.press("Shift+ArrowLeft")
    assert page.evaluate("window.getSelection().toString()") == "文"
    before=page.evaluate("backs");swipe(page);assert page.evaluate("backs") == before
    page.keyboard.press("ArrowRight")
    assert page.evaluate("events.length") > 0
    print("PASS injection fidelity, Chinese text input, selection, undo/redo, bridge events")

    open_editor(page,"ts","const x = 1\n")
    for args in [dict(x=50),dict(dx=79),dict(dy=100),dict(multi=True),dict(dx=-100)]:
        swipe(page,**args)
    assert page.evaluate("backs") == 0
    swipe(page);assert page.evaluate("backs") == 1
    page.locator(".cm-content").click()
    page.dispatch_event(".cm-content","compositionstart",{"data":"中"})
    assert read(page)["composing"] is True
    swipe(page);assert page.evaluate("backs") == 1
    page.dispatch_event(".cm-content","compositionend",{"data":"中"})
    print("PASS left-edge-only single-finger horizontal threshold; selection/multitouch/IME excluded")

    open_editor(page,"txt","不能编辑",True)
    assert page.locator(".cm-content").get_attribute("contenteditable") == "false"
    assert read(page)["content"] == "不能编辑"
    print("PASS read-only document")

    open_editor(page,"js","const x = '" + "long"*100 + "'\n" + "const row = 1\n"*150)
    whitespace=page.locator(".cm-content").evaluate("e=>getComputedStyle(e).whiteSpace")
    assert whitespace in ("pre-wrap", "break-spaces"), whitespace
    assert page.locator(".cm-line").first.evaluate("e=>e.getBoundingClientRect().height") > 30
    scroller=page.locator(".cm-scroller")
    assert scroller.evaluate("e=>e.scrollHeight > e.clientHeight")
    scroller.evaluate("e=>{e.scrollTop=500}")
    assert scroller.evaluate("e=>e.scrollTop") > 0
    for scheme,expected in [("dark","rgb(36, 36, 36)"),("light","rgb(255, 255, 255)")]:
        page.emulate_media(color_scheme=scheme)
        page.wait_for_function("expected=>getComputedStyle(document.querySelector('.cm-editor')).backgroundColor===expected", arg=expected)
        for selector in ["html","body",".cm-editor",".cm-content",".cm-gutters"]:
            actual=page.locator(selector).evaluate("e=>getComputedStyle(e).backgroundColor")
            assert actual==expected,(scheme,selector,actual)
    assert requests == [], requests
    print("PASS soft wrapping, scrolling, dark #242424 / light white backgrounds and zero requests")
    # Exercise the shipped bundle, not a CodeMirror mock, with actual nonempty JSON.
    for content in ['{"标题":"中文😀","special":"<tag>&"}\r\n', '', '{"icons":"' + '图标a'*50000 + '"}']:
        open_editor(page, "json", content)
        assert read(page)["content"] == content
        assert page.locator(".cm-content").is_visible()
        assert page.locator(".cm-editor").bounding_box()["height"] > 500
        assert page.locator("#editor-status").is_hidden()
        if content:
            assert page.locator(".cm-line").first.inner_text()
    print("PASS nonempty JSON/Chinese/CRLF, empty file and 350KiB single-line JSON visibly render; original text unchanged")

    content='{"original":"不可丢失</script>中文"}'
    # Force a real synchronous bundle dependency failure: old HTML had a blank #editor.
    broken=html("json",content).replace("<script>","<script>"+BOOT+";window.__originalMatchMedia=window.matchMedia;window.matchMedia=()=>{throw Error('forced bootstrap failure')};",1)
    page.set_content(broken)
    assert page.locator("#editor-fallback").is_visible()
    assert page.locator("#editor-fallback").input_value()==content
    assert page.locator("#editor-fallback").get_attribute("readonly") is not None
    assert "forced bootstrap failure" in page.locator("#editor-status").inner_text()
    assert page.evaluate("window.__localCodeEditorBootstrap.ready") is False
    assert page.evaluate("errors[0]")=="forced bootstrap failure"
    # Syntax failure is not caught by try/catch in that script; the earlier error listener still catches it.
    page.set_content(html("json",content).replace("<script>try{","<script>var = ;try{",1))
    assert page.locator("#editor-fallback").input_value()==content
    assert page.locator("#editor-status").is_visible()
    print("PASS actual bundle startup exception AND syntax exception show exact read-only original plus explicit recovery error")

    page.evaluate("window.matchMedia=window.__originalMatchMedia")
    delayed=html("json",content).replace("<script>try{","<script>setTimeout(function(){try{",1).replace("</script></body>","},150);</script></body>",1)
    page.set_content(delayed)
    assert page.locator("#editor-status").is_visible()
    assert page.evaluate("window.__localCodeEditorBootstrap.ready") is False
    page.wait_for_function("() => window.__localCodeEditorBootstrap.ready")
    assert read(page)["content"]==content
    assert page.locator("#editor-status").is_hidden()
    print("PASS delayed real bundle remains visibly loading then becomes ready without empty activation")
    assert requests == []
    browser.close()
