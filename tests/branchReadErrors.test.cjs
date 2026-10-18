/* Actual branch-query + runtime + detail hook; disposable filesystem only, no network/writes by queried paths. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {load,mount,ui,all}=require('./remoteFiles.test.cjs')
global.self=globalThis
const git=require('../vendor/index.umd.min.js'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-branch-read-')),dir=tmp+'/work',gitdir=dir+'/.git'
fs.mkdirSync(dir)
global.FileManager={appGroupDocumentsDirectory:tmp,exists:async p=>fs.existsSync(p),createDirectory:async()=>{throw Error('unexpected directory creation')}}
let ctx={git,fs,dir,gitdir},meta={bookmarkName:'repo',name:'test',source:'clone',repoId:'fixture',createdAt:1}
const branch=load('utils/branch.ts'),store={findRepo:()=>meta,getGitdirPath:()=>gitdir,resolveWorkdir:()=>dir,getRepoLastPulledAt:()=>null}
const runtime=load('services/git/runtime.ts',{scripting:ui,'../gitCore':{createFS:()=>ctx.fs,loadGitEngine:async()=>({git:ctx.git})},'../repoStore':store,'./matrixScanService':{},'../../utils/stash':{},'../../utils/branch':branch})
const query=load('services/git/branchQueryService.ts',{'./runtime':runtime})
const progress=load('utils/remoteProgress.ts'),remote=load('utils/remote.ts')
let fetches=0
const auto=load('services/git/autoPullService.ts',{'../gitCore':{createHttpTransport:()=>{throw Error('unexpected network')}},'../authStore':{getAuth:()=>null},'../repoStore':{...store,updateBranchLastPulledAt:()=>{throw Error('unexpected timestamp write')}},'./runtime':runtime,'../../utils/remote':remote,'../../utils/remoteProgress':progress})
const fmt=load('utils/format.ts'),github=load('utils/github.ts'),fresh=load('utils/statusFreshness.ts')
const hook=load('hooks/useRepoDetailData.ts',{scripting:ui,'../services/gitService':{getManagedBranches:query.getManagedBranches,isInitialized:async()=>true,getChanges:async()=>[],hasHeadCommit:async()=>true,listRemotes:async()=>[],getBranchUpstream:async()=>null,getMergeConflictState:async()=>null,getTrackedFiles:async()=>[],getRepoListStatus:async()=>{},statusRevision:()=>0},'../services/repoStore':store,'../utils/format':fmt,'../utils/github':github,'../utils/statusFreshness':fresh}).useRepoDetailData
const colors=load('constants/colors.ts'),BranchSection=load('components/RepoBranchSection.tsx',{scripting:ui,'../constants/colors':colors,'../constants/git':{DEFAULT_BRANCH:'main'}}).RepoBranchSection
const RemoteSections=load('components/RepoRemoteSections.tsx',{scripting:ui,'../constants/colors':colors,'../constants/git':{DEFAULT_BRANCH:'main'},'../utils/branchMerge':load('utils/branchMerge.ts',{'./remote':remote})}).RepoRemoteSections
let groups=0
async function test(name,fn){await fn();groups++;console.log('PASS '+name)}
function error(code,message){return Object.assign(Error(message),{code})}
function localFailure(cause){ctx={git:{...git,listBranches:async options=>{if(!options.remote)throw cause;return git.listBranches(options)}},fs,dir,gitdir}}
function headFailure(cause){ctx={git,fs:{...fs,promises:{...fs.promises,readFile:async(p,...args)=>{if(p===gitdir+'/HEAD')throw cause;return fs.promises.readFile(p,...args)}}},dir,gitdir}}
function branchView(api){return BranchSection({...api,hasRemote:true,mutating:false,onDelete(){},onMerge(){},onRename(){},onCreate(){},onSwitch(){}})}
function visible(node){return JSON.stringify({children:node.children,footer:node.props.footer})}
async function main(){try{
 await git.init({fs,dir,defaultBranch:'topic'})
 const oid='a'.repeat(40)
 await test('real normal/unborn/empty/detached/uninitialized query results remain valid, not guessed',async()=>{
  let result=await query.getManagedBranches('repo');assert.equal(result.current,'topic');assert.deepEqual(result.locals,['topic'])
  fs.mkdirSync(gitdir+'/refs/remotes/origin',{recursive:true});fs.writeFileSync(gitdir+'/refs/remotes/origin/master',oid+'\n')
  fs.writeFileSync(gitdir+'/refs/heads/topic',oid+'\n');result=await query.getManagedBranches('repo');assert.deepEqual(result.locals,['topic']);assert.deepEqual(result.remotes,['master']);assert.equal((await query.getBranches('repo')).current,'topic')
  fs.writeFileSync(gitdir+'/HEAD',oid+'\n');fs.unlinkSync(gitdir+'/refs/heads/topic');result=await query.getManagedBranches('repo');assert.equal(result.current,null);assert.deepEqual(result.locals,[]);assert.deepEqual(result.remotes,['master']);assert.equal(await query.getCurrentBranchName('repo'),null)
  fs.unlinkSync(gitdir+'/HEAD');assert.deepEqual(await query.getManagedBranches('repo'),{current:null,locals:[],remotes:[],remoteNames:[],hasRemote:false});assert.deepEqual(await query.getBranches('repo'),{branches:[],current:null});assert.equal(await runtime.resolveCurrentBranch(git,fs,dir,gitdir),null)
  fs.writeFileSync(gitdir+'/HEAD','ref: refs/heads/topic\n')
 })
 await test('both real query entrypoints propagate local enumeration failures with original code/reason; no remote-only successful result',async()=>{
  for(const code of ['EACCES','EIO','ParseError']){const cause=error(code,code+' local refs enumeration failed');localFailure(cause);for(const fn of [query.getBranches,query.getManagedBranches])await assert.rejects(fn('repo'),e=>e===cause&&e.code===code)}
  ctx={git,fs,dir,gitdir}
 })
 await test('HEAD native I/O, engine errors and malformed HEAD never become null/empty success; detached remains null',async()=>{
  for(const code of ['EACCES','EIO']){const cause=error(code,code+' HEAD unreadable');headFailure(cause);for(const fn of [query.getBranches,query.getManagedBranches,query.getCurrentBranchName])await assert.rejects(fn('repo'),e=>e===cause)}
  const cause=error('ParseError','engine cannot parse HEAD');ctx={git:{...git,currentBranch:async()=>{throw cause}},fs,dir,gitdir};await assert.rejects(query.getManagedBranches('repo'),e=>e===cause)
  ctx={git,fs,dir,gitdir};fs.writeFileSync(gitdir+'/HEAD','broken HEAD\n');await assert.rejects(query.getManagedBranches('repo'),/HEAD 内容无效/);fs.writeFileSync(gitdir+'/HEAD',oid+'\n');assert.equal((await query.getManagedBranches('repo')).current,null);fs.writeFileSync(gitdir+'/HEAD','ref: refs/heads/topic\n')
 })
 await test('actual detail hook retains full prior branch snapshot after failed reload and loadAll cannot cache failure as success; retry recovers',async()=>{
  const toasts=[],h=mount(hook,{bookmarkName:'repo',name:'test',showToast:(...a)=>toasts.push(a)})
  await h.tree.loadBranches();h.render();const snapshot=h.tree.branchInfo,remotes=h.tree.remoteOnlyBranches,names=h.tree.remoteBranchNames;assert.equal(h.tree.branchStateKnown,true)
  const cause=error('EACCES','permission denied local refs');localFailure(cause);await assert.rejects(h.tree.loadBranches(),e=>e===cause);h.render();assert.equal(h.tree.branchInfo,snapshot);assert.equal(h.tree.remoteOnlyBranches,remotes);assert.equal(h.tree.remoteBranchNames,names);assert.equal(h.tree.branchStateKnown,false);assert.match(h.tree.branchError,/permission denied/)
  const view=branchView(h.tree);assert.match(visible(view),/上次成功/);assert.ok(all(view).find(n=>n.type==='Picker').props.disabled);assert.doesNotMatch(visible(view),/默认 main|尚未初始化/)
  await h.tree.loadAll('test',true);h.render();assert.equal(h.tree.branchStateKnown,false);assert.match(toasts.at(-1)[0],/permission denied/)
  ctx={git,fs,dir,gitdir};await h.tree.loadAll('retry',false);h.render();assert.equal(h.tree.branchStateKnown,true);assert.equal(h.tree.branchError,null);assert.equal(h.tree.branchInfo.current,'topic');h.unmount()
 })
 await test('first-failure and initial-loading UI expose unknown state not default main/uninitialized; branch/sync/upload actions disabled',async()=>{
  const h=mount(hook,{bookmarkName:'repo',name:'test',showToast(){}});assert.doesNotMatch(visible(branchView(h.tree)),/默认 main|尚未初始化/)
  localFailure(error('EIO','disk unavailable reading local branches'));await assert.rejects(h.tree.loadBranches());h.render();assert.equal(h.tree.branchesLoaded,false);const view=branchView(h.tree);assert.match(visible(view),/disk unavailable/);assert.doesNotMatch(visible(view),/默认 main|尚未初始化/)
  assert.ok(all(view.props.header).filter(n=>n.type==='Button').every(n=>n.props.disabled))
  for(const hasRemote of [true,false]){const section=RemoteSections({branchInfo:h.tree.branchInfo,branchUnavailable:!h.tree.branchStateKnown,hasRemote,canUpload:true,hasCommits:true,mutating:false});assert.doesNotMatch(visible(section),/默认分支 main/);assert.ok(all(section).filter(n=>n.type==='Button').every(n=>n.props.title==='远端管理'||JSON.stringify(n.children).includes('远端管理')||n.props.disabled))}
  ctx={git,fs,dir,gitdir};await h.tree.loadBranches();h.render();assert.equal(h.tree.branchStateKnown,true);h.unmount()
 })
 await test('actual RepoDetailPage passes failure UI state and guards sync callbacks, then permits normal actions after successful retry',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../pages/RepoDetailPage.tsx'),'utf8'),mocks={scripting:ui},calls=[],noop=()=>{}
  for(const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
    const [,names,module]=match;if(module==='scripting')continue;mocks[module]={};for(const token of names.split(',')){const name=token.trim();if(name)mocks[module][name]=name}
  }
  let api
  mocks['../hooks/useRepoDetailData']={useRepoDetailData:props=>(api=hook(props))}
  mocks['../hooks/useLocalEntryCreation']={useLocalEntryCreation:()=>({busy:false,open:noop})}
  mocks['../hooks/useToast']={useToast:()=>({showToast:noop})}
  mocks['../hooks/useOpBusy']={useOpBusy:()=>({})}
  mocks['../hooks/useRepoDetailNavigation']={useRepoDetailNavigation:()=>({})}
  mocks['../hooks/useRepoWorktreeActions']={useRepoWorktreeActions:()=>({commitSheetMode:null})}
  mocks['../hooks/useRepoPendingActions']={useRepoPendingActions:()=>({})}
  mocks['../hooks/useRepoBranchActions']={useRepoBranchActions:()=>({})}
  mocks['../hooks/useRepoSyncActions']={useRepoSyncActions:()=>({handlePush:async()=>calls.push('push'),handlePull:async()=>calls.push('pull')})}
  mocks['../utils/format']={...fmt,suggestCommitTitle:()=>''}
  const Page=load('pages/RepoDetailPage.tsx',mocks).RepoDetailPage,h=mount(Page,{bookmarkName:'repo',name:'test'})
  localFailure(error('EACCES','local refs denied'));await assert.rejects(api.loadBranches());h.render()
  const section=()=>all(h.tree).find(n=>n.type==='RepoBranchSection'),sync=()=>all(h.tree).find(n=>n.type==='RepoRemoteSections')
  assert.equal(section().props.branchesLoaded,false);assert.match(section().props.branchError,/local refs denied/);assert.equal(sync().props.branchUnavailable,true)
  assert.doesNotMatch(visible(BranchSection(section().props)),/默认 main|尚未初始化/)
  await sync().props.onPush();await sync().props.onPull();assert.deepEqual(calls,[])
  ctx={git,fs,dir,gitdir};await api.loadBranches();h.render();assert.equal(sync().props.branchUnavailable,false);await sync().props.onPush();await sync().props.onPull();assert.deepEqual(calls,['push','pull']);h.unmount()
 })
 await test('batch pull actual inspect preserves same-source HEAD read errors before network; detached and unborn are legitimate skips',async()=>{
  const cause=error('EACCES','HEAD access denied');headFailure(cause);await assert.rejects(auto.autoPullInternal('repo'),e=>e===cause)
  ctx={git:{...git,fetch:async()=>{fetches++;throw Error('unexpected fetch')}},fs,dir,gitdir};fs.writeFileSync(gitdir+'/HEAD',oid+'\n');const detached=await auto.autoPullInternal('repo');assert.equal(detached.status,'skipped');assert.match(detached.reason,/HEAD 未指向本地分支/)
  fs.writeFileSync(gitdir+'/HEAD','ref: refs/heads/topic\n');const unborn=await auto.autoPullInternal('repo');assert.equal(unborn.status,'skipped');assert.match(unborn.reason,/尚无提交/)
  const resolveError=error('EIO','cannot read HEAD ref');ctx.git={...git,resolveRef:async()=>{throw resolveError}};await assert.rejects(auto.autoPullInternal('repo'),e=>e===resolveError);assert.equal(fetches,0)
 })
 console.log(groups+' branch read-error groups passed; no real/user remote operations or repository recovery attempted.')
}finally{fs.rmSync(tmp,{recursive:true,force:true})}}
main().catch(e=>{console.error(e);process.exitCode=1})
