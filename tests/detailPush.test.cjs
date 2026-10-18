/* Production detail page + worktree/sync hooks. All Git I/O mocked; no phone/network access. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,all,tick,deferred}=require('./remoteFiles.test.cjs')
const format=load('utils/format.ts')
function fixture(){
 const calls=[],toasts=[],navigations=[],times=[];let fail=null,gate=null,clearPending=0
 const data={displayName:'All',changes:[{filepath:'a',status:'modified',staged:false},{filepath:'folder/b',status:'modified',staged:true}],branchInfo:{current:'master',branches:['master']},branchStateKnown:true,hasRemote:true,repoSource:'clone',remoteOnlyBranches:[],mergeInProgress:false,
  setChanges:v=>{data.changes=v},setLastPulledAt:()=>{},refreshSyncState:async()=>{calls.push('refresh')},loadAll:async()=>{},refreshChangesAndSnapshot:async()=>data.changes,loadChanges:async()=>data.changes,loadStashes:async()=>{},refreshHistoryIfLoaded:()=>{}}
 const step=async name=>{calls.push(name);if(fail===name)throw Object.assign(Error(name+' failed'),{code:name==='conflict'?'MergeConflictError':'Error'})}
 const service={RemoteCancelToken:class{cancel(){}},isRemoteOperationCancelled:()=>false,
  stageAll:()=>step('stageAll'),commit:async(_key,msg)=>{await step('commit:'+msg);return '123456789'},hasRemoteBranch:async()=>true,
  pull:async()=>{await step('pull');if(fail==='conflict')throw Object.assign(Error('合并冲突'),{code:'MergeConflictError'});if(gate)await gate.promise},push:()=>step('push'),createStash:()=>step('stash'),addFiles:()=>step('stageFile')}
 const sync=load('hooks/useRepoSyncActions.ts',{'../services/gitService':service,'../services/notifyService':{notifySync:async()=>{},notifyError:async()=>{}},'../utils/branchMerge':{}})
 const worktree=load('hooks/useRepoWorktreeActions.ts',{scripting:ui,'../services/gitService':service,'../services/notifyService':{notifySync:async()=>{}},'../utils/format':format})
 const source=fs.readFileSync(path.join(__dirname,'../pages/RepoDetailPage.tsx'),'utf8'),mocks={scripting:ui}
 for(const [,names,module] of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
  if(module==='scripting')continue;mocks[module]={};for(const token of names.split(',')){const name=token.trim();if(name)mocks[module][name]=name}
 }
 let pendingApi,worktreeApi
 Object.assign(mocks,{
  '../utils/format':format,'../utils/repoDetailAlerts':{getRepoPendingAlert:()=>({title:'确认还原',message:'原有确认',confirmButton:'还原'})},
  '../services/repoStore':{updateBranchLastPulledAt:(...args)=>times.push(args)},
  '../hooks/useToast':{useToast:()=>({showToast:(...args)=>toasts.push(args)})},
  '../hooks/useRepoDetailData':{useRepoDetailData:()=>data},
  '../hooks/useRepoSyncActions':sync,
  '../hooks/useRepoWorktreeActions':{useRepoWorktreeActions:props=>{worktreeApi=worktree.useRepoWorktreeActions(props);return worktreeApi}},
  '../hooks/useOpBusy':{useOpBusy:()=>{const [opBusy,set]=ui.useState(null);return {opBusy,beginOpBusy:async()=>set({}),updateOpBusy:async()=>{},endOpBusy:()=>set(null),makeSyncCancel:()=>()=>{}}}},
  '../hooks/useRepoDetailNavigation':{useRepoDetailNavigation:()=>({openPage:key=>navigations.push(key),skipNextAppearLoad(){}})},
  '../hooks/useRepoBranchActions':{useRepoBranchActions:()=>({})},
  '../hooks/useLocalEntryCreation':{useLocalEntryCreation:()=>({})},
  '../hooks/useRepoPendingActions':{useRepoPendingActions:()=>{const [pending,setPending]=ui.useState(null);pendingApi={pending,setPending,clearPending:()=>{clearPending++;setPending(null)},amendDraft:{title:'old title',description:'old body'},handleAmendFormConfirm:()=>step('amend')};return pendingApi}},
 })
 const Page=load('pages/RepoDetailPage.tsx',mocks).RepoDetailPage,h=mount(Page,{bookmarkName:'repo',name:'All'})
 const render=()=>h.render(),find=type=>{render();return all(h.tree).find(n=>n.type===type)}
 const alert=()=>{render();return h.tree.props.alert},inputs=()=>all(alert().actions).filter(n=>n.type==='TextField')
 const button=title=>all(alert().actions).find(n=>n.type==='Button'&&n.props.title===title)
 const edit=(title,description='')=>{inputs()[0].props.onChanged(title);inputs()[1].props.onChanged(description);render()}
 const top=()=>find('RepoRemoteSections').props.onPush(),swipe=()=>find('RepoDetailTabContent').props.onPush()
 return {h,data,calls,toasts,navigations,times,render,find,alert,inputs,button,edit,top,swipe,setFail:v=>fail=v,setGate:v=>gate=v,get pending(){return pendingApi},get worktree(){return worktreeApi},get clears(){return clearPending}}
}
let groups=0;async function test(name,fn){await fn();groups++;console.log('PASS '+name)}
async function main(){
 await test('top and file/folder swipe use the identical native two-field alert; defaults, edits stable on rerender, cancellation/blank title write nothing',async()=>{
  const e=fixture();e.render();assert.equal(all(e.h.tree).find(n=>n.type==='RepoRemoteSections').props.onPush,all(e.h.tree).find(n=>n.type==='RepoDetailTabContent').props.onPush)
  for(const open of [e.top,e.swipe]){
   open();open();e.render();assert.equal(e.h.tree.props.sheet.isPresented,false);assert.equal(e.alert().title,'提交并推送');assert.equal(e.inputs().length,2);assert.equal(e.inputs()[0].props.value,'更新 2 个文件');assert.equal(e.inputs()[1].props.value,'');assert.deepEqual(e.calls,[])
   e.edit('自定义标题','描述');e.data.changes.push({filepath:'extra',status:'modified'});e.render();assert.equal(e.inputs()[0].props.value,'自定义标题');assert.equal(e.inputs()[1].props.value,'描述')
   e.edit('  ','描述');assert.equal(e.button('推送').props.disabled,true);await e.button('推送').props.action();assert.match(JSON.stringify(e.alert().message),/请填写提交信息/);assert.deepEqual(e.calls,[])
   const dismiss=e.alert().onChanged;e.button('取消').props.action();dismiss(false);e.render();assert.equal(e.alert().isPresented,false);assert.deepEqual(e.calls,[]);assert.equal(e.clears,0);e.data.changes.pop()
  }
  e.swipe();e.alert().onChanged(false);assert.equal(e.alert().isPresented,false);assert.deepEqual(e.calls,[]);e.h.unmount()
 })
 await test('both entries confirm stageAll → commit(title+body) → pull → push once, held busy until completion; dismiss cannot erase new conflict alert',async()=>{
  for(const entry of ['top','swipe']){
   const e=fixture(),gate=deferred();e.setGate(gate);e[entry]();e.edit('修复','详细说明');const old=e.alert(),action=e.button('推送').props.action,pending=action();await action();await tick();
   assert.deepEqual(e.calls,['stageAll','commit:修复\n\n详细说明','pull']);assert.equal(e.alert().isPresented,false);e.top();e.swipe();assert.equal(e.alert().isPresented,false)
   old.onChanged(false);assert.equal(e.clears,0);gate.resolve();await pending;e.render();assert.deepEqual(e.calls,['stageAll','commit:修复\n\n详细说明','pull','push','refresh']);assert.equal(e.times[0][1],'master');e.h.unmount()
  }
  const e=fixture();e.setFail('conflict');e.top();await e.button('推送').props.action();e.render();e.alert().onChanged(false);e.render();assert.equal(e.alert().title,'合并冲突');assert.ok(!e.calls.includes('push'));assert.equal(e.clears,0)
  // Original notice action/dismiss navigation is still available.
  e.button('去处理').props.action();await new Promise(r=>setTimeout(r,380));assert.deepEqual(e.navigations,['conflicts']);e.h.unmount()
 })
 await test('stage, commit or pull failure never pushes; no changes skips form/stage/commit and only synchronizes existing commits',async()=>{
  for(const failure of ['stageAll','commit:更新 2 个文件','pull']){
   const e=fixture();e.setFail(failure);e.swipe();await e.button('推送').props.action();assert.ok(!e.calls.includes('push'));assert.ok(e.toasts.some(([msg])=>msg.includes('推送失败')));if(failure==='stageAll')assert.ok(!e.calls.some(v=>v.startsWith('commit:')));e.h.unmount()
  }
  for(const entry of ['top','swipe']){const e=fixture();e.data.changes=[];await e[entry]();assert.deepEqual(e.calls,['pull','push','refresh']);assert.equal(e.alert().isPresented,false);assert.equal(e.h.tree.props.sheet.isPresented,false);e.h.unmount()}
 })
 await test('branch unknown, merge, busy, pending confirmation and commit/amend sheet protections at entry and confirmation; independent commit/amend and Stash remain unchanged',async()=>{
  for(const mode of ['branch','merge','busy','pending','commit','amend']){
   const e=fixture();const block=()=>{if(mode==='branch')e.data.branchStateKnown=false;else if(mode==='merge')e.data.mergeInProgress=true;else if(mode==='busy')e.worktree.handleStagePaths(['a']);else if(mode==='pending')e.pending.setPending({type:'restore',filepath:'a'});else e.worktree.setCommitSheetMode(mode);e.render()}
   if(mode==='busy'){
    // Explicit stagingBusy hook state while a deferred Stash is running.
    const original=e.data.refreshChangesAndSnapshot,wait=deferred();e.data.refreshChangesAndSnapshot=()=>wait.promise;e.render();const pending=e.worktree.handleStagePaths(['a']);e.render();e.top();e.swipe();assert.equal(e.alert().isPresented,false);wait.resolve([]);await pending;e.h.unmount();continue
   }
   block();e.top();e.swipe();assert.deepEqual(e.calls,[]);assert.equal(e.inputs().length,0);e.h.unmount()
   const fresh=fixture();fresh.top();if(mode==='branch')fresh.data.branchStateKnown=false;else if(mode==='merge')fresh.data.mergeInProgress=true;else if(mode==='pending')fresh.pending.setPending({type:'restore',filepath:'a'});else fresh.worktree.setCommitSheetMode(mode);fresh.render();await fresh.button('推送').props.action();assert.deepEqual(fresh.calls,[]);fresh.h.unmount()
  }
  const e=fixture();e.worktree.openCommitForm();e.render();assert.equal(e.h.tree.props.sheet.content.props.navigationTitle,'提交改动');assert.equal(e.h.tree.props.sheet.content.props.onConfirm,e.worktree.handleCommit);e.worktree.closeCommitSheet();e.render()
  e.worktree.setCommitSheetMode('amend');e.render();assert.equal(e.h.tree.props.sheet.content.props.navigationTitle,'重编提交');assert.equal(e.h.tree.props.sheet.content.props.initialTitle,'old title');assert.equal(e.h.tree.props.sheet.content.props.onConfirm,e.pending.handleAmendFormConfirm);e.worktree.closeCommitSheet();e.render()
  await e.worktree.handleStagePaths(['folder']);assert.deepEqual(e.calls,['stash']);assert.equal(e.calls.includes('stageAll'),false)
  e.calls.length=0;await e.worktree.handleCommit('独立提交','只提交已暂存内容');assert.deepEqual(e.calls,['commit:独立提交\n\n只提交已暂存内容']);assert.deepEqual(e.data.changes,[]);e.h.unmount()
 })
 console.log(groups+' detail push groups passed; production page + sync/worktree hooks, mocked Git I/O.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
