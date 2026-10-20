/* Execute production gestures/callbacks and delivered image JS, not native iOS recognition. */
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
const {load,mount,mountModal,all,ui,tick,deferred}=require('./remoteFiles.test.cjs')
const edge=load('hooks/useEdgeBack.ts',{scripting:ui})
const nav=load('components/FullScreenNavigation.tsx',{scripting:ui,'../constants/colors':load('constants/colors.ts')})
const drag=(x=0,width=100,height=0)=>({startLocation:{x},translation:{width,height}})
const gesture=h=>all(h.tree).find(n=>n.props.simultaneousGesture)?.props.simultaneousGesture
async function swipe(g,d=drag()){g.changed();await g.onEnded(d)}
let groups=0
async function test(name,fn){await fn();groups++;console.log('PASS '+name)}
async function main(){
 await test('edge/start/direction/distance thresholds; once per drag, pending dedup, retry, disabled and unmounted callbacks',async()=>{
  for(const d of [drag(-1),drag(25),drag(0,79),drag(0,-100),drag(0,100,100),drag(0,90,60),drag(NaN),drag(0,Infinity)])assert.equal(edge.isEdgeBack(d),false)
  for(const d of [drag(),drag(24,80),drag(0,100,-20)])assert.equal(edge.isEdgeBack(d),true)
  let calls=0,gate=null;const props={enabled:true}
  const h=mount(()=>__jsx('Harness',{simultaneousGesture:edge.useEdgeBack(async()=>{calls++;if(gate)await gate.promise},props.enabled)}),{})
  let g=gesture(h);assert.deepEqual(g.options,{minDistance:20,coordinateSpace:'local'})
  for(const d of [drag(100),drag(0,79),drag(0,80,80)])await swipe(g,d)
  assert.equal(calls,0);await swipe(g);await g.onEnded(drag());assert.equal(calls,1)
  gate=deferred();g.changed();const pending=g.onEnded(drag());g.changed();await g.onEnded(drag());assert.equal(calls,2);gate.resolve();await pending;gate=null
  props.enabled=false;h.render();await swipe(g);assert.equal(calls,2,'stale callback reads current disabled state')
  props.enabled=true;h.render();g=gesture(h);await swipe(g);assert.equal(calls,3)
  h.unmount();await swipe(g);assert.equal(calls,3)
 })
 await test('actual fullScreenLink -> modal edge return, guard update/retry, refresh once; own-close clone has no bypass gesture',async()=>{
  let closes=0,refreshes=0
  const cover=nav.fullScreenPage({isPresented:true,onChanged:()=>{closes++;refreshes++},content:__jsx('DiffPage',{})},false,true)
  const body=mountModal(cover);const scope=body.tree.children[0].props.value
  edge.ModalBackContext.testValue=scope
  const props={busy:true};const guard=mount(()=>{edge.useModalBackGuard(props.busy);return __jsx('Guard',{})},{})
  const g=gesture(body);await swipe(g);assert.equal(closes,0)
  props.busy=false;guard.render();await swipe(g);await g.onEnded(drag());body.tree.props.toolbar.topBarLeading.props.action();cover.onChanged(false);assert.equal(closes,1);assert.equal(refreshes,1)
  // Some hosts retain cover content while hidden: a new presentation must reset its close gate.
  const bodyProps=cover.content.children[0].props
  bodyProps.presentation=nav.fullScreenPage({isPresented:false,onChanged(){},content:__jsx('DiffPage',{})}).content.children[0].props.presentation;body.render()
  bodyProps.presentation=nav.fullScreenPage({isPresented:true,onChanged:()=>{closes++;refreshes++},content:__jsx('DiffPage',{})}).content.children[0].props.presentation;body.render()
  await swipe(gesture(body));assert.equal(closes,2);assert.equal(refreshes,2)
  guard.unmount();assert.equal(scope.guards.size,0);edge.ModalBackContext.testValue=undefined;body.unmount()
  const link=mount(nav.FullScreenLink,{destination:__jsx('CommitDiffPage',{}),children:__jsx('Text',{},'row')})
  all(link.tree).find(n=>n.type==='Button'&&n.props.buttonStyle==='plain').props.action();link.render();assert.equal(link.tree.props.fullScreenCover.isPresented,true)
  const child=mountModal(link.tree.props.fullScreenCover);await swipe(gesture(child));link.render();assert.equal(link.tree.props.fullScreenCover.isPresented,false);child.unmount();link.unmount()
  const clone=mountModal(nav.fullScreenPage({isPresented:true,onChanged(){throw Error('bypass')},content:__jsx('ClonePage',{})},true));assert.equal(gesture(clone),undefined);clone.unmount()
 })
 await test('forms use original cancel callback; busy blocks swipe independently of invalid/empty fields',async()=>{
  const {FormSheet}=load('components/FormSheet.tsx',{scripting:ui,'../constants/colors':{}})
  let cancelled=0;const p={navigationTitle:'form',confirmTitle:'确认',confirmDisabled:true,backDisabled:true,onCancel:()=>cancelled++,onConfirm(){},children:[]}
  const h=mount(FormSheet,p);const stale=gesture(h);await swipe(stale);assert.equal(cancelled,0)
  p.backDisabled=false;h.render();await swipe(stale);await stale.onEnded(drag());assert.equal(cancelled,1,'empty title must not prevent cancellation')
  h.unmount()
  for(const file of ['CommitMessageSheet','CreateIssueSheet','AddRemoteSheet','NameInputSheet']){
   const C=load('components/'+file+'.tsx',{scripting:ui,'./FormSheet':{FormSheet:'FormSheet'},'./FormRow':{FormRow:'FormRow'},'../constants/colors':{}})[file]
   const form=mount(C,{busy:true,initialTitle:'',initialDescription:'',initialName:'',onCancel(){},onConfirm(){}})
   assert.equal(form.tree.props.backDisabled,true,file);form.unmount()
  }
 })
 await test('local editor edge return reads latest draft, write failure stays; retry saves once, closes once and refreshes after exit',async()=>{
  let controller,writes=0,closes=0,refreshes=0,fail=true,gate=null
  const {LocalFileEditor}=load('pages/LocalFileEditor.tsx',{scripting:ui,'../constants/colors':{},'../services/gitService':{
   saveLocalWorktreeFile:async(_,base,text)=>{writes++;if(gate)await gate.promise;if(fail)throw Error('write denied');return {...base,text}},readLocalWorktreeFile:async()=>{throw Error('unused')},
  },'../services/diffService':{getFileVersions:async()=>({original:'old'})},'../components/DiffViewer':{DiffViewer:'Diff'},'../components/FileChangeSwitcher':{FileChangeSwitcher:'Tabs'},'../components/LocalCodeEditor':{LocalCodeEditor:'Editor'},
  '../services/localCodeEditor':{createLocalCodeEditorController:options=>(controller={...options,async getContent(){this.content='latest IME draft';return this.content},dispose(){}})},'../utils/editorDiff':{editorDiff:()=>({lines:[]})}})
  const h=mount(LocalFileEditor,{initialHasChanges:true,bookmarkName:'r',file:{path:'a',text:'old'},onClose:()=>closes++,onReload(){},onChanged:()=>refreshes++})
  assert.equal(gesture(h),undefined,'code WebView keeps its own IME/selection-aware edge path, no duplicate native recognizer')
  all(h.tree).find(n=>n.type==='Tabs').props.selection.value=1;h.render()
  const g=gesture(h);await swipe(g,drag(100));assert.equal(writes,0)
  await swipe(g);assert.equal(writes,1);assert.equal(closes,0);assert.equal(controller.content,'latest IME draft');assert.match(JSON.stringify(h.render()),/write denied/)
  fail=false;gate=deferred();g.changed();const pending=g.onEnded(drag());await tick();h.render();await swipe(gesture(h));assert.equal(writes,2);assert.equal(closes,0)
  gate.resolve();await pending;assert.equal(closes,1);assert.equal(refreshes,0)
  // Native/WebKit edge paths cannot save/close twice even before the unmount arrives.
  all(h.tree).find(n=>n.type==='Tabs').props.selection.value=0;h.render()
  await all(h.tree).find(n=>n.type==='Editor').props.onBack();assert.equal(closes,1);assert.equal(writes,2)
  h.unmount();await new Promise(r=>setTimeout(r,370));assert.equal(refreshes,1);assert.equal(h.lateWrites,0)
 })
 await test('existing CodeMirror WebKit edge path keeps IME/selection, direction and multitouch protections without a competing native drag',async()=>{
  const {localCodeEditorBundle}=load('vendor/local-code-editor-bundle.ts')
  const start=localCodeEditorBundle.lastIndexOf('var it=null,$a='),end=localCodeEditorBundle.lastIndexOf('})();')
  assert.ok(start>0&&end>start);const source=localCodeEditorBundle.slice(start,end)
  function run({x=0,dx=100,dy=0,composing=false,selection=false,multi=false,cancel=false}={}){
   const listeners={},messages=[],ce={compositionStarted:composing,state:{selection:{main:{empty:!selection}}}}
   vm.runInNewContext(source,{ce,window:{getSelection:()=>({isCollapsed:!selection})},document:{addEventListener:(name,fn,options)=>{assert.equal(options.passive,true);listeners[name]=fn}},bO:name=>messages.push(name)})
   const touch={clientX:x,clientY:100,identifier:1},last={clientX:x+dx,clientY:100+dy,identifier:1}
   listeners.touchstart({touches:multi?[touch,touch]:[touch]});listeners.touchmove({touches:multi?[last,last]:[last]});if(cancel)listeners.touchcancel({})
   const event={touches:[],changedTouches:[last]};listeners.touchend(event);listeners.touchend(event);return messages
  }
  assert.deepEqual(run(),['localCodeEditorBack']);assert.deepEqual(run({x:24,dx:80}),['localCodeEditorBack'])
  for(const options of [{x:25},{dx:79},{dx:-100},{dy:100},{composing:true},{selection:true},{multi:true},{cancel:true}])assert.deepEqual(run(options),[],JSON.stringify(options))
 })
 await test('remote swipe shares close/discard confirmation: cancel keeps draft, confirm closes, busy blocks; only save button submits',async()=>{
  const {GitHubFileSession}=load('services/githubFileSession.ts');let controller,closes=0,writes=0,confirms=0,discard=false,gate=null,confirmGate=null
  global.EditorController=class{constructor(o){Object.assign(this,o);controller=this}dispose(){}}
  global.Dialog={confirm:async()=>{confirms++;return confirmGate?confirmGate.promise:discard}}
  const {GitHubFileEditor}=load('pages/GitHubFileEditor.tsx',{scripting:ui,'../services/githubFileSession':{GitHubFileSession},'../api/githubApi':{saveRepoTextFile:async()=>{writes++;if(gate)await gate.promise;return 'new-sha'}}})
  function open(){return mount(GitHubFileEditor,{fullName:'o/r',branch:'main',file:{path:'a.ts',sha:'sha',text:'old'},onClose:()=>closes++})}
  let h=open();controller.content='draft';all(h.render()).find(n=>n.type==='TextField').props.onChanged('filled commit message');h.render();let g=gesture(h)
  await swipe(g);assert.equal(confirms,1);assert.equal(writes,0);assert.equal(closes,0);assert.equal(controller.content,'draft')
  confirmGate=deferred();g.changed();const asking=g.onEnded(drag());await g.onEnded(drag());await all(h.render()).find(n=>n.type==='Button'&&n.props.title==='关闭').props.action();assert.equal(confirms,2)
  confirmGate.resolve(false);await asking;confirmGate=null;assert.equal(closes,0);assert.equal(writes,0)
  discard=true;await swipe(g);await g.onEnded(drag());assert.equal(writes,0);assert.equal(closes,1);h.unmount()
  h=open();await swipe(gesture(h));assert.equal(closes,2);assert.equal(confirms,3,'clean editor needs no discard confirmation');assert.equal(writes,0);h.unmount()
  h=open();controller.content='draft';all(h.render()).find(n=>n.type==='TextField').props.onChanged('explicit commit');h.render();g=gesture(h);gate=deferred()
  const saving=all(h.tree).find(n=>n.type==='Button'&&n.props.title==='提交保存').props.action();assert.equal(writes,1);await swipe(g);assert.equal(closes,2);assert.equal(confirms,3,'saving blocks even stale swipe callbacks')
  gate.reject(Error('409 conflict'));await saving;gate=null;h.render();assert.match(JSON.stringify(h.tree),/409 conflict/);assert.equal(controller.content,'draft')
  discard=false;await swipe(g);assert.equal(closes,2);assert.equal(writes,1,'exit must never retry failed save');assert.equal(controller.content,'draft')
  discard=true;await swipe(g);assert.equal(closes,3);assert.equal(writes,1);h.unmount();assert.equal(h.lateWrites,0)
 })
 await test('all image modes execute edge-only passive WebKit handlers, preserve zoom/pan/multitouch and one close per drag',async()=>{
  const controllers=[];global.WebViewController=class{constructor(){controllers.push(this)}async addScriptMessageHandler(n,f){this[n]=f}async loadHTML(html){this.html=html}dispose(){}}
  const {ImageViewer}=load('components/ImageViewer.tsx',{scripting:ui})
  function run(html,{x=0,dx=100,dy=0,scale=1,multi=false,cancel=false,fast=false,viewport=true,unzoom=false}={}){
   const listeners={},photo={complete:false,naturalWidth:0,classList:{add(){}},addEventListener(){}},stage={},spinner={classList:{add(){}}};let closes=0
   const window={visualViewport:viewport?{scale}:undefined,webkit:{messageHandlers:{closeViewer:{postMessage:()=>closes++},imageReady:{postMessage(){}}}}}
   const context={window,document:{getElementById:id=>({photo,stage,spinner}[id]),addEventListener:(name,fn,options)=>{assert.equal(options.passive,true);listeners[name]=fn}},requestAnimationFrame:f=>f(),Promise}
   vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context)
   const start={clientX:x,clientY:100},end={clientX:x+dx,clientY:100+dy}
   listeners.touchstart({touches:multi?[start,start]:[start]});if(cancel)listeners.touchcancel({});if(unzoom)window.visualViewport.scale=1
   if(!fast){listeners.touchmove({touches:[end]});listeners.touchmove({touches:[end]})}
   listeners.touchend({touches:[],changedTouches:[end]});return closes
  }
  for(const compactImage of [false,true]){
   const h=mount(ImageViewer,{url:'data:image/png;base64,AA==',compactImage,onClose(){}});await tick();const html=controllers.at(-1).html
   controllers.at(-1).imageReady?.();h.render()
   assert.equal(gesture(h),undefined,'no outer native recognizer can steal image pan')
   assert.equal(run(html),1);assert.equal(run(html,{x:24,dx:80}),1);assert.equal(run(html,{fast:true}),1)
   for(const options of [{x:25},{x:-1},{dx:79},{dx:-100},{dy:100},{scale:2},{scale:2,unzoom:true},{multi:true},{cancel:true},{viewport:false}])assert.equal(run(html,options),0,JSON.stringify(options))
   assert.equal(run(html,{dx:0,dy:130}),compactImage?1:0,'only local image retains its existing down gesture')
   h.unmount()
  }
  let closed=0
  const loading=mount(ImageViewer,{url:'data:image/png;base64,AA==',compactImage:true,onClose:()=>closed++})
  await tick();loading.render();const loadingController=controllers.at(-1)
  assert.equal(all(loading.tree).find(n=>n.props.simultaneousGesture).type,'Rectangle')
  await swipe(gesture(loading));loadingController.closeViewer();assert.equal(closed,1,'loading mask and late WebKit callback share one close gate')
  loading.unmount()
 })
 await test('home/tab gestures unchanged; every cover family keeps its owning back path',async()=>{
  const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8')
  for(const p of ['index.tsx','pages/RepoListPage.tsx','pages/SettingsPage.tsx','components/FileChangeSwitcher.tsx'])assert.doesNotMatch(read(p),/simultaneousGesture|useEdgeBack/)
  for(const p of ['DiffPage','CommitDiffPage','CommitDetailPage','GitHubItemDetailPage'])assert.match(read('pages/'+p+'.tsx'),/ImageViewer/)
  assert.match(read('components/FullScreenNavigation.tsx'),/useEdgeBack\(back, !ownClose\)/)
  assert.doesNotMatch(read('hooks/useEdgeBack.ts'),/highPriorityGesture|defersSystemGestures/)
 })
 console.log(groups+' edge-back groups passed; native gesture competition, toolbar layout and modal vertical animation require device validation.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
