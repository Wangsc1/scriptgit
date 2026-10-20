/* Production horizontal route store/layers and real page callbacks. No iOS renderer. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript')
const {load,mount,all,ui,deferred,tick}=require('./remoteFiles.test.cjs')
const nav=load('components/HorizontalNavigation.tsx',{scripting:ui,'../constants/colors':load('constants/colors.ts')})
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8')
const drag={startLocation:{x:0},translation:{width:100,height:0}}
function layer(routes,route){
 const root=mount(nav.HorizontalNavigationRoot,{children:__jsx('RootTabs',{})})
 const layersNode=root.tree.children[0].children[1]
 const layers=mount(layersNode.type,{routes})
 const node=layers.render().children.find(n=>n.props.route===route)
 const h=mount(node.type,node.props)
 h.surface=()=>h.render().children[0]({size:{width:390,height:844}})
 h.close=()=>{h.unmount();layers.unmount();root.unmount()}
 return h
}
function declarations(file,scope){
 const source=read(file),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let expression
 function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(ast)==='useHorizontalDestinations')expression=n.arguments[0].getText(ast);ts.forEachChild(n,visit)}visit(ast);assert.ok(expression,file)
 const code=ts.transpileModule('module.exports=('+expression+')',{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'__jsx'}}).outputText
 const mod={exports:{}};new Function('module',...Object.keys(scope),'horizontalPage',code)(mod,...Object.values(scope),nav.horizontalPage);return [].concat(mod.exports)
}
async function main(){
 // Parent vnode stays outside the changing layer list; neither tab nor parent is replaced.
 const rootChild=__jsx('TabView',{selection:{value:1}}),root=mount(nav.HorizontalNavigationRoot,{children:rootChild})
 const base=root.tree.children[0].children[0];assert.equal(base.children[0],rootChild)
 const routes=new nav.HorizontalRoutes(),source={};let returned=0
 const parent=mount(()=>{const [selection,set]=ui.useState('history');return __jsx('Parent',{selection,set})},{})
 parent.tree.props.set('files');parent.render()
 const destination=__jsx('RealDestination',{navigationTitle:'Details',toolbar:{topBarTrailing:'menu'}})
 routes.update(source,[nav.horizontalPage({isPresented:true,content:destination,onChanged:()=>returned++})])
 const route=routes.routes[0],h=layer(routes,route);await tick()
 const surface=h.surface();assert.equal(surface.props.offset.x,0);assert.equal(surface.children[0].type,'NavigationStack')
 const shell=surface.children[0].children[0];assert.equal(shell.children[0].children[0].children[0],destination)
 assert.equal(shell.props.toolbar.topBarLeading.children[0].props.systemName,'chevron.left')
 const gate=deferred();route.animate=()=>gate.promise
 const closing=shell.props.toolbar.topBarLeading.props.action();await routes.back(route.id)
 assert.equal(routes.routes[0],route);assert.equal(returned,0);assert.equal(parent.tree.props.selection,'files')
 gate.resolve();await closing;assert.equal(returned,1);assert.equal(routes.routes.length,0);assert.equal(parent.unmounted,false)
 routes.update(source,[{isPresented:true,content:destination,onChanged(){}}]);assert.equal(routes.routes.length,0,'stale presented state cannot reopen completed route')
 routes.update(source,[{isPresented:false,content:null,onChanged(){}}]);routes.update(source,[nav.horizontalPage({isPresented:true,content:destination,onChanged:()=>returned++})])
 assert.notEqual(routes.routes[0].id,route.id);const reopened=layer(routes,routes.routes[0]);await tick()
 const gesture=reopened.surface().children[0].children[0].props.simultaneousGesture
 gesture.changed();await gesture.onEnded(drag);assert.equal(returned,2);assert.equal(routes.routes.length,0)
 reopened.close();h.close();root.unmount();parent.unmount()
 console.log('PASS actual layer button/swipe close, sibling chrome/title content, retained parent state, delayed once-only cleanup, reopen')

 // Exercise the actual row button, stable source and per-return callback twice.
 let rowReturns=0
 const row=mount(nav.HorizontalLink,{destination,children:__jsx('Text',{},'row'),onReturn:()=>rowReturns++})
 for(let n=0;n<2;n++){
  assert.equal(row.routes.routes.length,0)
  all(row.tree).find(v=>v.type==='Button').props.action();row.render();assert.equal(row.routes.routes.length,1)
  const active=row.routes.routes[0],finished=deferred();active.animate=()=>finished.promise
  const pending=row.routes.back(active.id);assert.equal(rowReturns,n);assert.equal(row.routes.routes.length,1)
  finished.resolve();await pending;row.render();assert.equal(rowReturns,n+1);assert.equal(row.routes.routes.length,0)
 }
 row.unmount();assert.equal(row.lateWrites,0)
 console.log('PASS real HorizontalLink row open/return/reopen invokes one post-animation refresh per return')

 // Real horizontal offset animations retain content/controllers until completion.
 const animationGates=[],calls=[]
 const animatedUI=new Proxy(ui,{get:(target,key)=>key==='withAnimation'?(...args)=>{const g=deferred();args.at(-1)();calls.push(args.length);animationGates.push(g);return g.promise}:target[key]})
 const animated=load('components/HorizontalNavigation.tsx',{scripting:animatedUI,'../constants/colors':{}})
 const aroot=mount(animated.HorizontalNavigationRoot,{children:__jsx('Root',{})}),aroutes=aroot.tree.props.value
 aroutes.update({},[animated.horizontalPage({isPresented:true,content:destination,onChanged:()=>returned++})]);const aroute=aroutes.routes[0]
 const layersNode=aroot.tree.children[0].children[1],als=mount(layersNode.type,{routes:aroutes}),av=als.tree.children[0],ah=mount(av.type,av.props)
 const out=aroutes.back(aroute.id);assert.equal(animationGates.length,1);assert.equal(aroutes.routes.length,1)
 animationGates[0].resolve();await tick();assert.equal(animationGates.length,2);assert.equal(calls[1],3,'explicit animation completion criterion')
 assert.equal(ah.render().children[0]({size:{width:430,height:900}}).props.offset.x,430)
 assert.equal(aroutes.routes.length,1,'do not unmount page at animation start')
 animationGates[1].resolve();await out;assert.equal(aroutes.routes.length,0)
 ah.unmount();als.unmount();aroot.unmount()
 console.log('PASS actual geometry-sized rightward exit awaits animation completion, not a timer')

 for(const [file,state,setter,Component] of [
  ['pages/ActionsPage.tsx','selectedRunId','setSelectedRunId','ActionRunDetailPage'],
  ['pages/ActionRunDetailPage.tsx','viewerJob','setViewerJob','ActionLogViewer'],
  ['pages/GitHubWorkPage.tsx','selectedNumber','setSelectedNumber','GitHubItemDetailPage'],
 ]){
  let value=state==='viewerJob'?{name:'Job',log:'text',steps:[]}:42,unrelated=0
  const render=()=>declarations(file,{[state]:value,[setter]:v=>value=v,[Component]:Component,fullName:'o/r',Text:'Text',showCreate:false,setShowCreate:()=>unrelated++,setCreateError(){},CreateIssueSheet:'CreateIssueSheet',creating:false,createError:null,handleCreate(){}})
  const r=new nav.HorizontalRoutes();r.update({},render());assert.equal(r.routes[0].destination.content.type,Component)
  const body=layer(r,r.routes[0]);const g=body.surface().children[0].children[0].props.simultaneousGesture
  g.changed();await g.onEnded(drag);assert.equal(value,null);assert.equal(unrelated,0);body.close()
 }
 console.log('PASS actual Actions/log/Issue destination declarations close through protected horizontal shell')

 // A source-controlled successful close freezes old content through animation;
 // release/root shutdown cancels post-animation callbacks, including late promises.
 const r=new nav.HorizontalRoutes(),src={};let callbacks=0
 r.update(src,[{isPresented:true,content:destination,onChanged:()=>callbacks++}]);const old=r.routes[0],done=deferred();old.animate=()=>done.promise
 r.update(src,[{isPresented:false,content:__jsx('Empty',{}),onChanged:()=>callbacks++}]);assert.equal(r.routes[0].destination.content,destination)
 done.resolve();await tick();assert.equal(callbacks,1);r.update(src,[{isPresented:true,content:destination,onChanged(){}}]);assert.equal(r.routes.length,1,'programmatic false must not latch a later reopen')
 const late=deferred();r.routes[0].animate=()=>late.promise;const pending=r.exit(r.routes[0].id,()=>callbacks++);r.release(src);late.resolve();await pending;assert.equal(callbacks,1)
 r.dispose();assert.equal(r.routes.length,0)
 console.log('PASS programmatic close retains content, reopen works, source/root unmount suppresses stale cleanup')

 // Root native presentation and lifetime are untouched.
 const rootGate=deferred();let options,exits=0
 load('index.tsx',{scripting:{...ui,Navigation:{present:v=>{options=v;return rootGate.promise}},Script:{exit:()=>exits++}},'./pages/RepoListPage':{RepoListPage:'RepoListPage'},'./pages/SettingsPage':{SettingsPage:'SettingsPage'}})
 assert.equal(options.modalPresentationStyle,'fullScreen');assert.equal(exits,0);rootGate.resolve();await tick();assert.equal(exits,1)
 for(const dir of ['pages','components'])for(const name of fs.readdirSync(path.join(__dirname,'..',dir)).filter(n=>n.endsWith('.tsx'))){const s=read(dir+'/'+name);assert.doesNotMatch(s,/fullScreenCover=|sheet=|<NavigationLink|navigationDestination=/,dir+'/'+name)}
 assert.match(read('pages/RepoListPage.tsx'),/<HorizontalLink onReturn=\{appear\}/)
 assert.match(read('pages/ClonePage.tsx'),/<Image systemName="chevron.left"/)
 assert.match(read('pages/RepoDetailPage.tsx'),/systemImage="ellipsis.circle"/)
 assert.equal(fs.existsSync(path.join(__dirname,'../components/FullScreenNavigation.tsx')),false)
 console.log('PASS all business entry families migrated; root fullScreen/exit lifetime, existing arrows and circle-ellipsis menu retained')

 const {env}=require('./cloneQueue.test.cjs'),{page}=require('./clonedSelection.test.cjs')
 const cloning=deferred(),e=env({clone:async()=>cloning.promise});let closed=0
 const cloneHost=mount(page(e,[]),{onCloned(){},onClose:()=>closed++});await tick()
 all(cloneHost.tree).find(n=>n.type==='FormRow'&&n.props.label==='Git URL').props.onChanged('https://github.com/bob/repo.git');cloneHost.render()
 const oldBack=cloneHost.tree.props.toolbar.topBarLeading.props.action
 const running=all(cloneHost.tree).find(n=>n.type==='Button'&&n.props.title==='克隆').props.action();await tick();cloneHost.render()
 oldBack();cloneHost.tree.props.simultaneousGesture.changed();await cloneHost.tree.props.simultaneousGesture.onEnded(drag);assert.equal(closed,0)
 cloning.resolve();await running;cloneHost.render();cloneHost.tree.props.simultaneousGesture.changed();await cloneHost.tree.props.simultaneousGesture.onEnded(drag);assert.equal(closed,1)
 cloneHost.unmount();assert.equal(cloneHost.lateWrites,0)
 console.log('PASS real ClonePage busy write/cancel gate blocks button and swipe, including stale pre-write callback')
}
main().catch(e=>{console.error(e);process.exitCode=1})
