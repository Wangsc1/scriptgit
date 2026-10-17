/* Startup/status regressions: fake FS/clock/gates only; never inspect user repos. */
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const ts=require('typescript')
const {load,mount,ui,all,text,node,tick,deferred}=require('./remoteFiles.test.cjs')
const {StatusCoordinator}=load('utils/statusCoordinator.ts')
let groups=0
async function test(name,fn){await fn();groups++;console.log('PASS '+name)}
function clock(){
  const originalSet=global.setTimeout,originalClear=global.clearTimeout,originalNow=Date.now
  let now=0,id=0;const timers=new Map()
  Date.now=()=>now;global.setTimeout=(fn,ms=0)=>{timers.set(++id,{fn,at:now+ms});return id};global.clearTimeout=id=>timers.delete(id)
  return {advance:async ms=>{const target=now+ms;for(let n=0;n<1000;n++){
    const due=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0]
    if(!due){now=target;await tick();return}now=due[1].at;timers.delete(due[0]);due[1].fn();await tick()
  }throw new Error('timer loop')},restore:()=>{global.setTimeout=originalSet;global.clearTimeout=originalClear;Date.now=originalNow}}
}
const status=(extra={})=>({branch:'main',uncommitted:0,ahead:0,behind:0,syncState:'upToDate',hasRemote:true,workdirOk:true,conflictCount:0,mergeInProgress:false,...extra})
const repo=key=>({name:key,bookmarkName:key,repoId:key,source:'clone',createdAt:0})
function hookEnv(keys,read,snapshot=async()=>({})){
  const repos=keys.map(repo),calls=[];let published=[]
  const hook=load('hooks/useRepoListStatus.ts',{'./useRepoGithubUpdated':{useRepoGithubUpdated:()=>({progress:{running:false,failed:0},refresh:async()=>{},stop(){}})},scripting:ui,'../services/repoStore':{listRepos:()=>repos,readSnapshots:snapshot},'../services/gitService':{getCachedRepoStatus:()=>undefined,getRepoListStatus:(key,_,options)=>{calls.push([key,options]);return read(key)}},'../utils/repoSort':{sortReposByGithubUpdated:r=>r}}).useRepoListStatus
  const h=mount(()=>global.__jsx('Harness',{api:hook(value=>{published=value})}),{})
  const api=()=>{h.render();return h.tree.props.api}
  return {h,api,calls,repos,published:()=>published,hook}
}
function readPage(e){
  const scripting=new Proxy(ui,{get:(t,key)=>key==='Navigation'?{useDismiss:()=>()=>{}}:t[key]})
  return load('pages/RepoListPage.tsx',{
    scripting,'../services/repoStore':{listRepos:()=>e.repos,sourceLabel:()=> '克隆'},'../services/gitService':{},
    '../components/BusyOverlay':{BusyOverlay:'BusyOverlay'},'./RepoDetailPage':{RepoDetailPage:'RepoDetailPage'},'./ClonePage':{ClonePage:'ClonePage'},'./GitHubFilesPage':{GitHubFilesPage:'GitHubFilesPage'},
    '../constants/colors':load('constants/colors.ts'),'../utils/mergeConflict':{formatRepoListMergeSummary:()=>null},'../utils/github':{githubRepoFromRemoteUrl:()=>null},'../utils/remoteProgress':{},'../utils/repoSort':{sortReposByGithubUpdated:r=>r},
    '../hooks/useRepoListStatus':{useRepoListStatus:e.hook},'../hooks/useRepoVisibilities':{useRepoVisibilities:()=>({})},
  }).RepoListPage
}
async function main(){
  await test('cold startup shows saved repos/controls before reads; slow first read cannot block healthy/error rows; retry reuses original',async()=>{
    const time=clock();let e
    try{
      const slow=deferred(),c=new StatusCoordinator({slowScanMs:8000,maxActiveScans:2,writeWaitMs:10000})
      e=hookEnv(['a-slow','b-good','c-error'],key=>c.read(key,()=>c.scan(key,'列表出现',async()=>key==='a-slow'?slow.promise:key==='c-error'?Promise.reject(new Error('permission denied')):status())))
      assert.equal(e.calls.length,0);assert.equal(e.api().progress.running,false)
      e.api().appear();const cycle=e.api().refreshAll();await tick();assert.equal(e.published().length,3)
      await time.advance(0);assert.deepEqual(e.calls.map(x=>x[0]),['a-slow'])
      await time.advance(10000);await cycle
      assert.deepEqual(e.calls.map(x=>x[0]),['a-slow','b-good','c-error'])
      let view=e.api();assert.equal(view.progress.running,false);assert.equal(view.progress.completed,3);assert.equal(view.repoRefreshMap['a-slow'].phase,'slow');assert.equal(view.statusMap['b-good'].workdirOk,true);assert.match(view.repoRefreshMap['c-error'].message,/permission denied/)
      const retry=e.api().refreshAll(true);await tick();await time.advance(0);await retry
      assert.equal(e.calls.filter(x=>x[0]==='a-slow').length,1)
      slow.resolve(status({ahead:2}));await tick();view=e.api();assert.equal(view.statusMap['a-slow'].ahead,2);assert.equal(view.repoRefreshMap['a-slow'],undefined)
    }finally{e?.h.unmount();time.restore()}
  })
  await test('two never-settling reads cap real work; remaining repos become explicit deferred, refresh promise finishes',async()=>{
    const time=clock();let e
    try{
      const gate=deferred();e=hookEnv(['a','b','c','d'],()=>gate.promise)
      e.api().appear();const pending=e.api().refreshAll();await tick();await time.advance(0);await time.advance(20000);await pending
      assert.equal(e.calls.length,2);assert.equal(e.api().progress.running,false);assert.equal(e.api().repoRefreshMap.c.phase,'deferred');assert.equal(e.api().repoRefreshMap.d.phase,'deferred')
      const retry=e.api().refreshAll(true);await tick();await time.advance(0);await retry;assert.equal(e.calls.length,2)
      e.h.unmount();gate.resolve(status());await tick();assert.equal(e.h.lateWrites,0)
    }finally{if(e&&!e.h.unmounted)e.h.unmount();time.restore()}
  })
  await test('unresolved snapshot does not gate refresh; hidden bulk-added repos do not enqueue scans; reentry resumes without duplicates',async()=>{
    const time=clock();let e
    try{
      const snapshot=deferred(),slow=deferred();e=hookEnv(['a'],()=>slow.promise,()=>snapshot.promise)
      e.api().refreshRepo(repo('a'));assert.equal(e.calls.length,0)
      e.api().appear();await tick();await time.advance(0);assert.equal(e.calls.length,1)
      e.api().disappear();e.repos.push(repo('b'));e.api().refreshRepo(repo('b'));assert.equal(e.calls.length,1)
      e.api().appear();const completion=e.api().refreshAll();await time.advance(20000);await time.advance(0);await time.advance(10000);await completion
      assert.equal(e.calls.filter(x=>x[0]==='a').length,1);assert.equal(e.calls.filter(x=>x[0]==='b').length,1)
      e.h.unmount();snapshot.resolve({a:{branch:'main'}});slow.resolve(status());await tick();assert.equal(e.h.lateWrites,0)
    }finally{if(e&&!e.h.unmounted)e.h.unmount();time.restore()}
  })
  await test('slow-scan spare slot progresses other repos but never exceeds two active scans or duplicates same-key matrix',async()=>{
    const time=clock()
    try{
      const c=new StatusCoordinator({slowScanMs:8000,maxActiveScans:2}),a=deferred(),b=deferred();let active=0,peak=0;const started=[]
      const scan=(key,gate)=>c.read(key,()=>c.scan(key,'列表出现',async()=>{started.push(key);peak=Math.max(peak,++active);try{return await gate.promise}finally{active--}}))
      const one=scan('a',a),two=scan('b',b),same=scan('a',a),third=scan('c',deferred())
      await tick();assert.deepEqual(started,['a']);await time.advance(8000);assert.deepEqual(started,['a','b']);await time.advance(8000);assert.equal(started.length,2)
      b.resolve('done-b');await two;await tick();assert.deepEqual(started,['a','b','c']);assert.equal(peak,2)
      a.resolve('done-a');assert.equal(await one,'done-a');assert.equal(await same,'done-a');assert.equal(started.filter(x=>x==='a').length,1)
      // third stays alive intentionally: its native task is not declared cancelled by a view timeout.
      void third
    }finally{time.restore()}
  })
  await test('write admission times out without executing later; real reads/writes retain barriers until their actual end',async()=>{
    const time=clock()
    try{
      const c=new StatusCoordinator({writeWaitMs:10000}),readGate=deferred(),writeGate=deferred();let writes=0
      const read=c.read('same',()=>readGate.promise)
      const pending=c.mutate('same',async()=>{writes++;return 'must-not-run'}).then(()=>null,error=>error)
      await tick();assert.equal(c.isWriting('same'),true);await time.advance(10000)
      assert.match((await pending).message,/暂未执行写操作/);assert.equal(writes,0);assert.equal(c.isWriting('same'),false)
      readGate.resolve('read-finished');await read;await tick();assert.equal(writes,0)
      const actual=c.mutate('same',async()=>{writes++;return writeGate.promise});await tick();await time.advance(50000);assert.equal(c.isWriting('same'),true)
      let newReadStarted=false;const following=c.read('same',async()=>{newReadStarted=true;return 'read-after-write'});await tick();assert.equal(newReadStarted,false)
      writeGate.resolve('written');assert.equal(await actual,'written');assert.equal(await following,'read-after-write');assert.equal(c.isWriting('same'),false)
    }finally{time.restore()}
  })
  await test('real RepoListPage has operable first screen, visible refresh progress/retry and non-spinning error rows',async()=>{
    const time=clock();let page,e
    try{
      const gate=deferred();e=hookEnv(['a-slow','b-good'],key=>key==='a-slow'?gate.promise:Promise.resolve(status()))
      page=mount(readPage(e),{});assert.equal(page.tree.props.overlay,undefined)
      assert.ok(node(page,'Button','重试状态刷新'));assert.equal(all(page.tree).filter(n=>typeof n.type==='function'&&n.props.repo).length,2)
      page.tree.props.onAppear();await tick();await time.advance(0);assert.match(text(page),/正在检查/)
      await time.advance(10000);await tick();assert.equal(node(page,'Button','重试状态刷新').props.disabled,false)
      page.render();const row=all(page.tree).find(n=>typeof n.type==='function'&&n.props.repo?.bookmarkName==='a-slow');assert.equal(row.props.refresh.phase,'slow')
      const rendered=row.type(row.props);assert.equal(all(rendered).filter(n=>n.type==='ProgressView').length,0)
      assert.ok(JSON.stringify(rendered).includes('状态读取较慢'));assert.ok(JSON.stringify(rendered).includes('状态未确认'))
      page.unmount();gate.resolve(status());await tick();assert.equal(page.lateWrites,0)
    }finally{if(page&&!page.unmounted)page.unmount();e?.h.unmount();time.restore()}
  })
  await test('existing coordinator serial-sharing/priority/revision/write-barrier regressions still pass',async()=>{
    const result=await new Promise((resolve,reject)=>{
      load('tests/statusCoordinator.test.ts',{'scripting':{Script:{exit:value=>value.includes('failed')?reject(new Error(value)):resolve(value)}},'../utils/statusCoordinator':{StatusCoordinator}})
    })
    assert.match(result,/passed/)
  })
  await test('existing statusScanService cache/revision/read-write tests pass with production coordinator policy',async()=>{
    const runtime={resolveGitdir:key=>'git/'+key}
    const matrix=load('services/git/matrixScanService.ts',{
      '../../utils/statusCoordinator':{StatusCoordinator},'../../utils/scanDiagnostics':{createScanDiagnostics:()=>({addSource(){},wrapFS:x=>x,finish(){}})},'../../utils/performance':{measureOperation:(_n,task)=>task()},'../repoStore':{findRepo:()=>undefined,listRepos:()=>[],getGitdirPath:()=>''},
    })
    const service=load('services/git/statusScanService.ts',{'./matrixScanService':matrix,'../../utils/statusFreshness':load('utils/statusFreshness.ts'),'./runtime':runtime})
    await new Promise((resolve,reject)=>load('tests/statusScanService.test.ts',{'scripting':{Script:{exit:value=>value.includes('failed')?reject(new Error(value)):resolve(value)}},'../services/git/runtime':runtime,'../services/git/statusScanService':service}))
  })
  await test('concurrent cold-start engine loads are single-flight; failed initialization can retry without duplicate eval',async()=>{
    const gate=deferred();let loads=0,reads=0
    global.FileManager={scriptsDirectory:'/mock',exists:async()=>true,readAsString:async()=>{reads++;return 'module.exports = { init: function(){} }'}}
    const core=load('services/gitCore.ts',{'../polyfills':{loadBufferPolyfill:async()=>{loads++;await gate.promise}}})
    const a=core.loadGitEngine(),b=core.loadGitEngine();await tick();assert.equal(loads,1);assert.equal(reads,0)
    gate.resolve();const values=await Promise.all([a,b]);assert.equal(values[0],values[1]);assert.equal(reads,1);await core.loadGitEngine();assert.equal(loads,1)
    let attempts=0
    const fail=load('services/gitCore.ts',{'../polyfills':{loadBufferPolyfill:async()=>{attempts++;if(attempts===1)throw new Error('asset temporarily unavailable')}}})
    const failed=await Promise.allSettled([fail.loadGitEngine(),fail.loadGitEngine()]);assert.ok(failed.every(x=>x.status==='rejected'));assert.equal(attempts,1)
    await fail.loadGitEngine();assert.equal(attempts,2)
  })
  await test('modified TS/TSX syntax parses and startup changes do not persist/delete queue or workspace data',async()=>{
    const root=path.join(__dirname,'..')
    for(const file of ['hooks/useRepoListStatus.ts','utils/statusCoordinator.ts','services/git/matrixScanService.ts','pages/RepoListPage.tsx','services/gitCore.ts']){
      const parsed=ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)
      assert.equal(parsed.parseDiagnostics.length,0,file)
    }
    const hook=fs.readFileSync(path.join(root,'hooks/useRepoListStatus.ts'),'utf8');assert.ok(!hook.includes('Storage.set')&&!hook.includes('FileManager.remove'))
  })
  console.log(`\n${groups} startup/status regression groups passed; no real filesystem or repositories touched.`)
}
main().catch(error=>{console.error(error);process.exitCode=1})
