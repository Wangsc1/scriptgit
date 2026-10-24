/* Production useRepoDetailData + gitService + remoteService + the real vendored Git engine against a REAL local bare
 * remote (served through `git upload-pack`, no network). Only the HTTP transport object is local. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),ts=require('typescript')
const {ui,mount,tick,deferred}=require('./remoteFiles.test.cjs')
global.self=globalThis
const project=path.resolve(__dirname,'..'),git=require('../vendor/index.umd.min.js')
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-origin-sync-')),bare=tmp+'/remote.git'
const sh=(cwd,...a)=>cp.execFileSync('git',['-c','user.name=t','-c','user.email=t@example.invalid','-c','protocol.file.allow=always',...a],{cwd,encoding:'utf8'}).trim()
global.FileManager={temporaryDirectory:tmp,scriptsDirectory:tmp,appGroupDocumentsDirectory:tmp,documentsDirectory:tmp,exists:async p=>fs.existsSync(p),readDirectory:async p=>fs.promises.readdir(p),createDirectory:async p=>fs.promises.mkdir(p,{recursive:true}),isDirectory:async p=>(await fs.promises.stat(p)).isDirectory(),isFile:async p=>(await fs.promises.stat(p)).isFile(),isLink:async()=>false,stat:async p=>{const s=await fs.promises.stat(p);return {size:s.size,modificationDate:s.mtimeMs}},readAsString:async p=>fs.readFileSync(p,'utf8'),remove:async p=>fs.promises.rm(p,{recursive:true})}
let token='tok';global.Keychain={contains:()=>!!token,get:()=>token,set:()=>true,remove:()=>true};global.Storage={get:()=>({login:'octo',id:7,avatarUrl:''}),set:()=>true,remove:()=>true};global.Dialog={confirm:async()=>true}
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
   if(dest===project+'/services/repoStore.ts')return {writeSnapshot(){},resolveWorkdir:()=>current.dir,findRepo:()=>({bookmarkName:'repo',name:'t',repoId:'repo',source:'clone',createdAt:1}),updateBranchLastPulledAt(){},listRepos:()=>[],getGitdirPath:()=>current.gitdir,getRepoLastPulledAt:()=>null,readSnapshots:async()=>({}),resolveRepoPathsReadOnly:()=>({workdir:current.dir,storedWorkdir:current.dir,gitdir:current.gitdir,source:'t',bookmarkChecks:[]})}
   if(dest===project+'/services/git/runtime.ts')return {...read(dest),runWithBackgroundKeepAlive:fn=>fn(),resolveGitdir:()=>current.gitdir,getCtx:async()=>({git,fs,dir:current.dir,gitdir:current.gitdir})}
   if(dest===project+'/services/notifyService.ts')return {notifySync:async()=>{},notifyError:async()=>{}}
   return read(dest)}
  new Function('require','module','exports',code)(req,m,m.exports);return m.exports}
 return rel=>read(project+'/'+rel)}
const load=loaderFor(),service=load('services/gitService.ts')
const refs=(cwd,ns)=>sh(cwd,'for-each-ref','--format=%(refname) %(objectname)',ns).split('\n').filter(Boolean).sort()
const names=(cwd,ns)=>refs(cwd,ns).map(l=>l.split(' ')[0].replace(ns,'').replace(/^\//,''))
function seed(){fs.rmSync(bare,{recursive:true,force:true});fs.rmSync(tmp+'/seedwork',{recursive:true,force:true});sh(tmp,'init','-q','--bare','-b','main',bare)
 const w=tmp+'/seedwork';sh(tmp,'init','-q','-b','main',w);fs.writeFileSync(w+'/a.txt','a');sh(w,'add','.');sh(w,'commit','-qm','one')
 for(const b of ['dev','feat/a/b','gone','df','team/x'])sh(w,'branch',b)
 sh(w,'remote','add','origin',bare);sh(w,'push','-q','origin','--all');sh(bare,'symbolic-ref','HEAD','refs/heads/main');return w}
function cloneWork(name,extra=[],dirty=true){const d=tmp+'/'+name;sh(tmp,'clone','-q',...extra,'file://'+bare,d);sh(d,'remote','set-url','origin','http://example.invalid/remote.git')
 sh(d,'branch','local-only');if(dirty)fs.writeFileSync(d+'/dirty.txt','untracked work');current={dir:d,gitdir:d+'/.git'};return d}

const Sync=load('hooks/useRepoSyncActions.ts').useRepoSyncActions
const tracking=d=>sh(d,'config','--get-regexp','^(branch|remote)\\.')
const gets=()=>calls.filter(c=>c.startsWith('GET')).length
function pullHost(){const toasts=[],events=[];const h=mount(()=>Sync({bookmarkName:'repo',displayName:'t',currentBranch:'main',hasRemote:true,beginOpBusy:async()=>{},updateOpBusy:async()=>{},endOpBusy(){},makeSyncCancel:token=>{events.push(token);return()=>token.cancel()},setPulledAt(){},refreshSyncState:async()=>{},reloadRepo:async()=>{events.push('reload')},showToast:(m,t)=>toasts.push([m,t]),showConflictNotice:m=>toasts.push([m,'conflict'])}),{});return {h,toasts,events}}
const originNames=d=>names(d,'refs/remotes/origin').filter(n=>n!=='HEAD')
const remoteNames=()=>names(bare,'refs/heads')
function advance(w,msg){fs.writeFileSync(w+'/a.txt',msg);sh(w,'commit','-qam',msg);sh(w,'push','-q','origin','main')}
async function main(){try{
 // ===== A. detail-page pull: ONE discovery request, new branch appears, deleted pruned, merge semantics intact, locals/config/untracked unchanged
 let w=seed();let d=cloneWork('A');sh(w,'branch','-D','gone');sh(bare,'branch','-D','gone');sh(w,'branch','brand-new');sh(w,'push','-q','origin','brand-new');advance(w,'remote change')
 const keepConfig=tracking(d),keepLocals=refs(d,'refs/heads').filter(l=>!l.includes('heads/main '));
 let x=pullHost();calls.length=0;await x.h.tree.handlePull()
 assert.equal(gets(),1,'single network discovery for pull + metadata sync');assert.ok(x.toasts.some(([m,t])=>t==='success'),JSON.stringify(x.toasts))
 assert.deepEqual(originNames(d),remoteNames(),'origin refs == remote branches (added, stale removed)')
 assert.equal(sh(d,'rev-parse','main'),sh(bare,'rev-parse','main'),'pull still merged/fast-forwarded current branch');assert.equal(fs.readFileSync(d+'/a.txt','utf8'),'remote change')
 assert.deepEqual(refs(d,'refs/heads').filter(l=>!l.includes('heads/main ')),keepLocals,'other local branches untouched');assert.equal(tracking(d),keepConfig,'remote/branch tracking config untouched')
 assert.equal(fs.readFileSync(d+'/dirty.txt','utf8'),'untracked work');assert.ok(x.events.includes('reload'));x.h.unmount()
 // ===== B. target branch deleted on remote: original error text kept, stale refs STILL cleaned, local branch/config kept; second request only in this error path
 d=cloneWork('B');sh(d,'checkout','-q','-b','feature');sh(w,'checkout','-q','-b','feature');sh(w,'push','-q','origin','feature');sh(d,'fetch','-q','file://'+bare,'+refs/heads/*:refs/remotes/origin/*');sh(d,'branch','-q','--set-upstream-to=origin/feature','feature')
 sh(w,'branch','-D','dev');sh(bare,'branch','-D','dev');sh(bare,'branch','-D','feature')
 const cfg=tracking(d);x=pullHost();calls.length=0;await x.h.tree.handlePull()
 let err=x.toasts.find(([m,t])=>t==='error');assert.ok(err&&/拉取失败：.*(Could not find|refs\/heads\/feature)/.test(err[0]),'original error preserved: '+JSON.stringify(x.toasts))
 assert.deepEqual(originNames(d),remoteNames(),'stale refs (dev, feature) cleaned even though pull failed');assert.equal(gets(),2,'cleanup is a best-effort second request only after missing target')
 assert.equal(tracking(d),cfg);assert.ok(refs(d,'refs/heads').some(l=>l.includes('heads/feature ')),'local feature kept');assert.equal(sh(d,'symbolic-ref','--short','HEAD'),'feature');x.h.unmount()
 // ===== C. cleanup request fails: still the original error, old refs kept, no unhandled error
 d=cloneWork('C');sh(d,'checkout','-q','-b','feature2');sh(w,'checkout','-q','-b','feature2');sh(w,'push','-q','origin','feature2');sh(d,'fetch','-q','file://'+bare,'+refs/heads/*:refs/remotes/origin/*');sh(d,'branch','-q','--set-upstream-to=origin/feature2','feature2');sh(bare,'branch','-D','feature2')
 const before=refs(d,'refs/remotes/origin');x=pullHost();calls.length=0
 // fail the second discovery by flipping failMode after the first GET
 const watcher=setInterval(()=>{if(gets()>=1)failMode='ETIMEDOUT'},1);await x.h.tree.handlePull();clearInterval(watcher);failMode=null
 err=x.toasts.find(([m,t])=>t==='error');assert.ok(err&&/拉取失败：/.test(err[0])&&!/ETIMEDOUT/.test(err[0]),'original error, not the cleanup failure: '+JSON.stringify(x.toasts));assert.deepEqual(refs(d,'refs/remotes/origin'),before,'failed cleanup keeps old refs');x.h.unmount()
 // ===== D. cancel during pull: cancelled toast, no cleanup request, nothing merged
 d=cloneWork('D');advance(w,'cancel test');const head=sh(d,'rev-parse','main');x=pullHost();calls.length=0;gate=deferred()
 const run=x.h.tree.handlePull();await until(()=>calls.length>0);x.events.find(e=>e&&e.cancel).cancel();gate.resolve();gate=null;await run
 assert.ok(x.toasts.some(([m,t])=>t==='warning'&&/拉取已取消/.test(m)),JSON.stringify(x.toasts));assert.equal(sh(d,'rev-parse','main'),head,'cancelled pull merged nothing');assert.equal(gets(),1,'no cleanup after cancel');x.h.unmount()
 // ===== E. home single/all pull (autoPullFastForward): explicit manual flag syncs in the SAME fetch; default/background stays single-branch without prune
 w=seed();d=cloneWork('E',[],false);sh(w,'branch','-D','gone');sh(bare,'branch','-D','gone');sh(w,'branch','e-new');sh(w,'push','-q','origin','e-new');advance(w,'auto1')
 const stale=originNames(d);for(const options of [undefined,{},{includeAllSources:true}]){calls.length=0;const r=await service.autoPullFastForward('repo',options);assert.ok(r.status==='updated'||r.status==='unchanged'||r.status==='skipped');assert.ok(originNames(d).includes('gone')&&!originNames(d).includes('e-new'),'default/background keeps single-branch, no prune: '+JSON.stringify(options));sh(d,'reset','-q','--hard','HEAD~0');if(options){}}
 // rewind local main so the manual path has work and a clean tree
 sh(d,'reset','-q','--hard','HEAD~1');calls.length=0
 const r=await service.autoPullFastForward('repo',{includeAllSources:true,pruneOriginBranches:true});assert.equal(r.status,'updated',JSON.stringify(r));assert.equal(gets(),1,'one request');assert.deepEqual(originNames(d),remoteNames());assert.equal(sh(d,'rev-parse','main'),sh(bare,'rev-parse','main'));assert.equal(sh(d,'status','--porcelain'),'')
 assert.ok(refs(d,'refs/heads').some(l=>l.includes('heads/local-only ')),'local-only kept')
 // target deleted in home path: original error surfaces, stale cleaned
 sh(w,'branch','-D','e-new');sh(bare,'branch','-D','e-new');sh(bare,'symbolic-ref','HEAD','refs/heads/dev');sh(bare,'update-ref','-d','refs/heads/main');calls.length=0
 await assert.rejects(service.autoPullFastForward('repo',{includeAllSources:true,pruneOriginBranches:true}),/Could not find|refs\/heads\/main/);assert.ok(!originNames(d).includes('e-new')&&!originNames(d).includes('main'),'stale cleaned after target-missing error');assert.equal(gets(),2)
 assert.ok(refs(d,'refs/heads').some(l=>l.includes('heads/main ')),'local main retained')
 // ===== F. wiring: only explicit manual entries pass the flag; push/revert/switch pulls and background defaults do not
 const read=f=>fs.readFileSync(project+'/'+f,'utf8')
 assert.equal([...read('pages/RepoListPage.tsx').matchAll(/pruneOriginBranches: true/g)].length,2);assert.match(read('hooks/useRepoSyncActions.ts'),/handlePull[\s\S]*pruneOriginBranches: true/);assert.ok(!/pruneOriginBranches/.test(read('hooks/useRepoPendingActions.ts')));assert.equal([...read('hooks/useRepoSyncActions.ts').matchAll(/pruneOriginBranches/g)].length,1,'push pre-pull unchanged')
 console.log('PASS real bare remote: manual pulls (detail/home) sync origin metadata in the same fetch; missing-target keeps original error and cleans stale refs; cleanup failure/cancel safe; background default unchanged')
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}}
const until=async fn=>{for(let i=0;i<500&&!fn();i++)await new Promise(r=>setTimeout(r,10));assert.ok(fn(),'condition reached')}
main().catch(e=>{console.error(e);process.exitCode=1})
