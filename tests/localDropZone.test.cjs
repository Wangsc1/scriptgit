/* Wiring/ref behavior only: this cannot prove native onDrop delivery. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,all}=require('./remoteFiles.test.cjs')
const source=fs.readFileSync(path.join(__dirname,'../pages/RepoDetailPage.tsx'),'utf8'),mocks={scripting:ui}
for(const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
 const [,names,module]=match;if(module==='scripting')continue;mocks[module]={}
 for(const token of names.split(',')){const name=token.trim();if(name&&!name.startsWith('type '))mocks[module][name]=name}
}
const hook=(module,name,value)=>mocks[module]={[name]:()=>value}
const data={displayName:'test',changes:[],branchInfo:{current:'main'},tab:0}
hook('../hooks/useLocalEntryCreation','useLocalEntryCreation',{busy:false,open(){}})
hook('../hooks/useToast','useToast',{})
hook('../hooks/useRepoDetailData','useRepoDetailData',data)
hook('../hooks/useOpBusy','useOpBusy',{})
hook('../hooks/useRepoDetailNavigation','useRepoDetailNavigation',{})
hook('../hooks/useRepoWorktreeActions','useRepoWorktreeActions',{commitSheetMode:null})
for(const [module,name]of [['useRepoPendingActions','useRepoPendingActions'],['useRepoBranchActions','useRepoBranchActions'],['useRepoSyncActions','useRepoSyncActions']])hook('../hooks/'+module,name,{})
mocks['../utils/format']={suggestCommitTitle:()=>'',shortOid(){}}
const Parent=load('pages/RepoDetailPage.tsx',mocks).RepoDetailPage
const TabContent=load('components/RepoDetailContent.tsx',{
 scripting:ui,'../pages/FilesTab':{FilesTab:'FilesTab'},'../pages/HistoryTab':{HistoryTab:'HistoryTab'},'../pages/StashTab':{StashTab:'StashTab'},'../constants/colors':{},
}).RepoDetailTabContent
function main(){
 const h=mount(Parent,{bookmarkName:'repo',name:'test'})
 assert.equal(h.tree.type,'List','existing List remains the root/swipe host')
 const zone=h.tree.props.safeAreaInset.bottom.content
 assert.equal(h.tree.props.safeAreaInset.bottom.spacing,0)
 assert.equal(zone.type,'FileDropDiagnosticZone')
 assert.ok(!h.tree.children.some(n=>all(n).some(v=>v.type==='FileDropDiagnosticZone')),'probe is outside List children/rows')
 const tab=all(h.tree).find(n=>n.type==='RepoDetailTabContent'),bridge=tab.props.dropDiagnosticBridge
 assert.equal(zone.props.bridge,bridge)
 const content=mount(TabContent,tab.props)
 assert.equal(all(content.tree).find(n=>n.type==='FilesTab').props.dropDiagnosticBridge,bridge,'same instance ref forwarded to actual FilesTab')
 for(const value of [1,2]){
  data.tab=value;h.render();assert.equal(h.tree.props.safeAreaInset,undefined,'no diagnostic region on stash/history')
  const props=all(h.tree).find(n=>n.type==='RepoDetailTabContent').props
  const other=mount(TabContent,props);assert.ok(!all(other.tree).some(n=>n.type==='FilesTab'));other.unmount()
 }
 data.tab=0;h.render();assert.equal(h.tree.props.safeAreaInset.bottom.content.props.bridge,bridge,'rerender/tab switches retain parent ref identity')
 content.unmount();h.unmount()
 assert.doesNotMatch(source,/DragDropTestPage|dragTestPresented|打开拖放测试/)
 console.log('PASS actual parent List.safeAreaInset bottom probe outside rows, file-tab-only, stable instance ref via actual tab component to FilesTab; no new presentation host')
 console.log('LIMIT native safe-area layout, drag delivery and List-vs-zone contrast require device verification')
}
main()
