/* GitHub updated_at ordering/metadata refresh only; API and persistent store mocked. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,tick,deferred,http}=require('./remoteFiles.test.cjs')
const {env,req}=require('./cloneQueue.test.cjs')
const github=load('utils/github.ts'),dates=load('utils/repoUpdated.ts',{'./github':github})
const {sortReposByGithubUpdated:sort}=load('utils/repoSort.ts',{'./repoUpdated':dates})
const repo=(name,date,extra={})=>({name,bookmarkName:name,repoId:name,createdAt:9999999999999,remoteUrl:`git@github.com:bob/${name}.git`,...(date?dates.githubUpdatedPatch(`https://github.com/bob/${name}`,date):{}),...extra})
let count=0
async function test(name,fn){await fn();count++;console.log('PASS '+name)}
function hook(rows,getRepo){let reads=0,published=[],writes=0
 const use=load('hooks/useRepoGithubUpdated.ts',{scripting:ui,'../api/githubApi':{getRepo},'../services/repoStore':{listRepos:()=>{reads++;return rows},updateRepo:(key,patch)=>{writes++;Object.assign(rows.find(r=>r.bookmarkName===key),patch)}},'../utils/github':github,'../utils/repoUpdated':dates}).useRepoGithubUpdated
 const h=mount(()=>global.__jsx('Harness',{api:use(r=>published=r)}),{});return {h,api:()=>{h.render();return h.tree.props.api},reads:()=>reads,writes:()=>writes,published:()=>published}
}
async function main(){
 await test('actual date descending with timezone offsets; equal-time name ordering; unknown/invalid/nonGitHub/wrong-origin last; no local-date fallback',async()=>{
  const rows=[repo('unknown'),repo('z','2025-01-01T00:00:00Z'),repo('b','2026-01-01T01:00:00+01:00'),repo('a','2026-01-01T00:00:00Z'),repo('bad',null,{githubUpdatedAt:'not a date'}),repo('local','2027-01-01T00:00:00Z',{remoteUrl:'https://gitlab.com/bob/local.git'}),repo('switched','2027-01-01T00:00:00Z',{remoteUrl:'https://github.com/other/switched.git'})]
  const original=rows.slice();assert.deepEqual(sort(rows).map(r=>r.name),['a','b','z','bad','local','switched','unknown']);assert.deepEqual(rows,original)
 })
 await test('clone preserves API updated_at in registered final record, re-read persistence, no invented date for legacy/URL-only',async()=>{
  const e=env({api:{getRepo:async()=>({fork:false,updatedAt:'2026-10-16T12:34:56Z'})}})
  const results=await e.queue.runCloneQueue([req('bob','new')],{kind:'icloud'},{cancelToken:new e.git.RemoteCancelToken()})
  assert.equal(results[0].status,'cloned');assert.equal(e.store.listRepos()[0].githubUpdatedAt,'2026-10-16T12:34:56Z');assert.equal(e.rows[0].githubUpdatedRepo,'bob/new')
  const old=await e.store.registerRepoByPath('/cloud/Scripting/git/legacy','legacy','https://github.com/bob/legacy.git','legacy');assert.equal(old.githubUpdatedAt,undefined)
 })
 await test('zero reads/network during render; background max two requests, duplicate refresh shares, failures preserve cache order and report nonblocking error',async()=>{
  const rows=[repo('a','2026-01-01T00:00:00Z'),repo('b'),repo('c'),repo('local',null,{remoteUrl:undefined})],gates={a:deferred(),b:deferred(),c:deferred()};let active=0,peak=0;const calls=[]
  const e=hook(rows,async name=>{calls.push(name);peak=Math.max(peak,++active);try{return await gates[name.split('/')[1]].promise}finally{active--}})
  e.h.render();assert.equal(e.reads(),0);assert.equal(calls.length,0)
  const pending=e.api().refresh();assert.equal(e.api().refresh(),pending);await new Promise(r=>setTimeout(r,5));assert.equal(calls.length,2)
  assert.ok(e.api().progress.running);assert.equal(rows[0].githubUpdatedAt,'2026-01-01T00:00:00Z')
  gates.b.resolve({updatedAt:'2026-03-01T00:00:00Z'});await tick();assert.equal(calls.length,3);gates.a.reject(Error('HTTP 403 token invalid; no fallback'));gates.c.resolve({updatedAt:'2026-02-01T00:00:00Z'});await pending
  assert.equal(peak,2);assert.deepEqual(sort(e.published()).map(r=>r.name),['b','c','a','local']);assert.equal(rows[0].githubUpdatedAt,'2026-01-01T00:00:00Z');assert.equal(e.api().progress.failed,1);assert.match(e.api().progress.error,/403/);assert.equal(e.api().progress.running,false)
  e.h.unmount()
 })
 await test('anonymous API works for public metadata; auth failure not retried anonymously, cache not cleared; 5min reuse and forced retry',async()=>{
  let token=null;const api=load('api/githubApi.ts',{'../services/authStore':{getToken:()=>token},'../utils/lru':{setLruEntry(){}}})
  let fail=false;const calls=http(()=>fail?{status:401,data:{message:'Bad credentials'}}:{data:{name:'old',full_name:'bob/old',clone_url:'https://github.com/bob/old.git',updated_at:'2026-10-16T00:00:00Z'}})
  const rows=[repo('old')],e=hook(rows,api.getRepo);await e.api().refresh();assert.equal(calls.length,1);assert.equal(calls[0].options.headers.Authorization,undefined);assert.equal(rows[0].githubUpdatedAt,'2026-10-16T00:00:00Z')
  await e.api().refresh();assert.equal(calls.length,1);token='mock-token';fail=true;await e.api().refresh(true);assert.equal(calls.length,2);assert.equal(calls[1].options.headers.Authorization,'Bearer mock-token');assert.equal(rows[0].githubUpdatedAt,'2026-10-16T00:00:00Z');assert.match(e.api().progress.error,/未降级/);e.h.unmount()
 })
 await test('late response cannot overwrite changed origin or removed repo; stop prevents new work/state updates; API invalid time does not fabricate',async()=>{
  const rows=[repo('a'),repo('b')],gate=deferred(),e=hook(rows,()=>gate.promise);const pending=e.api().refresh();await new Promise(r=>setTimeout(r,5));rows[0].remoteUrl='https://github.com/other/a.git';rows.splice(1);e.h.unmount();gate.resolve({updatedAt:'2026-10-01T00:00:00Z'});await pending;assert.equal(e.writes(),0);assert.equal(e.h.lateWrites,0)
  const invalid=hook([repo('old')],async()=>({updatedAt:'garbage'}));await invalid.api().refresh();assert.equal(invalid.writes(),0);assert.equal(invalid.api().progress.failed,1);invalid.h.unmount()
 })
 await test('homepage uses date sorter, has nonblocking refresh hint and no removed remote editing entry; detail remote entry remains',async()=>{
  const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8')
  assert.match(read('pages/RepoListPage.tsx'),/sortReposByGithubUpdated\(repos\)/);assert.ok(!read('pages/RepoListPage.tsx').includes('GitHubFilesPage'));assert.ok(!read('pages/RepoListPage.tsx').includes('GitHub 远端文件浏览与编辑'));assert.match(read('pages/RepoListPage.tsx'),/保留已有时间缓存/);assert.match(read('pages/RepoDetailPage.tsx'),/Edit Remote Files/)
 })
 console.log(`\n${count} GitHub date ordering/refresh groups passed; no network or real repository writes.`)
}
main().catch(e=>{console.error(e);process.exitCode=1})
