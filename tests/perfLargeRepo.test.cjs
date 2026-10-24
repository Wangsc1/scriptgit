/* Large-repo (1400+ files, real temp Git repo) enter-detail and branch-switch performance + correctness.
 * Production services/hooks; counts native-style operations and uses RELATIVE comparisons only
 * (op counts, in-flight concurrency, simulated per-call latency ratio). No network, no absolute-ms assertions. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {setup}=require('./perfHarness.cjs')
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const until=async fn=>{for(let i=0;i<600&&!fn();i++)await sleep(10);assert.ok(fn(),'condition reached')}
async function main(){
 // ===================== A. directory inventory: same result as a sequential walk, far less wall time under native-call latency
 {const S=setup({files:300,dirs:30,branches:1});try{
  const dir=S.dir;fs.mkdirSync(dir+'/empty/inner',{recursive:true});fs.mkdirSync(dir+'/untracked/deep',{recursive:true});fs.writeFileSync(dir+'/untracked/deep/u.txt','u');fs.writeFileSync(dir+'/loose.txt','l')
  fs.mkdirSync(dir+'/nested/.git',{recursive:true});fs.writeFileSync(dir+'/nested/x.txt','x');fs.writeFileSync(dir+'/skip.log','ignored');fs.symlinkSync(dir+'/d0',dir+'/linkdir');fs.symlinkSync(dir+'/loose.txt',dir+'/linkfile')
  const svc=S.load('services/gitService.ts')
  // sequential reference with the SAME native calls (the pre-change traversal shape)
  async function sequential(){const tracked=new Set(S.sh('ls-files').split('\n'));const out={files:[],directories:[]}
   async function visit(rel){const abs=S.dir+(rel?'/'+rel:'');if(await FileManager.isLink(abs))throw Error('link');const names=await FileManager.readDirectory(abs)
    if(rel&&names.some(n=>n.toLowerCase()==='.git'))return false
    for(const n of names){if(n==='.git')continue;const p=rel?rel+'/'+n:n,full=S.dir+'/'+p;if(await FileManager.isLink(full))continue;const d=await FileManager.isDirectory(full)
     const ignored=!tracked.has(p)&&(()=>{try{S.sh('check-ignore','-q',d?p+'/':p);return true}catch{return false}})()
     if(!d&&ignored)continue;if(d){if(ignored)continue;if(await visit(p))out.directories.push(p)}else if(await FileManager.isFile(full))out.files.push(p)}return true}
   await visit('');return out}
  S.control.latency=1;S.reset();S.control.maxInFlight=0
  const t0=Date.now();const seq=await sequential();const seqMs=Date.now()-t0;const seqOps=S.snap()
  S.reset();S.control.maxInFlight=0;const t1=Date.now();const entries=await svc.getWorktreeEntries('repo');const newMs=Date.now()-t1;const newOps=S.snap()
  assert.deepEqual([...entries.files].sort(),[...seq.files].sort(),'same files as the sequential walk');assert.deepEqual([...entries.directories].sort(),[...seq.directories].sort(),'same directories')
  assert.ok(!entries.files.includes('skip.log')&&!entries.files.includes('linkfile')&&!entries.files.some(f=>f.startsWith('nested/')),'ignored, links, nested repo excluded')
  assert.ok(entries.untrackedDirectories.includes('untracked')||entries.untrackedDirectories.includes('untracked/deep'),'untracked dirs reported');assert.ok(entries.directories.includes('empty/inner'),'empty dirs reported')
  assert.ok(S.control.maxInFlight>=4,'metadata calls overlap: '+S.control.maxInFlight)
  assert.ok(newMs<seqMs*0.5,`simulated native latency: ${newMs}ms vs sequential ${seqMs}ms (relative)`)
  for(const k of ['FM.readDirectory','FM.isFile'])assert.equal(newOps[k],seqOps[k],'same number of '+k+' calls (no extra work): '+newOps[k]+'/'+seqOps[k])
  console.log('PASS inventory: identical output, overlapped native calls',{seqMs,newMs,maxInFlight:S.control.maxInFlight})
  S.control.latency=0
 }finally{S.cleanup()}}

 // ===================== B. enter detail on 1450 files: first paint, loading, snapshot ordering, concurrency, single inventory
 {const S=setup();try{
  const toasts=[];const Hook=S.load('hooks/useRepoDetailData.ts').useRepoDetailData
  const h=S.mount(()=>Hook({bookmarkName:'repo',name:'big',showToast:(m,t)=>toasts.push([m,t])}),{})
  S.reset();const marks={};const p=h.tree.loadAll('perf',true);let done=false;p.then(()=>done=true)
  let started=0
  while(!done){h.render();const t=h.tree
   if(t.trackedFiles.length>=1451&&!marks.tracked){marks.tracked=true;marks.entriesAtTracked=t.worktreeEntries.files.length;marks.snapshotsAtTracked=S.snap()['snapshot.write']||0}
   if(!t.loading&&!marks.loadingOff){marks.loadingOff=true;marks.snapshotsAtLoadingOff=S.snap()['snapshot.write']||0}
   await sleep(1)}
  h.render();const t=h.tree;assert.deepEqual(toasts,[]);assert.equal(t.trackedFiles.length,1451);assert.ok(t.worktreeEntries.files.length>=1451);assert.equal(t.loading,false);assert.deepEqual(t.changes,[])
  assert.ok(marks.tracked,'tracked files were published');assert.equal(marks.entriesAtTracked,0,'HEAD file list is shown before the directory inventory is published')
  assert.equal(marks.snapshotsAtLoadingOff,0,'loading cleared before the home snapshot write');assert.equal(S.snap()['snapshot.write'],1,'snapshot still written once after loading')
  const ops=S.snap();assert.equal(ops['git.statusMatrix'],1,'one status scan');
  assert.ok(ops['FM.readDirectory']<600,'single directory inventory (~481 dirs), not repeated: '+ops['FM.readDirectory']);assert.equal(ops['git.isIgnored'],1)
  // tracked list must not carry stale content after a switch: reload shows new HEAD tree
  S.sh('checkout','-q','br1');await h.tree.loadAll('perf',true);h.render();assert.ok(h.tree.trackedFiles.includes('d0/new-1.txt'),'fresh HEAD tree after reload');S.sh('checkout','-q','main')
  h.unmount();console.log('PASS enter detail: tracked list first, loading ends before snapshot, one scan + one inventory',{opsReadDirectory:ops['FM.readDirectory'],matrix:ops['git.statusMatrix']})
 }finally{S.cleanup()}}

 // Stable native DisclosureGroup content on a real 1450-file repository: construction is JS-only.
 {const S=setup();try{
  const {all}=require('./remoteFiles.test.cjs'),{performance}=require('node:perf_hooks')
  const files=await S.load('services/gitService.ts').getTrackedFiles('repo')
  const FilesTab=S.load('pages/FilesTab.tsx').FilesTab
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  S.reset();const t0=performance.now()
  const h=S.mount(FilesTab,{files,changes:[],bookmarkName:'repo',loading:false,onOpen(){},onWorktreeChanged(){},onPush(){},onStage(){},onRestore(){},onCreateEntry(){},mergeInProgress:false})
  const rows=all(expand(h.tree)),buildMs=performance.now()-t0
  assert.equal(rows.filter(n=>n.type==='Button'&&n.props.trailingSwipeActions).length,files.length)
  const folders=rows.filter(n=>n.type==='DisclosureGroup');assert.ok(folders.length>400);assert.ok(folders.every(n=>n.props.isExpanded===false))
  await S.tick();h.render();await S.tick()
  const ops=S.snap();assert.equal(ops['FM.stat'],1,'only root .gitignore metadata, NOT all prebuilt files')
  for(const k of ['FM.readDirectory','FM.readAsData','FM.readAsString','fs.readFile','fs.readdir','git.statusMatrix'])assert.equal(ops[k]||0,0,'building full rows has no extra '+k)
  const times=[];for(let i=0;i<5;i++){const t=performance.now();h.render();expand(h.tree);times.push(+(performance.now()-t).toFixed(1))}
  console.log('PASS stable full disclosure: real Git HEAD files, zero extra file-content/directory reads',{files:files.length,folders:folders.length,firstJsBuildMs:+buildMs.toFixed(1),rerenderJsMs:times,metadataStats:ops['FM.stat']})
  h.unmount()
 }finally{S.cleanup()}}

 // ===================== C. branch switch: scoped worktree update == full force checkout, much fewer operations, protections intact
 {const S=setup();try{
  const svc=S.load('services/gitService.ts');const {git,fs:cfs,dir,gitdir}=S.ctx
  const ops=async fn=>{S.reset();await fn();return S.snap()}
  const total=o=>Object.entries(o).filter(([k])=>k.startsWith('fs.')).reduce((n,[,v])=>n+v,0)
  // baseline: the pre-change full force checkout
  const full=await ops(()=>git.checkout({fs:cfs,dir,gitdir,ref:'br1',force:true}));S.sh('checkout','-q','main','-f')
  const scoped=await ops(()=>svc.checkoutBranch('repo','br1',{refreshSnapshot:false}))
  assert.equal(S.sh('rev-parse','--abbrev-ref','HEAD'),'br1');assert.equal(S.sh('status','--porcelain'),'');assert.equal(S.sh('diff','br1'),'');assert.equal(fs.readFileSync(dir+'/d0/s0/f0.txt','utf8'),'branch 1 change 0');assert.ok(fs.existsSync(dir+'/d0/new-1.txt'))
  assert.equal(S.sh('fsck','--no-dangling'),'');assert.ok(!('snapshot.write' in scoped),'no snapshot scan inside the write barrier')
  const checkoutOps=scoped['git.checkout'];assert.equal(checkoutOps,1)
  // scoped checkout part alone (exclude the clean-check matrix scan)
  const matrixOnly=await ops(()=>svc.getChanges('repo','m'))
  assert.ok(total(scoped)-total(matrixOnly)<total(full)*0.1,`checkout filesystem ops ${total(scoped)-total(matrixOnly)} vs full ${total(full)}`)
  // default (compat) call still refreshes the home snapshot
  S.reset();await svc.checkoutBranch('repo','main');assert.equal(S.snap()['snapshot.write'],1);assert.equal(S.sh('rev-parse','--abbrev-ref','HEAD'),'main')
  // deletion leaving an empty directory, exec-bit only change (file<->dir swaps keep the previous full-checkout path): all identical to git's own result
  S.sh('checkout','-q','-b','shapes');fs.rmSync(dir+'/d5/s5',{recursive:true});fs.rmSync(dir+'/d7/s0/f7.txt')
  fs.chmodSync(dir+'/d1/s1/f1.txt',0o755);S.sh('add','-A');S.sh('commit','-qm','shapes');S.sh('checkout','-q','main')
  await svc.checkoutBranch('repo','shapes',{refreshSnapshot:false})
  assert.equal(S.sh('status','--porcelain'),'');assert.ok(fs.statSync(dir+'/d1/s1/f1.txt').mode&0o100,'exec bit applied');assert.ok(!fs.existsSync(dir+'/d7/s0/f7.txt'));assert.ok(!fs.existsSync(dir+'/d5/s5/f5.txt'))
  await svc.checkoutBranch('repo','main',{refreshSnapshot:false})
  assert.equal(S.sh('status','--porcelain'),'');assert.ok(fs.existsSync(dir+'/d5/s5/f5.txt'),'back to main');assert.ok(fs.existsSync(dir+'/d7/s0/f7.txt'));assert.equal(S.sh('diff','main'),'');assert.equal(S.sh('fsck','--no-dangling'),'')
  // identical trees: HEAD moves, worktree untouched
  S.sh('branch','same');const before=S.snap();await svc.checkoutBranch('repo','same',{refreshSnapshot:false});assert.equal(S.sh('rev-parse','--abbrev-ref','HEAD'),'same');assert.equal(S.sh('status','--porcelain'),'');await svc.checkoutBranch('repo','main',{refreshSnapshot:false})
  // huge diff falls back to full checkout and is still exact
  S.sh('checkout','-q','-b','huge');for(let i=0;i<650;i++)fs.writeFileSync(dir+`/d${i%60}/s${i%7}/f${i}.txt`,'huge '+i);S.sh('add','-A');S.sh('commit','-qm','huge');S.sh('checkout','-q','main')
  S.reset();await svc.checkoutBranch('repo','huge',{refreshSnapshot:false});assert.equal(S.sh('status','--porcelain'),'');assert.equal(S.sh('diff','huge'),'');assert.ok(S.snap()['fs.lstat']>2000,'fallback used the full checkout');await svc.checkoutBranch('repo','main',{refreshSnapshot:false});assert.equal(S.sh('status','--porcelain'),'')
  // remote-only branch creates local branch + tracking config
  S.sh('update-ref','refs/remotes/origin/remote-only',S.sh('rev-parse','br2'));await svc.checkoutBranch('repo','origin/remote-only',{refreshSnapshot:false})
  assert.equal(S.sh('rev-parse','--abbrev-ref','HEAD'),'remote-only');assert.equal(S.sh('config','branch.remote-only.merge'),'refs/heads/remote-only');assert.equal(S.sh('status','--porcelain'),'');assert.equal(S.sh('diff','br2'),'');await svc.checkoutBranch('repo','main',{refreshSnapshot:false})
  // protections: dirty / staged / untracked refuse and change nothing; unknown branch rejected; HEAD unchanged
  const head=S.sh('rev-parse','HEAD')
  for(const dirty of [()=>fs.writeFileSync(dir+'/d0/s0/f0.txt','edit'),()=>fs.writeFileSync(dir+'/untracked-new.txt','u'),()=>{fs.writeFileSync(dir+'/d2/s2/f2.txt','staged');S.sh('add','d2/s2/f2.txt')},()=>fs.rmSync(dir+'/d3/s3/f3.txt')]){
   dirty();const snapshot=S.sh('status','--porcelain');const refsBefore=S.sh('for-each-ref')
   await assert.rejects(svc.checkoutBranch('repo','br1',{refreshSnapshot:false}),/请先提交|Stash|丢弃/);assert.equal(S.sh('rev-parse','--abbrev-ref','HEAD'),'main');assert.equal(S.sh('status','--porcelain'),snapshot,'dirty state untouched');assert.equal(S.sh('for-each-ref'),refsBefore)
   S.sh('reset','-q','--hard');S.sh('clean','-fdq')}
  await assert.rejects(svc.checkoutBranch('repo','missing',{refreshSnapshot:false}),/本地与 origin 均无分支/);assert.equal(S.sh('rev-parse','HEAD'),head);assert.equal(S.sh('status','--porcelain'),'')
  // failure still refreshes the home snapshot (previous behavior) even though success skips it
  S.reset();await assert.rejects(svc.checkoutBranch('repo','missing',{refreshSnapshot:false}));assert.equal(S.snap()['snapshot.write'],1)
  console.log('PASS branch switch: scoped checkout exact for adds/deletes/mode, identical trees, >500-path fallback, remote-only, protections',{fullOps:total(full),scopedOps:total(scoped)-total(matrixOnly)})
 }finally{S.cleanup()}}

 // ===================== D. hook: switch uses one reload, guards, failure, cancel-free ordering
 {const S=setup({files:200,dirs:20,branches:2});try{
  const Actions=S.load('hooks/useRepoBranchActions.ts').useRepoBranchActions,Detail=S.load('hooks/useRepoDetailData.ts').useRepoDetailData
  const toasts=[],events=[];let mutating=false
  const host=S.mount(()=>{const data=Detail({bookmarkName:'repo',name:'big',showToast:(m,t)=>toasts.push([m,t])})
   const actions=Actions({bookmarkName:'repo',currentBranch:data.branchInfo.current,hasCommits:true,hasRemote:false,mutating,mergeInProgress:false,beginOpBusy:async(...a)=>{events.push('begin')},endOpBusy:()=>events.push('end'),reloadRepo:async()=>{events.push('reload');await data.loadAll('switch',true)},showAlert(){},showToast:(m,t)=>toasts.push([m,t]),showConflictNotice(){}})
   return {data,actions}},{})
  await host.tree.data.loadAll('p',true);host.render()
  S.reset();await host.tree.actions.handleSwitchBranch('br1');host.render()
  assert.deepEqual(events,['begin','reload','end']);assert.ok(toasts.some(([m,t])=>t==='success'&&m.includes('br1')));assert.equal(host.tree.data.branchInfo.current,'br1');assert.ok(host.tree.data.trackedFiles.includes('d0/new-1.txt'),'file tree reflects new branch (not stale)')
  assert.equal(S.snap()['snapshot.write'],1,'home snapshot written exactly once (by the reload)');assert.equal(S.snap()['git.statusMatrix'],2,'clean check + reload scan only')
  events.length=0;mutating=true;host.render();await host.tree.actions.handleSwitchBranch('main');assert.deepEqual(events,[],'busy: ignored');mutating=false;host.render()
  fs.writeFileSync(S.dir+'/d0/s0/f0.txt','dirty');events.length=0;toasts.length=0;await host.tree.actions.handleSwitchBranch('main');host.render()
  assert.deepEqual(events,['begin','end'],'refused switch: no reload, overlay closed');assert.ok(toasts.some(([m,t])=>t==='error'&&/切换失败：.*请先提交/.test(m)));assert.equal(S.sh('rev-parse','--abbrev-ref','HEAD'),'br1');assert.equal(fs.readFileSync(S.dir+'/d0/s0/f0.txt','utf8'),'dirty','uncommitted edit kept')
  host.unmount();console.log('PASS hook: one reload, single snapshot write, busy/dirty guards, no stale tree')
 }finally{S.cleanup()}}
}
main().catch(e=>{console.error(e);process.exitCode=1})
