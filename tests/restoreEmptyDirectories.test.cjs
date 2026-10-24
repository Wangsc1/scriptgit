const {isFolderRow,folderExpanded}=require('./standardTreeHelpers.js')
/* Disposable real FS + bundled Git + production facade/status/restore/UI.
 * Python.run bridge executes the exact shipped Python program via python3, not mocked rmdir.
 */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),ts=require('typescript')
const {ui,mount,all,tick,deferred}=require('./remoteFiles.test.cjs');global.self=globalThis
const project=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(os.tmpdir()+'/scriptgit-restore-empty-'),dir=tmp+'/work',outside=tmp+'/outside',git={...require('../vendor/index.umd.min.js')};fs.mkdirSync(dir);fs.mkdirSync(outside)
let removed=[],pythonCalls=[],race=null,root=dir,snapshots={}
const privateState=new Map();global.Storage={get:key=>privateState.get(key),set:(key,value)=>{privateState.set(key,JSON.parse(JSON.stringify(value)));return true}}
const exists=p=>{try{fs.lstatSync(p);return true}catch{return false}}
global.FileManager={documentsDirectory:tmp,appGroupDocumentsDirectory:tmp,scriptsDirectory:tmp,temporaryDirectory:tmp,exists:async p=>exists(p),isLink:async p=>exists(p)&&fs.lstatSync(p).isSymbolicLink(),isDirectory:async p=>exists(p)&&fs.statSync(p).isDirectory(),isFile:async p=>exists(p)&&fs.statSync(p).isFile(),readDirectory:async p=>fs.readdirSync(p),readAsString:async p=>fs.readFileSync(p,'utf8'),stat:async p=>{const s=fs.statSync(p);return {size:s.size,creationDate:s.birthtimeMs,modificationDate:s.mtimeMs}},remove:async p=>{assert.ok(!fs.lstatSync(p).isDirectory(),'recursive FileManager.remove MUST NOT delete a directory');removed.push(p);fs.unlinkSync(p)}}
global.Python={run:async(code,options)=>{const payload=JSON.parse(options.queryParameters.payload);pythonCalls.push(payload.mode);if(payload.mode==='delete'&&race){const run=race;race=null;run()};const r=cp.spawnSync('python3',['-c',code],{encoding:'utf8',env:{...process.env,SCRIPTING_QUERY_PARAMETERS:JSON.stringify(options.queryParameters)}});return {exitCode:r.status,output:r.stdout+r.stderr}}}
const ctx={git,fs,dir,gitdir:dir+'/.git'},runtime={getCtx:async()=>ctx,resolveGitdir:()=>ctx.gitdir,runWithBackgroundKeepAlive:fn=>fn(),checkoutWithEmptyDirCleanup:(g,f,options)=>g.checkout({fs:f,...options})},repo={bookmarkName:'repo',name:'Repo',repoId:'repo',source:'local'}
const store={listRepos:()=>[repo],findRepo:()=>repo,getGitdirPath:()=>ctx.gitdir,resolveWorkdir:()=>root,resolveRepoPathsReadOnly:()=>({workdir:root,gitdir:ctx.gitdir}),sourceLabel:()=>'',writeSnapshot:async(key,s)=>{snapshots[key]=s}}
const cache=new Map();function load(relative){let file=path.resolve(project,relative);if(!/\.tsx?$/.test(file))file=['.ts','.tsx'].map(ext=>file+ext).find(fs.existsSync)||file;if(cache.has(file))return cache.get(file).exports;const m={exports:{}};cache.set(file,m);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'__jsx',jsxFragmentFactory:'__fragment'}}).outputText;new Function('require','module','exports',code)(name=>{if(name==='scripting')return new Proxy(ui,{get:(t,k)=>k==='Widget'?{reloadAll(){}}:k==='Navigation'?{useDismiss:()=>()=>{}}:t[k]});const dest=path.relative(project,path.resolve(path.dirname(file),name));if(dest==='services/repoStore')return store;if(dest==='services/git/runtime')return runtime;if(dest==='services/gitCore')return {createFS:()=>fs,loadGitEngine:async()=>({git})};return load(dest)},m,m.exports);return m.exports}
const service=load('services/gitService.ts'),scan=load('services/git/statusScanService.ts'),coordinator=load('services/git/matrixScanService.ts').statusCoordinator
const cmd=(...args)=>cp.execFileSync('git',['-C',dir,...args],{encoding:'utf8'});cmd('init','-qb','main');cmd('config','user.name','T');cmd('config','user.email','t@example.invalid');fs.mkdirSync(dir+'/tracked');fs.writeFileSync(dir+'/tracked/base','HEAD');fs.writeFileSync(dir+'/.gitignore','ignored/\n*.hidden\n');fs.mkdirSync(dir+'/rename-fixture/nested',{recursive:true});fs.writeFileSync(dir+'/rename-fixture/main','original');fs.writeFileSync(dir+'/rename-fixture/nested/binary',Buffer.from([0,255,3]));const renameSamples=[['code.ts',Buffer.from('const a=1\r\n')],['code.js',Buffer.from('export default 1')],['config.json',Buffer.from('{"ok":true}')],['README.md',Buffer.from('# 中文')],['no-extension',Buffer.from('text')],['.dotfile',Buffer.from('hidden name')],['照片.png',Buffer.from([0,255,3,77])],['zero.txt',Buffer.alloc(0)],['large.bin',Buffer.alloc(512*1024+7,255)]];for(const [name,bytes]of renameSamples){fs.mkdirSync(dir+'/rename-cases',{recursive:true});fs.writeFileSync(dir+'/rename-cases/'+name,bytes)};cmd('add','.');cmd('commit','-qm','base')
const originalHead=fs.readFileSync(ctx.gitdir+'/HEAD','utf8'),oid=cmd('rev-parse','HEAD').trim()
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
function write(p,v='new'){fs.mkdirSync(path.dirname(dir+'/'+p),{recursive:true});fs.writeFileSync(dir+'/'+p,v)}
function mkdir(p){fs.mkdirSync(dir+'/'+p,{recursive:true})}
function sameHead(){assert.equal(fs.readFileSync(ctx.gitdir+'/HEAD','utf8'),originalHead);assert.equal(cmd('rev-parse','HEAD').trim(),oid)}
const alerts=load('utils/repoDetailAlerts.ts')
const {page}=require('./homePullAll.test.cjs')
let statusMap={},refreshes=0
const Page=page([repo],async()=>{},async()=>{},async()=>{statusMap.repo=await service.getRepoListStatus('repo',undefined,{force:true});refreshes++},{'../services/gitService':service,'../services/repoStore':store,'../utils/mergeConflict':{formatRepoListMergeSummary:()=>null},'../hooks/useRepoListStatus':{useRepoListStatus:()=>({statusMap,snapshotMap:snapshots,repoRefreshMap:{},githubUpdatedProgress:{},refreshRepo:async()=>{statusMap.repo=await service.getRepoListStatus('repo',undefined,{force:true});refreshes++}})}})
const swipe=h=>{h.render();return all(h.tree).find(n=>n.props.trailingSwipeActions).props.trailingSwipeActions.actions}
async function settle(h){for(let i=0;i<300;i++){await new Promise(r=>setTimeout(r,10));h.render();if(h.tree.props.alert?.isPresented&&!all(h.tree).some(n=>n.props.title==='还原'&&n.props.disabled))return}throw Error('UI did not settle: '+JSON.stringify(h.tree.props.alert))}
let groups=0;async function test(name,fn){await fn();groups++;console.log('PASS '+name)}
async function main(){
 await test('homepage 1 Git change + 4 empty folders: preview explicit counts/scope, cancel zero writes; confirm actual facade restores file+4 dirs, cache/snapshot become clean, HEAD stays attached',async()=>{
  write('tracked/base','modified');for(let i=0;i<4;i++)mkdir('empty-'+i)
  statusMap.repo=await service.getRepoListStatus('repo',undefined,{force:true});assert.equal(statusMap.repo.uncommitted,1);assert.equal(statusMap.repo.newDirectories,4)
  const cancelIndex=fs.readFileSync(ctx.gitdir+'/index'),cancelIndexTime=fs.statSync(ctx.gitdir+'/index').mtimeMs;const h=mount(Page,{});const restore=()=>swipe(h).find(a=>a.props.title==='还原');restore().props.action();await settle(h);assert.equal(h.tree.props.alert.title,'还原文件并删除新增空目录？');assert.deepEqual(h.tree.props.alert.message.children,["当前文件改动将丢失，不可撤销。"]);assert.equal(fs.readFileSync(dir+'/tracked/base','utf8'),'modified');assert.equal(pythonCalls.includes('delete'),false)
  all(h.tree.props.alert.actions).find(n=>n.props.title==='取消').props.action();h.render();for(let i=0;i<4;i++)assert.ok(exists(dir+'/empty-'+i));assert.equal(refreshes,0);assert.deepEqual(fs.readFileSync(ctx.gitdir+'/index'),cancelIndex);assert.equal(fs.statSync(ctx.gitdir+'/index').mtimeMs,cancelIndexTime);sameHead()
  restore().props.action();await settle(h);await all(h.tree.props.alert.actions).find(n=>n.props.title==='还原').props.action();h.render();assert.equal(h.tree.props.alert.isPresented,false);for(let i=0;i<300&&!refreshes;i++)await new Promise(r=>setTimeout(r,10));assert.equal(fs.readFileSync(dir+'/tracked/base','utf8'),'HEAD');for(let i=0;i<4;i++)assert.ok(!exists(dir+'/empty-'+i));assert.equal(cmd('status','--porcelain'),'');assert.equal(statusMap.repo.uncommitted,0);assert.equal(statusMap.repo.newDirectories,0);assert.equal(snapshots.repo.uncommitted,0);assert.equal(snapshots.repo.newDirectories,0);sameHead();h.unmount()
 })
 await test('directory-only homepage offers restore without push/Stash; folder row -> production worktree request/pending executor removes only selected nested subtree, retaining parent/outside/tracked directories',async()=>{
  mkdir('parent/selected/leaf');mkdir('parent/other');mkdir('outside-scope');mkdir('tracked/empty')
  statusMap.repo=await service.getRepoListStatus('repo',undefined,{force:true});const home=mount(Page,{});assert.deepEqual(swipe(home).map(a=>a.props.title),['拉取','还原','删除']);home.unmount()
  let pending=null,refresh=0,shown=[];const req=mount(load('hooks/useRepoWorktreeActions.ts').useRepoWorktreeActions,{bookmarkName:'repo',changes:[],mergeInProgress:false,setPending:a=>pending=a,showToast:(...a)=>shown.push(a)})
  const props={files:await service.getTrackedFiles('repo'),worktreeEntries:await service.getWorktreeEntries('repo'),loading:false,bookmarkName:'repo',changes:[],onOpen(){},onWorktreeChanged(){},onPush(){throw Error('no push')},onStage(){throw Error('no stash')},onRestore:(...args)=>req.tree.handleRestore(...args),mergeInProgress:false}
  const files=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function folder(name){files.render();return all(expand(files.tree)).find(n=>isFolderRow(n)&&all(n.children[0].children[0]).some(t=>t.type==='Text'&&t.children.includes(name)))}
  folder('parent').props.action();let row=folder('selected');assert.deepEqual(row.props.trailingSwipeActions.actions.map(a=>a.props.title),['还原','删除']);await row.props.trailingSwipeActions.actions[0].props.action();for(let i=0;i<300&&!pending;i++)await new Promise(r=>setTimeout(r,10));req.render();assert.ok(pending.restorePlan);assert.equal(pending.restorePlan.scope,'parent/selected');assert.equal(pending.restorePlan.empty.directories.length,2);assert.equal(alerts.getRepoPendingAlert(pending).message,"当前文件改动将丢失，不可撤销。")
  const exec=mount(load('hooks/useRepoPendingActions.ts').useRepoPendingActions,{bookmarkName:'repo',beginOpBusy:async()=>{},endOpBusy(){},reloadRepo:async()=>{refresh++},showAlert:(...a)=>shown.push(a),showToast:(...a)=>shown.push(a)})
  exec.tree.setPending(pending);exec.render();exec.tree.clearPending();exec.render();await exec.tree.runPending();assert.ok(exists(dir+'/parent/selected/leaf'));assert.equal(refresh,0)
  exec.tree.setPending(pending);exec.render();await exec.tree.runPending();assert.equal(refresh,1);assert.deepEqual(shown,[]);assert.ok(!exists(dir+'/parent/selected'));for(const p of ['parent','parent/other','outside-scope','tracked','tracked/empty'])assert.ok(exists(dir+'/'+p),p);sameHead();files.unmount();req.unmount();exec.unmount()
  const allPlan=await service.prepareRestoreScope('repo');await service.restoreWorktreeScope('repo',allPlan);for(const p of ['parent','outside-scope','tracked/empty'])assert.ok(!exists(dir+'/'+p));assert.ok(exists(dir+'/tracked'));sameHead()
 })
 await test('ignored/hidden/nonempty paths preserved; changed-to-nonempty and symlink after confirmation reject before touching Git files; capability absence fails closed',async()=>{
  mkdir('ignored/empty');mkdir('contains-ignored');write('contains-ignored/secret.hidden','KEEP');write('tracked/base','modified');mkdir('stale')
  const plan=await service.prepareRestoreScope('repo');assert.ok(!plan.empty.directories.some(d=>d.path==='ignored'||d.path==='contains-ignored'));assert.ok(plan.empty.retained.some(p=>p.includes('contains-ignored')))
  write('stale/new.hidden','KEEP');await assert.rejects(service.restoreWorktreeScope('repo',plan),/空目录已变化|非空/);assert.equal(fs.readFileSync(dir+'/tracked/base','utf8'),'modified');assert.equal(fs.readFileSync(dir+'/stale/new.hidden','utf8'),'KEEP')
  fs.unlinkSync(dir+'/stale/new.hidden');const linkPlan=await service.prepareRestoreScope('repo');fs.rmdirSync(dir+'/stale');fs.symlinkSync(outside,dir+'/stale');await assert.rejects(service.restoreWorktreeScope('repo',linkPlan),/变化|符号/);assert.ok(fs.lstatSync(dir+'/stale').isSymbolicLink());fs.unlinkSync(dir+'/stale');mkdir('stale')
  const python=global.Python;delete global.Python;await assert.rejects(service.prepareRestoreScope('repo'),/安全非递归/);global.Python=python;assert.equal(fs.readFileSync(dir+'/tracked/base','utf8'),'modified')
  const fresh=await service.prepareRestoreScope('repo');await service.restoreWorktreeScope('repo',fresh);assert.ok(!exists(dir+'/stale'));assert.ok(exists(dir+'/ignored/empty'));assert.equal(fs.readFileSync(dir+'/contains-ignored/secret.hidden','utf8'),'KEEP');sameHead()
 })
 await test('concurrent contents at atomic delete cannot be recursively removed; no directory scope escape, metadata/root guards and tracked/index paths protected',async()=>{
  mkdir('race');const plan=await service.prepareRestoreScope('repo','race');race=()=>write('race/late.hidden','KEEP');const result=await service.restoreWorktreeScope('repo',plan);assert.match(result,/保留/);assert.equal(fs.readFileSync(dir+'/race/late.hidden','utf8'),'KEEP')
  for(const scope of ['..','../outside','.git','tracked/../race','/','tracked//empty'])await assert.rejects(service.prepareRestoreScope('repo',scope),/不安全/)
  mkdir('indexed');write('indexed/base','index');cmd('add','indexed/base');mkdir('indexed/empty');const scoped=await service.prepareRestoreScope('repo','indexed/empty');await service.restoreWorktreeScope('repo',scoped);assert.ok(exists(dir+'/indexed'));assert.ok(exists(dir+'/indexed/base'));assert.ok(!exists(dir+'/indexed/empty'));sameHead()
 })
 await test('staged and untracked files retain existing HEAD restore semantics while file-only restore never sweeps sibling empty dirs',async()=>{
  write('tracked/base','staged');cmd('add','tracked/base');mkdir('tracked/sibling-empty');await service.restoreFile('repo','tracked/base');assert.equal(fs.readFileSync(dir+'/tracked/base','utf8'),'HEAD');assert.ok(exists(dir+'/tracked/sibling-empty'));assert.ok(!cmd('diff','--cached','--name-only').includes('tracked/base'));sameHead()
  write('tracked/untracked','new');const plan=await service.prepareRestoreScope('repo','tracked');await service.restoreWorktreeScope('repo',plan);assert.ok(!exists(dir+'/tracked/untracked'));sameHead()
  write('file-container/sub/new','new');mkdir('file-container/empty');const container=await service.prepareRestoreScope('repo','file-container');assert.equal(container.filepaths.length,1);assert.equal(container.empty.directories.length,3);await service.restoreWorktreeScope('repo',container);assert.ok(!exists(dir+'/file-container'));assert.ok(pythonCalls.includes('unlink'));sameHead()
 })
 await test('renamed folder swipe restore confirms both names, cancel preserves rename; real executor restores original bytes and clears destination/deleted ghosts only within paired scopes',async()=>{
  FileManager.rename=async(a,b)=>fs.renameSync(a,b)
  const beforeStage=cmd('ls-files','--stage');write('tracked/base','OUTSIDE KEEP')
  let pending=null,refresh=0;const shown=[]
  const req=mount(load('hooks/useRepoWorktreeActions.ts').useRepoWorktreeActions,{bookmarkName:'repo',changes:await service.getChanges('repo'),mergeInProgress:false,setPending:a=>pending=a,showToast:(...a)=>shown.push(a)})
  const props={files:await service.getTrackedFiles('repo'),worktreeEntries:await service.getWorktreeEntries('repo'),loading:false,bookmarkName:'repo',changes:await service.getChanges('repo'),onOpen(){},onPush(){},onStage(){},mergeInProgress:false,onRestore:(...args)=>req.tree.handleRestore(...args),onWorktreeChanged:async()=>{props.changes=await service.getChanges('repo');props.worktreeEntries=await service.getWorktreeEntries('repo')}}
  const files=mount(load('pages/FilesTab.tsx').FilesTab,props,{effectUpdates:true})
  function folder(name){files.render();return all(expand(files.tree)).find(n=>isFolderRow(n)&&all(n.children[0].children[0]).some(t=>t.type==='Text'&&t.children.includes(name)))}
  global.Dialog={prompt:async()=> 'renamed-fixture'}
  await all(folder('rename-fixture').props.contextMenu.menuItems).find(n=>n.props.title==='重命名').props.action()
  assert.ok(!exists(dir+'/rename-fixture'));assert.ok(exists(dir+'/renamed-fixture/nested/binary'))
  assert.equal(folder('rename-fixture'),undefined)
  await folder('renamed-fixture').props.trailingSwipeActions.actions.find(a=>a.props.title==='还原').props.action()
  for(let i=0;i<300&&!pending;i++)await new Promise(r=>setTimeout(r,10))
  assert.ok(pending?.restorePlan,JSON.stringify(shown));assert.deepEqual(new Set(pending.restorePlan.filepaths),new Set(['rename-fixture/main','rename-fixture/nested/binary','renamed-fixture/main','renamed-fixture/nested/binary']))
  assert.equal(alerts.getRepoPendingAlert(pending).message,"当前文件改动将丢失，不可撤销。")
  const exec=mount(load('hooks/useRepoPendingActions.ts').useRepoPendingActions,{bookmarkName:'repo',beginOpBusy:async()=>{},endOpBusy(){},reloadRepo:async()=>{refresh++;await props.onWorktreeChanged()},showAlert:(...a)=>shown.push(a),showToast:(...a)=>shown.push(a)})
  exec.tree.setPending(pending);exec.render();exec.tree.clearPending();exec.render();await exec.tree.runPending();assert.equal(refresh,0);assert.ok(exists(dir+'/renamed-fixture/main'));assert.ok(!exists(dir+'/rename-fixture'))
  exec.tree.setPending(pending);exec.render();await exec.tree.runPending();assert.equal(refresh,1)
  assert.equal(fs.readFileSync(dir+'/rename-fixture/main','utf8'),'original');assert.deepEqual(fs.readFileSync(dir+'/rename-fixture/nested/binary'),Buffer.from([0,255,3]));assert.ok(!exists(dir+'/renamed-fixture'))
  assert.ok(folder('rename-fixture'));assert.equal(folder('renamed-fixture'),undefined);assert.doesNotMatch(JSON.stringify(folder('rename-fixture').children[0].children[0]),/已删除|已重命名/)
  folder('rename-fixture').props.action();folder('nested').props.action();files.render();assert.doesNotMatch(JSON.stringify(expand(files.tree)),/已删除/)
  assert.equal(fs.readFileSync(dir+'/tracked/base','utf8'),'OUTSIDE KEEP');assert.equal(cmd('ls-files','--stage'),beforeStage);sameHead();files.unmount();req.unmount();exec.unmount()
 })
 await test('old-version deleted-folder outcome can be recovered from HEAD through the original folder row, with cancel still read-only',async()=>{
  fs.renameSync(dir+'/rename-fixture',dir+'/recovery-temporary');fs.rmSync(dir+'/recovery-temporary',{recursive:true})
  const plan=await service.prepareRestoreScope('repo','rename-fixture');assert.deepEqual(plan.filepaths,['rename-fixture/main','rename-fixture/nested/binary']);assert.ok(!exists(dir+'/rename-fixture'))
  await service.restoreWorktreeScope('repo',plan);assert.equal(fs.readFileSync(dir+'/rename-fixture/main','utf8'),'original');assert.deepEqual(fs.readFileSync(dir+'/rename-fixture/nested/binary'),Buffer.from([0,255,3]));sameHead()
  await assert.rejects(service.prepareRestoreScope('repo','not-a-real-deleted-folder'),/没有可恢复/)
 })
 await test('paired restore scopes reject unsafe/moved old paths and changed source contents before mutating either side',async()=>{
  write('paired-target/new','NEW KEEP')
  for(const source of ['', '..', '.git', '../outside', '/root'])await assert.rejects(service.prepareRestoreScope('repo','paired-target',[source]),/不安全|范围/)
  fs.symlinkSync(outside,dir+'/paired-old-link');await assert.rejects(service.prepareRestoreScope('repo','paired-target',['paired-old-link']),/安全目录/);fs.unlinkSync(dir+'/paired-old-link')
  const plan=await service.prepareRestoreScope('repo','paired-target',['paired-absent-old']);assert.ok(!exists(dir+'/paired-absent-old'));assert.deepEqual(plan.renameSources,['paired-absent-old'])
  write('paired-absent-old/late','OLD KEEP');await assert.rejects(service.restoreWorktreeScope('repo',plan),/文件列表已变化/)
  assert.equal(fs.readFileSync(dir+'/paired-target/new','utf8'),'NEW KEEP');assert.equal(fs.readFileSync(dir+'/paired-absent-old/late','utf8'),'OLD KEEP');sameHead()
 })
 await test('real coordinator preserves lock until confirmed restore completes; duplicate writers rejected and root relocation invalidates consent',async()=>{
  mkdir('lock');const plan=await service.prepareRestoreScope('repo','lock'),gate=deferred();const read=coordinator.read(ctx.gitdir,()=>gate.promise);let done=false;const restoring=service.restoreWorktreeScope('repo',plan).then(()=>done=true);await tick();assert.equal(done,false);await assert.rejects(service.restoreWorktreeScope('repo',plan),/写|操作/);gate.resolve();await read;await restoring;assert.ok(!exists(dir+'/lock'))
  mkdir('move');const old=await service.prepareRestoreScope('repo','move');root=outside;await assert.rejects(service.restoreWorktreeScope('repo',old));root=dir;assert.ok(exists(dir+'/move'));sameHead()
 })
 async function session(){
  FileManager.rename=async(a,b)=>fs.renameSync(a,b);FileManager.readAsData=async p=>new Data(fs.readFileSync(p))
  let pending=null;const shown=[]
  const req=mount(load('hooks/useRepoWorktreeActions.ts').useRepoWorktreeActions,{bookmarkName:'repo',mergeInProgress:false,setPending:a=>pending=a,showToast:(...a)=>shown.push(a)})
  const props={files:await service.getTrackedFiles('repo'),changes:await service.getChanges('repo'),worktreeEntries:await service.getWorktreeEntries('repo'),bookmarkName:'repo',loading:false,mergeInProgress:false,onOpen(){},onPush(){},onStage(){},onRestore:(...a)=>req.tree.handleRestore(...a),onWorktreeChanged:async()=>{props.changes=await service.getChanges('repo');props.worktreeEntries=await service.getWorktreeEntries('repo')}}
  const files=mount(load('pages/FilesTab.tsx').FilesTab,props,{effectUpdates:true})
  function rows(){files.render();const map=new Map();function visit(n){if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(visit);return}if(typeof n.type==='function'&&n.props.node){const raw=n.type(n.props),row=typeof raw.type==='function'?raw.type(raw.props):raw;map.set(n.props.node.path,row);visit(row);return}Object.values(n).forEach(visit)}visit(files.tree);return map}
  function item(p){const parts=p.split('/');for(let i=1;i<parts.length;i++){const group=rows().get(parts.slice(0,i).join('/'));if(group&&!folderExpanded(group))group.props.action()}const row=rows().get(p);assert.ok(row,'row '+p);return row}
  async function rename(p,name){global.Dialog={prompt:async()=>name};await all(item(p).props.contextMenu.menuItems).find(n=>n.props.title==='重命名').props.action()}
  async function preview(p){pending=null;const row=item(p),actions=row.props.trailingSwipeActions.actions;await actions.find(n=>n.props.title==='还原').props.action();for(let i=0;i<300&&!pending;i++)await new Promise(r=>setTimeout(r,10));assert.ok(pending,JSON.stringify(shown));return pending}
  const exec=mount(load('hooks/useRepoPendingActions.ts').useRepoPendingActions,{bookmarkName:'repo',beginOpBusy:async()=>{},endOpBusy(){},reloadRepo:props.onWorktreeChanged,showAlert:(...a)=>shown.push(a),showToast:(...a)=>shown.push(a)})
  async function restore(p,cancel=false){const plan=await preview(p);exec.tree.setPending(plan);exec.render();if(cancel){exec.tree.clearPending();exec.render()}await exec.tree.runPending();return plan}
  return {props,files,item,rename,preview,restore,shown,close(){files.unmount();req.unmount();exec.unmount()}}
 }
 await test('all file types: actual native rename -> page remount -> single-file swipe restore recovers original bytes, removes target, clears D/A and preserves unrelated edits',async()=>{
  write('tracked/base','UNRELATED')
  for(const [name,bytes]of renameSamples){
   const source='rename-cases/'+name,target='rename-cases/renamed-'+name;let e=await session();await e.rename(source,'renamed-'+name);assert.ok(!exists(dir+'/'+source));assert.deepEqual(fs.readFileSync(dir+'/'+target),bytes);e.close()
   e=await session();const plan=await e.restore(target,true);assert.deepEqual(new Set(plan.restorePlan.filepaths),new Set([source,target]));assert.ok(!exists(dir+'/'+source));assert.ok(exists(dir+'/'+target))
   await e.restore(target);assert.deepEqual(fs.readFileSync(dir+'/'+source),bytes);assert.ok(!exists(dir+'/'+target));assert.doesNotMatch(JSON.stringify(e.item(source).children),/已删除|已重命名/)
   assert.ok(!(await service.getChanges('repo')).some(c=>c.filepath===source||c.filepath===target));assert.equal(fs.readFileSync(dir+'/tracked/base','utf8'),'UNRELATED');sameHead();e.close()
  }
 })
 await test('file/parent mixed rename orders, multiple renames, directory and nested-file restore never leave original files deleted',async()=>{
  // Child first, then parent twice: all names are reconstructed from exact native operations.
  let e=await session();await e.rename('rename-fixture/main','renamed-main');await e.rename('rename-fixture','mixed-parent');await e.rename('mixed-parent','mixed-final');e.close();e=await session();await e.restore('mixed-final');assert.equal(fs.readFileSync(dir+'/rename-fixture/main','utf8'),'original');assert.ok(!exists(dir+'/mixed-final'));assert.ok(!exists(dir+'/mixed-parent'));assert.ok(!(await service.getChanges('repo')).some(c=>c.filepath.startsWith('rename-fixture/')));e.close()
  // Parent first, then child: restore only child, preserve binary sibling in new folder, then restore parent.
  e=await session();await e.rename('rename-fixture','parent-first');await e.rename('parent-first/main','child-second');await e.restore('parent-first/child-second');assert.equal(fs.readFileSync(dir+'/rename-fixture/main','utf8'),'original');assert.ok(!exists(dir+'/parent-first/child-second'));assert.deepEqual(fs.readFileSync(dir+'/parent-first/nested/binary'),Buffer.from([0,255,3]));await e.restore('parent-first');assert.ok(!exists(dir+'/parent-first'));assert.deepEqual(fs.readFileSync(dir+'/rename-fixture/nested/binary'),Buffer.from([0,255,3]));e.close();sameHead()
  // File rename twice, stage the D/A pair, and restore: HEAD paths/index content are restored.
  e=await session();await e.rename('rename-cases/code.ts','chain-one.ts');await e.rename('rename-cases/chain-one.ts','chain-two.ts');cmd('add','-A','rename-cases');await e.restore('rename-cases/chain-two.ts');assert.deepEqual(fs.readFileSync(dir+'/rename-cases/code.ts'),renameSamples[0][1]);assert.ok(!exists(dir+'/rename-cases/chain-one.ts'));assert.ok(!exists(dir+'/rename-cases/chain-two.ts'));assert.equal(cmd('diff','--cached','--name-only','--','rename-cases'),'');e.close();sameHead()
 })
 await test('recreated old name is preserved; invalid later path preflight prevents earlier file mutations; failed/cancelled rename records no false association',async()=>{
  let e=await session();await e.rename('rename-cases/code.js','recreated-new.js');write('rename-cases/code.js','RECREATED KEEP');await e.restore('rename-cases/recreated-new.js');assert.equal(fs.readFileSync(dir+'/rename-cases/code.js','utf8'),'RECREATED KEEP');assert.ok(!exists(dir+'/rename-cases/recreated-new.js'));e.close();await service.restoreFile('repo','rename-cases/code.js')
  e=await session();const native=FileManager.rename;FileManager.rename=async()=>{throw Error('native failed')};await e.rename('rename-cases/config.json','never-created.json');FileManager.rename=native;assert.ok(exists(dir+'/rename-cases/config.json'));assert.ok(!exists(dir+'/rename-cases/never-created.json'));assert.ok(!service.knownLocalRenameHints('repo').some(h=>h.path.endsWith('never-created.json')));e.close()
  // Revalidate ALL paths before first checkout: source is unchanged if the later target is replaced by a symlink.
  e=await session();await e.rename('rename-cases/README.md','unsafe-target.md');const action=await e.preview('rename-cases/unsafe-target.md');fs.unlinkSync(dir+'/rename-cases/unsafe-target.md');fs.symlinkSync(outside,dir+'/rename-cases/unsafe-target.md');await assert.rejects(service.restoreWorktreeScope('repo',action.restorePlan),/安全|变化|符号/);assert.ok(!exists(dir+'/rename-cases/README.md'));assert.ok(fs.lstatSync(dir+'/rename-cases/unsafe-target.md').isSymbolicLink());fs.unlinkSync(dir+'/rename-cases/unsafe-target.md');fs.writeFileSync(dir+'/rename-cases/unsafe-target.md',renameSamples[3][1]);await e.props.onWorktreeChanged();await e.restore('rename-cases/unsafe-target.md');e.close();sameHead()
 })
 await test('nested directory rename composition and old-path entry restore remove both sides without deleted ghosts',async()=>{
  let e=await session();await e.rename('rename-fixture','nest-parent');await e.rename('nest-parent/nested','renamed-child');e.close()
  const plan=await service.prepareRestoreScope('repo','rename-fixture/nested');assert.ok(plan.filepaths.includes('nest-parent/renamed-child/binary'));assert.ok(plan.filepaths.includes('rename-fixture/nested/binary'));await service.restoreWorktreeScope('repo',plan);assert.deepEqual(fs.readFileSync(dir+'/rename-fixture/nested/binary'),Buffer.from([0,255,3]));assert.ok(!exists(dir+'/nest-parent/renamed-child'));await service.restoreWorktreeScope('repo',await service.prepareRestoreScope('repo','nest-parent'));assert.ok(!exists(dir+'/nest-parent'));assert.ok(!(await service.getChanges('repo')).some(c=>c.filepath.startsWith('rename-fixture/')))
  e=await session();await e.rename('rename-cases/config.json','old-side.json');e.close();await service.restoreWorktreeScope('repo',await service.prepareRestoreScope('repo','rename-cases/config.json',[],false));assert.deepEqual(fs.readFileSync(dir+'/rename-cases/config.json'),renameSamples[2][1]);assert.ok(!exists(dir+'/rename-cases/old-side.json'));sameHead()
 })
 await test('original checkout failure and HEAD I/O failure preserve all renamed destination bytes',async()=>{
  let e=await session();await e.rename('rename-cases/code.ts','aaa-target.ts');e.close();const plan=await service.prepareRestoreScope('repo','rename-cases/aaa-target.ts',[],false);const checkout=git.checkout;git.checkout=async options=>{if(options.filepaths?.includes('rename-cases/code.ts'))throw Error('injected checkout failure');return checkout(options)}
  try{await assert.rejects(service.restoreWorktreeScope('repo',plan),/injected/);assert.deepEqual(fs.readFileSync(dir+'/rename-cases/aaa-target.ts'),renameSamples[0][1]);assert.ok(!exists(dir+'/rename-cases/code.ts'))}finally{git.checkout=checkout}
  const resolve=git.resolveRef;git.resolveRef=async()=>{throw Object.assign(Error('HEAD I/O failure'),{code:'EIO'})};try{await assert.rejects(service.prepareRestoreScope('repo','rename-cases/aaa-target.ts',[],false),/HEAD I\/O/);assert.deepEqual(fs.readFileSync(dir+'/rename-cases/aaa-target.ts'),renameSamples[0][1])}finally{git.resolveRef=resolve}
  await service.restoreWorktreeScope('repo',await service.prepareRestoreScope('repo','rename-cases/aaa-target.ts',[],false));sameHead()
 })
 await test('production FileManager fs adapter restore uses guarded native unlink/rmdir path, not recursive FileManager.remove',async()=>{
  Object.assign(FileManager,{readAsBytes:async p=>new Uint8Array(fs.readFileSync(p)),writeAsBytes:async(p,b)=>fs.writeFileSync(p,b),writeAsString:async(p,s)=>fs.writeFileSync(p,s),createDirectory:async(p,recursive)=>fs.mkdirSync(p,{recursive}),rename:async(a,b)=>fs.renameSync(a,b)})
  const core=require('./remoteFiles.test.cjs').load('services/gitCore.ts',{'../polyfills':{}}),original=ctx.fs;ctx.fs=core.createFS(ctx.gitdir,dir)
  write('tracked/base','adapter modified');write('tracked/adapter-new','adapter new');mkdir('tracked/adapter-empty');const before=removed.length,plan=await service.prepareRestoreScope('repo','tracked');await service.restoreWorktreeScope('repo',plan);assert.equal(fs.readFileSync(dir+'/tracked/base','utf8'),'HEAD');assert.ok(!exists(dir+'/tracked/adapter-new'));assert.ok(!exists(dir+'/tracked/adapter-empty'));assert.equal(removed.length,before);sameHead();ctx.fs=original
 })
 console.log(groups+' real FS + actual Python os.rmdir + production facade/home/folder restore groups passed; no recursive directory remove, no phone/network Git mutations.')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}))
