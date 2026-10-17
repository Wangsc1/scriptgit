/* Pure in-memory mocks: never clones or writes a real repository. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {load,mount,node,text,all,ui,tick,deferred,http} = require('./remoteFiles.test.cjs')
const progress = load('utils/remoteProgress.ts')
const {RemoteCancelToken,isRemoteOperationCancelled} = progress
let groups=0
async function test(name,fn) { await fn(); console.log('PASS '+name); groups++ }
const rawRepo=(owner,name,priv=false)=>({name,full_name:owner+'/'+name,owner:{login:owner},clone_url:`https://github.com/${owner}/${name}.git`,private:priv,default_branch:'main'})
const repo=(owner,name)=>({name,fullName:owner+'/'+name,url:`https://github.com/${owner}/${name}.git`,defaultBranch:'main',private:false})
const req=(owner,name)=>({name,url:`https://github.com/${owner}/${name}.git`,githubRepo:repo(owner,name)})
function fakeFM() {
  const files=new Map([['/cloud/Scripting','dir'],['/local','dir'],['/group','dir'],['/external','dir']])
  const removed=[], created=[], renamed=[], bookmarks=new Map()
  let cloud=true, unavailable=false, denied=false, bookmarkAttempts=0
  const fm={
    documentsDirectory:'/local',appGroupDocumentsDirectory:'/group',
    get isiCloudEnabled(){return cloud},set isiCloudEnabled(v){cloud=v},
    get iCloudDocumentsDirectory(){if(unavailable)throw new Error('container offline');return '/cloud/Scripting'},
    setUnavailable(v){unavailable=v},setDenied(v){denied=v},
    exists:async p=>files.has(p),
    isLink:async p=>files.get(p)==='link',isDirectory:async p=>files.get(p)==='dir',
    createDirectory:async(p,recursive)=>{if(denied)throw new Error('permission denied');if(files.has(p)){if(!recursive)throw new Error('already exists');return}if(!recursive&&!files.has(path.posix.dirname(p)))throw new Error('missing parent');created.push(p);const parts=p.split('/').filter(Boolean);let dir='';for(const part of parts){dir+='/'+part;if(!files.has(dir))files.set(dir,'dir')}},
    readDirectory:async p=>{if(denied)throw new Error('permission denied');if(files.get(p)!=='dir')throw new Error('not a directory');const base=p.replace(/\/$/,'')+'/';return Array.from(files.keys()).filter(x=>x.startsWith(base)&&x!==base&&!x.slice(base.length).includes('/')).map(x=>x.slice(base.length))},
    rename:async(a,b)=>{if(files.has(b))throw new Error('destination exists');renamed.push([a,b]);for(const [p,v] of Array.from(files)){if(p===a||p.startsWith(a+'/')){files.delete(p);files.set(b+p.slice(a.length),v)}}},
    remove:async p=>{removed.push(p);for(const x of Array.from(files.keys()))if(x===p||x.startsWith(p+'/'))files.delete(x)},
    bookmarkExists:n=>bookmarks.has(n),bookmarkedPath:n=>bookmarks.get(n)||null,
    addFileBookmark:(p,n)=>{bookmarkAttempts++;bookmarks.set(n,p);return n},removeFileBookmark:n=>bookmarks.delete(n),
    get bookmarkAttempts(){return bookmarkAttempts},files,removed,created,renamed,bookmarks,
  }
  global.FileManager=fm
  return fm
}
function env(overrides={}) {
  const fm=fakeFM(), rows=[]
  const workspace=load('services/cloneWorkspace.ts')
  const store=load('services/repoStore.ts',{
    './cloneWorkspace':workspace,
    './storage':{readRepos:()=>rows,writeRepos:v=>{rows.splice(0,rows.length,...v)},readSnapshots:()=>({}),writeSnapshots:()=>{}},
  })
  let seq=0
  const storeDependency={...store,createRepoId:()=>`r${++seq}`}
  const clones=[]
  const git={RemoteCancelToken,isRemoteOperationCancelled,clone:overrides.cloneImplementation || (async(url,dir,id,_ref,_depth,options)=>{
    clones.push({url,dir,id,options});await fm.createDirectory('/group/git-repos/'+id,true)
    fm.files.set(dir+'/README.md','downloaded')
    await options.onProgress?.({label:'下载对象 50%',percent:50})
    await overrides.clone?.(url,dir,id,options,fm)
  })}
  const api={getRepo:async fullName=>({fullName,fork:false})}
  const queue=load('services/cloneQueue.ts',{'../api/githubApi':{...api,...overrides.api},'./gitService':git,'./repoStore':{...storeDependency,...overrides.store},'./cloneWorkspace':workspace})
  return {fm,rows,workspace,store,queue,git,clones}
}
async function main(){
  await test('own private repositories: all pages use authenticated owner endpoint',async()=>{
    const api=load('api/githubApi.ts',{'../services/authStore':{getToken:()=> 'mock-token'},'../utils/lru':{setLruEntry(){}}})
    const calls=http((url)=>{
      if(url.endsWith('/user'))return {data:{login:'alice'}}
      assert.ok(url.includes('/user/repos?affiliation=owner&visibility=all'))
      return {data:url.endsWith('page=1')?Array.from({length:100},(_,i)=>rawRepo('alice','repo'+i,i===0)):[rawRepo('alice','private-end',true)]}
    })
    const repos=await api.listOwnedRepos('ALIce');assert.equal(repos.length,101);assert.equal(repos.filter(r=>r.private).length,2);assert.equal(calls.length,3)
    assert.ok(calls.every(x=>x.options.method==='GET'))
  })
  await test('other user public pages plus accessible private repos are merged, filtered and deduplicated',async()=>{
    const api=load('api/githubApi.ts',{'../services/authStore':{getToken:()=> 'mock-token'},'../utils/lru':{setLruEntry(){}}})
    const calls=http(url=>{
      if(url.endsWith('/user'))return {data:{login:'alice'}}
      if(url.includes('/users/bob/repos'))return {data:url.endsWith('page=1')?Array.from({length:100},(_,i)=>rawRepo('bob','pub'+i)):[rawRepo('bob','last')]}
      if(url.includes('/user/repos'))return {data:[rawRepo('bob','pub0'),rawRepo('bob','secret',true),rawRepo('unrelated','hidden',true)]}
      throw new Error('unexpected '+url)
    })
    const repos=await api.listOwnedRepos('bob');assert.equal(repos.length,102);assert.ok(repos.some(r=>r.fullName==='bob/secret'&&r.private));assert.ok(repos.every(r=>r.fullName.startsWith('bob/')));assert.equal(calls.length,4)
  })
  await test('failed later pagination rejects instead of exposing a partial all-repositories list',async()=>{
    const api=load('api/githubApi.ts',{'../services/authStore':{getToken:()=> 'mock-token'},'../utils/lru':{setLruEntry(){}}})
    http(url=>url.endsWith('/user')?{data:{login:'alice'}}:url.endsWith('page=1')?{data:Array.from({length:100},(_,i)=>rawRepo('alice','r'+i))}:{status:403,data:{message:'rate limited'}})
    await assert.rejects(api.listOwnedRepos('alice'),/403/)
    await assert.rejects(api.listOwnedRepos('../bad'),/用户名/)
  })
  await test('iCloud default is container/git, auto-created without any bookmark or local fallback',async()=>{
    const e=env();assert.equal(await e.workspace.prepareCloneRoot({kind:'icloud'}),'/cloud/Scripting/git');assert.ok(e.fm.files.has('/cloud/Scripting/git'));assert.equal(e.fm.bookmarkAttempts,0);assert.ok(!e.fm.files.has('/local/git'))
    const registered=await e.store.registerRepoByPath('/cloud/Scripting/git/a','a','https://github.com/o/a.git','a')
    assert.equal(registered.accessBookmarkName,undefined);assert.equal(e.store.resolveWorkdir('a'),'/cloud/Scripting/git/a');assert.equal(e.fm.bookmarkAttempts,0)
    const local=await e.store.registerRepoByPath('/local/git/b','b',undefined,'b');assert.equal(local.accessBookmarkName,undefined);assert.equal(e.store.resolveWorkdir('b'),'/local/git/b');assert.equal(e.fm.bookmarkAttempts,0)
  })
  await test('iCloud disabled/offline or permission failure is explicit; never falls back to local',async()=>{
    for(const mode of ['disabled','offline','denied']){
      const e=env();if(mode==='disabled')e.fm.isiCloudEnabled=false;if(mode==='offline')e.fm.setUnavailable(true);if(mode==='denied')e.fm.setDenied(true)
      await assert.rejects(e.workspace.prepareCloneRoot({kind:'icloud'}),/iCloud|权限/);assert.ok(!e.fm.created.includes('/local/git'));assert.equal(e.fm.bookmarkAttempts,0)
    }
  })
  await test('external parent bookmark is activated and registration retains git/repo relative path across relocation',async()=>{
    const e=env();e.fm.bookmarks.set('parent','/external')
    const destination={kind:'external',parentPath:'/old',accessBookmarkName:'parent'}
    assert.equal(await e.workspace.prepareCloneRoot(destination),'/external/git')
    const results=await e.queue.runCloneQueue([req('bob','a')],destination,{cancelToken:new RemoteCancelToken()})
    assert.equal(results[0].status,'cloned');assert.equal(e.rows[0].accessBookmarkName,'parent');assert.equal(e.rows[0].workdirRelative,'git/a')
    e.fm.bookmarks.set('parent','/moved');assert.equal(e.store.resolveWorkdir(e.rows[0].bookmarkName),'/moved/git/a')
    e.fm.bookmarks.delete('parent');assert.throws(()=>e.workspace.cloneRoot(destination),/授权已失效/)
  })
  await test('temporary external selection without a bookmark is usable rather than falsely blocked',async()=>{
    const e=env();assert.equal(await e.workspace.prepareCloneRoot({kind:'external',parentPath:'/external',accessBookmarkName:null}),'/external/git')
  })
  await test('batch sequential success, per-item progress, parent registration and repeat run skips without duplicates',async()=>{
    const e=env(),seen=[],registered=[]
    const requests=[req('bob','a'),req('bob','b')]
    const result=await e.queue.runCloneQueue(requests,{kind:'icloud'},{cancelToken:new RemoteCancelToken(),onProgress:(i,total,name,detail)=>seen.push([i,total,name,detail]),onRegistered:r=>registered.push(r)})
    assert.deepEqual(result.map(r=>r.status),['cloned','cloned']);assert.equal(e.rows.length,2);assert.equal(registered.length,2);assert.ok(seen.some(x=>x[0]===2&&x[3].includes('50%')))
    assert.ok(e.clones.every(c=>c.dir.includes('/.scriptgit-clone-')));assert.ok(e.fm.files.has('/cloud/Scripting/git/a/README.md'));assert.equal(e.fm.bookmarkAttempts,0)
    const rerun=await e.queue.runCloneQueue(requests,{kind:'icloud'},{cancelToken:new RemoteCancelToken()});assert.deepEqual(rerun.map(r=>r.status),['skipped','skipped']);assert.equal(e.rows.length,2);assert.equal(e.clones.length,2)
  })
  await test('partial failure continues and removes only owned staging/gitdir; existing nonempty/empty/file/link targets are untouched',async()=>{
    const e=env({clone:async url=>{if(url.endsWith('/bad.git'))throw new Error('network error')}})
    await e.workspace.prepareCloneRoot({kind:'icloud'})
    for(const [name,type] of [['existing','dir'],['empty','dir'],['file','precious'],['link','link']])e.fm.files.set('/cloud/Scripting/git/'+name,type)
    e.fm.files.set('/cloud/Scripting/git/existing/user.txt','precious')
    const requests=['existing','empty','file','link','bad','good'].map(n=>req('bob',n))
    const result=await e.queue.runCloneQueue(requests,{kind:'icloud'},{cancelToken:new RemoteCancelToken()})
    assert.deepEqual(result.map(r=>r.status),['skipped','skipped','skipped','skipped','failed','cloned']);assert.equal(e.rows.length,1)
    assert.equal(e.fm.files.get('/cloud/Scripting/git/existing/user.txt'),'precious')
    assert.ok(e.fm.removed.every(p=>p.includes('/.scriptgit-clone-')||p.startsWith('/group/git-repos/')))
    assert.ok(!e.fm.files.has('/cloud/Scripting/git/bad'));assert.ok(![...e.fm.files.keys()].some(p=>p.includes('.scriptgit-clone-')))
  })
  await test('same-name case-insensitive collision and traversal names never overwrite',async()=>{
    const e=env();const requests=[req('bob','Demo'),req('other','demo'),req('bob','../escape')]
    const result=await e.queue.runCloneQueue(requests,{kind:'icloud'},{cancelToken:new RemoteCancelToken()})
    assert.deepEqual(result.map(r=>r.status),['cloned','skipped','failed']);assert.equal(e.clones.length,1);assert.equal(e.rows.length,1)
  })
  await test('cancelling in-flight item cleans its stage and marks remaining items cancelled, preserving completed ones',async()=>{
    const token=new RemoteCancelToken();const e=env({clone:async(url,_dir,_id,options)=>{if(url.endsWith('/b.git')){token.cancel();options.cancelToken.throwIfCancelled()}}})
    const result=await e.queue.runCloneQueue(['a','b','c'].map(n=>req('bob',n)),{kind:'icloud'},{cancelToken:token})
    assert.deepEqual(result.map(r=>r.status),['cloned','cancelled','cancelled']);assert.equal(e.rows.length,1);assert.equal(e.clones.length,2);assert.ok(e.fm.files.has('/cloud/Scripting/git/a/README.md'));assert.ok(!e.fm.files.has('/cloud/Scripting/git/b'));assert.ok(!e.fm.files.has('/cloud/Scripting/git/c'))
  })
  await test('cancellation before queue performs no clone; root file/symlink and denied path cannot trigger cleanup',async()=>{
    const e=env();const token=new RemoteCancelToken();token.cancel();const result=await e.queue.runCloneQueue([req('bob','a')],{kind:'icloud'},{cancelToken:token});assert.equal(result[0].status,'cancelled');assert.equal(e.clones.length,0)
    e.fm.files.set('/cloud/Scripting/git','link');await assert.rejects(e.queue.runCloneQueue([req('bob','a')],{kind:'icloud'},{cancelToken:new RemoteCancelToken()}),/普通文件夹/);assert.equal(e.fm.removed.length,0)
  })
  await test('target created during clone is preserved; failed registration after publish leaves files intact',async()=>{
    const e=env({clone:async(_url,_dir,_id,_opts,fm)=>{fm.files.set('/cloud/Scripting/git/a','dir');fm.files.set('/cloud/Scripting/git/a/important','precious')}})
    const result=await e.queue.runCloneQueue([req('bob','a')],{kind:'icloud'},{cancelToken:new RemoteCancelToken()});assert.equal(result[0].status,'failed');assert.equal(e.fm.files.get('/cloud/Scripting/git/a/important'),'precious');assert.ok(!e.fm.removed.includes('/cloud/Scripting/git/a'))
    const f=env({store:{registerRepoByPath:async()=>{throw new Error('storage failure')}}})
    const failed=await f.queue.runCloneQueue([req('bob','a')],{kind:'icloud'},{cancelToken:new RemoteCancelToken()});assert.match(failed[0].message,/注册失败/);assert.ok(f.fm.files.has('/cloud/Scripting/git/a/README.md'));assert.equal(f.fm.removed.length,0)
  })
  await test('same root concurrent queue is rejected; duplicate ID never cleans someone else staging or gitdir',async()=>{
    const wait=deferred();const e=env({clone:async()=>wait.promise})
    const pending=e.queue.runCloneQueue([req('bob','a')],{kind:'icloud'},{cancelToken:new RemoteCancelToken()});await tick()
    await assert.rejects(e.queue.runCloneQueue([req('bob','b')],{kind:'icloud'},{cancelToken:new RemoteCancelToken()}),/已有克隆任务/)
    wait.resolve();await pending
    const f=env({store:{createRepoId:()=> 'duplicate'}});f.fm.files.set('/group/git-repos/duplicate','dir');f.fm.files.set('/group/git-repos/duplicate/user','precious')
    const result=await f.queue.runCloneQueue([req('bob','a')],{kind:'icloud'},{cancelToken:new RemoteCancelToken()});assert.equal(result[0].status,'failed');assert.equal(f.fm.removed.length,0);assert.equal(f.fm.files.get('/group/git-repos/duplicate/user'),'precious')
  })
  await test('fork clone retains upstream behavior',async()=>{
    const e=env({api:{getRepo:async()=>({fork:true,parent:{url:'https://github.com/source/a.git'}})}})
    const result=await e.queue.runCloneQueue([req('bob','a')],{kind:'icloud'},{cancelToken:new RemoteCancelToken()});assert.equal(result[0].status,'cloned');assert.deepEqual(e.clones[0].options.upstream,{url:'https://github.com/source/a.git'})
  })

  function page(e,api={},queue=e.queue){
    const useToast=load('hooks/useToast.ts',{scripting:ui}).useToast
    return load('pages/ClonePage.tsx',{
      scripting:ui,'../components/AvatarView':{AvatarView:'AvatarView'},'../hooks/useGitHubUserSearch':load('hooks/useGitHubUserSearch.ts',{scripting:ui,'../api/githubApi':{searchGitHubUsers:async()=>({items:[],total:0,hasMore:false,limited:false,incomplete:false})}}),'../components/FormRow':{FormRow:'FormRow'},'../components/BusyOverlay':{BusyOverlay:'BusyOverlay'},'../components/Toast':{toastContent:message=>global.__jsx('Text',{},message)},'../hooks/useToast':{useToast},
      '../services/repoStore':{pickDirectory:async()=>({path:'/external',accessBookmarkName:null})},'../services/gitService':{RemoteCancelToken},'../services/cloneWorkspace':e.workspace,'../services/cloneQueue':queue,
      '../services/authStore':{hasToken:()=>true},'../services/notifyService':{notifySync:async()=>{},notifyError:async()=>{}},
      '../api/githubApi':{listMyRepos:async()=>[],listOwnedRepos:async()=>[repo('bob','a'),repo('bob','b')],...api},'../utils/format':{repoNameFromUrl:url=>url.split('/').pop().replace(/\.git$/,'')},'../utils/remoteProgress':{yieldForUi:async()=>{}},
    }).ClonePage
  }
  function form(h,label){h.render();const found=all(h.tree).find(n=>n.type==='FormRow'&&n.props.label===label);assert.ok(found);return found}
  await test('UI defaults all selected; unselect/select, count+directory confirmation, per-item results and keep-open registration',async()=>{
    const e=env(),registered=[];const h=mount(page(e),{onCloned:(r,keepOpen)=>registered.push([r,keepOpen])});await tick()
    form(h,'用户名').props.onChanged('bob');await node(h,'Button','加载全部仓库').props.action()
    assert.match(text(h),/已选\s+2\s+个/);await node(h,'Button','取消全选').props.action();assert.equal(node(h,'Button','批量克隆所选 0 个仓库').props.disabled,true)
    await node(h,'Button','全选').props.action();await node(h,'Button','☑ bob/a').props.action();assert.match(text(h),/已选\s+1\s+个/)
    let confirmation;global.Dialog={confirm:async options=>{confirmation=options;return false}}
    await node(h,'Button','批量克隆所选 1 个仓库').props.action();assert.equal(e.clones.length,0);assert.match(confirmation.title,/1/);assert.match(confirmation.message,/\/cloud\/Scripting\/git/)
    global.Dialog.confirm=async()=>true;await node(h,'Button','批量克隆所选 1 个仓库').props.action()
    assert.equal(e.rows.length,1);assert.equal(registered[0][1],true);assert.match(text(h),/成功 1/);assert.match(text(h),/bob\/b/)
    await node(h,'Button','更改目录').props.action();assert.ok(e.fm.files.has('/external/git'));assert.ok(!text(h).includes('/external/git'));h.unmount()
  })
  await test('UI single clone uses same default without directory picker and keeps original completion callback behavior',async()=>{
    const e=env(),registered=[];const h=mount(page(e),{onCloned:(...args)=>registered.push(args)});await tick()
    form(h,'Git URL').props.onChanged('https://github.com/bob/single.git');await node(h,'Button','克隆').props.action()
    assert.ok(e.fm.files.has('/cloud/Scripting/git/single/README.md'));assert.equal(registered.length,1);assert.equal(registered[0].length,1);h.unmount()
  })
  await test('UI pagination loading error never enables batch; iCloud unavailable is visible and single cloning errors, not local fallback',async()=>{
    const e=env();e.fm.isiCloudEnabled=false
    const wait=deferred();const h=mount(page(e,{listOwnedRepos:()=>wait.promise}),{onCloned:()=>{}});await tick();assert.match(text(h),/iCloud 未启用/)
    form(h,'Git URL').props.onChanged('https://github.com/bob/a.git');await node(h,'Button','克隆').props.action();assert.equal(e.clones.length,0);h.render();assert.match(h.tree.props.toast.content.children.join(''),/iCloud/)
    form(h,'用户名').props.onChanged('bob');const pending=node(h,'Button','加载全部仓库').props.action();assert.equal(node(h,'Button','正在分页加载全部仓库…').props.disabled,true)
    wait.reject(new Error('page 2 failed'));await pending;assert.match(text(h),/加载失败，未开始克隆/);assert.ok(!all(h.tree).some(n=>n.type==='Button'&&String(n.props.title).startsWith('批量克隆所选')));h.unmount()
  })
  await test('UI cancellation is wired to active queue; batch stops and results remain visible',async()=>{
    const wait=deferred();const e=env({clone:async(_url,_dir,_id,options)=>{await wait.promise;options.cancelToken.throwIfCancelled()}})
    const h=mount(page(e),{onCloned:()=>{}});await tick();form(h,'用户名').props.onChanged('bob');await node(h,'Button','加载全部仓库').props.action();global.Dialog={confirm:async()=>true}
    const pending=node(h,'Button','批量克隆所选 2 个仓库').props.action();await tick();h.render();assert.equal(h.tree.props.navigationBarBackButtonHidden,true)
    node(h,'BusyOverlay').props.onCancel();assert.equal(node(h,'BusyOverlay').props.cancelling,true);wait.resolve();await pending;assert.match(text(h),/取消 2/);assert.equal(e.rows.length,0);h.unmount()
  })
  await test('rename keeps original storage/keychain/merge keys and all visible release names are scriptgit',async()=>{
    const root=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8')
    assert.match(read('services/storage.ts'),/const PREFIX = "gitgit\."/)
    assert.match(read('constants/auth.ts'),/KC_TOKEN_KEY = "isomorphic_git_token"/);assert.match(read('constants/auth.ts'),/KC_USERNAME_KEY = "isomorphic_git_username"/)
    assert.match(read('services/git/mergeConflictService.ts'),/gitgit-merge-state\.json/)
    assert.match(read('pages/RepoListPage.tsx'),/navigationTitle="scriptgit"/)
    for(const f of ['script.json','README.md','pages/SettingsPage.tsx','pages/GitHubFileEditor.tsx','services/notifyService.ts','widget.tsx','polyfills.ts','services/gitCore.ts'])assert.ok(!read(f).includes('scripgit'),f)
  })
  console.log(`\n${groups} clone test groups passed; filesystem, network and clone engine are in-memory mocks.`)
}
module.exports = { env, fakeFM, rawRepo, repo, req }
if (require.main === module) main().catch(e=>{console.error(e);process.exitCode=1})
