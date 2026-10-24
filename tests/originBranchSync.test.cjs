/* Production useRepoDetailData + gitService + remoteService + the real vendored Git engine against a REAL local bare
 * remote (served through `git upload-pack`, no network). Only the HTTP transport object is local. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),ts=require('typescript')
const {ui,mount,tick,deferred}=require('./remoteFiles.test.cjs')
global.self=globalThis
const project=path.resolve(__dirname,'..'),git=require('../vendor/index.umd.min.js')
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-origin-sync-')),bare=tmp+'/remote.git'
const sh=(cwd,...a)=>cp.execFileSync('git',['-c','user.name=t','-c','user.email=t@example.invalid','-c','protocol.file.allow=always',...a],{cwd,encoding:'utf8'}).trim()
global.FileManager={temporaryDirectory:tmp,scriptsDirectory:tmp,appGroupDocumentsDirectory:tmp,documentsDirectory:tmp,exists:async p=>fs.existsSync(p),readDirectory:async p=>fs.promises.readdir(p),createDirectory:async p=>fs.promises.mkdir(p,{recursive:true}),isDirectory:async p=>(await fs.promises.stat(p)).isDirectory(),isFile:async p=>(await fs.promises.stat(p)).isFile(),isLink:async()=>false,stat:async p=>{const s=await fs.promises.stat(p);return {size:s.size,modificationDate:s.mtimeMs}},readAsString:async p=>fs.readFileSync(p,'utf8'),remove:async p=>fs.promises.rm(p,{recursive:true})}
let token='tok';global.Keychain={contains:()=>!!token,get:()=>token,set:()=>true,remove:()=>true};global.Storage={get:()=>null,set:()=>true,remove:()=>true};global.Dialog={confirm:async()=>true}
// ---- local transport over real git upload-pack
const calls=[];let failMode=null,gate=null,transportOptions=[]
function transport(remotePath){return {async request({url,method,headers,body}){
 calls.push(method+' '+url);if(failMode)throw Object.assign(Error(failMode),{code:failMode});if(gate)await gate.promise
 const env={...process.env,GIT_PROTOCOL:headers?.['Git-Protocol']||''}
 let out
 if(method==='GET')out=Buffer.concat([Buffer.from('001e# service=git-upload-pack\n0000'),cp.execFileSync('git',['upload-pack','--stateless-rpc','--advertise-refs',remotePath],{env})])
 else{const parts=[];for await(const c of body)parts.push(Buffer.from(c));out=cp.execFileSync('git',['upload-pack','--stateless-rpc',remotePath],{env,input:Buffer.concat(parts),maxBuffer:1<<26})}
 return {url,method,statusCode:200,statusMessage:'OK',headers:{'content-type':'application/x-git-upload-pack-'+(method==='GET'?'advertisement':'result')},body:(async function*(){yield new Uint8Array(out)})()}}}}
let current={dir:null,gitdir:null}
function loaderFor(){const cache=new Map()
 function read(file){file=path.resolve(file);if(cache.has(file))return cache.get(file).exports
  const m={exports:{}};cache.set(file,m)
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'__jsx',jsxFragmentFactory:'__fragment'},fileName:file}).outputText
  const req=name=>{if(name==='scripting')return new Proxy(ui,{get:(t,k)=>k==='Widget'?{reloadAll(){}}:t[k]})
   let dest=path.resolve(path.dirname(file),name);dest=['.ts','.tsx'].map(e=>dest+e).find(fs.existsSync)||dest
   if(dest===project+'/services/gitCore.ts')return {loadGitEngine:async()=>({git}),createFS:()=>fs,createHttpTransport:(u,p,o)=>{transportOptions.push(o);return transport(bare)}}
   if(dest===project+'/services/repoStore.ts')return {writeSnapshot(){},resolveWorkdir:()=>current.dir,findRepo:()=>({bookmarkName:'repo',name:'t',repoId:'repo',source:'clone'}),listRepos:()=>[],getGitdirPath:()=>current.gitdir,getRepoLastPulledAt:()=>null,readSnapshots:async()=>({}),resolveRepoPathsReadOnly:()=>({workdir:current.dir,storedWorkdir:current.dir,gitdir:current.gitdir,source:'t',bookmarkChecks:[]})}
   if(dest===project+'/services/git/runtime.ts')return {...read(dest),runWithBackgroundKeepAlive:fn=>fn(),resolveGitdir:()=>current.gitdir,getCtx:async()=>({git,fs,dir:current.dir,gitdir:current.gitdir})}
   return read(dest)}
  new Function('require','module','exports',code)(req,m,m.exports);return m.exports}
 return rel=>read(project+'/'+rel)}
const load=loaderFor(),service=load('services/gitService.ts'),Hook=load('hooks/useRepoDetailData.ts').useRepoDetailData
const refs=(cwd,ns)=>sh(cwd,'for-each-ref','--format=%(refname) %(objectname)',ns).split('\n').filter(Boolean).sort()
const names=(cwd,ns)=>refs(cwd,ns).map(l=>l.split(' ')[0].replace(ns,'').replace(/^\//,''))
function seed(){fs.rmSync(tmp+'/seedwork',{recursive:true,force:true});sh(tmp,'init','-q','--bare','-b','main',bare)
 const w=tmp+'/seedwork';sh(tmp,'init','-q','-b','main',w);fs.writeFileSync(w+'/a.txt','a');sh(w,'add','.');sh(w,'commit','-qm','one')
 for(const b of ['dev','feat/a/b','gone','df','team/x'])sh(w,'branch',b)
 sh(w,'remote','add','origin',bare);sh(w,'push','-q','origin','--all');sh(bare,'symbolic-ref','HEAD','refs/heads/main');return w}
function cloneWork(name,extra=[]){const d=tmp+'/'+name;sh(tmp,'clone','-q',...extra,'file://'+bare,d);sh(d,'remote','set-url','origin','http://example.invalid/remote.git')
 sh(d,'branch','local-only');fs.writeFileSync(d+'/dirty.txt','uncommitted work');fs.writeFileSync(d+'/a.txt','edited, uncommitted');current={dir:d,gitdir:d+'/.git'};return d}
function snapshot(d){return {locals:refs(d,'refs/heads'),head:fs.readFileSync(d+'/.git/HEAD','utf8'),config:fs.readFileSync(d+'/.git/config','utf8'),index:fs.readFileSync(d+'/.git/index'),dirty:fs.readFileSync(d+'/dirty.txt','utf8'),a:fs.readFileSync(d+'/a.txt','utf8'),status:sh(d,'status','--porcelain')}}
function host(){const toasts=[];const h=mount(()=>Hook({bookmarkName:'repo',name:'t',showToast:(m,t)=>toasts.push([m,t])}),{});return {h,toasts,api:()=>{h.render();return h.tree}}}
async function main(){try{
 // ===== A. success: new branch, slash branches, D/F replacement, remote-deleted branch pruned; locals/config/worktree untouched
 const w=seed();const d=cloneWork('A')
 assert.ok(names(d,'refs/remotes/origin').includes('gone')&&names(d,'refs/remotes/origin').includes('df'),'fixture has stale-to-be refs')
 sh(bare,'branch','-D','gone');sh(bare,'branch','-D','feat/a/b');sh(bare,'branch','-D','df')
 for(const b of ['gone','feat/a/b','df'])sh(w,'branch','-D',b);sh(w,'branch','fix/v0.13.0-personal');sh(w,'branch','df/child');sh(w,'branch','team/y');sh(w,'push','-q','origin','fix/v0.13.0-personal','df/child','team/y')
 const before=snapshot(d),{h,toasts,api}=host()
 calls.length=0;transportOptions.length=0
 assert.equal(await api().syncOriginBranchRefs(),'synced')
 assert.deepEqual(names(d,'refs/remotes/origin').filter(n=>n!=='HEAD'),['dev','df/child','fix/v0.13.0-personal','main','team/x','team/y'].sort(),'origin refs mirror remote: new fetched, deleted pruned, slash branches intact')
 assert.deepEqual(refs(d,'refs/remotes/origin').filter(l=>!l.includes('/HEAD')),refs(bare,'refs/heads').map(l=>l.replace('refs/heads','refs/remotes/origin')),'same commits as remote')
 assert.deepEqual(snapshot(d),before,'local branches, HEAD, config, index, dirty file and status unchanged')
 assert.equal(transportOptions.at(-1)?.timeout,60,'bounded request timeout is used only for this operation')
 assert.deepEqual(toasts,[]);assert.ok(calls.length>0)
 // loadAll afterwards exposes new list in branchInfo (page refresh path)
 await api().loadBranches();let t=api();assert.ok(t.branchInfo.branches.includes('local-only'),'local-only branch kept');assert.ok(t.remoteBranchNames.includes('fix/v0.13.0-personal')&&!t.remoteBranchNames.includes('gone')&&!t.remoteBranchNames.includes('feat/a/b'))
 assert.equal(t.branchInfo.current,'main')
 h.unmount()
 // ===== B. current tracked branch deleted remotely: origin/main pruned, local main + tracking config + HEAD stay
 {const d2=cloneWork('B');sh(bare,'update-ref','-d','refs/heads/dev');sh(w,'checkout','-q','-b','tmpbase');sh(bare,'symbolic-ref','HEAD','refs/heads/team/x')
  sh(w,'branch','-D','main');sh(bare,'update-ref','-d','refs/heads/main')
  const b=snapshot(d2),x=host();if(process.env.DBG)console.log(refs(d2,'refs/remotes/origin'),refs(bare,'refs/heads'));const rr=await x.api().syncOriginBranchRefs();if(process.env.DBG)console.log(x.toasts);assert.equal(rr,'synced')
  assert.ok(!names(d2,'refs/remotes/origin').includes('main'),'deleted remote current branch record cleaned');assert.deepEqual(snapshot(d2),b,'local main, branch.main.* config, HEAD kept');x.h.unmount()}
 // ===== C. no origin: no network, no toast
 {const d3=tmp+'/C';sh(tmp,'init','-q','-b','main',d3);fs.writeFileSync(d3+'/f','x');sh(d3,'add','.');sh(d3,'commit','-qm','x');current={dir:d3,gitdir:d3+'/.git'}
  calls.length=0;const x=host();assert.equal(await x.api().syncOriginBranchRefs(),'skipped');assert.equal(calls.length,0);assert.deepEqual(x.toasts,[]);x.h.unmount()}
 // ===== D. failures (offline / timeout / 401 / no token): old records preserved, warning toast, refresh proceeds ('skipped', not 'aborted')
 seed2();const d4=cloneWork('D');const keep=refs(d4,'refs/remotes/origin')
 for(const mode of ['ETIMEDOUT','HTTP 401 Unauthorized','ENOTFOUND']){failMode=mode;const x=host();assert.equal(await x.api().syncOriginBranchRefs(),'skipped');assert.ok(x.toasts.some(([m,ty])=>ty==='warning'&&m.includes(mode)&&/本机已有/.test(m)));assert.deepEqual(refs(d4,'refs/remotes/origin'),keep,mode+' keeps old list');x.h.unmount()}
 failMode=null;token=null;{const x=host();calls.length=0;assert.equal(await x.api().syncOriginBranchRefs(),'skipped');assert.equal(calls.length,0,'no credential => no request');assert.ok(x.toasts[0][0].includes('Token'));assert.deepEqual(refs(d4,'refs/remotes/origin'),keep);x.h.unmount()};token='tok'
 // ===== E. repeated pulls share one request; later pull after completion fetches again
 {const x=host();calls.length=0;gate=deferred();const p1=x.api().syncOriginBranchRefs(),p2=x.api().syncOriginBranchRefs();assert.equal(p1,p2,'same in-flight promise');await until(()=>calls.length>0);await tick();assert.equal(calls.length,1,'one network request while pending');gate.resolve();gate=null;assert.equal(await p1,'synced');calls.length=0
  assert.equal(await x.api().syncOriginBranchRefs(),'synced');assert.ok(calls.length>0);x.h.unmount()}
 // ===== F. unmount mid-flight: cancelled, result discarded, no toast/state writes
 {const x=host();gate=deferred();const p=x.api().syncOriginBranchRefs();await until(()=>calls.length>0);x.h.unmount();gate.resolve();gate=null;assert.equal(await p,'aborted');assert.deepEqual(x.toasts,[]);assert.equal(x.h.lateWrites,0)}
 // ===== G. remote fetch error is not stale-overwritten: failed request followed by good one lists latest remote
 {failMode='ETIMEDOUT';const x=host();await x.api().syncOriginBranchRefs();failMode=null;sh(w,'branch','after-failure');sh(w,'push','-q','origin','after-failure');assert.equal(await x.api().syncOriginBranchRefs(),'synced');assert.ok(names(d4,'refs/remotes/origin').includes('after-failure'));x.h.unmount()}
 // ===== H. shallow clone: new branches arrive, local shallow boundary + branches unchanged, nothing unshallowed or merged
 {const d5=cloneWork('H',['--depth','1','--no-single-branch']);const shallow=fs.readFileSync(d5+'/.git/shallow','utf8');sh(w,'branch','shallow-new');sh(w,'push','-q','origin','shallow-new');const b=snapshot(d5)
  const x=host();const rs=await x.api().syncOriginBranchRefs();if(process.env.DBG)console.log(rs,x.toasts,names(d5,'refs/remotes/origin'),refs(bare,'refs/heads'));assert.equal(rs,'synced');assert.ok(names(d5,'refs/remotes/origin').includes('shallow-new'));assert.deepEqual(snapshot(d5),b);assert.equal(fs.readFileSync(d5+'/.git/shallow','utf8').split('\n')[0],shallow.split('\n')[0],'existing shallow root kept');x.h.unmount()}
 // ===== I. page wiring: pull-to-refresh calls sync before loadAll, aborted stops, failure still reloads; mount/render never networks
 {const src=fs.readFileSync(project+'/pages/RepoDetailPage.tsx','utf8');const i=src.indexOf('async function handleRefresh');const body=src.slice(i,src.indexOf('\n  }\n',i));assert.ok(body.indexOf('syncOriginBranchRef')>0&&body.indexOf('syncOriginBranchRef')<body.indexOf('loadAll("详情下拉", true)'));assert.match(body,/aborted/)
  assert.equal([...src.matchAll(/syncOriginBranchRefs/g)].length,1,'only the refresh handler requests it');const hook=fs.readFileSync(project+'/hooks/useRepoDetailData.ts','utf8');assert.equal([...hook.matchAll(/syncOriginBranches\(/g)].length,1,'hook calls the service only inside the explicit function')}
 console.log('PASS real bare remote: manual origin metadata sync adds/prunes (slash + D/F), keeps local branches/current/config/worktree; no-origin, failure, no token, repeat, unmount, shallow and wiring covered')
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}}
const until=async fn=>{for(let i=0;i<500&&!fn();i++)await new Promise(r=>setTimeout(r,10));assert.ok(fn(),'condition reached')}
function seed2(){fs.rmSync(bare,{recursive:true,force:true});return seed()}
main().catch(e=>{console.error(e);process.exitCode=1})
