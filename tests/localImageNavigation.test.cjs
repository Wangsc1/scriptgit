/* Real RepoDetailPage -> real LocalImagePreview props/lifecycle. System edge
 * gesture recognition itself is NOT simulated or established by this test. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,all,tick,deferred}=require('./remoteFiles.test.cjs')
function viewportNodes(h){return all(h.tree)}
const execution=load('services/localImportExecution.ts')
let reads=0,fail=false,gate=null,sourceWrites=0,mergeLoads=0,skips=0
const original={path:'synthetic.HEIC',text:null,image:true,previewImage:{native:'first',toJPEGBase64String:()=>'FIRST'},version:{}}
const refreshed={...original,previewImage:{native:'refreshed',toJPEGBase64String:()=>'REFRESHED'}}
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
const btn=h=>all(h.tree).find(n=>n.type==='Button'&&/刷新/.test(n.props.title))
function child(route){const h=mount(route.content.type,route.content.props);assert.equal(h.tree.type,'ZStack');assert.equal(all(h.tree).find(n=>n.type==='ImageViewer').props.sessionId,route.content.props.sessionId);assert.equal(all(h.tree).find(n=>n.type==='ImageViewer').props.onClose,route.content.props.onClose);assert.doesNotMatch(JSON.stringify(h.tree),/图片只读|显示缩略图/);assert.ok(!all(h.tree).some(n=>n.type==='WebView'));return h}
async function main(){
 global.FileManager=new Proxy({},{get:()=>()=>{sourceWrites++;throw Error('navigation must not touch source')}})
 const parent=mount(Parent,{bookmarkName:'repo',name:'test'});let route=open(parent),image=child(route)
 const initialUrl=all(image.tree).find(n=>n.type==='ImageViewer').props.url;assert.match(initialUrl,/^data:image\/jpeg;base64,/)
 const oldKey=route.content.props.key
 await btn(image).props.action();parent.render();route=parent.tree.props.fullScreenCover[1];assert.equal(route.isPresented,true);assert.equal(route.content.props.file.previewImage,refreshed.previewImage);assert.notEqual(route.content.props.key,oldKey);assert.equal(skips,0);image.unmount();image=child(route)
 fail=true;await btn(image).props.action();image.render();assert.match(JSON.stringify(image.tree),/图片刷新失败/);assert.equal(all(image.tree).find(n=>n.type==='ImageViewer').props.url,'data:image/jpeg;base64,REFRESHED');parent.render();assert.equal(parent.tree.props.fullScreenCover[1].isPresented,true);fail=false
 // Native sheet pull-down/close completion reports false to the
 // PARENT destination. Pop during an in-flight refresh must never reopen it.
 gate=deferred();const loading=btn(image).props.action();await tick();assert.equal(btn(image).props.disabled,false) // render below reads new busy state
 image.render();assert.equal(btn(image).props.disabled,true)
 parent.tree.props.fullScreenCover[1].onChanged(false);parent.render();assert.equal(parent.tree.props.fullScreenCover[1].isPresented,false);assert.equal(parent.tree.props.fullScreenCover[0].isPresented,false);image.unmount();gate.resolve();await loading;parent.render();assert.equal(parent.tree.props.fullScreenCover[1].isPresented,false);assert.equal(image.lateWrites,0);assert.equal(mergeLoads,0)
 gate=null;route=open(parent);image=child(route);image.tree.props.children;all(image.tree).find(n=>n.type==='ImageViewer').props.onClose();parent.render();assert.equal(parent.tree.props.fullScreenCover[1].isPresented,false,'close button dismisses');route=open(parent);image=child(route);const staleReload=route.content.props.onReload;route.onChanged(false);parent.render();image.unmount();staleReload(refreshed);parent.render();assert.equal(parent.tree.props.fullScreenCover[1].isPresented,false)
 route=open(parent);image=child(route);const detachedReload=route.content.props.onReload;image.unmount();parent.unmount();detachedReload(refreshed);assert.equal(parent.lateWrites,0);assert.equal(sourceWrites,0);assert.equal(reads,3)
 console.log('PASS actual parent native image destination -> real view refresh/error -> parent pop cleanup, in-flight/stale/unmounted refresh cannot reopen; fullScreenCover system dismissal callback/close button, no custom drag, ImageViewer data URL/close/error preserved, no editor cover/source access')
 console.log('LIMIT native ImageViewer WebKit zoom, edge-swipe close and downward cover animation need device validation (stub does not prove smoothness)')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{delete global.FileManager})
