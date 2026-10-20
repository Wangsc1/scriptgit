function routeDestination(h,slot=0){return h.routes?.routes.find(r=>r.slot===slot)?.destination || {isPresented:false}}
/* Actual detail List -> FilesTab callback -> centered Dialog.prompt hook. Native presentation remains unverified. */
const assert=require('node:assert/strict')
const {load,ui,mount,all,deferred,tick}=require('./remoteFiles.test.cjs')
const noop=()=>{},calls=[],created=[],errors=[]
let root='/authorized/work',gate=null,refreshGate=null,fail=false,refreshes=0
const {useLocalEntryCreation}=load('hooks/useLocalEntryCreation.ts',{
 scripting:ui,'../services/localImportExecution':load('services/localImportExecution.ts'),'../services/repoStore':{resolveWorkdir:()=>root},
 '../services/gitService':{createLocalWorktreeEntry:async(...args)=>{calls.push(args);if(gate)await gate.promise;if(fail)throw Error('native write failed');return args[1]}},
})
const content=load('components/RepoDetailContent.tsx',{'./FilledSegmentedControl':{FilledSegmentedControl:'FilledSegmentedControl'},
 scripting:ui,'../constants/colors':{},'../pages/FilesTab':{FilesTab:'FilesTab'},'../pages/HistoryTab':{HistoryTab:'HistoryTab'},'../pages/StashTab':{StashTab:'StashTab'},
})
const data={displayName:'Repo',branchInfo:{current:'main'},branchStateKnown:true,changes:[],tab:0,trackedFiles:[],mergeInProgress:false,loadAll:noop,refreshChangesAndSnapshot:async()=>{refreshes++;if(refreshGate)await refreshGate.promise}}
const worktree={commitSheetMode:null,closeCommitSheet:noop}
const {RepoDetailPage}=load('pages/RepoDetailPage.tsx',{
 '../utils/rawFileUrl':load('utils/rawFileUrl.ts'),
 scripting:ui,'../components/LocalImagePreview':{LocalImagePreview:'LocalImagePreview'},'./LocalFileEditor':{LocalFileEditor:'LocalFileEditor'},
 '../components/BusyOverlay':{BusyOverlay:'BusyOverlay'},'../components/Toast':{toastContent:noop},
 '../hooks/useToast':{useToast:()=>({showToast:message=>errors.push(message)})},
 '../components/RepoBranchSection':{RepoBranchSection:'RepoBranchSection'},'../components/RepoRemoteSections':{RepoRemoteSections:'RepoRemoteSections'},
 '../components/RepoDetailContent':content,'../components/RepoDetailDestination':{RepoDetailDestination:'RepoDetailDestination'},
'../hooks/useLocalEntryCreation':{useLocalEntryCreation},
 '../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},'../components/CommitMessageSheet':{CommitMessageSheet:'CommitMessageSheet'},
 '../hooks/useOpBusy':{useOpBusy:()=>({opBusy:null})},'../hooks/useRepoDetailData':{useRepoDetailData:()=>data},
 '../hooks/useRepoDetailNavigation':{useRepoDetailNavigation:()=>({isPresented:false,skipNextAppearLoad(){}})},'../hooks/useRepoWorktreeActions':{useRepoWorktreeActions:()=>worktree},
 '../hooks/useRepoPendingActions':{useRepoPendingActions:()=>({pending:null})},'../hooks/useRepoBranchActions':{useRepoBranchActions:()=>({})},
 '../hooks/useRepoSyncActions':{useRepoSyncActions:()=>({})},'../services/repoStore':{updateBranchLastPulledAt:noop},
 '../utils/format':{suggestCommitTitle:()=>'',shortOid:String},'../utils/repoDetailAlerts':{},
})
function tabProps(h){h.render();const node=all(h.tree).find(n=>n.type===content.RepoDetailTabContent);const tree=content.RepoDetailTabContent(node.props);return all(tree).find(n=>n.type==='FilesTab')?.props}
async function main(){
 const prompts=[];let input=null,promptGate=null
 global.Dialog={prompt:async options=>{prompts.push(options);return promptGate?promptGate.promise:input}}
 const h=mount(RepoDetailPage,{bookmarkName:'repo',name:'Repo'},{effectUpdates:true})
 const copied=[];global.Pasteboard={setString:async value=>copied.push(value)};data.githubFullName='o/r'
 await tabProps(h).onCopyLink('folder/a.txt');assert.deepEqual(copied,['https://raw.githubusercontent.com/o/r/refs/heads/main/folder/a.txt']);assert.match(errors.pop(),/已复制 Raw 链接/)
 for(const directory of [false,true]){
  input=null;await tabProps(h).onCreateEntry(directory,path=>created.push(path));h.render()
  assert.equal(routeDestination(h,3).isPresented,false);assert.equal(prompts.at(-1).title,directory?'创建目录':'创建文件');assert.equal(prompts.at(-1).defaultValue,'');assert.equal(prompts.at(-1).confirmLabel,'创建');assert.equal(calls.length,0);assert.equal(refreshes,0)
 }
 promptGate=deferred();const pending=tabProps(h).onCreateEntry(false,path=>created.push(path));await tick();h.render();assert.equal(tabProps(h).creationActive,true);assert.equal(routeDestination(h,3).isPresented,false)
 const count=prompts.length;await tabProps(h).onCreateEntry(true,noop);assert.equal(prompts.length,count)
 data.tab=2;h.render();assert.equal(routeDestination(h,3).isPresented,false);data.tab=0
 gate=deferred();refreshGate=deferred();promptGate.resolve('file.ts');await tick();assert.deepEqual(calls.at(-1),['repo','file.ts',false,'/authorized/work']);gate.resolve();await tick();assert.equal(tabProps(h).creationActive,true);refreshGate.resolve();await pending;gate=null;refreshGate=null;promptGate=null
 assert.deepEqual(created,['file.ts']);assert.equal(refreshes,1);assert.equal(tabProps(h).creationActive,false)
 input='Folder';fail=true;await tabProps(h).onCreateEntry(true,path=>created.push(path));assert.match(errors.at(-1),/native write failed/);assert.equal(routeDestination(h,3).isPresented,false)
 fail=false;await tabProps(h).onCreateEntry(true,path=>created.push(path));assert.deepEqual(calls.at(-1),['repo','Folder',true,'/authorized/work'])
 promptGate=deferred();const detached=tabProps(h).onCreateEntry(false,()=>{throw Error('late created')});await tick();const before=calls.length;h.unmount();promptGate.resolve('detached');await detached;assert.equal(calls.length,before);assert.equal(h.lateWrites,0)
 console.log('PASS actual detail parent owns centered creation prompt: empty default/cancel, no bottom sheet, captured root, busy through refresh, duplicate/error/retry/tab/unmount guards')
 console.log('LIMIT: system prompt rendering itself is not verified on iOS')
}
main().catch(e=>{console.error(e);process.exitCode=1})
