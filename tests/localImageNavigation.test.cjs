/* Real RepoDetailPage -> real LocalImagePreview props/lifecycle. System edge
 * gesture recognition itself is NOT simulated or established by this test. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,all,tick,deferred}=require('./remoteFiles.test.cjs')
function viewportNodes(h){return all(h.tree)}
const execution=load('services/localImportExecution.ts')
let reads=0,fail=false,gate=null,sourceWrites=0,mergeLoads=0,skips=0
const original={path:'synthetic.png',text:null,image:true,previewImage:{native:'first',toPNGBase64String:()=>'FIRST'},version:{}}
const refreshed={...original,previewImage:{native:'refreshed',toPNGBase64String:()=>'REFRESHED'}}
const ImagePage=load('components/LocalImagePreview.tsx',{'./ImageViewer':{ImageViewer:'ImageViewer'},'../utils/localImageDisplay':load('utils/localImageDisplay.ts'),scripting:ui,'../services/localImportExecution':execution,'../services/gitService':{openLocalWorktreeFile:async(bookmark,file)=>{reads++;assert.equal(bookmark,'repo');assert.equal(file,original.path);if(gate)await gate.promise;if(fail)throw Error('decode failed');return refreshed}}}).LocalImagePreview
const source=fs.readFileSync(path.join(__dirname,'../pages/RepoDetailPage.tsx'),'utf8'),mocks={scripting:ui}
for(const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
 const [,names,module]=match;if(module==='scripting')continue;mocks[module]={};for(const token of names.split(',')){const name=token.trim();if(name)mocks[module][name]=name}
}
const hook=(module,name,value)=>mocks[module]={[name]:()=>value}
hook('../hooks/useLocalEntryCreation','useLocalEntryCreation',{busy:false,open(){}})
hook('../hooks/useToast','useToast',{})
hook('../hooks/useRepoDetailData','useRepoDetailData',{displayName:'test',changes:[],branchInfo:{current:'main'},tab:2,loadMergeState:()=>{mergeLoads++}})
hook('../hooks/useOpBusy','useOpBusy',{})
hook('../hooks/useRepoDetailNavigation','useRepoDetailNavigation',{isPresented:false,skipNextAppearLoad(){skips++}})
hook('../hooks/useRepoWorktreeActions','useRepoWorktreeActions',{commitSheetMode:null})
for(const [module,name]of [['useRepoPendingActions','useRepoPendingActions'],['useRepoBranchActions','useRepoBranchActions'],['useRepoSyncActions','useRepoSyncActions']])hook('../hooks/'+module,name,{})
mocks['../utils/format']={suggestCommitTitle:()=>'',shortOid(){}}
mocks['../components/LocalImagePreview']={LocalImagePreview:ImagePage}
const Parent=load('pages/RepoDetailPage.tsx',mocks).RepoDetailPage
function open(parent){parent.render();all(parent.tree).find(n=>n.type==='RepoDetailTabContent').props.onOpenLocalFile(original);parent.render();const route=parent.tree.props.fullScreenCover[1];assert.equal(route.isPresented,true);assert.equal(parent.tree.props.navigationDestination.isPresented,false);assert.equal(parent.tree.props.fullScreenCover[0].isPresented,false);assert.equal(route.content.type,ImagePage);return route}
function child(route){const h=mount(route.content.type,route.content.props);assert.equal(h.tree.type,'ZStack');assert.equal(all(h.tree).find(n=>n.type==='ImageViewer').props.sessionId,route.content.props.sessionId);assert.equal(all(h.tree).find(n=>n.type==='ImageViewer').props.onClose,route.content.props.onClose);assert.doesNotMatch(JSON.stringify(h.tree),/图片只读|显示缩略图/);assert.ok(!all(h.tree).some(n=>n.type==='WebView'));return h}
async function main(){
 global.FileManager=new Proxy({},{get:()=>()=>{sourceWrites++;throw Error('navigation must not touch source')}})
 const parent=mount(Parent,{bookmarkName:'repo',name:'test'});let route=open(parent),image=child(route)
 const url=h=>all(h.tree).find(n=>n.type==='ImageViewer').props.url;assert.equal(url(image),'data:image/png;base64,FIRST')
 assert.ok(!all(image.tree).some(n=>n.type==='Button'),'no refresh button');assert.doesNotMatch(JSON.stringify(image.tree),/刷新/);assert.equal(route.content.props.onReload,undefined);assert.equal(route.content.props.bookmarkName,undefined)
 // Close via the ImageViewer callback: parent clears the session; a second/stale close cannot reopen.
 const staleClose=route.content.props.onClose;all(image.tree).find(n=>n.type==='ImageViewer').props.onClose();parent.render();assert.equal(parent.tree.props.fullScreenCover[1].isPresented,false);assert.equal(parent.tree.props.fullScreenCover[0].isPresented,false);image.unmount()
 route=open(parent);image=child(route);const nativeDismiss=parent.tree.props.fullScreenCover[1].onChanged;nativeDismiss(false);parent.render();assert.equal(parent.tree.props.fullScreenCover[1].isPresented,false,'system cover dismissal clears state');staleClose();parent.render();assert.equal(parent.tree.props.fullScreenCover[1].isPresented,false,'stale close is inert');image.unmount()
 route=open(parent);image=child(route);const detachedClose=route.content.props.onClose;image.unmount();parent.unmount();detachedClose();assert.equal(parent.lateWrites,0);assert.equal(sourceWrites,0);assert.equal(reads,0);assert.equal(mergeLoads,0)
 console.log('PASS actual parent native image destination -> real ImageViewer wiring without refresh -> close/system-dismiss cleanup, stale/unmounted close inert; fullScreenCover system dismissal callback/close button, no custom drag, ImageViewer PNG data URL/close preserved, no editor cover/source access')
 console.log('LIMIT native ImageViewer WebKit zoom, edge-swipe close and downward cover animation need device validation (stub does not prove smoothness)')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{delete global.FileManager})
