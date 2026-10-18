/* Actual bundled Git, production fs adapter/HEAD-only service/coordinator; disposable split gitdir only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process')
const {load,mount,ui,all,tick,deferred}=require('./remoteFiles.test.cjs');global.self=globalThis
const git=require('../vendor/index.umd.min.js'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-head-'))
const group=tmp+'/group',dir=tmp+'/work',gitdir=group+'/git-repos/repo'
fs.mkdirSync(path.dirname(gitdir),{recursive:true});cp.execFileSync('git',['init','-q','-b','master','--separate-git-dir='+gitdir,dir])
const cmd=(...args)=>cp.execFileSync('git',['--git-dir='+gitdir,'--work-tree='+dir,...args],{encoding:'utf8'})
cmd('config','user.name','Test');cmd('config','user.email','test@example.invalid');fs.writeFileSync(dir+'/a','base a\n');fs.writeFileSync(dir+'/b','base b\n');cmd('add','.');cmd('commit','-qm','base')
const oid=cmd('rev-parse','HEAD').trim();cmd('branch','matching');cmd('update-ref','refs/remotes/origin/master',oid);cmd('symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/master');cmd('pack-refs','--all')
fs.writeFileSync(dir+'/a','staged a\n');cmd('add','a');fs.writeFileSync(dir+'/a','working a\n');fs.writeFileSync(dir+'/b','working b\n');fs.writeFileSync(dir+'/binary',Buffer.from([0,255,1,2]));fs.writeFileSync(gitdir+'/HEAD',oid+'\n')
const writes=[],reads=[];let failWrite=null,readCommitHook=null
const exists=p=>{try{fs.lstatSync(p);return true}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return false;throw e}}
const fm={appGroupDocumentsDirectory:group,scriptsDirectory:tmp,documentsDirectory:tmp,
 exists:async p=>exists(p),existsSync:exists,
 isLink:async p=>exists(p)&&fs.lstatSync(p).isSymbolicLink(),isLinkSync:p=>exists(p)&&fs.lstatSync(p).isSymbolicLink(),
 isDirectory:async p=>exists(p)&&fs.statSync(p).isDirectory(),isDirectorySync:p=>exists(p)&&fs.statSync(p).isDirectory(),
 readDirectory:async p=>fs.promises.readdir(p),stat:async p=>{const s=await fs.promises.stat(p);return {size:s.size,creationDate:s.birthtimeMs,modificationDate:s.mtimeMs,type:s.isDirectory()?'directory':'file'}},
 readAsString:async p=>{reads.push(p);return fs.promises.readFile(p,'utf8')},readAsStringSync:p=>{reads.push(p);return fs.readFileSync(p,'utf8')},readAsBytes:async p=>new Uint8Array(await fs.promises.readFile(p)),readAsBytesSync:p=>new Uint8Array(fs.readFileSync(p)),
 writeAsStringSync(p,text){assert.equal(p,gitdir+'/HEAD','association may ONLY write HEAD');writes.push(p);if(failWrite)return failWrite(p,text);fs.writeFileSync(p,text)},
 writeAsString:async(p,text)=>fs.promises.writeFile(p,text),writeAsBytes:async(p,bytes)=>{await fs.promises.mkdir(path.dirname(p),{recursive:true});await fs.promises.writeFile(p,bytes)},
 createDirectory:async p=>fs.promises.mkdir(p,{recursive:true}),remove:async p=>fs.promises.rm(p,{recursive:true,force:true}),rename:async(a,b)=>fs.promises.rename(a,b),createLink:async(p,target)=>fs.promises.symlink(target,p),
}
global.FileManager=fm
const core=load('services/gitCore.ts',{'../polyfills':{}}),adapter=core.createFS(gitdir,dir),ctx={git,fs:adapter,dir,gitdir}
const {StatusCoordinator}=load('utils/statusCoordinator.ts'),coordinator=new StatusCoordinator({writeWaitMs:1000})
const status=load('services/git/statusScanService.ts',{'./matrixScanService':{statusCoordinator:coordinator},'./runtime':{resolveGitdir:()=>gitdir},'../../utils/statusFreshness':{}})
const resolver={resolveRepoPathsReadOnly:()=>({workdir:dir,gitdir,storedWorkdir:dir,source:'fixture',bookmarkChecks:[]})}
const association=load('services/headAssociation.ts',{'./repoStore':resolver,'./gitCore':{createFS:core.createFS,loadGitEngine:async()=>({git:{...git,readCommit:async options=>{const result=await git.readCommit(options);if(readCommitHook)await readCommitHook();return result}}})},'../utils/branch':load('utils/branch.ts'),'./git/matrixScanService':{statusCoordinator:coordinator},'./git/statusScanService':status})
function files(){const out={};function walk(p){for(const name of fs.readdirSync(p)){const full=p+'/'+name,s=fs.lstatSync(full);if(s.isDirectory())walk(full);else out[full]=s.isSymbolicLink()?['link',fs.readlinkSync(full)]:['file',s.mode,fs.readFileSync(full).toString('base64')]}}walk(tmp);return out}
const detached=()=>fs.writeFileSync(gitdir+'/HEAD',oid+'\n')
async function rejectedUnchanged(action,pattern){const before=files(),count=writes.length;await assert.rejects(action,pattern);assert.deepEqual(files(),before);assert.equal(writes.length,count)}
let groups=0;async function test(name,fn){await fn();groups++;console.log('PASS '+name)}
async function main(){
 await test('fresh same-OID packed local candidates are read-only; explicit branch only changes HEAD text with staged/unstaged/binary work intact',async()=>{
  const before=files(),index=fs.readFileSync(gitdir+'/index'),workA=fs.readFileSync(dir+'/a'),refs=cmd('show-ref'),headOid=cmd('rev-parse','HEAD')
  const preview=await association.inspectHeadAssociation('repo');assert.deepEqual(preview.branches,['master','matching']);assert.equal(preview.headOid,oid);assert.deepEqual(files(),before);assert.equal(writes.length,0)
  await association.associateDetachedHead('repo','master',preview,true)
  const after=files();assert.equal(fs.readFileSync(gitdir+'/HEAD','utf8'),'ref: refs/heads/master\n');delete before[gitdir+'/HEAD'];delete after[gitdir+'/HEAD'];assert.deepEqual(after,before)
  assert.deepEqual(fs.readFileSync(gitdir+'/index'),index);assert.deepEqual(fs.readFileSync(dir+'/a'),workA);assert.equal(cmd('show-ref'),refs);assert.equal(cmd('rev-parse','HEAD'),headOid);assert.equal(writes.length,1)
  detached()
 })
 await test('cancel/unlisted/invalid branch, symbolic HEAD, target moved, broken packed refs, lock/merge state and symlinks all reject without writes',async()=>{
  let p=await association.inspectHeadAssociation('repo')
  await rejectedUnchanged(()=>association.associateDetachedHead('repo','master',p,false),/未确认/)
  await rejectedUnchanged(()=>association.associateDetachedHead('repo','not-a-candidate',p,true),/明确选择/)
  await rejectedUnchanged(()=>association.associateDetachedHead('repo','../master',p,true),/明确选择/)
  fs.writeFileSync(gitdir+'/HEAD','ref: refs/heads/master\n');await rejectedUnchanged(()=>association.associateDetachedHead('repo','master',p,true),/不是有效的分离/);detached()
  for(const marker of ['index.lock','HEAD.lock','MERGE_HEAD','gitgit-merge-state.json']){fs.writeFileSync(gitdir+'/'+marker,'lock');await rejectedUnchanged(()=>association.associateDetachedHead('repo','master',p,true),/Git 锁|未完成/);fs.unlinkSync(gitdir+'/'+marker)}
  const savedIndex=fs.readFileSync(gitdir+'/index');cmd('update-index','--index-info');
  const blob=cmd('rev-parse',oid+':a').trim();cp.execFileSync('git',['--git-dir='+gitdir,'--work-tree='+dir,'update-index','--index-info'],{input:`0 ${'0'.repeat(40)}\ta\n100644 ${blob} 1\ta\n100644 ${blob} 2\ta\n100644 ${blob} 3\ta\n`})
  await rejectedUnchanged(()=>association.associateDetachedHead('repo','master',p,true),/冲突/);fs.writeFileSync(gitdir+'/index',savedIndex)
  fs.writeFileSync(gitdir+'/refs/heads/master','a'.repeat(40)+'\n');await rejectedUnchanged(()=>association.associateDetachedHead('repo','master',p,true),/已变化/);fs.unlinkSync(gitdir+'/refs/heads/master')
  const packed=fs.readFileSync(gitdir+'/packed-refs');fs.appendFileSync(gitdir+'/packed-refs','invalid\n');await rejectedUnchanged(()=>association.associateDetachedHead('repo','master',p,true),/格式异常/);fs.writeFileSync(gitdir+'/packed-refs',packed)
  fs.renameSync(gitdir+'/HEAD',gitdir+'/saved-head');fs.symlinkSync(gitdir+'/saved-head',gitdir+'/HEAD');await rejectedUnchanged(()=>association.associateDetachedHead('repo','master',p,true),/文件类型异常/);fs.unlinkSync(gitdir+'/HEAD');fs.renameSync(gitdir+'/saved-head',gitdir+'/HEAD')
 })
 await test('real coordinator excludes concurrent Git writers; stale HEAD and last-moment ref changes reject before HEAD write',async()=>{
  const p=await association.inspectHeadAssociation('repo'),gate=deferred();let started=false
  const active=coordinator.mutate(gitdir,async()=>{started=true;await gate.promise});while(!started)await tick()
  await rejectedUnchanged(()=>association.inspectHeadAssociation('repo'),/其它 Git 写/)
  await rejectedUnchanged(()=>association.associateDetachedHead('repo','master',p,true),/其它写操作/);gate.resolve();await active
  fs.writeFileSync(gitdir+'/HEAD','b'.repeat(40)+'\n');await rejectedUnchanged(()=>association.associateDetachedHead('repo','master',p,true));detached()
  const beforeHead=fs.readFileSync(gitdir+'/HEAD'),index=fs.readFileSync(gitdir+'/index'),count=writes.length
  readCommitHook=async()=>{fs.writeFileSync(gitdir+'/refs/heads/master','c'.repeat(40)+'\n')}
  await assert.rejects(association.associateDetachedHead('repo','master',p,true),/引用已变化/);readCommitHook=null
  assert.equal(writes.length,count);assert.deepEqual(fs.readFileSync(gitdir+'/HEAD'),beforeHead);assert.deepEqual(fs.readFileSync(gitdir+'/index'),index);fs.unlinkSync(gitdir+'/refs/heads/master')
 })
 await test('write I/O failure including simulated partial write restores original HEAD; other files remain byte-identical',async()=>{
  const p=await association.inspectHeadAssociation('repo'),before=files()
  failWrite=()=>{throw Error('write denied')};await assert.rejects(association.associateDetachedHead('repo','master',p,true),/保持原分离/);failWrite=null;assert.deepEqual(files(),before)
  let once=true;failWrite=(file,text)=>{if(once){once=false;fs.writeFileSync(file,'partial');throw Error('partial failure')}fs.writeFileSync(file,text)}
  await assert.rejects(association.associateDetachedHead('repo','master',p,true),/保持原分离/);failWrite=null;assert.deepEqual(files(),before)
 })
 await test('real bundled checkout noUpdateHead:true preserves symbolic HEAD for OID; restore-by-HEAD bug reproduced and production fix preserves association; explicit OID detach retained',async()=>{
  const runtime=load('services/git/runtime.ts',{scripting:ui,'../gitCore':{},'../repoStore':{},'../../utils/branch':load('utils/branch.ts'),'../../utils/stash':{},'./matrixScanService':{}})
  fs.writeFileSync(gitdir+'/HEAD','ref: refs/heads/master\n');const raw=fs.readFileSync(gitdir+'/HEAD')
  await git.checkout({...ctx,ref:oid,filepaths:['b'],noUpdateHead:true,force:true});assert.deepEqual(fs.readFileSync(gitdir+'/HEAD'),raw)
  await git.checkout({...ctx,ref:'HEAD',filepaths:['b'],force:true});assert.equal(fs.readFileSync(gitdir+'/HEAD','utf8'),oid+'\n','old restore behavior actually detaches')
  fs.writeFileSync(gitdir+'/HEAD',raw);fs.writeFileSync(dir+'/b','changed again')
  const service=load('services/git/worktreeService.ts',{'./emptyDirectoryRemoval':load('services/git/emptyDirectoryRemoval.ts'),'./matrixScanService':{},'../../constants/git':{},'../../utils/stageSelection':{},'../../utils/stash':{},'../authStore':{},'./runtime':{...runtime,getCtx:async()=>ctx},'./pathStashService':{}})
  await service.restoreFileInternal('repo','b');assert.equal(fs.readFileSync(dir+'/b','utf8'),'base b\n');assert.deepEqual(fs.readFileSync(gitdir+'/HEAD'),raw)
  await runtime.forceCheckoutRef(git,adapter,dir,gitdir,'HEAD');assert.deepEqual(fs.readFileSync(gitdir+'/HEAD'),raw,'abort fallback source HEAD must stay attached')
  const mergeUtil=load('utils/mergeConflict.ts');fs.writeFileSync(gitdir+'/gitgit-merge-state.json',mergeUtil.serializeMergeState(mergeUtil.buildMergeState({oursOid:oid,theirsOid:oid,conflicts:[]})))
  const abortCtx={...ctx,git:{...git,abortMerge:async()=>{throw Error('force fallback for regression')}}}
  const mergeService=load('services/git/mergeConflictService.ts',{'../authStore':{},'../../utils/mergeConflict':mergeUtil,'./commitService':{},'./runtime':{...runtime,getCtx:async()=>abortCtx}})
  await mergeService.abortMergeInternal('repo');assert.deepEqual(fs.readFileSync(gitdir+'/HEAD'),raw,'actual abort fallback preserves symbolic HEAD');assert.equal(fs.existsSync(gitdir+'/gitgit-merge-state.json'),false)

  await runtime.forceCheckoutRef(git,adapter,dir,gitdir,oid);assert.equal(fs.readFileSync(gitdir+'/HEAD','utf8'),oid+'\n','explicit OID detach still works')
  await runtime.forceCheckoutRef(git,adapter,dir,gitdir,'matching');assert.equal(fs.readFileSync(gitdir+'/HEAD','utf8'),'ref: refs/heads/matching\n','named switch still works');detached()
 })
 await test('actual diagnostic UI: multiple choices require explicit selection and confirmation; cancel never invokes association; success refreshes only report/display callback',async()=>{
  let checks=0,associations=[],choice=false,updates=[],reports=0
  const Page=load('pages/RepoDiagnosticsPage.tsx',{scripting:ui,'../services/repoDiagnostics':{collectRepoDiagnostics:async()=>{reports++;return 'REPORT'},diagnosticText:String},'../services/headAssociation':{inspectHeadAssociation:async()=>{checks++;return {gitdir,headOid:oid,branches:['master','matching']}},associateDetachedHead:async(...args)=>{associations.push(args);return args[1]},headAssociationErrorMessage:String}}).RepoDiagnosticsPage
  global.Dialog={confirm:async options=>{assert.equal(options.confirmLabel,'仅关联 HEAD');assert.match(options.message,/不 checkout\/reset\/stash/);return choice}}
  const h=mount(Page,{bookmarkName:'repo',onClose(){},onAssociated:b=>updates.push(b)});await tick()
  const button=title=>{h.render();return all(h.tree).find(n=>n.type==='Button'&&n.props.title===title)}
  assert.equal(checks,0);assert.equal(associations.length,0);button('查找同提交的本地分支（只读）').props.action();await tick()
  assert.equal(checks,1);assert.equal(associations.length,0);assert.ok(button('关联到「matching」…'))
  button('关联到「master」…').props.action();await tick();assert.equal(associations.length,0);assert.deepEqual(updates,[])
  choice=true;button('关联到「matching」…').props.action();await tick();assert.equal(associations.length,1);assert.equal(associations[0][1],'matching');assert.equal(associations[0][3],true);assert.deepEqual(updates,['matching']);assert.equal(reports,2);h.unmount()
 })
 await test('association display callback only updates in-memory branch selection and local label; no extra query/snapshot/config/worktree writes',async()=>{
  let queries=0
  const hook=load('hooks/useRepoDetailData.ts',{scripting:ui,'../services/gitService':{getManagedBranches:async()=>{queries++;return {current:null,locals:[],remotes:['master'],remoteNames:['master']}}},'../services/repoStore':{findRepo:()=>undefined},'../utils/format':{},'../utils/github':{},'../utils/statusFreshness':{}}).useRepoDetailData
  const h=mount(hook,{bookmarkName:'repo',name:'All',showToast(){}});await h.tree.loadBranches();h.render();h.tree.setChanges([{filepath:'a',status:'*modified'}]);h.render();const changes=h.tree.changes,count=writes.length
  h.tree.acceptHeadAssociation('master');h.render();assert.equal(h.tree.branchInfo.current,'master');assert.deepEqual(h.tree.remoteOnlyBranches,[]);assert.equal(h.tree.changes,changes);assert.equal(queries,1);assert.equal(writes.length,count);h.unmount()
 })
 console.log(groups+' HEAD association/checkout groups passed; no phone or real remote access.')
}
const watchdog=setTimeout(()=>{console.error('FAIL HEAD tests did not finish');process.exitCode=1},30000)
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{clearTimeout(watchdog);fs.rmSync(tmp,{recursive:true,force:true})})
