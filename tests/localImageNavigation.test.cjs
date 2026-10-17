/* Real RepoDetailPage -> real LocalImagePreview props/lifecycle. System edge
 * gesture recognition itself is NOT simulated or established by this test. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,all,tick,deferred}=require('./remoteFiles.test.cjs')
function viewportNodes(h){const geometry=all(h.tree).find(n=>n.type==='GeometryReader');return geometry?all(geometry.children[0]({size:{width:320,height:520}})):all(h.tree)}
const execution=load('services/localImportExecution.ts')
let reads=0,fail=false,gate=null,sourceWrites=0,mergeLoads=0,skips=0
const original={path:'synthetic.HEIC',text:null,image:true,previewImage:{native:'first',width:1600,height:800},version:{}}
const refreshed={...original,previewImage:{native:'refreshed',width:1600,height:800}}
const ImagePage=load('components/LocalImagePreview.tsx',{'../utils/localImageZoom':load('utils/localImageZoom.ts'),scripting:ui,'../services/localImportExecution':execution,'../services/gitService':{openLocalWorktreeFile:async(bookmark,file)=>{reads++;assert.equal(bookmark,'repo');assert.equal(file,original.path);if(gate)await gate.promise;if(fail)throw Error('decode failed');return refreshed}}}).LocalImagePreview
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
function open(parent){parent.render();all(parent.tree).find(n=>n.type==='RepoDetailTabContent').props.onOpenLocalFile(original);parent.render();const route=parent.tree.props.navigationDestination;assert.equal(route.isPresented,true);assert.equal(parent.tree.props.fullScreenCover.isPresented,false);assert.equal(route.content.type,ImagePage);return route}
function child(route){const h=mount(route.content.type,route.content.props);assert.equal(h.tree.type,'VStack');assert.equal(h.tree.props.navigationBarBackButtonHidden,false);assert.equal(h.tree.props.toolbar.topBarLeading,undefined);assert.doesNotMatch(JSON.stringify(h.tree),/图片只读|显示缩略图/);assert.ok(!all(h.tree).some(n=>n.type==='NavigationStack'||n.type==='WebView'));return h}
async function main(){
 global.FileManager=new Proxy({},{get:()=>()=>{sourceWrites++;throw Error('navigation must not touch source')}})
 const parent=mount(Parent,{bookmarkName:'repo',name:'test'});let route=open(parent),image=child(route)
 const initialViewport=viewportNodes(image).find(n=>n.type==='ScrollView');initialViewport.props.simultaneousGesture.ended({magnification:2});image.render();assert.equal(viewportNodes(image).find(n=>n.type==='ScrollView').props.scrollDisabled,false);assert.equal(parent.tree.props.navigationDestination.isPresented,true)
 const oldKey=route.content.props.key
 await image.tree.props.toolbar.topBarTrailing.props.action();parent.render();route=parent.tree.props.navigationDestination;assert.equal(route.isPresented,true);assert.equal(route.content.props.file.previewImage,refreshed.previewImage);assert.notEqual(route.content.props.key,oldKey);assert.equal(skips,1);image.unmount();image=child(route);assert.equal(viewportNodes(image).find(n=>n.type==='ScrollView').props.scrollDisabled,true,'actual refreshed parent session resets zoom')
 const newPinch=viewportNodes(image).find(n=>n.type==='ScrollView').props.simultaneousGesture;newPinch.ended({magnification:2});image.render()
 fail=true;await image.tree.props.toolbar.topBarTrailing.props.action();image.render();assert.match(JSON.stringify(image.tree),/图片刷新失败/);assert.equal(viewportNodes(image).find(n=>n.type==='Image').props.image,refreshed.previewImage);parent.render();assert.equal(parent.tree.props.navigationDestination.isPresented,true);assert.equal(viewportNodes(image).find(n=>n.type==='ScrollView').props.scrollDisabled,false,'failed refresh preserves current zoom');fail=false
 // Native system back-button/interactive-pop completion reports false to the
 // PARENT destination. Pop during an in-flight refresh must never reopen it.
 gate=deferred();const loading=image.tree.props.toolbar.topBarTrailing.props.action();await tick();assert.equal(image.tree.props.toolbar.topBarTrailing.props.disabled,false) // render below reads new busy state
 image.render();assert.equal(image.tree.props.toolbar.topBarTrailing.props.disabled,true)
 parent.tree.props.navigationDestination.onChanged(false);parent.render();assert.equal(parent.tree.props.navigationDestination.isPresented,false);assert.equal(parent.tree.props.fullScreenCover.isPresented,false);image.unmount();gate.resolve();await loading;parent.render();assert.equal(parent.tree.props.navigationDestination.isPresented,false);assert.equal(image.lateWrites,0);assert.equal(mergeLoads,0)
 gate=null;route=open(parent);image=child(route);const staleReload=route.content.props.onReload;route.onChanged(false);parent.render();image.unmount();staleReload(refreshed);parent.render();assert.equal(parent.tree.props.navigationDestination.isPresented,false)
 route=open(parent);image=child(route);const detachedReload=route.content.props.onReload;image.unmount();parent.unmount();detachedReload(refreshed);assert.equal(parent.lateWrites,0);assert.equal(sourceWrites,0);assert.equal(reads,3)
 console.log('PASS actual parent native image destination -> real view refresh/error -> parent pop cleanup, in-flight/stale/unmounted refresh cannot reopen; default back button retained, zoom/reset/error preserved, no root drag gesture/nested stack/footer/source access')
 console.log('LIMIT native iPhone edge-swipe pop and navigation animation still need device validation')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{delete global.FileManager})
