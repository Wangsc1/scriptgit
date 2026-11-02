/* Actual RepoDetailPage virtual nodes; native presentation is NOT emulated. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,all,tick,deferred}=require('./remoteFiles.test.cjs')
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(root+'/pages/RepoDetailPage.tsx','utf8')
const noop=()=>{},mocks={scripting:ui}
// Every dependency is explicit; exercise the real List/presentation state, not native UIKit.
for(const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
 const [,names,module]=match;if(module==='scripting')continue
 mocks[module]={};for(const token of names.split(',')){const name=token.trim();if(name)mocks[module][name]=name}
}
let refreshed=0,skippedReloads=0,closedOtherPages=0,mergeLoads=0
const nav={isPresented:false,page:null,destinationId:0,skipNextAppearLoad(){skippedReloads++},openPage(page,options){this.destinationId++;this.page=page;this.isPresented=true;if(options?.skipReload)this.skipNextAppearLoad()},closePage(page){if(this.page===page){this.page=null;this.isPresented=false}},closeAll(){closedOtherPages++;this.page=null;this.isPresented=false;return true}}
const data={displayName:'test',changes:[],branchInfo:{current:'main'},tab:2,loadAll(){throw Error('unexpected full scan')},loadMergeState:()=>{mergeLoads++},refreshChangesAndSnapshot:async()=>{refreshed++}}
const hook=(module,name,value)=>mocks[module]={[name]:()=>value}
hook('../hooks/useLocalEntryCreation','useLocalEntryCreation',{busy:false,open(){}})
hook('../hooks/useToast','useToast',{})
hook('../hooks/useRepoDetailData','useRepoDetailData',data)
hook('../hooks/useOpBusy','useOpBusy',{})
hook('../hooks/useRepoDetailNavigation','useRepoDetailNavigation',nav)
hook('../hooks/useRepoWorktreeActions','useRepoWorktreeActions',{commitSheetMode:null})
hook('../hooks/useRepoPendingActions','useRepoPendingActions',{})
hook('../hooks/useRepoBranchActions','useRepoBranchActions',{})
hook('../hooks/useRepoSyncActions','useRepoSyncActions',{})
mocks['../utils/format']={suggestCommitTitle:()=>'',shortOid:noop}
const {RepoDetailPage}=load('pages/RepoDetailPage.tsx',mocks)
async function main(){
 const h=mount(RepoDetailPage,{bookmarkName:'repo',name:'test'})
 assert.equal(h.tree.type,'List');assert.equal(h.tree.props.fullScreenCover.length,1);assert.equal(h.tree.props.navigationDestination.isPresented,false)
 const tab=()=>{h.render();return all(h.tree).find(n=>n.type==='RepoDetailTabContent')}
 const file={path:'file.txt',text:'draft',version:{}}
 tab().props.onOpenLocalFile(file);h.render();let cover=h.tree.props.navigationDestination
 assert.equal(cover.isPresented,true);assert.equal(cover.content.type,'LocalFileEditor');assert.equal(cover.content.props.file,file)
 // Follow the real parent destination -> LocalFileEditor -> bottom TabView ->
 // LocalCodeEditor. This exercises JS/native lifecycle callbacks, NOT UIKit layout.
 const actualService=load('services/localCodeEditor.ts',{'../vendor/local-code-editor-bundle':load('vendor/local-code-editor-bundle.ts')})
 let gate=deferred(),savedText,saveFail=false,saveGate=null,saveCalls=0;const browsers=[]
 global.WebViewController=class {
  constructor(){this.handlers={};this.revision=0;this.content='';this.loads=0;browsers.push(this)}
  async addScriptMessageHandler(name,callback){this.handlers[name]=callback}
  async loadHTML(html){assert.equal(this.bound,true,'loadHTML must follow the bound native WebView appearance, never the root effect');this.html=html;this.loads++;if(gate)await gate.promise;return true}
  async evaluateJavaScript(code){
   if(code.includes('__localCodeEditorBootstrap'))return {ready:true,error:''}
   if(code.includes('.activate(')){this.content=JSON.parse(code.match(/activate\((.*)\)$/s)[1]);return {content:this.content,revision:this.revision}}
   if(code.includes('width: window.innerWidth'))return {width:390,height:700}
   if(code.includes('.prepareRead('))return false
   if(code.includes('.read('))return {content:this.content,revision:this.revision}
   return true
  }
  dispose(){this.disposed=true}
 }
 const color=load('constants/colors.ts')
 const ActualCode=load('components/LocalCodeEditor.tsx',{scripting:ui}).LocalCodeEditor
 const tabUI=new Proxy(ui,{get:(target,key)=>key==='ImageRenderer'?{toUIImage:async()=>({withTintColor:()=>({original:true})})}:target[key]})
 const ActualSwitcher=load('components/FileChangeSwitcher.tsx',{scripting:tabUI,'../constants/colors':color}).FileChangeSwitcher
 const ActualPage=load('pages/LocalFileEditor.tsx',{scripting:ui,'../constants/colors':color,'../services/gitService':{saveLocalWorktreeFile:async(_,base,value)=>{saveCalls++;if(saveGate)await saveGate.promise;if(saveFail)throw Error('disk denied');savedText=value;return {...base,text:value}},readLocalWorktreeFile:async()=>({...file,text:'disk refresh'})},'../services/diffService':{},'../components/DiffViewer':{DiffViewer:'DiffViewer'},'../components/FileChangeSwitcher':{FileChangeSwitcher:ActualSwitcher},'../components/LocalCodeEditor':{LocalCodeEditor:ActualCode},'../services/localCodeEditor':actualService,'../utils/editorDiff':{}}).LocalFileEditor
 const ActualDetail=load('pages/RepoDetailPage.tsx',{...mocks,'../hooks/useRepoDetailNavigation':load('hooks/useRepoDetailNavigation.ts',{scripting:ui}),'./LocalFileEditor':{LocalFileEditor:ActualPage}}).RepoDetailPage
 data.changes=[{filepath:'file.txt'}]
 const actual=mount(ActualDetail,{bookmarkName:'repo',name:'test'})
 // Exercise the real file Button, not merely the parent's onOpen callback.
 const fileSource=fs.readFileSync(root+'/pages/FilesTab.tsx','utf8'),fileMocks={scripting:ui}
 for(const m of fileSource.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
  if(m[2]==='scripting')continue;fileMocks[m[2]]={};for(const name of m[1].split(','))fileMocks[m[2]][name.trim()]=name.trim()
 }
 let openedFiles=0
 Object.assign(fileMocks,{'../components/StandardFolderRow':load('components/StandardFolderRow.tsx',{scripting:ui}),'../utils/fileTree':load('utils/fileTree.ts'),'../utils/fileListPerformance':load('utils/fileListPerformance.ts'),'../constants/colors':color,'../services/repoStore':{resolveWorkdir:()=>'/fixture'},'../services/localImportExecution':{localImportOnMain:async(_,fn)=>fn()},'../utils/format':{formatBytes:String,formatDate:String},'../services/gitService':{knownLocalRenameHints:()=>[],openLocalWorktreeFile:async(bookmark,path)=>{assert.equal(bookmark,'repo');assert.equal(path,file.path);openedFiles++;return file}}})
 const FixtureFiles=load('pages/FilesTab.tsx',fileMocks).FilesTab,priorFileManager=global.FileManager
 global.FileManager={stat:async()=>({size:5,modificationDate:1})}
 const listing=mount(FixtureFiles,{files:[],loading:false,bookmarkName:'repo',changes:[{filepath:file.path,status:'*added'}],onWorktreeChanged:async()=>{},onOpen:all(actual.tree).find(n=>n.type==='RepoDetailTabContent').props.onOpenLocalFile})
 function expandFile(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expandFile);if(typeof n.type==='function')return expandFile(n.type(n.props));return {...n,children:(n.children||[]).map(expandFile)}}
 const fileButton=all(expandFile(listing.tree)).find(n=>n.type==='Button'&&JSON.stringify(n.children).includes(file.path));assert.ok(fileButton);await fileButton.props.action();actual.render();assert.equal(openedFiles,1)
 listing.unmount();await tick();global.FileManager=priorFileManager
 const actualCover=actual.tree.props.navigationDestination;assert.equal(actualCover.content.type,ActualPage);assert.equal(actual.tree.props.fullScreenCover[0].isPresented,false)
 all(actual.tree).find(n=>n.type==='RepoRemoteSections').props.onManageRemotes();actual.render();assert.equal(actual.tree.props.navigationDestination.content.type,ActualPage,'pending parent route cannot replace a draft editor')
 const editor=mount(actualCover.content.type,actualCover.content.props);assert.equal(editor.tree.type,'VStack');assert.equal(editor.tree.props.navigationBarBackButtonHidden,true);assert.equal(all(editor.tree).some(n=>n.type==='NavigationStack'),false)
 const switchNode=all(editor.tree).find(n=>n.type===ActualSwitcher);assert.ok(switchNode,'modified/untracked text immediately uses the original bottom switcher')
 assert.equal(all(editor.tree).some(n=>n.type==='TextField'||['代码编辑','文本编辑'].includes(n.props.title)),false)
 const bar=mount(switchNode.type,switchNode.props);assert.equal(bar.tree.type,'TabView');assert.equal(bar.tree.props.tabIndex,0)
 assert.equal(bar.tree.children[0].props.tag,0);assert.equal(bar.tree.children[1].props.tag,1)
 assert.deepEqual(bar.tree.children.map(n=>all(n.props.tabItem).find(x=>x.type==='Text').children.join('')),['原内容','改动项'])
 const codeNode=bar.tree.children[0].children[0];assert.equal(codeNode.type,ActualCode)
 let body=mount(codeNode.type,codeNode.props);body.tree.props.onAppear?.();await tick();body.render();editor.render()
 assert.equal(browsers.length,1);const browser=browsers[0]
 let webNode=all(body.tree).find(n=>n.type==='WebView');assert.equal(webNode.props.controller,browser);assert.equal(browser.loads,0);assert.equal(codeNode.props.controller.phase,'idle');browser.bound=true;webNode.props.onAppear();await tick();body.render();editor.render()
 assert.ok(all(body.tree).some(n=>n.type==='Text'&&n.children.join('').includes('正在加载本地编辑器')))
 gate.resolve();gate=null;await tick();await tick();body.render();editor.render()
 assert.equal(codeNode.props.controller.phase,'ready');assert.equal(browser.content,'draft');assert.equal(browser.loads,1)
 assert.equal(all(editor.tree).some(n=>n.type==='Text'&&n.children.join('').includes('代码编辑器：')),false,'no temporary status row')
 browser.content='未保存中文草稿';browser.revision=1;browser.handlers.localCodeEditorChange({content:browser.content,revision:1})
 for(let i=0;i<2;i++){
  webNode.props.onDisappear?.();body.tree.props.onDisappear?.();body.unmount();bar.tree.props.onTabIndexChanged(1);bar.render();assert.equal(bar.tree.props.tabIndex,1)
  bar.tree.props.onTabIndexChanged(0);bar.render();assert.equal(bar.tree.props.tabIndex,0)
  const returning=bar.tree.children[0].children[0];assert.equal(returning.props.controller,codeNode.props.controller)
  body=mount(returning.type,returning.props);assert.equal(body.tree.children[0].props.controller,browser);body.tree.props.onAppear?.();webNode=body.tree.children[0];webNode.props.onAppear();await tick()
  assert.equal(browser.loads,1);assert.equal(codeNode.props.controller.content,'未保存中文草稿');assert.equal(browser.content,'未保存中文草稿');assert.equal(browser.disposed,undefined)
 }
 browser.handlers.localCodeEditorError('controlled native integration failure');body.render();assert.ok(all(body.tree).some(n=>n.type==='Text'&&n.children.join('').includes('controlled native integration failure')),'real error remains visible')
 body.tree.props.onAppear?.();webNode.props.onAppear();await tick();assert.equal(browser.loads,1,'repeated native appearances never reload or replace a draft')
 browser.content='最后中文草稿\r\n';browser.revision=2
 const beforeSaveRefresh=refreshed
 saveFail=true;await editor.tree.props.toolbar.topBarLeading.props.action();editor.render();actual.render()
 assert.equal(actual.tree.props.navigationDestination.isPresented,true);assert.equal(browser.content,'最后中文草稿\r\n');assert.ok(all(editor.tree).some(n=>n.type==='Text'&&n.children.join('').includes('disk denied')))
 assert.equal(savedText,undefined);assert.equal(refreshed,beforeSaveRefresh)
 // Native destination notifications cannot replace the save-first toolbar/Web path.
 actualCover.onChanged(false);actual.render();assert.equal(actual.tree.props.navigationDestination.isPresented,true)
 saveFail=false;saveGate=deferred();const beforeCalls=saveCalls
 const returning=editor.tree.props.toolbar.topBarLeading.props.action();await tick();const double=editor.tree.props.toolbar.topBarLeading.props.action();await browser.handlers.localCodeEditorBack();await double
 assert.equal(saveCalls,beforeCalls+1);actual.render();assert.equal(actual.tree.props.navigationDestination.isPresented,true)
 saveGate.resolve();saveGate=null;await returning;assert.equal(savedText,'最后中文草稿\r\n');actual.render();assert.equal(actual.tree.props.navigationDestination.isPresented,false)
 body.unmount();bar.unmount();editor.unmount();assert.equal(browser.disposed,true)
 actual.tree.props.onAppear();await new Promise(r=>setTimeout(r,370));assert.equal(refreshed,beforeSaveRefresh+1,'one delayed status refresh, not another whole-tree load')
 // Refresh remounts only the editor key within the SAME destination.
 all(actual.tree).find(n=>n.type==='RepoDetailTabContent').props.onOpenLocalFile(file);actual.render()
 const beforeReload=actual.tree.props.navigationDestination,priorKey=beforeReload.content.props.key
 const refreshing=mount(beforeReload.content.type,beforeReload.content.props)
 await refreshing.tree.props.toolbar.topBarTrailing.props.action();actual.render();const afterReload=actual.tree.props.navigationDestination
 assert.equal(afterReload.isPresented,true);assert.notEqual(afterReload.content.props.key,priorKey);assert.equal(afterReload.content.props.file.text,'disk refresh')
 beforeReload.content.props.onClose();beforeReload.content.props.onReload({...file,text:'late wrong value'});beforeReload.onChanged(false);actual.render()
 assert.equal(actual.tree.props.navigationDestination.content.props.file.text,'disk refresh');assert.equal(actual.tree.props.navigationDestination.isPresented,true);refreshing.unmount()
 const reloaded=mount(afterReload.content.type,afterReload.content.props)
 await reloaded.tree.props.toolbar.topBarLeading.props.action();actual.render();assert.equal(actual.tree.props.navigationDestination.isPresented,false);reloaded.unmount()
 // Real shared navigation hook: old editor/remote dismissals cannot close history/GitHub.
 all(actual.tree).find(n=>n.type==='RepoRemoteSections').props.onManageRemotes();actual.render();const remoteRoute=actual.tree.props.navigationDestination
 assert.equal(remoteRoute.content.props.showRemotes,true);afterReload.content.props.onClose();afterReload.onChanged(false);actual.render();assert.equal(actual.tree.props.navigationDestination.content.props.showRemotes,true)
 all(actual.tree).find(n=>n.type==='RepoDetailTabContent').props.onSelectCommit({oid:'abc'});actual.render();assert.equal(actual.tree.props.navigationDestination.content.props.selectedCommitOid,'abc')
 remoteRoute.onChanged(false);actual.render();assert.equal(actual.tree.props.navigationDestination.content.props.selectedCommitOid,'abc')
 actual.tree.props.navigationDestination.onChanged(false);actual.render();assert.equal(actual.tree.props.navigationDestination.isPresented,false)
 data.githubFullName='owner/repo';actual.render();all(actual.tree.props.toolbar).find(n=>n.type==='Button'&&n.props.title==='Edit Remote Files').props.action();actual.render()
 assert.equal(actual.tree.props.navigationDestination.content.props.githubWorkKind,3);assert.equal(actual.tree.props.navigationDestination.content.props.githubFullName,'owner/repo');assert.equal(actual.tree.props.navigationDestination.content.props.selectedCommitOid,null)
 actual.tree.props.navigationDestination.onChanged(false);actual.render();data.githubFullName=null
 all(actual.tree).find(n=>n.type==='RepoDetailTabContent').props.onOpenLocalFile(file);actual.render();const detached=actual.tree.props.navigationDestination.content.props
 actual.unmount();detached.onClose();detached.onReload({...file,text:'late'});await detached.onChanged();assert.equal(actual.lateWrites,0)
 refreshed=0;mergeLoads=0

 data.changes=[]
 // Tabs retain the original stable List presentation owner.
 data.tab=0;h.render();assert.equal(h.tree.props.navigationDestination.isPresented,true)
 await cover.content.props.onChanged('file.txt',false);assert.equal(refreshed,1)
 cover.content.props.onClose();h.render();assert.equal(h.tree.props.navigationDestination.isPresented,false)
 tab().props.onOpenLocalFile({...file,previewImage:{nativeThumbnail:true},text:null});h.render();let destination=h.tree.props.fullScreenCover[0]
 assert.equal(h.tree.props.navigationDestination.isPresented,false,'image retains its cover, editor destination stays closed');assert.equal(destination.isPresented,true)
 assert.equal(destination.content.type,'LocalImagePreview');assert.deepEqual(destination.content.props.file.previewImage,{nativeThumbnail:true});assert.equal(destination.content.props.onReload,undefined,'no refresh wiring');assert.ok(!all(destination.content).some(n=>n.type==='LocalFileEditor'))
 const firstImageSession=destination.content.props.sessionId
 assert.equal(skippedReloads,1,'editor push skips duplicate full-tree appearance scan; image does not add navigation reloads')
 destination.onChanged(false);h.render();assert.equal(h.tree.props.fullScreenCover[0].isPresented,false);assert.equal(h.tree.props.navigationDestination.isPresented,false)
 assert.equal(mergeLoads,0);assert.equal(closedOtherPages,0,'image dismiss does not close or refresh unrelated routes')
 for(let i=0;i<3;i++){
  tab().props.onOpenLocalFile({...file,previewImage:{nativeThumbnail:true},text:null});h.render();destination=h.tree.props.fullScreenCover[0]
  assert.ok(destination.content.props.sessionId>firstImageSession+i,'same image gets a fresh session')
  destination.onChanged(false);h.render();assert.equal(h.tree.props.fullScreenCover[0].isPresented,false)
 }
 nav.isPresented=true;h.render();assert.equal(h.tree.props.navigationDestination.content.type,'RepoDetailDestination');h.tree.props.navigationDestination.onChanged(false);assert.equal(closedOtherPages,1);assert.equal(mergeLoads,1)
 tab().props.onOpenLocalFile({...file,previewImage:{nativeThumbnail:true},text:null});h.render();const afterUnmountClose=h.tree.props.fullScreenCover[0].content.props.onClose
 h.unmount();afterUnmountClose();assert.equal(h.lateWrites,0)
 const entry=fs.readFileSync(root+'/index.tsx','utf8');assert.match(entry,/await Navigation.present\(\{ element: <View \/>, modalPresentationStyle: "fullScreen" \}\)/);assert.equal((entry.match(/Script.exit\(\)/g)||[]).length,1)
 for(const name of ['pages/FilesTab.tsx','pages/LocalFileEditor.tsx','services/git/localFileService.ts'])assert.doesNotMatch(fs.readFileSync(root+'/'+name,'utf8'),/Script.exit|Navigation.present/)
 // Capture actual WebView HTML for local/default modes; do not pretend to render native WebKit.
 let loadGate=null;const controllers=[];global.WebViewController=class{
  constructor(){controllers.push(this)}
  async addScriptMessageHandler(name,callback){this[name]=callback;if(name==='closeViewer')this.close=callback}
  async loadHTML(html){this.loads=(this.loads||0)+1;this.html=html;if(loadGate)await loadGate.promise}
  dispose(){this.disposed=true}
 }
 const {ImageViewer}=load('components/ImageViewer.tsx',{scripting:ui});let closed=0
 loadGate=deferred();const compact=mount(ImageViewer,{url:'data:image/png;base64,AA==',compactImage:true,onClose:()=>closed++});await tick();const local=controllers.at(-1);assert.equal(all(compact.tree).find(n=>n.type==='WebView').props.opacity,0,'pre-HTML WebView empty surface not composited');await tick();compact.render();assert.equal(all(compact.tree).find(n=>n.type==='WebView').props.opacity,0);loadGate.resolve();loadGate=null;await tick();compact.render();assert.equal(all(compact.tree).find(n=>n.type==='WebView').props.opacity,0,'navigation load completion is NOT image readiness');assert.equal(compact.tree.children.at(-2).type,'Rectangle','opaque cover sits above WebView before readiness');assert.deepEqual(compact.tree.children.at(-2).props.fill,{light:'#F7F9FA',dark:'#1C1C1E'});assert.ok(compact.tree.children.findIndex(n=>n.type==='Rectangle')>compact.tree.children.findIndex(n=>n.type==='VStack'));local.imageReady();compact.render();assert.ok(!all(compact.tree).some(n=>n.type==='Rectangle'),'cover removed only after image readiness');assert.equal(all(compact.tree).find(n=>n.type==='WebView').props.opacity,1,'reveal only on page image/decode readiness')
 const sameControllerCount=controllers.length;for(let i=0;i<5;i++)compact.render();assert.equal(controllers.length,sameControllerCount,'same url/session re-render does not reconstruct controller');assert.equal(local.loads,1,'one loadHTML per open, not a repeated reload')
 assert.equal(compact.tree.type,'ZStack');assert.equal(compact.tree.props.frame.maxHeight,'infinity');assert.equal(compact.tree.props.ignoresSafeArea.regions,'all')
 assert.match(local.html,/max-width: 80%/);assert.match(local.html,/max-height: 60%/);assert.match(local.html,/width: auto; height: auto; object-fit: contain/);assert.match(local.html,/box-sizing: border-box; padding: env\(safe-area-inset-top/);assert.match(local.html,/viewport-fit=cover/)
 assert.match(local.html,/html, body \{[\s\S]*?background: #F7F9FA/);assert.match(local.html,/@media \(prefers-color-scheme: dark\) \{ html, body \{ background: #1C1C1E; \} \}/);assert.match(local.html,/img \{ background: transparent; \}/)
 assert.doesNotMatch(local.html,/conic-gradient|linear-gradient|checker|background-size|border-radius:.*img|clip-path/)
 assert.deepEqual(compact.tree.props.background,{light:'#F7F9FA',dark:'#1C1C1E'});assert.deepEqual(all(compact.tree).find(n=>n.type==='VStack').props.background,{light:'#F7F9FA',dark:'#1C1C1E'})
 // Canvas follows appearance: off-white by day, black by night; no fixed-contrast claim.
 assert.match(local.html,/scale <= 1\.01 && \(edgeBack \|\| pullDown\)/);assert.match(local.html,/startX <= 24 && dx >= 80/);assert.match(local.html,/multiTouch/)

 assert.match(local.html,/initial-scale=1, minimum-scale=1, maximum-scale=6, user-scalable=yes/);assert.match(local.html,/图片加载失败/)
 // Execute real local HTML readiness: image load alone waits for decode; frame
 // callback is requested only after ready class applied; errors also reveal text.
 const vmReady=require('node:vm'),script=local.html.match(/<script>([\s\S]*?)<\/script>/)[1]
 async function readiness({cached=false,error=false}={}){
  const decodeGate=deferred(),events={},frames=[],classes=[],messages=[]
  const photo={complete:cached,naturalWidth:cached?1:0,decode:()=>decodeGate.promise,classList:{add:v=>classes.push(v)},addEventListener:(name,fn)=>events[name]=fn}
  const stage={},spinner={classList:{add(){}}}
  const context={Promise,requestAnimationFrame:fn=>frames.push(fn),document:{getElementById:id=>({photo,stage,spinner}[id]),addEventListener(){}},window:{webkit:{messageHandlers:{imageReady:{postMessage:()=>messages.push('ready')},closeViewer:{postMessage(){}}}}}}
  vmReady.runInNewContext(script,context)
  if(error){events.error();assert.match(stage.innerHTML,/图片加载失败/)}else{if(!cached)events.load();assert.equal(frames.length,0,'no reveal before decode');assert.equal(classes.length,0);decodeGate.resolve();await tick();assert.deepEqual(classes,['ready'])}
  assert.equal(messages.length,0);assert.equal(frames.length,1);frames[0]();assert.deepEqual(messages,['ready']);events.error();assert.equal(frames.length,1,'readiness posts once')
 }
 await readiness();await readiness({cached:true});await readiness({error:true})
 assert.doesNotMatch(local.html,/transition: opacity/,'local image no longer fades after reveal');
 // Execute the delivered touch handlers: edge right-back only, not ordinary panning/zoom/diagonal/multitouch.
 const vm=require('node:vm')
 function gesture({x=10,y=100,dx=100,dy=0,scale=1,multi=false,cancel=false,fast=false}={}){
  const listeners={},classes={add(){}},photo={complete:true,naturalWidth:1,classList:classes,addEventListener(){}},stage={},spinner={classList:classes};let count=0
  const context={document:{getElementById:id=>({photo,stage,spinner}[id]),addEventListener:(name,fn)=>listeners[name]=fn},requestAnimationFrame:fn=>fn(),window:{visualViewport:{scale},webkit:{messageHandlers:{imageReady:{postMessage(){}},closeViewer:{postMessage:()=>count++}}}}}
  vm.runInNewContext(local.html.match(/<script>([\s\S]*?)<\/script>/)[1],context)
  const touch={clientX:x,clientY:y};listeners.touchstart({touches:multi?[touch,touch]:[touch]})
  if(cancel)listeners.touchcancel({})
  const end={clientX:x+dx,clientY:y+dy};if(!fast){listeners.touchmove({touches:[end]});listeners.touchmove({touches:[end]})}listeners.touchend({touches:[],changedTouches:[end]});return count
 }
 assert.equal(gesture(),1);assert.equal(gesture({x:100}),0);assert.equal(gesture({scale:2}),0)
 assert.equal(gesture({dy:100}),0);assert.equal(gesture({multi:true}),0);assert.equal(gesture({cancel:true}),0)
 assert.equal(gesture({dx:0,dy:130}),1)
 assert.equal(gesture({fast:true}),1);assert.equal(gesture({fast:true,scale:2}),0)
 assert.equal(gesture({fast:true,multi:true}),0);assert.equal(gesture({fast:true,cancel:true}),0)
 assert.equal(gesture({fast:true,x:100}),0)
 local.close();local.close();assert.equal(closed,1);compact.unmount();assert.equal(local.disposed,true);local.imageReady();assert.equal(compact.lateWrites,0,'late decode ready after disposal ignored')
 const repeatProps={url:'data:image/png;base64,AA==',compactImage:true,sessionId:1,onClose:()=>closed++}
 let repeat=mount(ImageViewer,repeatProps);await tick();let prior=controllers.at(-1);prior.close();const beforeRepeat=closed
 for(let id=2;id<=4;id++){
  // Parent changes key with sessionId: React unmounts the prior viewer.
  repeat.unmount();repeatProps.sessionId=id;repeat=mount(ImageViewer,repeatProps);await tick();const fresh=controllers.at(-1)
  assert.notEqual(fresh,prior);assert.equal(prior.disposed,true)
  prior.close();assert.equal(closed,beforeRepeat+id-2,'stale close ignored')
  fresh.close();fresh.close();assert.equal(closed,beforeRepeat+id-1,'fresh close unlocked, once per session')
  prior=fresh
 }
 repeat.unmount()
 const normal=mount(ImageViewer,{url:'https://example.invalid/image.png',onClose(){}});await tick();const original=controllers.at(-1)
 assert.match(original.html,/background: #000/);assert.doesNotMatch(original.html,/touchmove|prefers-color-scheme|#242424/);assert.equal(normal.tree.props.background,'black');assert.equal(all(normal.tree).find(n=>n.type==='WebView').props.opacity,1,'shared mode rendering unchanged');assert.match(original.html,/max-width: 100%/);assert.match(original.html,/max-height: 100%/);assert.doesNotMatch(original.html,/viewport-fit=cover|safe-area-inset|object-fit/)
 assert.doesNotMatch(original.html,/conic-gradient|background-size: 16px|#707070|img \{ background: transparent/);assert.doesNotMatch(original.html,/Fast swipes|startX <= 24/);normal.unmount()
 for(const name of ['DiffPage','CommitDiffPage','GitHubItemDetailPage'])assert.doesNotMatch(fs.readFileSync(root+'/pages/'+name+'.tsx','utf8'),/compactImage/)
 console.log('PASS compact local image HTML caps 80%/60% inside safe-area stage, intrinsic small-image sizing, full-screen container, unchanged close/zoom/error script and shared default mode.')
 console.log('PASS real RepoDetailPage pushes text via native destination/save-first pop, keeps images in their original fullScreenCover with close cleanup, refresh/stale/unmount guards and unrelated routes unchanged; no added Navigation.present/Script.exit path. Native lifecycle requires device validation.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
