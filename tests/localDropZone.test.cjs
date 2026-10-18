/* Wiring/ref behavior only: this cannot prove native onDrop delivery. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,all,tick}=require('./remoteFiles.test.cjs')
const source=fs.readFileSync(path.join(__dirname,'../pages/RepoDetailPage.tsx'),'utf8'),mocks={scripting:ui}
for(const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
 const [,names,module]=match;if(module==='scripting')continue;mocks[module]={}
 for(const token of names.split(',')){const name=token.trim();if(name&&!name.startsWith('type '))mocks[module][name]=name}
}
const hook=(module,name,value)=>mocks[module]={[name]:()=>value}
const data={displayName:'test',changes:[],trackedFiles:['source.txt','dest/keep'],loading:false,mergeInProgress:false,branchInfo:{current:'main'},tab:0}
hook('../hooks/useLocalEntryCreation','useLocalEntryCreation',{busy:false,open(){}})
hook('../hooks/useToast','useToast',{})
hook('../hooks/useRepoDetailData','useRepoDetailData',data)
hook('../hooks/useOpBusy','useOpBusy',{})
hook('../hooks/useRepoDetailNavigation','useRepoDetailNavigation',{})
hook('../hooks/useRepoWorktreeActions','useRepoWorktreeActions',{commitSheetMode:null})
for(const [module,name]of [['useRepoPendingActions','useRepoPendingActions'],['useRepoBranchActions','useRepoBranchActions'],['useRepoSyncActions','useRepoSyncActions']])hook('../hooks/'+module,name,{})
mocks['../utils/format']={suggestCommitTitle:()=>'',shortOid(){}}
const Parent=load('pages/RepoDetailPage.tsx',mocks).RepoDetailPage
const FilesTab=load('pages/FilesTab.tsx',{
 scripting:ui,'../utils/fileRowSwipe':load('utils/fileRowSwipe.ts'),'../utils/localFileDrag':load('utils/localFileDrag.ts'),
 '../utils/fileTree':load('utils/fileTree.ts'),'../utils/fileListPerformance':load('utils/fileListPerformance.ts'),'../utils/format':{formatBytes:String,formatDate:String},
 '../constants/colors':{},'../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},'../services/repoStore':{resolveWorkdir:()=>'/work'},
 '../services/localImportExecution':load('services/localImportExecution.ts'),'../services/localFileImport':{},'../services/localImportBatchSummary':load('services/localImportBatchSummary.ts'),'../services/gitService':{},
}).FilesTab
const TabContent=load('components/RepoDetailContent.tsx',{
 scripting:ui,'../pages/FilesTab':{FilesTab},'../pages/HistoryTab':{HistoryTab:'HistoryTab'},'../pages/StashTab':{StashTab:'StashTab'},'../constants/colors':{},
}).RepoDetailTabContent
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type({...n.props,children:n.children}));return {...n,children:(n.children||[]).map(expand)}}
async function main(){
 global.FileManager={stat:async()=>({size:1,modificationDate:1})}
 global.UUID={string:()=>require('node:crypto').randomUUID()}
 global.ItemProvider={fromText:value=>({registeredTypes:['public.utf8-plain-text','public.url'],loadText:async()=>value})}
 const h=mount(Parent,{bookmarkName:'repo',name:'test'})
 assert.equal(h.tree.type,'VStack','stable presentation host independent of file/history tab')
 const host=h.tree
 const scroll=all(h.tree).filter(n=>n.type==='ScrollView'),lists=all(h.tree).filter(n=>n.type==='List')
 assert.equal(scroll.length,1);assert.equal(lists.length,0,'directory targets have no List ancestor')
 assert.equal(typeof scroll[0].props.refreshable,'function')
 assert.ok(all(scroll[0]).some(n=>n.type==='LazyVStack'))
 for(const type of ['RepoBranchSection','RepoRemoteSections','RepoDetailTabContent'])assert.ok(all(scroll[0]).some(n=>n.type===type),type+' shares single scroll')
 const tab=all(h.tree).find(n=>n.type==='RepoDetailTabContent')
 const content=mount(TabContent,tab.props)
 const fileNode=all(content.tree).find(n=>n.type===FilesTab)
 assert.ok(fileNode,'actual tab component forwards tracked files to actual FilesTab')
 const fileHost=mount(fileNode.type,fileNode.props,{effectUpdates:true})
 await tick();fileHost.render()
 const rendered=expand(fileHost.tree),directory=all(rendered).find(n=>n.type==='DisclosureGroup')
 assert.ok(directory.props.label.props.onDrop,'actual directory row has drop handler')
 assert.equal(all(rendered).some(n=>n.type==='List'),false)
 const sourceRow=all(rendered).find(n=>n.type==='Button'&&n.props.onDrag)
 const provider=sourceRow.props.onDrag.data();assert.equal(provider instanceof Promise,false)
 assert.equal(directory.props.label.props.onDrop.validateDrop({hasItemsConforming:()=>true}),true)
 assert.ok(all(rendered).some(n=>n.type==='Menu'))
 const picker=all(content.tree).find(n=>n.type==='Picker');assert.equal(typeof picker.props.onChanged,'function')
 assert.equal(h.tree.props.safeAreaInset,undefined);assert.equal(tab.props.dropDiagnosticBridge,undefined)
 const covers=h.tree.props.fullScreenCover,nav=h.tree.props.navigationDestination
 for(const value of [1,2]){
  data.tab=value;h.render();assert.equal(h.tree.type,host.type)
  assert.equal(all(h.tree).filter(n=>n.type==='ScrollView').length,0)
  assert.equal(all(h.tree).filter(n=>n.type==='List').length,1)
  assert.equal(typeof all(h.tree).find(n=>n.type==='List').props.refreshable,'function')
  assert.equal(h.tree.props.fullScreenCover.length,covers.length);assert.equal(h.tree.props.navigationDestination.isPresented,nav.isPresented)
  const props=all(h.tree).find(n=>n.type==='RepoDetailTabContent').props
  const other=mount(TabContent,props);assert.ok(!all(other.tree).some(n=>n.type===FilesTab));other.unmount()
 }
 fileHost.unmount();content.unmount();h.unmount()
 assert.equal(fileHost.lateWrites,0)
 assert.doesNotMatch(source,/DragDropTestPage|FileDropDiagnosticZone|dropDiagnosticBridge/)
 console.log('PASS file tab single ScrollView/LazyVStack including branch/sync/segment, no List ancestor; history/stash retain List; stable VStack presentation host; bottom probe removed')
 console.log('LIMIT native drag delivery and simultaneous scroll/swipe/context menu arbitration require device verification')
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{delete global.FileManager;delete global.UUID;delete global.ItemProvider})
