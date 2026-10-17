/* Real metadata store and detail data hook; sync/network side effects mocked. */
const assert=require('node:assert/strict')
const {load,mount,ui}=require('./remoteFiles.test.cjs'),{env}=require('./cloneQueue.test.cjs')
const e=env(),store=e.store,now=Date.now,base=1800000000000
const progress=load('utils/remoteProgress.ts'),remote=load('utils/remote.ts'),format=load('utils/format.ts')
const merge=load('utils/branchMerge.ts',{'./remote':remote})
let branch='old',mode='success',writes=0
const row={bookmarkName:'repo',name:'test',createdAt:1,lastPulledAtByBranch:{old:base-3600000,newest:base-60000}}
e.rows.push(row)
const dataHook=load('hooks/useRepoDetailData.ts',{scripting:ui,'../services/gitService':{getManagedBranches:async()=>({locals:['old','newest'],remotes:[],remoteNames:[],current:branch})},'../services/repoStore':store,'../utils/format':format,'../utils/github':load('utils/github.ts'),'../utils/statusFreshness':load('utils/statusFreshness.ts')}).useRepoDetailData
const sync=load('hooks/useRepoSyncActions.ts',{scripting:ui,'../services/gitService':{...progress,pull:async()=>{if(mode==='failure')throw Error('offline');if(mode==='cancel')throw Object.assign(Error('cancel'),{code:'RemoteOperationCancelled'});return {branch:'old',status:'upToDate',remote:'origin',remoteBranch:'old'}},hasRemoteBranch:async()=>true,push:async()=>{}},'../services/notifyService':{notifySync:async()=>{},notifyError:async()=>{}},'../utils/branchMerge':merge}).useRepoSyncActions
async function main(){
 Date.now=()=>base
 try {
  assert.equal(store.getRepoLastPulledAt(null),null);assert.equal(store.getRepoLastPulledAt({createdAt:base}),null)
  assert.equal(store.getRepoLastPulledAt({lastPulledAtByBranch:{bad:NaN,infinite:Infinity,negative:-1,zero:0}}),null)
  const h=mount(dataHook,{bookmarkName:'repo',name:'test',showToast(){}})
  await h.tree.loadBranches();h.render();assert.equal(h.tree.pulledLabel,'1 分钟前')
  branch='newest';await h.tree.loadBranches();h.render();assert.equal(h.tree.pulledLabel,'1 分钟前')
  branch='unrecorded';await h.tree.loadBranches();h.render();assert.equal(h.tree.pulledLabel,'1 分钟前')
  // Real persistent update does not replace a newer success with an older timestamp.
  store.updateBranchLastPulledAt('repo','newest',base-7200000);assert.equal(store.getRepoLastPulledAt(store.findRepo('repo')),base-60000)
  const props={bookmarkName:'repo',displayName:'test',currentBranch:'old',hasRemote:true,beginOpBusy:async()=>{},updateOpBusy:async()=>{},endOpBusy(){},makeSyncCancel:()=>()=>{},setPulledAt:(branch,time)=>{writes++;store.updateBranchLastPulledAt('repo',branch,time)},refreshSyncState:async()=>{},reloadRepo:async()=>{},showToast(){},showConflictNotice(){}}
  const s=mount(sync,props)
  await s.tree.handlePull();assert.equal(writes,1);assert.equal(store.getRepoLastPulledAt(store.findRepo('repo')),base)
  Date.now=()=>base+60000;mode='failure';await s.tree.handlePull();assert.equal(writes,1);mode='cancel';await s.tree.handlePull();assert.equal(writes,1);assert.equal(store.getRepoLastPulledAt(store.findRepo('repo')),base)
  await h.tree.loadBranches();h.render();assert.equal(h.tree.pulledLabel,'1 分钟前')
  e.rows[0]={...store.findRepo('repo'),lastPulledAtByBranch:undefined};await h.tree.loadBranches();h.render();assert.equal(h.tree.pulledLabel,'尚未拉取')
  s.unmount();h.unmount();console.log('PASS latest stored successful pull across branches drives actual detail label; unknown not fabricated, older writes preserved, manual success/failure/cancel semantics')
 } finally {Date.now=now}
}
main().catch(e=>{console.error(e);process.exitCode=1})
