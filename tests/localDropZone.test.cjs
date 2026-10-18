/* Original List/native-row structure and JS wiring only; not native layout/drop validation. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,all,tick}=require('./remoteFiles.test.cjs')
const source=fs.readFileSync(path.join(__dirname,'../pages/RepoDetailPage.tsx'),'utf8'),mocks={scripting:ui}
for(const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
 const [,names,module]=match;if(module==='scripting')continue;mocks[module]={}
 for(const token of names.split(',')){const name=token.trim();if(name&&!name.startsWith('type '))mocks[module][name]=name}
}
const hook=(module,name,value)=>mocks[module]={[name]:()=>value}
const changed=[]
const data={displayName:'test',changes:[],trackedFiles:['source.txt','dest/keep'],loading:false,mergeInProgress:false,branchInfo:{current:'main'},tab:0,handleTabChange:value=>changed.push(value)}
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
 scripting:ui,'../utils/localFileDrag':load('utils/localFileDrag.ts'),
 '../utils/fileTree':load('utils/fileTree.ts'),'../utils/fileListPerformance':load('utils/fileListPerformance.ts'),'../utils/format':{formatBytes:String,formatDate:String},
 '../constants/colors':{},'../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},'../services/repoStore':{resolveWorkdir:()=>'/work'},
 '../services/localImportExecution':load('services/localImportExecution.ts'),'../services/localFileImport':{},'../services/localImportBatchSummary':load('services/localImportBatchSummary.ts'),'../services/gitService':{},
}).FilesTab
const Segmented=load('components/FilledSegmentedControl.tsx',{scripting:ui,'../constants/colors':{COLOR_ACCENT:'systemBlue'}}).FilledSegmentedControl
const TabContent=load('components/RepoDetailContent.tsx',{
 './FilledSegmentedControl':{FilledSegmentedControl:Segmented},scripting:ui,'../pages/FilesTab':{FilesTab},'../pages/HistoryTab':{HistoryTab:'HistoryTab'},'../pages/StashTab':{StashTab:'StashTab'},'../constants/colors':{},
}).RepoDetailTabContent
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type({...n.props,children:n.children}));return {...n,children:(n.children||[]).map(expand)}}
async function main(){
 global.FileManager={stat:async()=>({size:1,modificationDate:1})}
 global.UUID={string:()=>require('node:crypto').randomUUID()}
 global.ItemProvider={fromText:value=>({registeredTypes:['public.utf8-plain-text','public.url'],loadText:async()=>value})}
 const h=mount(Parent,{bookmarkName:'repo',name:'test'})
 const covers=h.tree.props.fullScreenCover
 for(const tab of [0,1,2]){
  data.tab=tab;h.render()
  assert.equal(h.tree.type,'List','all tabs keep original stable List presentation owner')
  assert.equal(typeof h.tree.props.refreshable,'function')
  assert.equal(h.tree.props.safeAreaInset,undefined)
  assert.equal(h.tree.props.fullScreenCover.length,covers.length)
  assert.deepEqual(h.tree.children.map(n=>n.type),['RepoBranchSection','RepoRemoteSections','RepoDetailTabContent'],'original section order')
  assert.equal(all(h.tree).some(n=>['ScrollView','LazyVStack'].includes(n.type)),false)
  const props=all(h.tree).find(n=>n.type==='RepoDetailTabContent').props
  const content=mount(TabContent,props)
  const segmentSection=content.tree.children[0]
  assert.equal(segmentSection.type,'Section')
  const picker=all(segmentSection).find(n=>n.type===Segmented)
  assert.equal(picker.props.value,tab)
  assert.deepEqual(picker.props.options,[{value:0,title:'文件'},{value:1,title:'Stash'},{value:2,title:'状态'}])
  picker.props.onChanged(tab)
  if(tab===0){
   const fileNode=all(content.tree).find(n=>n.type===FilesTab),fileHost=mount(fileNode.type,fileNode.props,{effectUpdates:true})
   await tick();fileHost.render();assert.equal(fileHost.tree.type,'Section')
   const nodes=all(expand(fileHost.tree)),folder=nodes.find(n=>n.type==='DisclosureGroup'),file=nodes.find(n=>n.type==='Button'&&n.props.onDrag)
   assert.ok(folder.props.label.props.onDrop)
   assert.equal(folder.props.label.props.background,undefined);assert.equal(folder.props.padding,undefined)
   assert.equal(folder.props.trailingSwipeActions.allowsFullSwipe,false)
   assert.equal(file.props.trailingSwipeActions.allowsFullSwipe,false)
   assert.ok(nodes.every(n=>!n.props?.gesture&&!n.props?.simultaneousGesture&&!n.props?.highPriorityGesture&&!n.props?.defersSystemGestures))
   assert.ok(nodes.every(n=>n.props?.frame?.maxHeight!=='infinity'))
   const provider=file.props.onDrag.data();assert.equal(provider instanceof Promise,false)
   assert.equal(folder.props.label.props.onDrop.validateDrop({hasItemsConforming:()=>true}),true)
   folder.props.onChanged(true);fileHost.render();assert.ok(all(expand(fileHost.tree)).some(n=>n.type==='Text'&&n.children.includes('keep')))
   fileHost.unmount();assert.equal(fileHost.lateWrites,0)
  }else assert.ok(all(content.tree).some(n=>n.type===(tab===1?'StashTab':'HistoryTab')))
  content.unmount()
 }
 assert.deepEqual(changed,[0,1,2]);h.unmount()
 assert.doesNotMatch(source,/ScrollView|LazyVStack|FileDropDiagnosticZone|dropDiagnosticBridge/)
 console.log('PASS 1.4.39 stable List/native Section, original branch/sync/segment/files order, segmented values/content switching, native swipe and DisclosureGroup, refresh/cover wiring; no custom gestures/card rows/bottom probe')
 console.log('LIMIT JS wiring is not native scrolling/layout/gesture arbitration proof; List directory drop callback delivery remains unresolved on device')
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{delete global.FileManager;delete global.UUID;delete global.ItemProvider})
