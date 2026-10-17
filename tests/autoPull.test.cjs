/* Real bundled Git fixtures; fetch/HTTP boundary mocked, no user repos/network. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {load,mount,ui,tick,deferred}=require('./remoteFiles.test.cjs')
global.self=globalThis;const git=require('../vendor/index.umd.min.js'),root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-autopull-'))
global.FileManager={scriptsDirectory:tmp,appGroupDocumentsDirectory:tmp,exists:async p=>fs.existsSync(p)}
const transport=load('services/gitCore.ts',{'../polyfills':{}}).createHttpTransport,progress=load('utils/remoteProgress.ts'),remote=load('utils/remote.ts')
let auth=null,ctx,meta,fetchImpl,fetchCalls=[]
const wrapper=new Proxy(git,{get:(t,key)=>key==='fetch'?async options=>{fetchCalls.push(options);return fetchImpl(options)}:t[key]})
const runtime={resolveGitdir:()=>ctx.gitdir,getCtx:async()=>ctx},store={findRepo:()=>meta,listRepos:()=>[meta],getGitdirPath:()=>ctx.gitdir}
const core=load('services/git/autoPullService.ts',{'../gitCore':{createHttpTransport:transport},'../authStore':{getAuth:()=>auth},'../repoStore':store,'./runtime':runtime,'../../utils/remote':remote,'../../utils/remoteProgress':progress})
const {StatusCoordinator}=load('utils/statusCoordinator.ts'),coordinator=new StatusCoordinator({})
const scan=load('services/git/statusScanService.ts',{'../../utils/statusFreshness':{isRepoStatusFresh:()=>false},'./matrixScanService':{statusCoordinator:coordinator},'./runtime':runtime})
const facadeMocks={};for(const m of fs.readFileSync(root+'/services/gitService.ts','utf8').matchAll(/from "([^"]+)"/g))facadeMocks[m[1]]={}
facadeMocks['./git/autoPullService']=core;facadeMocks['./git/statusScanService']=scan
const facade=load('services/gitService.ts',facadeMocks),author={name:'Fixture',email:'fixture@example.invalid'};let groups=0,seq=0
async function test(name,fn){await fn();groups++;console.log('PASS '+name)}
async function fixture(){
 const dir=tmp+'/'+ ++seq;fs.mkdirSync(dir);ctx={git:wrapper,fs,dir,gitdir:dir+'/.git'};meta={name:'fixture',bookmarkName:'repo',source:'clone'};auth=null;fetchCalls=[]
 await git.init({fs,dir,defaultBranch:'local-topic'});fs.writeFileSync(dir+'/a.txt','base');await git.add({fs,dir,filepath:'a.txt'});const base=await git.commit({fs,dir,author,message:'base'})
 fs.writeFileSync(dir+'/a.txt','remote');await git.add({fs,dir,filepath:'a.txt'});const target=await git.commit({fs,dir,author,message:'remote'})
 await git.writeRef({fs,dir,ref:'refs/heads/local-topic',value:base,force:true});await git.checkout({fs,dir,ref:'local-topic',force:true})
 await git.addRemote({fs,dir,remote:'company',url:'https://example.invalid/repo.git'});await git.setConfig({fs,dir,path:'branch.local-topic.remote',value:'company'});await git.setConfig({fs,dir,path:'branch.local-topic.merge',value:'refs/heads/server-topic'})
 fetchImpl=async o=>{assert.equal(o.remote,'company');assert.equal(o.ref,'server-topic');await git.writeRef({fs,dir,ref:'refs/remotes/company/server-topic',value:target,force:true});return {fetchHead:target}}
 return {dir,base,target,head:()=>git.resolveRef({fs,dir,ref:'HEAD'})}
}
async function main(){
 await test('real fast-forward follows custom upstream, named HEAD/index/worktree correct, no merge commit or identity config',async()=>{
  const f=await fixture();assert.equal((await facade.autoPullFastForward('repo')).status,'updated');assert.equal(await f.head(),f.target);assert.equal(fs.readFileSync(f.dir+'/a.txt','utf8'),'remote');assert.equal(await git.currentBranch({fs,dir:f.dir}),'local-topic');assert.deepEqual((await git.statusMatrix({fs,dir:f.dir})).map(r=>r.slice(1)),[[1,1,1]]);assert.equal(await git.getConfig({fs,dir:f.dir,path:'user.name'}),undefined);assert.equal((await git.readCommit({fs,dir:f.dir,oid:f.target})).commit.parent.length,1)
 })
 await test('divergence skips preserving ref/index/worktree and commit count; local ahead unchanged',async()=>{
  const f=await fixture();fs.writeFileSync(f.dir+'/a.txt','local');await git.add({fs,dir:f.dir,filepath:'a.txt'});const local=await git.commit({fs,dir:f.dir,author,message:'local'}),index=fs.readFileSync(ctx.gitdir+'/index')
  assert.equal((await facade.autoPullFastForward('repo')).status,'skipped');assert.equal(await f.head(),local);assert.equal(fs.readFileSync(f.dir+'/a.txt','utf8'),'local');assert.deepEqual(fs.readFileSync(ctx.gitdir+'/index'),index);assert.equal((await git.log({fs,dir:f.dir})).length,2)
  fetchImpl=async()=>{await git.writeRef({fs,dir:f.dir,ref:'refs/remotes/company/server-topic',value:f.base,force:true});return {fetchHead:f.base}};assert.equal((await facade.autoPullFastForward('repo')).status,'unchanged')
 })
 await test('dirty/staged/untracked/ignored-untracked/merge/rebase/detached/missing-upstream skip BEFORE fetch, preserve worktree',async()=>{
  for(const kind of ['dirty','staged','untracked','ignored','merge','rebase','detached','upstream']){
   const f=await fixture();if(kind==='dirty'||kind==='staged')fs.writeFileSync(f.dir+'/a.txt','draft');if(kind==='staged')await git.add({fs,dir:f.dir,filepath:'a.txt'});if(kind==='untracked')fs.writeFileSync(f.dir+'/new.txt','untracked')
   if(kind==='ignored'){fs.writeFileSync(f.dir+'/.gitignore','secret\n');await git.add({fs,dir:f.dir,filepath:'.gitignore'});await git.commit({fs,dir:f.dir,author,message:'ignore'});fs.writeFileSync(f.dir+'/secret','keep')}
   if(kind==='merge')fs.writeFileSync(ctx.gitdir+'/gitgit-merge-state.json','invalid but protected');if(kind==='rebase')fs.mkdirSync(ctx.gitdir+'/rebase-merge');if(kind==='detached')await git.checkout({fs,dir:f.dir,ref:f.base});if(kind==='upstream')await git.setConfig({fs,dir:f.dir,path:'branch.local-topic.remote',value:undefined})
   const head=await f.head(),text=fs.readFileSync(f.dir+'/a.txt');assert.equal((await facade.autoPullFastForward('repo')).status,'skipped',kind);assert.equal(fetchCalls.length,0,kind);assert.equal(await f.head(),head);assert.deepEqual(fs.readFileSync(f.dir+'/a.txt'),text)
  }
 })
 await test('fetch-time dirty/staged/untracked/branch/HEAD/upstream/workdir changes rechecked before checkout',async()=>{
  for(const kind of ['dirty','staged','untracked','branch','head','upstream','workdir']){
   const f=await fixture(),original=fetchImpl;fetchImpl=async o=>{const result=await original(o);if(kind==='dirty'||kind==='staged'){fs.writeFileSync(f.dir+'/a.txt','outside');if(kind==='staged')await git.add({fs,dir:f.dir,filepath:'a.txt'})}if(kind==='untracked')fs.writeFileSync(f.dir+'/new.txt','outside');if(kind==='branch')await git.branch({fs,dir:f.dir,ref:'other',checkout:true});if(kind==='head')await git.writeRef({fs,dir:f.dir,ref:'refs/heads/local-topic',value:f.target,force:true});if(kind==='upstream')await git.setConfig({fs,dir:f.dir,path:'branch.local-topic.merge',value:'refs/heads/other'});if(kind==='workdir')ctx={...ctx,dir:f.dir+'/moved'};return result}
   assert.equal((await facade.autoPullFastForward('repo')).status,'skipped',kind);assert.notEqual(fs.readFileSync(f.dir+'/a.txt','utf8'),'remote',kind)
  }
 })
 await test('anonymous public transport has no Authorization; invalid configured token fails once with Basic auth, no fallback',async()=>{
  for(const token of [null,{username:'token',password:'invalid-test-token'}]){
   const f=await fixture();auth=token;const calls=[];global.fetch=async(url,options)=>{calls.push(options);return {status:token?401:200,statusText:'',url,headers:new Map(),dataStream:(async function*(){})()}}
   const original=fetchImpl;fetchImpl=async o=>{assert.deepEqual(o.onAuth(),token||{username:'anonymous',password:''});const response=await o.http.request({url:'https://example.invalid/git',method:'GET',headers:{}});if(response.statusCode!==200)throw Error('HTTP 401 authentication failed');return original(o)}
   if(token){await assert.rejects(facade.autoPullFastForward('repo'),/401/);assert.equal(await f.head(),f.base)}else assert.equal((await facade.autoPullFastForward('repo')).status,'updated')
   assert.equal(calls.length,1);assert.equal(Boolean(calls[0].headers.Authorization),Boolean(token))
  }
 })
 await test('facade blocks editor save during fetch; cancelled original retains lock until settlement; existing reader gates auto writer',async()=>{
  const f=await fixture(),gate=deferred(),started=deferred(),token=new progress.RemoteCancelToken(),original=fetchImpl
  fetchImpl=async o=>{started.resolve();await gate.promise;return original(o)};const pending=facade.autoPullFastForward('repo',{cancelToken:token});await started.promise;token.cancel();assert.equal(coordinator.isWriting(ctx.gitdir),true)
  await assert.rejects(facade.saveLocalWorktreeFile('repo',{},'draft'),/写操作/);gate.resolve();await assert.rejects(pending,/取消/);assert.equal(coordinator.isWriting(ctx.gitdir),false);assert.equal(await f.head(),f.base)
  const readGate=deferred(),reading=coordinator.read(ctx.gitdir,()=>readGate.promise);fetchCalls=[];fetchImpl=original;const next=facade.autoPullFastForward('repo');await tick();assert.equal(fetchCalls.length,0);readGate.resolve();await reading;assert.equal((await next).status,'updated')
 })
 function schedule(rows,operation){let reads=0;const queue=load('services/startupAutoPull.ts',{'./repoStore':{listRepos:()=>{reads++;return rows}},'./gitService':{autoPullFastForward:operation},'../utils/remoteProgress':progress});return {queue,reads:()=>reads}}
 await test('queue yields before Storage/workspace, starts once; single failure continues, local repos excluded and paths sanitized',async()=>{
  const gate=deferred(),calls=[],e=schedule([{bookmarkName:'a',name:'/private/long/a',source:'clone'},{bookmarkName:'local',name:'local',source:'local'},{bookmarkName:'b',name:'b',source:'clone'}],async key=>{calls.push(key);if(key==='a'){await gate.promise;throw Error('EACCES /private/secret/token')}return {status:'updated',reason:'已快进更新'}})
  const p=e.queue.startStartupPull();assert.equal(e.queue.startStartupPull(),p);assert.equal(e.reads(),0);assert.equal(calls.length,0);await new Promise(r=>setTimeout(r,5));assert.deepEqual(calls,['a']);gate.resolve();await p;assert.deepEqual(calls,['a','b']);await e.queue.startStartupPull();assert.deepEqual(calls,['a','b']);assert.doesNotMatch(JSON.stringify(e.queue.getStartupPullState()),/private|secret/);assert.deepEqual(e.queue.getStartupPullState().results.map(r=>r.status),['failed','updated'])
 })
 await test('timeout requests cancel only; original awaited before second item, stop prevents subsequent pulls',async()=>{
  const originalTimer=global.setTimeout,originalClear=global.clearTimeout;let fire;global.setTimeout=(fn,ms)=>ms===60000?(fire=fn,999):originalTimer(fn,ms);global.clearTimeout=id=>id===999?undefined:originalClear(id)
  try{const gate=deferred(),started=deferred(),calls=[],e=schedule([{bookmarkName:'a',name:'a',source:'clone'},{bookmarkName:'b',name:'b',source:'clone'}],async(key,o)=>{calls.push(key);started.resolve();await gate.promise;o.cancelToken.throwIfCancelled();return {status:'updated',reason:'ok'}})
   let settled=false;const p=e.queue.startStartupPull().then(()=>settled=true);await started.promise;fire();await tick();assert.equal(e.queue.getStartupPullState().results[0].status,'waiting');assert.equal(settled,false);assert.deepEqual(calls,['a']);e.queue.stopStartupPull();gate.resolve();await p;assert.deepEqual(calls,['a']);assert.deepEqual(e.queue.getStartupPullState().results.map(r=>r.status),['cancelled','cancelled'])
  }finally{global.setTimeout=originalTimer;global.clearTimeout=originalClear}
 })
 await test('hook initial render has no extra registry reads, remount uses one script-run queue; unsubscribe prevents late UI writes',async()=>{
  const e=schedule([],async()=>{}),use=load('hooks/useStartupAutoPull.ts',{scripting:ui,'../services/startupAutoPull':e.queue}).useStartupAutoPull
  const h=mount(()=>global.__jsx('Harness',{state:use(()=>{})}),{});assert.equal(e.reads(),0);await e.queue.startStartupPull();assert.equal(e.reads(),1);h.unmount();const again=mount(()=>global.__jsx('Harness',{state:use(()=>{})}),{});await e.queue.startStartupPull();assert.equal(e.reads(),1);again.unmount();assert.equal(h.lateWrites,0)
 })
 console.log(`\n${groups} auto-pull fixture/queue/auth/lock groups passed; only disposable local files changed, HTTP/fetch mocked.`)
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}))
