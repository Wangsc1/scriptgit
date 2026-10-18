/* Notification retirement regression: no real notifications/network/user files. */
const assert=require('node:assert/strict')
const {load,mount,ui,all,node,text,tick}=require('./remoteFiles.test.cjs')
let scheduled=0,permissions=0,storageReads=0,storageWrites=0,assetReads=0,legacyEnabled=true
const notifications={Notification:{schedule:async()=>scheduled++,requestAuthorization:async()=>permissions++}}
const legacy={readNotifyEnabled:()=>{storageReads++;return legacyEnabled},readErrorNotifyEnabled:()=>{storageReads++;return legacyEnabled},writeNotifyEnabled:()=>storageWrites++,writeErrorNotifyEnabled:()=>storageWrites++}
const retired=load('services/notifyService.ts',{scripting:notifications,'./storage':legacy})
const progress=load('utils/remoteProgress.ts'),format=load('utils/format.ts')
async function main(){
 global.FileManager={scriptsDirectory:'/unused',exists:async()=>{assetReads++;return true}}
 global.Data={fromFile:()=>{assetReads++;throw Error('retired notification asset must not load')}}
 // Previously persisted true/false must make no difference, including failed operations.
 for(const enabled of [true,false]){legacyEnabled=enabled;for(const kind of ['push','pull','commit','clone','fetch']){
  await retired.notifySync(kind,'repo','done');await retired.notifyError(kind,'repo','failed')
 }}
 assert.equal(scheduled,0);assert.equal(permissions,0);assert.equal(storageReads,0);assert.equal(storageWrites,0);assert.equal(assetReads,0)
 console.log('PASS retired notify API has zero system/permission/storage/asset side effects, even with old enabled preferences')

 const scripting=new Proxy(ui,{get:(target,key)=>key==='Navigation'?{useDismiss:()=>()=>{}}:key==='Script'?{metadata:require('../script.json')}:target[key]})
 const Settings=load('pages/SettingsPage.tsx',{
  scripting,'../components/FormRow':{FormRow:'FormRow'},'../components/AvatarView':{AvatarView:'AvatarView'},
  '../services/authStore':{hasToken:()=>false,getVerifiedUser:()=>null},'../services/storage':legacy,
  '../services/gitService':{getHistoryCacheStats:()=>({})},'../utils/performance':{getSlowOperations:()=>[],buildPerformanceReport:()=>'',clearSlowOperations(){}},
  '../api/githubApi':{checkTokenValidity:async()=>{throw Error('not needed')}},'../constants/colors':{},
 }).SettingsPage
 const settings=mount(Settings,{});await tick();settings.render()
 const nodes=all(settings.tree)
 assert.equal(nodes.filter(n=>n.type==='Toggle').length,0)
 assert.doesNotMatch(JSON.stringify(settings.tree),/完成通知|失败通知|系统通知|"通知"/)
 for(const label of ['GitHub Token','性能诊断'])assert.match(JSON.stringify(settings.tree),new RegExp(label))
 assert.equal(storageReads,0);assert.equal(storageWrites,0);settings.unmount()
 console.log('PASS actual SettingsPage nodes have no notification section/toggles; Token and diagnostics remain; no old preference access')

 let failure=false,shown=[]
 const showToast=(message,type)=>shown.push([message,type])
 const sync=load('hooks/useRepoSyncActions.ts',{
  '../services/gitService':{...progress,hasRemoteBranch:async()=>false,push:async()=>{if(failure)throw Error('push offline')},pull:async()=>{if(failure)throw Error('pull offline');return {branch:'main'}}},
  '../services/notifyService':retired,'../utils/branchMerge':{formatPullSuccessAlert:()=>({title:'拉取成功',message:'已更新'})},
 }).useRepoSyncActions
 const s=mount(sync,{bookmarkName:'repo',displayName:'repo',currentBranch:'main',hasRemote:true,
  beginOpBusy:async()=>{},updateOpBusy:async()=>{},endOpBusy(){},makeSyncCancel:()=>()=>{},setPulledAt(){},refreshSyncState:async()=>{},reloadRepo:async()=>{},showToast,showConflictNotice(){}})
 for(const bad of [false,true]){failure=bad;for(const action of ['handlePush','handlePull']){
  shown=[];await s.tree[action]();assert.equal(shown.length,1);assert.equal(shown[0][1],bad?'error':'success');assert.match(shown[0][0],bad?/失败/:/成功/)
 }}s.unmount()
 const work=load('hooks/useRepoWorktreeActions.ts',{scripting:ui,'../services/gitService':{commit:async()=>{if(failure)throw Error('commit failed');return '1234567890'}},'../services/notifyService':retired,'../utils/format':format}).useRepoWorktreeActions
 const w=mount(work,{bookmarkName:'repo',displayName:'repo',changes:[{filepath:'a',staged:true}],mergeInProgress:false,beginOpBusy:async()=>{},endOpBusy(){},clearChanges(){},reloadRepo:async()=>{},showToast})
 for(const bad of [false,true]){failure=bad;shown=[];await w.tree.handleCommit('title','');assert.equal(shown.length,1);assert.equal(shown[0][1],bad?'error':'success');assert.match(shown[0][0],bad?/提交失败/:/提交成功/)}w.unmount()
 console.log('PASS push/pull/commit actual hooks retain exactly one in-app success/error toast using the retired notify implementation')

 const useToast=load('hooks/useToast.ts',{scripting:ui}).useToast
 const toastMocks={'../components/Toast':{toastContent:message=>__jsx('Text',{},message)},'../hooks/useToast':{useToast}}
 let row={bookmarkName:'repo',name:'repo',pendingRemoteUrl:'https://github.com/example/repo.git',pendingRemoteName:'repo'},uploaded=0
 const Upload=load('pages/UploadGitHubPage.tsx',{
  scripting:ui,'../components/FormRow':{FormRow:'FormRow'},'../components/BusyOverlay':{BusyOverlay:'BusyOverlay'},...toastMocks,
  '../api/githubApi':{getCurrentUser:async()=>({login:'example'})},'../services/authStore':{hasToken:()=>true},
  '../services/gitService':{...progress,isInitialized:async()=>true,getBranches:async()=>({current:'main'}),getLog:async()=>[{}],setOriginAndPush:async()=>{if(failure)throw Error('upload offline')}},
  '../services/repoStore':{findRepo:()=>row,updateRepo:(_,patch)=>(row={...row,...patch})},'../services/notifyService':retired,
  '../utils/remoteProgress':progress,'../constants/git':{DEFAULT_BRANCH:'main'},'../constants/colors':{},'../utils/gitSync':load('utils/gitSync.ts'),
 }).UploadGitHubPage
 for(const bad of [false,true]){failure=bad;row={...row,pendingRemoteUrl:'https://github.com/example/repo.git'}
  const h=mount(Upload,{bookmarkName:'repo',defaultName:'repo',onUploaded:()=>uploaded++});await tick()
  await node(h,'Button','重试推送').props.action();h.render()
  if(bad){assert.equal(uploaded,1);assert.match(JSON.stringify(h.tree.props.toast.content),/上传失败.*upload offline/)}else assert.equal(uploaded,1)
  h.unmount()
 }
 console.log('PASS upload success still calls parent result handler; failure still renders in-app toast')

 const {env}=require('./cloneQueue.test.cjs')
 const e=env(),github=load('utils/github.ts'),marker=load('utils/clonedGithubRepos.ts',{'./github':github})
 const Clone=load('pages/ClonePage.tsx',{
  scripting:ui,'../components/FormRow':{FormRow:'FormRow'},'../components/AvatarView':{AvatarView:'AvatarView'},'../components/BusyOverlay':{BusyOverlay:'BusyOverlay'},...toastMocks,
  '../hooks/useGitHubUserSearch':{useGitHubUserSearch:()=>({candidates:[],total:null,changeQuery(){},selectUser(){}})},
  '../utils/displayPaths':load('utils/displayPaths.ts'),'../services/cloneDiagnostics':{runDirectoryCheck:async()=>''},
  '../utils/clonedGithubRepos':marker,'../services/repoStore':{listRepos:()=>[],pickDirectory:async()=>null},
  '../services/gitService':progress,'../services/cloneWorkspace':e.workspace,
  '../services/cloneQueue':{runCloneQueue:async(requests,destination,options)=>{
   const result={status:failure?'failed':'cloned',name:'repo',url:requests[0].url,displayPath:'git/repo',message:failure?'clone offline':'clone complete',repo:failure?undefined:{bookmarkName:'repo'}}
   options.onResult(result);return [result]
  }},
  '../services/authStore':{hasToken:()=>false},'../services/notifyService':retired,'../api/githubApi':{},
  '../utils/format':format,'../utils/remoteProgress':{yieldForUi:async()=>{}},
 }).ClonePage
 let cloned=0
 for(const bad of [false,true]){failure=bad;const h=mount(Clone,{onCloned:()=>cloned++});await tick();await tick()
  const form=all(h.render()).find(n=>n.type==='FormRow'&&n.props.label==='Git URL');form.props.onChanged('https://github.com/example/repo.git')
  await node(h,'Button','克隆').props.action();h.render()
  assert.match(text(h),bad?/失败.*repo[\s\S]*clone offline/:/成功.*repo[\s\S]*clone complete/)
  if(bad)assert.ok(all(h.tree).some(n=>n.type==='Text'&&n.props.foregroundStyle==='red'&&JSON.stringify(n.children).includes('clone offline')))
  assert.equal(cloned,1);h.unmount()
 }
 assert.equal(scheduled,0);assert.equal(permissions,0);assert.equal(storageReads,0);assert.equal(storageWrites,0)
 console.log('PASS clone success callback and visible result rows retained; failed clone remains visible in red; all paths schedule zero system notifications')
}
main().catch(e=>{console.error(e);process.exitCode=1})
