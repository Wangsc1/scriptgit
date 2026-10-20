/* Production modal expressions + hook/virtual-node tests. No native animation emulation. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript')
const {load,mount,all,ui,deferred,tick}=require('./remoteFiles.test.cjs')
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8')
const navigation=load('components/FullScreenNavigation.tsx',{scripting:ui,'../constants/colors':load('constants/colors.ts')})
const files=[];(function walk(d){for(const n of fs.readdirSync(path.join(root,d))){const r=d+'/'+n;if(fs.statSync(path.join(root,r)).isDirectory())walk(r);else if(r.endsWith('.tsx'))files.push(r)}})('pages');files.push(...fs.readdirSync(path.join(root,'components')).filter(n=>n.endsWith('.tsx')).map(n=>'components/'+n),'index.tsx')
for(const f of files){
 const ast=ts.createSourceFile(f,read(f),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 function visit(n){
  if(ts.isJsxAttribute(n))assert.ok(!['navigationDestination','sheet'].includes(n.name.getText(ast)),f+': business destination must be a full-screen modal')
  if(ts.isJsxOpeningElement(n)||ts.isJsxSelfClosingElement(n))assert.notEqual(n.tagName.getText(ast),'NavigationLink',f)
  ts.forEachChild(n,visit)
 }visit(ast)
 assert.doesNotMatch(read(f),/highPriorityGesture|interactiveDismissDisabled/,f)
}
// Actual row tap -> cover -> isolated NavigationStack -> back/native dismissal -> reopen.
const destination=global.__jsx('BusinessPage',{navigationTitle:'Title',toolbar:{topBarTrailing:'existing action'}})
const h=mount(navigation.FullScreenLink,{destination,children:global.__jsx('Text',{},'Row')})
for(let i=0;i<2;i++){
 assert.equal(h.tree.props.fullScreenCover.isPresented,false)
 all(h.tree).find(n=>n.type==='Button'&&n.props.buttonStyle==='plain').props.action();h.render()
 const cover=h.tree.props.fullScreenCover;assert.equal(cover.isPresented,true);assert.equal(cover.content.type,'NavigationStack')
 assert.equal(cover.content.children[0].children[0],destination,'destination title/toolbar node is retained')
 if(i===0)cover.content.children[0].props.toolbar.topBarLeading.props.action();else cover.onChanged(false)
 h.render();assert.equal(h.tree.props.fullScreenCover.isPresented,false)
}
const lateDismiss=h.tree.props.fullScreenCover.onChanged;h.unmount();lateDismiss(false);assert.equal(h.lateWrites,0)

// Full-screen business forms retain their own title and cancel/confirm toolbar.
const {FormSheet}=load('components/FormSheet.tsx',{scripting:ui,'../constants/colors':load('constants/colors.ts')})
let cancelled=0,confirmed=0
const formProps={navigationTitle:'Business form',confirmTitle:'确认',confirmDisabled:true,error:'retryable error',onCancel:()=>cancelled++,onConfirm:()=>confirmed++,children:global.__jsx('Text',{},'draft')}
const form=mount(FormSheet,formProps)
assert.equal(form.tree.type,'NavigationStack');const list=form.tree.children[0]
assert.equal(list.props.navigationTitle,'Business form');assert.equal(list.props.presentationDetents,undefined)
assert.equal(list.props.toolbar.confirmationAction.props.disabled,true)
list.props.toolbar.cancellationAction.props.action();assert.equal(cancelled,1)
formProps.confirmDisabled=false;form.render();assert.equal(form.tree.children[0].props.toolbar.confirmationAction.props.disabled,false)
form.tree.children[0].props.toolbar.confirmationAction.props.action();assert.equal(confirmed,1);form.unmount()

// Evaluate the actual page cover expression, not a duplicated fixture route.
function presentations(file,scope){
 const source=read(file),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let expression
 function visit(n){if(ts.isJsxAttribute(n)&&n.name.getText(ast)==='fullScreenCover')expression=n.initializer.expression.getText(ast);ts.forEachChild(n,visit)}visit(ast);assert.ok(expression,file)
 const compiled=ts.transpileModule('module.exports = ('+expression+')',{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'__jsx'}}).outputText
 const mod={exports:{}};new Function('module',...Object.keys(scope),'fullScreenPage',compiled)(mod,...Object.values(scope),navigation.fullScreenPage)
 return [].concat(mod.exports)
}
for(const [file,state,setter,Component] of [
 ['pages/ActionsPage.tsx','selectedRunId','setSelectedRunId','ActionRunDetailPage'],
 ['pages/ActionRunDetailPage.tsx','viewerJob','setViewerJob','ActionLogViewer'],
 ['pages/GitHubWorkPage.tsx','selectedNumber','setSelectedNumber','GitHubItemDetailPage'],
]){
 let value=state==='viewerJob'?{name:'Job',log:'text',steps:[],initialStepNumber:1}:42,createClosed=0
 const render=()=>presentations(file,{[state]:value,[setter]:next=>value=next,[Component]:Component,fullName:'o/r',Text:'Text',showCreate:false,setShowCreate:()=>createClosed++,setCreateError(){},CreateIssueSheet:'CreateIssueSheet',creating:false,createError:null,handleCreate(){}})
 let cover=render()[0];assert.equal(cover.isPresented,true);assert.equal(cover.content.type,'NavigationStack')
 const page=cover.content.children[0].children[0];assert.equal(page.type,Component)
 cover.content.children[0].props.toolbar.topBarLeading.props.action();assert.equal(value,null);assert.equal(render()[0].isPresented,false)
 value=state==='viewerJob'?{name:'Job',log:'text',steps:[]}:43;cover=render()[0];cover.onChanged(false);assert.equal(render()[0].isPresented,false)
 assert.equal(createClosed,0,'closing child leaves unrelated form untouched')
 console.log('PASS '+file+': actual cover content, toolbar return and native callback clear route state')
}
// Clone close must not bypass the write/cancel gate.
const clone=read('pages/ClonePage.tsx');assert.match(clone,/title="返回" action=\{\(\) => \{ if \(!locked.current\) onClose\?\.\(\) \}\} disabled=\{cloning\}/)
// Save-first editor close remains owned by the editor, never the generic business cover.
const editor=read('pages/LocalFileEditor.tsx');assert.match(editor,/topBarLeading: <Button title="返回" action=\{back\}/);assert.equal((editor.match(/onClose\(\)/g)||[]).length,1);assert.match(editor,/async function back\(\)[\s\S]*saveLocalWorktreeFile[\s\S]*onClose\(\)/)
assert.match(read('index.tsx'),/Navigation.present\(\{ element: <View \/>, modalPresentationStyle: "fullScreen" \}\)/)
// Root presentation uses the real entry code and still exits only after root dismissal.
async function rootPresentation(){
 const gate=deferred();let options,exits=0
 load('index.tsx',{scripting:{...ui,Navigation:{present:input=>{options=input;return gate.promise}},Script:{exit:()=>exits++}},'./pages/RepoListPage':{RepoListPage:'RepoListPage'},'./pages/SettingsPage':{SettingsPage:'SettingsPage'}})
 assert.equal(options.modalPresentationStyle,'fullScreen');assert.equal(exits,0)
 gate.resolve();await tick();assert.equal(exits,1)
 console.log('PASS actual root Navigation.present fullScreen options; Script.exit waits for dismissal')
 const {env}=require('./cloneQueue.test.cjs'),{page}=require('./clonedSelection.test.cjs')
 const cloning=deferred(),e=env({clone:async()=>cloning.promise});let closed=0
 const cloneHost=mount(page(e,[]),{onCloned(){},onClose:()=>closed++});await tick()
 all(cloneHost.tree).find(n=>n.type==='FormRow'&&n.props.label==='Git URL').props.onChanged('https://github.com/bob/repo.git');cloneHost.render()
 const oldBack=cloneHost.tree.props.toolbar.topBarLeading.props.action
 const pending=all(cloneHost.tree).find(n=>n.type==='Button'&&n.props.title==='克隆').props.action();await tick();cloneHost.render()
 assert.equal(cloneHost.tree.props.toolbar.topBarLeading.props.disabled,true);oldBack();assert.equal(closed,0,'stale pre-clone close also respects write gate')
 cloning.resolve();await pending;cloneHost.render();assert.equal(cloneHost.tree.props.toolbar.topBarLeading.props.disabled,false)
 cloneHost.tree.props.toolbar.topBarLeading.props.action();assert.equal(closed,1);cloneHost.unmount();assert.equal(cloneHost.lateWrites,0)
 console.log('PASS real clone page: return blocked during clone, including stale callback; enabled after completion')
}
rootPresentation().catch(e=>{console.error(e);process.exitCode=1})
console.log('PASS full-screen row open/close/reopen, modal route callbacks and independent navigation containers; native vertical transition, gestures and toolbar rendering require device validation.')
