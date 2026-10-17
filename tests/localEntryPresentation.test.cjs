/* Execute actual detail List -> tab props -> create hook -> dedicated form.
 * Virtual-node/JS boundary tests only; no native UIKit/SwiftUI renderer here.
 */
const assert=require('node:assert/strict')
const {load,ui,mount,all,deferred,tick}=require('./remoteFiles.test.cjs')
const noop=()=>{},calls=[],created=[],errors=[]
let root='/authorized/work',gate=null,refreshGate=null,fail=false,refreshes=0
const {useLocalEntryCreation}=load('hooks/useLocalEntryCreation.ts',{
 scripting:ui,'../services/repoStore':{resolveWorkdir:()=>root},
 '../services/gitService':{createLocalWorktreeEntry:async(...args)=>{calls.push(args);if(gate)await gate.promise;if(fail)throw Error('native write failed');return args[1]}},
})
const {FormRow}=load('components/FormRow.tsx',{scripting:ui})
const {CreateLocalEntrySheet}=load('components/CreateLocalEntrySheet.tsx',{scripting:ui,'./FormRow':{FormRow}})
const content=load('components/RepoDetailContent.tsx',{
 scripting:ui,'../constants/colors':{},'../pages/FilesTab':{FilesTab:'FilesTab'},'../pages/HistoryTab':{HistoryTab:'HistoryTab'},'../pages/StashTab':{StashTab:'StashTab'},
})
const data={displayName:'Repo',branchInfo:{current:'main'},branchStateKnown:true,changes:[],tab:0,trackedFiles:[],mergeInProgress:false,loadAll:noop,refreshChangesAndSnapshot:async()=>{refreshes++;if(refreshGate)await refreshGate.promise}}
const worktree={commitSheetMode:null,closeCommitSheet:noop}
const {RepoDetailPage}=load('pages/RepoDetailPage.tsx',{
 scripting:ui,'../components/ImageViewer':{ImageViewer:'ImageViewer'},'./LocalFileEditor':{LocalFileEditor:'LocalFileEditor'},
 '../components/BusyOverlay':{BusyOverlay:'BusyOverlay'},'../components/Toast':{toastContent:noop},
 '../hooks/useToast':{useToast:()=>({showToast:message=>errors.push(message)})},
 '../components/RepoBranchSection':{RepoBranchSection:'RepoBranchSection'},'../components/RepoRemoteSections':{RepoRemoteSections:'RepoRemoteSections'},
 '../components/RepoDetailContent':content,'../components/RepoDetailDestination':{RepoDetailDestination:'RepoDetailDestination'},
 '../components/CreateLocalEntrySheet':{CreateLocalEntrySheet},'../hooks/useLocalEntryCreation':{useLocalEntryCreation},
 '../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},'../components/CommitMessageSheet':{CommitMessageSheet:'CommitMessageSheet'},
 '../hooks/useOpBusy':{useOpBusy:()=>({opBusy:null})},'../hooks/useRepoDetailData':{useRepoDetailData:()=>data},
 '../hooks/useRepoDetailNavigation':{useRepoDetailNavigation:()=>({})},'../hooks/useRepoWorktreeActions':{useRepoWorktreeActions:()=>worktree},
 '../hooks/useRepoPendingActions':{useRepoPendingActions:()=>({pending:null})},'../hooks/useRepoBranchActions':{useRepoBranchActions:()=>({cancelRenameBranch:noop})},
 '../hooks/useRepoSyncActions':{useRepoSyncActions:()=>({})},'../services/repoStore':{updateBranchLastPulledAt:noop},
 '../utils/format':{suggestCommitTitle:()=>'',shortOid:String},'../utils/repoDetailAlerts':{},
})
function tabProps(h){h.render();const node=all(h.tree).find(n=>n.type===content.RepoDetailTabContent);const tree=content.RepoDetailTabContent(node.props);return all(tree).find(n=>n.type==='FilesTab')?.props}
async function main(){
 const h=mount(RepoDetailPage,{bookmarkName:'repo',name:'Repo'},{effectUpdates:true})
 assert.equal(h.tree.type,'List');assert.equal(h.tree.props.sheet.isPresented,false)
 for(const directory of [false,true]){
  const files=tabProps(h);assert.equal(files.creationActive,false);files.onCreateEntry(directory,path=>created.push(path));h.render()
  assert.equal(h.tree.type,'List');assert.equal(h.tree.props.sheet.isPresented,true);assert.equal(h.tree.props.sheet.content.type,CreateLocalEntrySheet)
  assert.equal(h.tree.props.sheet.content.props.directory,directory);assert.equal(tabProps(h).creationActive,true);assert.equal(calls.length,0,'open must not write')
  const key=h.tree.props.sheet.content.props.key
  data.tab=2;h.render();assert.equal(h.tree.props.sheet.isPresented,true);assert.equal(h.tree.props.sheet.content.props.key,key,'sheet survives conditional FilesTab removal')
  h.tree.props.sheet.onChanged(false);h.render();assert.equal(h.tree.props.sheet.isPresented,false);data.tab=0
 }
 // Real form root receives native presentation modifiers; an empty observable is
 // bound to the actual FormRow/TextField without imperative focus or navigation.
 let confirmed=null,cancelled=0
 const form=mount(CreateLocalEntrySheet,{directory:false,busy:false,error:'',onCancel:()=>cancelled++,onConfirm:value=>confirmed=value})
 assert.equal(form.tree.type,'NavigationStack');assert.deepEqual(form.tree.props.presentationDetents,['medium','large'])
 const list=all(form.tree).find(n=>n.type==='List');assert.equal(list.props.presentationDetents,undefined)
 const row=all(form.tree).find(n=>n.type===FormRow),field=all(FormRow(row.props)).find(n=>n.type==='TextField')
 assert.equal(field.props.value.value,'');assert.equal(field.props.focused,undefined);assert.equal(field.props.onChanged,undefined)
 assert.equal(list.props.toolbar.confirmationAction.props.disabled,true)
 field.props.value.setValue('file.json');form.render();all(form.tree).find(n=>n.type==='List').props.toolbar.confirmationAction.props.action();assert.equal(confirmed,'file.json')
 all(form.tree).find(n=>n.type==='List').props.toolbar.cancellationAction.props.action();assert.equal(cancelled,1);form.unmount()
 // Same parent-owned operation, captured root, duplicate guard, errors and retry.
 tabProps(h).onCreateEntry(false,path=>created.push(path));h.render();gate=deferred()
 const operation=h.tree.props.sheet.content.props.onConfirm('arbitrary.ts');h.render();assert.equal(h.tree.props.sheet.content.props.busy,true)
 h.tree.props.sheet.onChanged(false);h.render();assert.equal(h.tree.props.sheet.isPresented,true)
 await h.tree.props.sheet.content.props.onConfirm('duplicate');assert.equal(calls.length,1);assert.deepEqual(calls[0],['repo','arbitrary.ts',false,'/authorized/work'])
 refreshGate=deferred();gate.resolve();await tick();h.render();assert.equal(h.tree.props.sheet.isPresented,false);assert.equal(tabProps(h).creationActive,true,'refresh still holds the create busy guard');refreshGate.resolve();await operation;gate=null;refreshGate=null;h.render();assert.equal(tabProps(h).creationActive,false);assert.deepEqual(created,['arbitrary.ts']);assert.equal(refreshes,1)
 tabProps(h).onCreateEntry(true,path=>created.push(path));h.render();fail=true;await h.tree.props.sheet.content.props.onConfirm('Folder');h.render()
 assert.equal(h.tree.props.sheet.isPresented,true);assert.match(h.tree.props.sheet.content.props.error,/native write failed/);assert.equal(errors.length,1)
 fail=false;await h.tree.props.sheet.content.props.onConfirm('Folder');h.render();assert.equal(h.tree.props.sheet.isPresented,false);assert.deepEqual(calls.at(-1),['repo','Folder',true,'/authorized/work'])
 // No presentation callbacks/state writes after the detail owner is destroyed.
 tabProps(h).onCreateEntry(false,()=>{throw Error('late onCreated')});h.render();gate=deferred();const detached=h.tree.props.sheet.content.props.onConfirm('detached');h.unmount();gate.resolve();await detached;assert.equal(h.lateWrites,0)
 console.log('PASS actual detail List owns create sheet across tab changes; dedicated NavigationStack root modifiers, empty input/cancel/confirm, captured root/busy/error/retry/unmount')
 console.log('LIMIT: native crash and iOS sheet rendering remain unverified')
}
main().catch(e=>{console.error(e);process.exitCode=1})
