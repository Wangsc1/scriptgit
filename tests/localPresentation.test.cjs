/* Actual RepoDetailPage virtual nodes; native presentation is NOT emulated. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,all}=require('./remoteFiles.test.cjs')
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(root+'/pages/RepoDetailPage.tsx','utf8')
const noop=()=>{},mocks={scripting:ui}
// Every dependency is explicit; exercise the real List/presentation state, not native UIKit.
for(const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
 const [,names,module]=match;if(module==='scripting')continue
 mocks[module]={};for(const token of names.split(',')){const name=token.trim();if(name)mocks[module][name]=name}
}
let refreshed=0
const data={displayName:'test',changes:[],branchInfo:{current:'main'},tab:2,refreshChangesAndSnapshot:async()=>{refreshed++}}
const hook=(module,name,value)=>mocks[module]={[name]:()=>value}
hook('../hooks/useToast','useToast',{})
hook('../hooks/useRepoDetailData','useRepoDetailData',data)
hook('../hooks/useOpBusy','useOpBusy',{})
hook('../hooks/useRepoDetailNavigation','useRepoDetailNavigation',{})
hook('../hooks/useRepoWorktreeActions','useRepoWorktreeActions',{commitSheetMode:null})
hook('../hooks/useRepoPendingActions','useRepoPendingActions',{})
hook('../hooks/useRepoBranchActions','useRepoBranchActions',{})
hook('../hooks/useRepoSyncActions','useRepoSyncActions',{})
mocks['../utils/format']={suggestCommitTitle:()=>'',shortOid:noop}
const {RepoDetailPage}=load('pages/RepoDetailPage.tsx',mocks)
async function main(){
 const h=mount(RepoDetailPage,{bookmarkName:'repo',name:'test'})
 assert.equal(h.tree.type,'List');assert.equal(h.tree.props.fullScreenCover.isPresented,false)
 const tab=()=>{h.render();return all(h.tree).find(n=>n.type==='RepoDetailTabContent')}
 const file={path:'file.txt',text:'draft',version:{}}
 tab().props.onOpenLocalFile(file);h.render();let cover=h.tree.props.fullScreenCover
 assert.equal(cover.isPresented,true);assert.equal(cover.content.type,'LocalFileEditor');assert.equal(cover.content.props.file,file)
 // Tab source content can change while the stable List owns the editor session.
 data.tab=0;h.render();assert.equal(h.tree.props.fullScreenCover.isPresented,true)
 await cover.content.props.onChanged('file.txt',false);assert.equal(refreshed,1)
 cover.content.props.onClose();h.render();assert.equal(h.tree.props.fullScreenCover.isPresented,false)
 tab().props.onOpenLocalFile({...file,previewUrl:'data:image/png;base64,AA==',text:null});h.render();cover=h.tree.props.fullScreenCover
 assert.equal(cover.content.type,'ImageViewer');assert.equal(cover.content.props.url,'data:image/png;base64,AA==');assert.ok(!all(cover.content).some(n=>n.type==='LocalFileEditor'))
 cover.content.props.onClose();h.render();assert.equal(h.tree.props.fullScreenCover.isPresented,false);h.unmount()
 const entry=fs.readFileSync(root+'/index.tsx','utf8');assert.match(entry,/await Navigation.present\(<View \/>\)/);assert.equal((entry.match(/Script.exit\(\)/g)||[]).length,1)
 for(const name of ['pages/FilesTab.tsx','pages/LocalFileEditor.tsx','services/git/localFileService.ts'])assert.doesNotMatch(fs.readFileSync(root+'/'+name,'utf8'),/Script.exit|Navigation.present/)
 console.log('PASS real RepoDetailPage List owns editor/image sessions across Tab changes; explicit close, refresh, image route; no added Navigation.present/Script.exit path. Native lifecycle requires device validation.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
