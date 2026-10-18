/* Node mock tests: no Scripting/iOS installation or network writes. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
let count = 0
async function test(name, fn) { await fn(); console.log('PASS ' + name); count++ }
function load(relative, mocks = {}) {
  const filename = path.join(root, relative)
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React, jsxFactory: '__jsx', jsxFragmentFactory: '__fragment',
  }, fileName: filename, reportDiagnostics: true })
  const mod = { exports: {} }
  const req = (name) => {
    if (Object.hasOwn(mocks, name)) return mocks[name]
    throw new Error('Unmocked dependency: ' + name)
  }
  new Function('require', 'module', 'exports', result.outputText)(req, mod, mod.exports)
  return mod.exports
}
class MockData {
  constructor(bytes) { this.bytes = Buffer.from(bytes) }
  get size() { return this.bytes.length }
  toBase64String() { return this.bytes.toString('base64') }
  toRawString() { try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.bytes) } catch { return null } }
  static fromRawString(text) { return new MockData(Buffer.from(text, 'utf8')) }
  static fromBase64String(text) { return new MockData(Buffer.from(text, 'base64')) }
}
global.Data = MockData
const { GitHubFileSession } = load('services/githubFileSession.ts')
let token = 'mock-token-not-a-real-secret'
const api = load('api/githubApi.ts', {
  '../services/authStore': { getToken: () => token },
  '../utils/lru': { setLruEntry() {} },
})
function http(handler) {
  const calls = []
  global.fetch = async (url, options) => {
    calls.push({ url, options })
    const response = await handler(url, options, calls.length)
    const status = response.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => response.data }
  }
  return calls
}
const content = (text, extra = {}) => ({ type: 'file', sha: 'original-sha', size: Buffer.byteLength(text), encoding: 'base64', content: Buffer.from(text).toString('base64'), ...extra })
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }

// Tiny hook/virtual-node harness; emulates only documented interfaces used by these pages.
global.__fragment = 'Fragment'
global.__jsx = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x !== null && x !== false && x !== undefined) })
let active
const ui = new Proxy({}, { get(_, name) {
  if (name === 'useColorScheme') return () => 'light'
  if (name === 'MagnifyGesture') return minScaleDelta => ({ kind: 'magnify', minScaleDelta,
    onChanged(fn) { this.changed = fn; return this }, onEnded(fn) { this.ended = fn; return this } })
  if (name === 'DragGesture') return options => ({ onEnded: onEnded => ({ kind: 'drag', options, onEnded }) })
  if (name === 'useObservable') return (initial) => {
    const h = active, i = h.cursor++
    if (!(i in h.slots)) {
      const listeners = new Set()
      let value = typeof initial === 'function' ? initial() : initial
      h.slots[i] = { get value() { return value }, set value(next) { const old=value;value=next;if(next!==old)listeners.forEach(fn=>fn(next,old)) },
        setValue(next) { this.value=next }, subscribe(fn) { listeners.add(fn) }, unsubscribe(fn) { listeners.delete(fn) } }
    }
    return h.slots[i]
  }
  if (name === 'useState') return (initial) => {
    const h = active, i = h.cursor++
    if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial
    return [h.slots[i], (value) => { if (h.unmounted) h.lateWrites++; h.slots[i] = typeof value === 'function' ? value(h.slots[i]) : value }]
  }
  if (name === 'useRef') return (initial) => {
    const h = active, i = h.cursor++; return h.slots[i] || (h.slots[i] = { current: initial })
  }
  if (name === 'useMemo') return (factory, deps) => {
    const h = active, i = h.cursor++, previous = h.slots[i]
    if (!previous || !deps || !previous.deps || deps.some((value, index) => !Object.is(value, previous.deps[index]))) h.slots[i] = { value: factory(), deps }
    return h.slots[i].value
  }
  if (name === 'useEffect') return (effect, deps) => {
    const h = active, i = h.cursor++, previous = h.slots[i]
    if (!previous || (h.effectUpdates && (!deps || !previous.deps || deps.some((value, index) => !Object.is(value, previous.deps[index]))))) {
      const slot = { deps, cleanup: previous?.cleanup }; h.slots[i] = slot
      h.effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() })
    }
  }
  return String(name)
}})
// Legacy tests explicitly simulate refreshes; opt in to dependency effects for scheduling tests.
function mount(Component, props, { effectUpdates = false } = {}) {
  const h = { effectUpdates, slots: [], cursor: 0, effects: [], cleanups: [], lateWrites: 0, unmounted: false,
    render() { active=h; h.cursor=0; h.tree=Component(props); active=null; h.effects.splice(0).forEach(f=>f()); return h.tree },
    unmount() { h.unmounted=true; h.cleanups.forEach(f=>f()); h.slots.forEach(slot=>slot?.cleanup?.()) },
  }
  h.render(); return h
}
function all(tree) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(all)
  return [...(tree.type ? [tree] : []), ...Object.values(tree).flatMap(all)]
}
function node(h, type, title) { h.render(); const found = all(h.tree).find(n => n.type === type && (title === undefined || n.props.title === title)); assert.ok(found, `${type} ${title} exists`); return found }
function text(h) { h.render(); const walk = x => typeof x === 'object' ? (x.children || []).map(walk).join(' ') : String(x); return walk(h.tree) }
const tick = () => new Promise(resolve => setImmediate(resolve))

async function main() {
  await test('branch pagination, auth and encoded repository', async () => {
    const calls = http((url, options, n) => ({ data: n === 1 ? Array.from({length:100}, (_,i)=>({name:'b'+i})) : [{name:'feature/中文'}] }))
    const branches = await api.listRepoBranches('owner/a b') .catch(e => e)
    assert.ok(branches instanceof Error)
    assert.equal(calls.length, 0)
    const names = await api.listRepoBranches('owner/repo')
    assert.equal(names.length, 101); assert.equal(names[100], 'feature/中文')
    assert.match(calls[1].url, /page=2$/)
    assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + token)
    assert.equal(calls[0].options.headers['X-GitHub-Api-Version'], '2022-11-28')
  })
  await test('directory sorting, segment encoding and explicit ref', async () => {
    const calls = http(() => ({data:[{name:'z',path:'z',type:'file',sha:'s'}, {name:'a',path:'a',type:'dir',sha:'d'}]}))
    const entries = await api.listRepoContents('owner/repo', 'feat/a #中', 'dir/a #中')
    assert.equal(entries[0].type, 'dir')
    assert.ok(calls[0].url.endsWith('/contents/dir/a%20%23%E4%B8%AD?ref=feat%2Fa%20%23%E4%B8%AD'))
    await assert.rejects(api.listRepoContents('owner/repo','main','../bad'), /路径无效/)
  })
  await test('UTF-8 unicode, empty file, BOM and CRLF roundtrip', async () => {
    for (const value of ['', '中文😀\r\nline\r\n', '\ufefftext\n']) {
      http(() => ({data:content(value)}))
      const file = await api.loadRepoTextFile('owner/repo','main','a.txt')
      assert.equal(file.text,value); assert.equal(file.sha,'original-sha'); assert.equal(file.readOnlyReason,undefined)
    }
  })
  await test('binary, invalid UTF-8, oversized, unsupported encoding, symlink and submodule are read-only', async () => {
    const cases = [content('a\0b'),content('',{content:'/w==',size:1}),content('x',{size:api.REMOTE_TEXT_LIMIT+1}),content('x',{encoding:'none'}),content('x',{type:'symlink',target:'a'}),content('x',{submodule_git_url:'https://github.com/a/b'})]
    for (const data of cases) { http(()=>({data})); const file=await api.loadRepoTextFile('o/r','main','a'); assert.equal(file.text,null); assert.ok(file.readOnlyReason) }
  })
  await test('PUT includes original SHA, branch, message and lossless Base64', async () => {
    const calls = http(() => ({data:{content:{sha:'new-sha'}}}))
    assert.equal(await api.saveRepoTextFile('o/r',{path:'a #/中.md',branch:'feat/x',sha:'old-sha',text:'中文😀\r\n',message:' update '}),'new-sha')
    const request=calls[0]; assert.equal(request.options.method,'PUT')
    assert.ok(request.url.endsWith('/contents/a%20%23/%E4%B8%AD.md'))
    const body=JSON.parse(request.options.body)
    assert.deepEqual(body,{message:'update',content:Buffer.from('中文😀\r\n').toString('base64'),branch:'feat/x',sha:'old-sha'})
    await assert.rejects(api.saveRepoTextFile('o/r',{path:'a',branch:'main',sha:'',text:'x',message:'x'}),/原 SHA/)
    await assert.rejects(api.saveRepoTextFile('o/r',{path:'a',branch:'main',sha:'s',text:'x'.repeat(api.REMOTE_TEXT_LIMIT+1),message:'x'}),/上限/)
    assert.equal(calls.length,1)
  })
  await test('409/422 conflict never auto-retries; 403/404/500 and missing token remain errors', async () => {
    for (const status of [409,422,403,404,500]) {
      const calls=http(()=>({status,data:{message:'remote changed'}}))
      await assert.rejects(api.saveRepoTextFile('o/r',{path:'a',branch:'main',sha:'s',text:'x',message:'m'}), status===409||status===422 ? /草稿已保留/ : new RegExp('HTTP '+status))
      assert.equal(calls.length,1)
    }
    const calls=http(()=>({data:{}})); token=null
    await assert.rejects(api.listRepoBranches('o/r'),/Token/); assert.equal(calls.length,0); token='mock-token-not-a-real-secret'
  })
  await test('network failure and malformed save response do not claim success', async () => {
    http(()=>{throw new Error('offline')})
    await assert.rejects(api.saveRepoTextFile('o/r',{path:'a',branch:'b',sha:'s',text:'x',message:'m'}),/offline/)
    http(()=>({data:{}}))
    await assert.rejects(api.saveRepoTextFile('o/r',{path:'a',branch:'b',sha:'s',text:'x',message:'m'}),/SHA/)
  })
  await test('session preserves dirty draft and original SHA after failure, advances SHA only on success', async () => {
    const s=new GitHubFileSession({path:'a',sha:'s1',text:'old'},'feature/a'); const inputs=[]
    await assert.rejects(s.save('draft','m',async input=>{inputs.push(input);throw new Error('conflict')}),/conflict/)
    assert.ok(s.isDirty('draft')); assert.equal(s.saving,false)
    await s.save('draft','m',async input=>{inputs.push(input);return 's2'})
    assert.equal(inputs[1].sha,'s1'); assert.equal(inputs[1].branch,'feature/a'); assert.equal(s.isDirty('draft'),false)
    await s.save('new draft','m',async input=>{assert.equal(input.sha,'s2');return 's3'})
    await assert.rejects(s.save('new draft','m',async()=>''),/没有修改/)
  })
  await test('session validates message/read-only and blocks overlapping save', async () => {
    const s=new GitHubFileSession({path:'a',sha:'s',text:'old'},'main'); const wait=deferred()
    await assert.rejects(s.save('new',' ',async()=>''),/消息/)
    const pending=s.save('new','m',()=>wait.promise)
    await assert.rejects(s.save('other','m',async()=>''),/重复提交/)
    wait.resolve('s2'); await pending; assert.ok(s.isDirty('other'))
    const ro=new GitHubFileSession({path:'a',sha:'s',text:null,readOnlyReason:'binary'},'main')
    await assert.rejects(ro.save('x','m',async()=>''),/binary/)
  })

  const controllers=[]
  global.EditorController=class {
    constructor(options) { Object.assign(this,options); controllers.push(this) }
    dispose() { this.disposed=true }
  }
  let confirmed=false, confirms=0
  global.Dialog={confirm:async()=>{confirms++;return confirmed}}
  const editorModule=(save)=>load('pages/GitHubFileEditor.tsx',{
    scripting:ui,'../api/githubApi':{saveRepoTextFile:save},'../services/githubFileSession':{GitHubFileSession},
  })
  await test('editor close reads latest controller content, cancel protects draft, discard closes, cleanup disposes', async () => {
    let closed=0; const {GitHubFileEditor}=editorModule(async()=> 's2')
    const h=mount(GitHubFileEditor,{fullName:'o/r',branch:'main',file:{path:'a.ts',sha:'s',text:'old'},onClose:()=>closed++})
    const controller=controllers.at(-1); controller.content='typed just now' // no delayed onContentChanged notification
    const before=confirms; confirmed=false; await node(h,'Button','关闭').props.action()
    assert.equal(confirms,before+1); assert.equal(closed,0); assert.equal(controller.content,'typed just now')
    confirmed=true; await node(h,'Button','关闭').props.action(); assert.equal(closed,1)
    h.unmount(); assert.ok(controller.disposed)
  })
  await test('editor save failure retains text/message; success keeps newly typed text dirty; closing blocked during save', async () => {
    const wait=deferred(); let calls=0, closed=0
    const {GitHubFileEditor}=editorModule(async(_,input)=>{calls++; if(calls===1) throw new Error('409 conflict'); return wait.promise})
    const h=mount(GitHubFileEditor,{fullName:'o/r',branch:'feat/x',file:{path:'a',sha:'s',text:'old'},onClose:()=>closed++})
    controllers.at(-1).content='draft'
    node(h,'TextField','提交消息').props.onChanged('commit it')
    await node(h,'Button','提交保存').props.action()
    assert.match(text(h),/409 conflict/); assert.equal(controllers.at(-1).content,'draft'); assert.equal(node(h,'TextField','提交消息').props.value,'commit it')
    const saving=node(h,'Button','提交保存').props.action()
    assert.equal(node(h,'Button','关闭').props.disabled,true)
    await node(h,'Button','关闭').props.action(); assert.equal(closed,0)
    controllers.at(-1).content='newer typing'; wait.resolve('s2'); await saving
    assert.match(text(h),/仍有新的未保存修改/)
    confirmed=false; await node(h,'Button','关闭').props.action(); assert.equal(closed,0)
    h.unmount()
  })
  await test('read-only editor has no save control', async () => {
    const {GitHubFileEditor}=editorModule(async()=>{throw new Error('must not save')})
    const h=mount(GitHubFileEditor,{fullName:'o/r',branch:'main',file:{path:'a.png',sha:'s',text:null,readOnlyReason:'binary'},onClose:()=>{}})
    assert.ok(controllers.at(-1).readOnly); assert.equal(all(h.tree).filter(n=>n.type==='Button' && n.props.title==='提交保存').length,0); assert.match(text(h),/binary/); h.unmount()
  })
  function browser(mock) { return load('pages/GitHubFilesPage.tsx',{scripting:ui,'../api/githubApi':mock,'../utils/format':load('utils/format.ts'),'../constants/colors':load('constants/colors.ts'),'./GitHubFileEditor':{GitHubFileEditor:'FileEditor'}}).GitHubFilesPage }
  function entryButton(h, name) {
    h.render()
    const found=all(h.tree).find(n=>n.type==='Button'&&all(n.children).some(t=>t.type==='Text'&&t.children.includes(name)))
    assert.ok(found, `file row ${name} exists`);return found
  }
  function browserApi(overrides={}) { return {
    getRepo:async name=>({fullName:name,defaultBranch:'main'}),listRepoBranches:async()=>['main','feature/a'],
    listRepoContents:async(_r,_b,p)=> p ? [{name:'a.txt',path:p+'/a.txt',type:'file',sha:'s'}] : [{name:'docs',path:'docs',type:'dir',sha:'d'}],
    loadRepoTextFile:async(_r,_b,p)=>({path:p,sha:'s',text:'hello'}),listMyRepos:async()=>[],...overrides,
  } }
  await test('browser loads default branch, switches branch, navigates directory and opens full-screen editor', async () => {
    const reads=[]; const mock=browserApi({listRepoContents:async(r,b,p='')=>{reads.push([r,b,p]);return p ? [{name:'a.txt',path:p+'/a.txt',type:'file',sha:'s'}] : [{name:'docs',path:'docs',type:'dir',sha:'d'}]}})
    const h=mount(browser(mock),{fullName:'o/r'}); await tick()
    assert.deepEqual(reads[0],['o/r','main',''])
    await node(h,'Picker','分支').props.onChanged('feature/a'); await tick()
    assert.deepEqual(reads.at(-1),['o/r','feature/a',''])
    await entryButton(h,'docs').props.action(); assert.deepEqual(reads.at(-1),['o/r','feature/a','docs'])
    await entryButton(h,'a.txt').props.action()
    h.render(); const cover=h.tree.props.fullScreenCover; assert.equal(cover.isPresented,true); assert.equal(cover.content.props.branch,'feature/a')
    cover.onChanged(false); h.render(); assert.equal(h.tree.props.fullScreenCover.isPresented,true)
    cover.content.props.onClose(); h.render(); assert.equal(h.tree.props.fullScreenCover.isPresented,false)
    await node(h,'Button','上一级目录').props.action(); assert.equal(reads.at(-1)[2],''); h.unmount()
  })
  await test('browser loading/error/retry and symlink read-only path', async () => {
    let fail=true, loads=0
    const h=mount(browser(browserApi({listRepoContents:async()=>{if(fail)throw new Error('offline');return [{name:'link',path:'link',type:'symlink',sha:'l'}]},loadRepoTextFile:async()=>{loads++;throw new Error('must not follow symlink')}})),{fullName:'o/r'})
    assert.match(text(h),/加载中/); await tick(); assert.match(text(h),/offline/)
    fail=false; await node(h,'Button','刷新目录 / 重试').props.action(); await entryButton(h,'link').props.action()
    h.render(); assert.equal(loads,0); assert.match(h.tree.props.fullScreenCover.content.props.file.readOnlyReason,/只读/); h.unmount()
  })
  await test('browser ignores response after unmount and blocks duplicate requests', async () => {
    const wait=deferred(); let calls=0
    const h=mount(browser(browserApi({getRepo:async name=>{calls++;await wait.promise;return {fullName:name,defaultBranch:'main'}}})),{fullName:'o/r'})
    await node(h,'Button','打开仓库').props.action(); assert.equal(calls,1)
    h.unmount(); wait.resolve(); await tick(); assert.equal(h.lateWrites,0)
  })
  await test('all project TypeScript/TSX parses without syntax diagnostics', async () => {
    let files=0
    function walk(dir) { for(const item of fs.readdirSync(dir,{withFileTypes:true})) {
      if(item.name==='vendor' || item.name==='.git')continue
      const p=path.join(dir,item.name)
      if(item.isDirectory())walk(p)
      else if(/\.(ts|tsx)$/.test(p) && !p.endsWith('.d.ts')) {
        const source=ts.createSourceFile(p,fs.readFileSync(p,'utf8'),ts.ScriptTarget.Latest,true,p.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)
        assert.equal(source.parseDiagnostics.length,0,`${p}: ${source.parseDiagnostics.map(x=>ts.flattenDiagnosticMessageText(x.messageText,' '))}`); files++
      }
    }}
    walk(root); console.log(`  parsed ${files} TS/TSX files (syntax only)`)
  })
  await test('metadata identity, release name, import URL, bundle paths and notification launch targets', async () => {
    const meta=JSON.parse(fs.readFileSync(path.join(root,'script.json'),'utf8'))
    assert.equal(meta.name,'scriptgit'); assert.match(meta.version,/^\d+\.\d+(?:\.\d+)?$/); assert.deepEqual(meta.author,{email:null,homepage:'https://github.com/Wangsc1',name:'Wangsc1'})
    assert.equal(meta.remoteResource.url,'https://github.com/Wangsc1/scriptgit');assert.deepEqual(meta.contributors,[]);assert.equal(meta.color,'rgba(0, 0, 0, 1)');assert.equal(meta.iconImage,'https://raw.githubusercontent.com/Wangsc1/scriptgit/main/icon-white.png');assert.ok(fs.existsSync(path.join(root,'icon-white.png')))
    const read=f=>fs.readFileSync(path.join(root,f),'utf8')
    assert.ok(read('README.md').includes('https://scripting.fun/import_scripts?urls=["https%3A%2F%2Fgithub.com%2FWangsc1%2Fscriptgit"]'))
    assert.ok(read('polyfills.ts').includes('/scriptgit/vendor/buffer-bundle.js')); assert.ok(read('services/gitCore.ts').includes('/scriptgit/vendor/index.umd.min.js'))
    assert.ok(!read('services/notifyService.ts').includes('scriptName: "gitgit"'))
    assert.ok(!read('pages/RepoListPage.tsx').includes('GitHubFilesPage'))
    assert.ok(read('components/RepoDetailDestination.tsx').includes('githubWorkKind === 3'))
  })
  console.log(`\n${count} test groups passed; all GitHub writes mocked; no iOS device validation.`)
}
module.exports = { load, mount, node, text, all, ui, tick, deferred, http, MockData }
if (require.main === module) main().catch(e=>{console.error(e);process.exitCode=1})
