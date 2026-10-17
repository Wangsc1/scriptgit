/* Run: NODE_PATH=<directory containing esbuild> node tests/localCodeEditor.test.cjs */
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
function load(file, mocks = {}) {
  const code = esbuild.transformSync(fs.readFileSync(path.join(root,file),'utf8'), {loader:file.endsWith('tsx')?'tsx':'ts',format:'cjs',target:'es2020',jsxFactory:'__jsx'}).code
  const module = {exports:{}}
  new Function('require','module','exports',code)(name => {if (name in mocks) return mocks[name]; throw Error('Unmocked '+name)}, module, module.exports)
  return module.exports
}
const bundle = load('vendor/local-code-editor-bundle.ts')
const service = load('services/localCodeEditor.ts', {'../vendor/local-code-editor-bundle':bundle})
if (process.argv[2] === '--html') {
  process.stdout.write(service.localCodeEditorHTML({content:process.argv[4] ?? 'const 中文 = 1\n', ext:process.argv[3] || 'tsx', readOnly:process.argv[5] === 'true'}))
} else {
  const tick = () => new Promise(r=>setImmediate(r))
  const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
  let mode = {}, instances = []
  global.WebViewController = class {
    constructor(){this.handlers={};this.text='';this.revision=0;this.calls=[];instances.push(this)}
    async addScriptMessageHandler(name,handler){this.handlers[name]=handler;if(mode.handlerWait)await mode.handlerWait.promise}
    async loadHTML(html,baseURL){this.html=html;this.baseURL=baseURL;if(this.shouldAllowRequest && !await this.shouldAllowRequest({url:'applewebdata://internal/editor'}))throw Error('WKWebView internal navigation blocked'); if(mode.loadWait)await mode.loadWait.promise; if(mode.loadError)throw Error('load failed');return mode.loaded!==false}
    async evaluateJavaScript(code){
      this.calls.push(code)
      if(mode.evalError)throw Error('read failed')
      if(code.includes('.activate(')){this.text=JSON.parse(code.match(/activate\((.*)\)$/s)[1]);return {content:this.text,revision:this.revision}}
      if(code.includes('.replace(')){this.text=JSON.parse(code.match(/replace\((.*)\)$/s)[1]);return {content:this.text,revision:++this.revision}}
      if(code.includes('.prepareRead('))return !!mode.composing
      if(code.includes('.read('))return mode.invalid ? null : {content:this.text,revision:this.revision,composing:!!mode.composing}
      return true
    }
    dispose(){this.disposed=true}
  }
  async function test(name,fn){mode={};await fn();console.log('PASS '+name)}
  async function main(){
    await test('safe HTML encoding; no remote script/resources or floating native Editor',async()=>{
      const payload='</script><script>window.PWN=1</script>\u2028\u2029中文 & <b>'
      const html=service.localCodeEditorHTML({content:payload,ext:'tsx',readOnly:false})
      assert.ok(!html.includes(payload));assert.equal((html.match(/<script>/g)||[]).length,2)
      assert.match(html,/connect-src 'none'/);assert.doesNotMatch(html,/<script[^>]+src=/i)
      assert.equal(JSON.parse(service.encodeLocalEditorValue(payload)),payload)
    })
    await test('synchronous factory, visible lifecycle, pre-ready draft',async()=>{
      const count=instances.length,c=service.createLocalCodeEditorController({content:'草稿',ext:'ts',readOnly:false})
      assert.equal(instances.length,count);assert.equal(c.phase,'idle');assert.equal(await c.getContent(),'草稿')
      let events=0;const off=c.subscribe(()=>events++);await c.start();assert.equal(c.phase,'ready');assert.ok(events>=3)
      assert.equal(await c.getContent(),'草稿');assert.equal(await c.webController.shouldAllowRequest({url:'https://example.com'}),false)
      assert.equal(await c.webController.shouldAllowRequest({url:'about:blank'}),true)
      assert.equal(await c.webController.shouldAllowRequest({url:'applewebdata://internal/editor'}),true)
      assert.equal(c.webController.baseURL,'about:blank')
      for(const url of ['http://example.com','file:///etc/passwd','javascript:alert(1)','about:blank.evil'])assert.equal(await c.webController.shouldAllowRequest({url}),false)
      off();c.dispose();assert.equal(c.phase,'disposed');await assert.rejects(c.getContent(),/关闭/)
    })
    await test('getContent directly reads newest browser draft even without bridge; stale messages rejected',async()=>{
      const c=service.createLocalCodeEditorController({content:'初始',ext:'json',readOnly:false});await c.start();const w=c.webController
      let changes=0;c.onContentChanged=()=>changes++
      w.text='最后一个汉字';w.revision=5
      assert.equal(c.content,'初始');assert.equal(await c.getContent(),'最后一个汉字');assert.equal(c.content,w.text);assert.equal(changes,1)
      w.handlers.localCodeEditorChange({content:'旧消息',revision:2});assert.equal(c.content,w.text)
      w.handlers.localCodeEditorChange({content:'桥接草稿',revision:6});assert.equal(c.content,'桥接草稿');assert.equal(changes,2)
      c.dispose()
    })
    await test('load failure preserves initial draft; ready read failure/invalid result/IME must throw',async()=>{
      mode.loaded=false;const c=service.createLocalCodeEditorController({content:'不可丢',ext:'txt',readOnly:false});await c.start()
      assert.equal(c.phase,'error');assert.equal(await c.getContent(),'不可丢');c.dispose()
      mode={};const d=service.createLocalCodeEditorController({content:'保留',ext:'txt',readOnly:false});await d.start()
      mode.evalError=true;await assert.rejects(d.getContent(),/read failed/);assert.equal(d.content,'保留')
      mode={invalid:true};await assert.rejects(d.getContent(),/有效草稿/);assert.equal(d.content,'保留')
      mode={composing:true};await assert.rejects(d.getContent(),/中文输入/);assert.equal(d.content,'保留');d.dispose()
    })
    await test('pre-ready setter, serialized programmatic changes and initialization wait',async()=>{
      mode.loadWait=deferred();const c=service.createLocalCodeEditorController({content:'a',ext:'txt',readOnly:false})
      const start=c.start();await tick();c.content='b';let done=false;const read=c.getContent().then(v=>{done=true;return v});await tick();assert.equal(done,false)
      mode.loadWait.resolve();await start;assert.equal(await read,'b')
      c.content='c';c.content='d';assert.equal(await c.getContent(),'d');assert.equal(c.content,'d');c.dispose()
    })
    await test('back callback bridge detach and dispose ignore late async completions',async()=>{
      const c=service.createLocalCodeEditorController({content:'keep',ext:'ts',readOnly:false});await c.start();const w=c.webController
      let backs=0;const off=c.attachBack(async()=>backs++);await w.handlers.localCodeEditorBack();assert.equal(backs,1)
      off();await w.handlers.localCodeEditorBack();assert.equal(backs,1)
      c.dispose();w.handlers.localCodeEditorChange({content:'late',revision:99});assert.equal(c.content,'keep');assert.equal(w.disposed,true)
      mode.handlerWait=deferred();const d=service.createLocalCodeEditorController({content:'pending',ext:'md',readOnly:false});const p=d.start();const native=d.webController;d.dispose();mode.handlerWait.resolve();await p
      assert.equal(d.phase,'disposed');assert.equal(native.html,undefined)
    })
    await test('component fills space; unmount/remount retains WebView/controller and detaches callbacks',async()=>{
      let active
      global.__jsx=(type,props,...children)=>({type,props:props||{},children:children.flat().filter(Boolean)})
      const ui={VStack:'VStack',Text:'Text',ProgressView:'ProgressView',WebView:'WebView',useColorScheme:()=> 'dark',
        useState:initial=>{const h=active,i=h.cursor++;if(!(i in h.slots))h.slots[i]=initial;return [h.slots[i],v=>{assert.ok(!h.unmounted,'no late React update');h.slots[i]=typeof v==='function'?v(h.slots[i]):v}]},
        useEffect:(fn,deps)=>{const h=active,i=h.cursor++;if(!(i in h.slots)){h.slots[i]=deps;h.effects.push(fn)}}}
      const {LocalCodeEditor}=load('components/LocalCodeEditor.tsx',{scripting:ui})
      const c=service.createLocalCodeEditorController({content:'persistent',ext:'tsx',readOnly:false})
      function mount(){const h={cursor:0,slots:[],effects:[],cleanups:[],render(){active=h;h.cursor=0;h.tree=LocalCodeEditor({controller:c,onBack:()=>{}});h.effects.splice(0).forEach(f=>{const cleanup=f();if(cleanup)h.cleanups.push(cleanup)});return h.tree},unmount(){h.unmounted=true;h.cleanups.forEach(f=>f())}};h.render();return h}
      const first=mount();assert.equal(first.tree.children[0].children[0].type,'ProgressView');await c.start();first.render()
      const w=c.webController;first.unmount();w.text='unmounted latest';w.revision=2;w.handlers.localCodeEditorChange({content:w.text,revision:2})
      const second=mount();assert.equal(c.webController,w);assert.equal(c.content,'unmounted latest');assert.equal(w.disposed,undefined)
      assert.deepEqual(second.tree.props.background,{light:'white',dark:'#242424'});assert.equal(second.tree.props.frame.maxHeight,Infinity)
      assert.ok(second.tree.children.some(n=>n.type==='WebView'));assert.equal(second.tree.children.some(n=>n.type==='Editor'),false)
      second.unmount();c.dispose();assert.equal(w.disposed,true)
    })
    console.log('PASS all local editor controller/component tests')
  }
  main().catch(e=>{console.error(e);process.exitCode=1})
}
