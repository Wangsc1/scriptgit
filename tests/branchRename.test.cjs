/* Actual detail button -> hook -> same Dialog.prompt as create branch. Native UI not emulated. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,all,deferred,tick}=require('./remoteFiles.test.cjs')
const branch=load('utils/branch.ts'),merge={},calls=[],toasts=[]
let fail=false,gate=null,refreshes=0,begins=0,ends=0,result={oldRemote:null,remoteError:null,pushedNewBranch:false}
const actions=load('hooks/useRepoBranchActions.ts',{scripting:ui,'../services/gitService':{renameBranch:async(...args)=>{calls.push(args);if(gate)await gate.promise;if(fail)throw Error('branch exists');return result}},'../utils/branch':branch,'../utils/branchMerge':merge})
const colors=load('constants/colors.ts'),Section=load('components/RepoBranchSection.tsx',{scripting:ui,'../constants/colors':colors,'../constants/git':{DEFAULT_BRANCH:'main'}}).RepoBranchSection
const source=fs.readFileSync(path.join(__dirname,'../pages/RepoDetailPage.tsx'),'utf8'),mocks={scripting:ui},noop=()=>{}
for(const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
 const [,names,module]=match;if(module==='scripting')continue;mocks[module]={};for(const token of names.split(',')){const name=token.trim();if(name)mocks[module][name]=name}
}
const data={githubFullName:'owner/repo',remoteOnlyBranches:[],remoteBranchNames:[],mergeSources:[],deletableBranches:[],displayName:'test',changes:[],branchInfo:{current:'main',branches:['main','topic']},hasCommits:true,hasRemote:true,mergeInProgress:false,tab:0,loadAll:async()=>refreshes++}
const hook=(module,name,value)=>mocks[module]={[name]:()=>value}
hook('../hooks/useToast','useToast',{showToast:(...args)=>toasts.push(args)})
hook('../hooks/useRepoDetailData','useRepoDetailData',data)
hook('../hooks/useOpBusy','useOpBusy',{beginOpBusy:async()=>begins++,endOpBusy:()=>ends++})
hook('../hooks/useRepoDetailNavigation','useRepoDetailNavigation',{openGitHubWorkPage:tab=>calls.push(['remote',tab])})
hook('../hooks/useRepoWorktreeActions','useRepoWorktreeActions',{commitSheetMode:null})
hook('../hooks/useRepoPendingActions','useRepoPendingActions',{clearPending:noop})
mocks['../hooks/useRepoBranchActions']=actions
hook('../hooks/useRepoSyncActions','useRepoSyncActions',{})
hook('../hooks/useLocalEntryCreation','useLocalEntryCreation',{busy:false,open:noop})
mocks['../utils/format']={suggestCommitTitle:()=>'',shortOid:noop}
const Page=load('pages/RepoDetailPage.tsx',mocks).RepoDetailPage
async function engineSemantics(){
 // No actual Git transport: both injected pushBranch and git.push are in-memory spies.
 const progress=load('utils/remoteProgress.ts')
 for(const scenario of ['unpublished','success','push-failure','delete-failure']){
  const operations=[],config=[],options={}
  const git={listBranches:async()=>['main'],currentBranch:async()=>'main',getConfig:async()=>scenario==='unpublished'?undefined:'origin',renameBranch:async()=>operations.push('rename'),setConfig:async input=>config.push(input),push:async input=>{operations.push('delete');assert.equal(input.delete,true);assert.equal(input.remoteRef,'refs/heads/main');if(scenario==='delete-failure')throw Error('mock delete failure')},deleteRef:async()=>operations.push('delete-tracking')}
  const engine=load('services/git/branchService.ts',{'../gitCore':{createHttpTransport:()=>({mock:true})},'../authStore':{getAuth:()=>({username:'fixture',password:'fixture'})},'../../utils/branch':branch,'../../utils/remoteProgress':progress,'./runtime':{getCtx:async()=>({git,fs:{},dir:'/mock',gitdir:'/mock/gitdir'})}})
  const outcome=await engine.renameBranchInternal('repo','main','new',async(...args)=>{operations.push('push');assert.deepEqual(args,['repo','origin','new',false,options,'refs/heads/new']);if(scenario==='push-failure')throw Error('mock push failure')},options)
  assert.equal(outcome.oldRemote,scenario==='unpublished'?null:'origin')
  if(scenario==='unpublished'){assert.deepEqual(operations,['rename']);assert.equal(outcome.pushedNewBranch,false)}
  else {assert.equal(config.find(c=>c.path==='branch.new.merge').value,'refs/heads/new');assert.equal(config.find(c=>c.path==='branch.main.remote').value,undefined)}
  if(scenario==='success'){assert.deepEqual(operations,['rename','push','delete','delete-tracking']);assert.equal(outcome.pushedNewBranch,true);assert.equal(outcome.deletedOldRemoteBranch,true);assert.equal(outcome.remoteError,null)}
  if(scenario==='push-failure'){assert.deepEqual(operations,['rename','push']);assert.equal(outcome.pushedNewBranch,false);assert.equal(outcome.deletedOldRemoteBranch,false);assert.match(outcome.remoteError,/mock push failure/)}
  if(scenario==='delete-failure'){assert.deepEqual(operations,['rename','push','delete']);assert.equal(outcome.pushedNewBranch,true);assert.equal(outcome.deletedOldRemoteBranch,false);assert.match(outcome.remoteError,/mock delete failure/)}
 }
 console.log('PASS restored branch engine preserves upstream migration and push-new/delete-old order plus partial-failure flags; all transports mocked')
}
async function main(){
 await engineSemantics()
 let input=null,promptGate=null;const prompts=[]
 global.Dialog={prompt:async options=>{prompts.push(options);return promptGate?promptGate.promise:input}}
 const h=mount(Page,{bookmarkName:'repo',name:'test'})
 const section=()=>{h.render();return Section(all(h.tree).find(n=>n.type==='RepoBranchSection').props)}
 const rename=()=>all(section().props.header).find(n=>n.type==='Button'&&JSON.stringify(n.children).includes('重命名'))
 await rename().props.action();h.render();assert.equal(h.tree.props.sheet.isPresented,false);assert.equal(prompts.at(-1).defaultValue,'main');assert.equal(prompts.at(-1).confirmLabel,'重命名');assert.deepEqual(calls,[]);assert.equal(begins,0);assert.equal(ends,0)
 input='bad..name';await rename().props.action();assert.match(toasts.at(-1)[0],/名称无效/);assert.deepEqual(calls,[])
 input='main';await rename().props.action();assert.deepEqual(calls,[])
 input='topic';fail=true;await rename().props.action();assert.match(toasts.at(-1)[0],/branch exists/);assert.equal(begins,1);assert.equal(ends,1);assert.equal(refreshes,0)
 fail=false;input='new-name';gate=deferred();const pending=rename().props.action();await tick();const n=prompts.length;await rename().props.action();assert.equal(prompts.length,n);gate.resolve();await pending;gate=null;assert.deepEqual(calls.at(-1),['repo','main','new-name']);assert.equal(refreshes,1)
 promptGate=deferred();const stale=rename().props.action();await tick();data.branchInfo.current='changed';h.render();promptGate.resolve('stale');await stale;assert.match(toasts.at(-1)[0],/已变化/);assert.equal(calls.length,2);promptGate=null;data.branchInfo.current='main'
 for(const scenario of [
  {oldRemote:'origin',remoteError:null,pushedNewBranch:true},
  {oldRemote:'origin',remoteError:'push denied',pushedNewBranch:false},
  {oldRemote:'origin',remoteError:'delete denied',pushedNewBranch:true},
 ]){
  result=scenario;input='remote-name';await rename().props.action();assert.match(prompts.at(-1).message,/同步远端/);h.render();assert.equal(h.tree.props.sheet.isPresented,false)
  if(!scenario.remoteError)assert.match(toasts.at(-1)[0],/已重命名并同步远端/)
  else {assert.equal(h.tree.props.alert.title,'本地已重命名，远端同步失败');assert.match(JSON.stringify(h.tree.props.alert.message),scenario.pushedNewBranch?/删除远端旧分支失败/:/推送新分支失败/);h.tree.props.alert.onChanged(false)}
 }
 data.mergeInProgress=true;assert.equal(rename().props.disabled,true);const before=prompts.length;await rename().props.action();assert.equal(prompts.length,before);data.mergeInProgress=false
 const picker=all(section()).find(n=>n.type==='Picker');assert.equal(picker.props.title,'更改分支')
 let switched;const direct=Section({...all(h.tree).find(n=>n.type==='RepoBranchSection').props,onSwitch:ref=>switched=ref});all(direct).find(n=>n.type==='Picker').props.onChanged('topic');assert.equal(switched,'topic')
 const remote=all(h.tree.props.toolbar.topBarTrailing).find(n=>n.type==='Button'&&n.props.title==='Edit Remote Files');assert.ok(remote);remote.props.action();assert.deepEqual(calls.at(-1),['remote',3])
 const content=fs.readFileSync(path.join(__dirname,'../components/RepoDetailContent.tsx'),'utf8');assert.match(content,/<Text tag=\{2\}>状态<\/Text>/);assert.match(content,/<HistoryTab/)
 h.unmount();console.log('PASS actual branch header click opens centered Dialog.prompt; cancellation/no-op/invalid/stale/failure/retry/duplicate guards; unchanged picker and remote navigation with requested labels')
}
main().catch(e=>{console.error(e);process.exitCode=1})
