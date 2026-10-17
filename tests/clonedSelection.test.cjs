/* Real clone page/queue/store, with in-memory FS/Storage/network/engine only. */
const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript')
const {load,mount,node,all,ui,tick}=require('./remoteFiles.test.cjs')
const {env,repo}=require('./cloneQueue.test.cjs')
const progress=load('utils/remoteProgress.ts')
const marker=load('utils/clonedGithubRepos.ts',{'./github':load('utils/github.ts')})
let groups=0
async function test(name,fn){await fn();groups++;console.log('PASS '+name)}
function page(e,repos,onRead=()=>{},search=()=>({candidates:[],total:null,changeQuery(){},selectUser(){}})){
  return load('pages/ClonePage.tsx',{'../utils/displayPaths':load('utils/displayPaths.ts'),'../services/cloneDiagnostics':{runDirectoryCheck:async()=>''},
    scripting:ui,'../components/AvatarView':{AvatarView:'AvatarView'},'../hooks/useGitHubUserSearch':{useGitHubUserSearch:search},
    '../components/FormRow':{FormRow:'FormRow'},'../components/BusyOverlay':{BusyOverlay:'BusyOverlay'},'../components/Toast':{toastContent:()=>null},'../hooks/useToast':{useToast:()=>({showToast(){}})},
    '../utils/clonedGithubRepos':marker,'../services/repoStore':{listRepos:()=>{onRead();return e.store.listRepos()},pickDirectory:async()=>null},
    '../services/gitService':{RemoteCancelToken:progress.RemoteCancelToken},'../services/cloneWorkspace':e.workspace,'../services/cloneQueue':e.queue,
    '../services/authStore':{hasToken:()=>false},'../services/notifyService':{notifySync:async()=>{},notifyError:async()=>{}},'../api/githubApi':{listOwnedRepos:typeof repos==='function'?repos:async()=>repos},
    '../utils/format':{repoNameFromUrl:url=>url.split('/').pop().replace(/\.git$/,'')},'../utils/remoteProgress':{yieldForUi:async()=>{}},
  }).ClonePage
}
async function loadUser(h){h.render();all(h.tree).find(n=>n.type==='FormRow'&&n.props.label==='用户名').props.onChanged('bob');await new Promise(resolve=>setTimeout(resolve,700));await tick()}
function row(h,name){h.render();const n=all(h.tree).find(n=>n.type==='Button'&&typeof n.props.title==='string'&&n.props.title.slice(2).startsWith(name));assert.ok(n,'row '+name);return n}
async function main(){
  await test('origin canonicalization: case, HTTPS/SSH/scp/.git/trailing slash; full owner/repo only, never display name/upstream/pending/directory',async()=>{
    const urls=[' https://GitHub.COM/BOB/Demo.git ','git@github.com:bob/demo.git','ssh://git@GITHUB.com:22/Bob/DEMO.git','https://github.com/bob/demo/','https://github.com/bob/demo.GIT/']
    for(const remoteUrl of urls)assert.deepEqual([...marker.registeredGithubRepos([{name:'unrelated alias',remoteUrl}])],['bob/demo'])
    const names=marker.registeredGithubRepos([
      {name:'demo',remoteUrl:'https://github.com/alice/demo.git'},
      {name:'demo',remoteUrl:'https://gitlab.com/bob/demo.git'},
      {name:'demo',workdir:'/cloud/Scripting/git/demo'},
      {name:'demo',pendingRemoteUrl:'https://github.com/bob/demo.git',upstreamUrl:'https://github.com/bob/demo.git'},
      {remoteUrl:'https://github.com.evil/bob/demo.git'},{remoteUrl:'https://github.com/bob/demo/tree/main'},
    ])
    assert.deepEqual([...names],['alice/demo']);assert.equal(names.has('bob/demo'),false)
  })
  await test('automatic load reads registry once after debounce; only un-cloned selected; manual/full/clear selection retains meaning',async()=>{
    const e=env();e.rows.push({name:'alias',bookmarkName:'old',remoteUrl:'git@github.com:BOB/Existing.git',workdir:'/elsewhere/alias',createdAt:0})
    let reads=0;const h=mount(page(e,[repo('bob','existing'),repo('bob','new')],()=>reads++),{onCloned(){}});await tick()
    h.render();h.render();assert.equal(reads,0)
    await loadUser(h);assert.equal(reads,1)
    assert.equal(row(h,'bob/existing').props.title,'☐ bob/existing（已克隆）');assert.equal(row(h,'bob/new').props.title,'☑ bob/new')
    assert.equal(node(h,'Button','克隆所选仓库').props.disabled,false)
    row(h,'bob/existing').props.action();assert.ok(node(h,'Button','克隆所选仓库'))
    node(h,'Button','取消全选').props.action();assert.equal(node(h,'Button','克隆所选仓库').props.disabled,true)
    node(h,'Button','全选').props.action();assert.ok(node(h,'Button','克隆所选仓库'));h.render();assert.equal(reads,1)
    h.unmount()
  })
  await test('real queue keeps safe skips; success marks immediately via registration; failures/plain directories not marked; remount derives from stored rows',async()=>{
    const e=env({clone:async url=>{if(url.endsWith('/fail.git'))throw Error('mock failure')}})
    await e.workspace.prepareCloneRoot({kind:'icloud'})
    await e.fm.createDirectory('/cloud/Scripting/git/existing',true)
    await e.store.registerRepoByPath('/cloud/Scripting/git/existing','alias','ssh://git@github.com/BOB/Existing.git','existing')
    e.rows.push({name:'shared',bookmarkName:'other-owner',remoteUrl:'https://github.com/alice/shared.git',createdAt:0})
    await e.fm.createDirectory('/cloud/Scripting/git/plain',true)
    const repos=['existing','shared','plain','good','fail'].map(n=>repo('bob',n));repos[0].private=true
    let reads=0,callbackChecks=0,h
    h=mount(page(e,repos,()=>reads++),{onCloned:r=>{callbackChecks++;assert.match(row(h,'bob/'+r.name).props.title,/已克隆/)}});await tick();await loadUser(h)
    assert.equal(row(h,'bob/existing').props.title,'☐ bob/existing（已克隆）（私有）')
    for(const name of ['shared','plain','good','fail'])assert.equal(row(h,'bob/'+name).props.title,'☑ bob/'+name)
    assert.ok(node(h,'Button','克隆所选仓库'))
    node(h,'Button','全选').props.action();global.Dialog={confirm:async()=>true}
    await node(h,'Button','克隆所选仓库').props.action()
    assert.equal(callbackChecks,2);assert.equal(e.clones.length,3)
    for(const name of ['existing','shared','good'])assert.match(row(h,'bob/'+name).props.title,/已克隆/)
    for(const name of ['plain','fail'])assert.ok(!row(h,'bob/'+name).props.title.includes('已克隆'))
    assert.equal(e.rows.length,4);assert.equal(reads,1);assert.ok(e.fm.files.has('/cloud/Scripting/git/plain'));assert.ok(e.fm.files.has('/cloud/Scripting/git/good/README.md'))
    h.unmount()
    const reopened=mount(page(e,repos,()=>reads++),{onCloned(){}});await tick();assert.equal(reads,1);await loadUser(reopened)
    for(const name of ['existing','shared','good'])assert.match(row(reopened,'bob/'+name).props.title,/^☐ .*已克隆/)
    for(const name of ['plain','fail'])assert.equal(row(reopened,'bob/'+name).props.title,'☑ bob/'+name)
    assert.ok(node(reopened,'Button','克隆所选仓库'));assert.equal(reads,2);reopened.unmount()
  })
  await test('all already cloned => zero selected and disabled batch, manual selection still enabled',async()=>{
    const e=env();e.rows.push({name:'whatever',remoteUrl:'https://github.com/BOB/a.git',bookmarkName:'a',createdAt:0})
    const h=mount(page(e,[repo('bob','a')]),{onCloned(){}});await tick();await loadUser(h)
    assert.equal(node(h,'Button','克隆所选仓库').props.disabled,true);assert.equal(row(h,'bob/a').props.disabled,false)
    row(h,'bob/a').props.action();assert.equal(node(h,'Button','克隆所选仓库').props.disabled,false);h.unmount()
  })
  await test('home dismiss xmark is white, settings dismiss xmark stays black; unrelated search xmark unchanged',async()=>{
    const root=path.join(__dirname,'..')
    for(const file of ['pages/RepoListPage.tsx','pages/SettingsPage.tsx']){
      const source=ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
      assert.equal(source.parseDiagnostics.length,0);let count=0
      const attr=(n,key)=>n.attributes.properties.find(p=>p.name?.text===key)?.initializer
      const visit=n=>{if(ts.isJsxSelfClosingElement(n)&&n.tagName.getText(source)==='Image'&&attr(n,'systemName')?.text==='xmark'){
        count++;assert.equal(attr(n,'foregroundStyle')?.text,file==='pages/RepoListPage.tsx'?'white':'black')
        let p=n.parent;while(p&&!ts.isJsxElement(p))p=p.parent
        assert.equal(p.openingElement.tagName.getText(source),'Button');assert.equal(attr(p.openingElement,'action').expression.getText(source),'dismiss')
        p=p.parent;while(p&&(!ts.isJsxElement(p)||p.openingElement.tagName.getText(source)!=='ToolbarItem'))p=p.parent
        assert.equal(attr(p.openingElement,'placement')?.text,'topBarLeading')
      }ts.forEachChild(n,visit)};visit(source);assert.equal(count,1)
    }
    const history=fs.readFileSync(path.join(root,'components/HistorySearchBar.tsx'),'utf8');assert.match(history,/systemName="xmark"[\s\S]*?foregroundStyle=\{COLOR_SECONDARY_LABEL\}/)
  })
  console.log(`\n${groups} cloned-selection/close-button groups passed; no real network, filesystem or Storage writes.`)
}
module.exports={page}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1})
