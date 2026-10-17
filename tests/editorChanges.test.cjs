const assert=require('node:assert/strict')
const {load,mount,ui,all,tick,deferred}=require('./remoteFiles.test.cjs')
const inline=load('utils/inlineDiff.ts')
const service=load('services/diffService.ts',{'./gitCore':{},'./repoStore':{},'../utils/inlineDiff':inline,'../utils/imageDiff':{}})
const {editorDiff}=load('utils/editorDiff.ts',{'../services/diffService':service})
let controllers=[],writes=[],closed=0,fail=false,versionCalls=0,diffCalls=0,wait=null
const versions={filepath:'test.json',original:'{\n"value": 1\n}\n',current:'{\n"value": 2\n}\n',added:false,deleted:false,binary:false}
global.EditorController=class {constructor(opts){Object.assign(this,opts);controllers.push(this)}dispose(){this.disposed=true}}
const {LocalFileEditor}=load('pages/LocalFileEditor.tsx',{
 scripting:ui,'../constants/colors':{},'../services/gitService':{
  saveLocalWorktreeFile:async(_,base,content)=>{writes.push(content);return {...base,text:content}},
  readLocalWorktreeFile:async()=>{throw Error('unused')},
 },
 '../services/diffService':{getFileVersions:async()=>{versionCalls++;if(wait)await wait.promise;if(fail)throw Error('read failed');return {...versions}}},
 '../components/DiffViewer':{DiffViewer:'DiffViewer'},'../components/FileChangeSwitcher':{FileChangeSwitcher:'FileChangeSwitcher'},'../utils/editorDiff':{editorDiff:(...args)=>{diffCalls++;return editorDiff(...args)}},
})
function open(text=versions.current,initialHasChanges=true){return mount(LocalFileEditor,{initialHasChanges,bookmarkName:'repo',file:{path:'test.json',text},onClose:()=>closed++,onChanged:()=>{},onReload(){}})}
function find(h,type){h.render();return all(h.tree).find(n=>n.type===type)}
async function main(){
 const pause=()=>new Promise(r=>setTimeout(r,10))
 const h=open(),c=controllers.at(-1);assert.equal(find(h,'Editor').props.controller,c);assert.equal(find(h,'Editor').props.showAccessoryView,false)
 assert.equal(h.tree.children[0].props.fullScreenCover,undefined)
 await pause();let bar=find(h,'FileChangeSwitcher');assert.equal(bar.props.selection.value,0)
 assert.equal(versionCalls,0);assert.equal(diffCalls,0);assert.equal(h.tree.children[0].props.safeAreaInset,undefined)
 assert.equal(h.tree.children[0].props.frame.maxHeight,Infinity)
 bar.props.selection.value=1;await pause();const diff=find(h,'DiffViewer');assert.equal(diff.props.compact,true);assert.ok(diff.props.diff.lines.some(l=>l.type==='del'));assert.ok(diff.props.diff.lines.some(l=>l.type==='add'&&l.segments.some(s=>s.type==='changed')))
 assert.equal(writes.length,0);assert.equal(c.disposed,undefined)
 bar.props.selection.value=0;assert.equal(find(h,'Editor').props.controller,c);assert.equal(controllers.length,1)
 c.content='{\n"value": 333\n}\n';c.onContentChanged();const before=diffCalls;await pause();assert.equal(diffCalls,before)
 bar.props.selection.value=1;await pause();assert.ok(find(h,'DiffViewer').props.diff.lines.some(l=>l.content.includes('333')))
 assert.equal(writes.length,0);assert.equal(versionCalls,1)
 await h.tree.children[0].props.toolbar.topBarLeading.props.action();assert.deepEqual(writes,[c.content]);assert.equal(closed,1)
 h.unmount();assert.equal(c.disposed,true);assert.equal(c.onContentChanged,undefined)
 const clean=open(versions.original,false);await pause();assert.equal(find(clean,'FileChangeSwitcher'),undefined);assert.equal(find(clean,'Editor').props.showAccessoryView,false);const cc=controllers.at(-1)
 const beforeCleanReads=versionCalls,beforeCleanDiff=diffCalls
 cc.content=versions.current;cc.onContentChanged();assert.ok(find(clean,'FileChangeSwitcher'));assert.equal(versionCalls,beforeCleanReads);assert.equal(diffCalls,beforeCleanDiff);clean.unmount()
 fail=true;const error=open();find(error,'FileChangeSwitcher').props.selection.value=1;await pause()
 const retry=all(error.render()).find(n=>n.props.title==='重试读取改动');assert.ok(retry);fail=false;await retry.props.action();assert.ok(find(error,'DiffViewer'));error.unmount()
 wait=deferred();const slow=open();let tabs=find(slow,'FileChangeSwitcher');tabs.props.selection.value=1;await pause();tabs.props.selection.value=0
 assert.equal(find(slow,'Editor').props.controller,controllers.at(-1));const beforeResolve=diffCalls
 slow.unmount();wait.resolve();await tick();assert.equal(slow.lateWrites,0);assert.equal(diffCalls,beforeResolve);wait=null
 const added=editorDiff({...versions,original:null,added:true},'new\n');assert.equal(added.lines.filter(l=>l.type==='add').length,1)
 assert.equal(editorDiff({...versions,original:''},'').lines.length,0)
 const deleted=editorDiff(versions,'');assert.equal(deleted.lines.filter(l=>l.type==='del').length,3)
 const content=require('node:fs').readFileSync(require('node:path').resolve(__dirname,'../pages/LocalFileEditor.tsx'),'utf8');assert.doesNotMatch(content,/fullScreenCover|改动后|viewVersion/)
 // Render actual compact/default diff nodes and floating controls, not just page wiring.
 global.Device={systemVersion:'26',screen:{width:390}};global.UIGlass={clear:()=>({interactive:()=> 'glass'})}
 const scripting=new Proxy(ui,{get:(target,key)=>key==='useColorScheme'?()=> 'light':target[key]})
 const {DiffViewer}=load('components/DiffViewer.tsx',{scripting,'../utils/inlineDiff':inline,'./ImageDiffPreview':{}})
 const sample=editorDiff(versions,versions.current)
 const compact=mount(DiffViewer,{diff:sample,compact:true})
 function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
 const nodes=all(expand(compact.tree));assert.ok(nodes.some(n=>n.props.background==='#ffebe9'));assert.ok(nodes.some(n=>n.props.background==='#e6ffec'))
 assert.ok(nodes.some(n=>n.props.background==='#abf2bc'));assert.equal(nodes.some(n=>n.props.frame?.width===28),false)
 const standard=mount(DiffViewer,{diff:sample});assert.ok(all(expand(standard.tree)).some(n=>n.props.frame?.width===28));compact.unmount();standard.unmount()
 const {FileChangeSwitcher}=load('components/FileChangeSwitcher.tsx',{scripting:ui,'../constants/colors':{COLOR_ACCENT:'blue'}})
 const selection={value:0}
 const switcher=mount(FileChangeSwitcher,{selection,content:__jsx('Editor',{}),changes:__jsx('Text',{},'diff'),disabled:false})
 assert.equal(switcher.tree.type,'TabView');assert.equal(switcher.tree.props.selection,selection)
 assert.deepEqual(all(switcher.tree).filter(n=>n.type==='Tab').map(n=>[n.props.title,n.props.value,n.props.systemImage]),[['原内容',0,'doc.text'],['改动项',1,'plusminus']])
 assert.equal(all(switcher.tree).some(n=>n.props.glassEffect||n.props.safeAreaInset||n.props.padding),false)
 switcher.unmount()
 console.log('PASS 首屏零HEAD读取/零差异计算、内容输入不算差异、原生TabView不设边距偏移、默认全屏内容、条件双按钮、红删绿增/行内高亮、即时草稿、切换零写入、同一控制器、自动保存、重试及卸载安全')
}
main().catch(e=>{console.error(e);process.exitCode=1})
