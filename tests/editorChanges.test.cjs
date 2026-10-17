const assert=require('node:assert/strict')
const {load,mount,ui,all,tick,deferred}=require('./remoteFiles.test.cjs')
const inline=load('utils/inlineDiff.ts')
const service=load('services/diffService.ts',{'./gitCore':{},'./repoStore':{},'../utils/inlineDiff':inline,'../utils/imageDiff':{}})
const {editorDiff}=load('utils/editorDiff.ts',{'../services/diffService':service})
let controllers=[],writes=[],closed=0,fail=false,versionCalls=0,diffCalls=0,wait=null
const versions={filepath:'test.json',original:'{\n"value": 1\n}\n',current:'{\n"value": 2\n}\n',added:false,deleted:false,binary:false}
global.EditorController=class {constructor(opts){Object.assign(this,opts);controllers.push(this)}dispose(){this.disposed=true}}
const {LocalFileEditor}=load('pages/LocalFileEditor.tsx',{
 scripting:new Proxy(ui,{get:(target,key)=>key==='useColorScheme'?()=> 'light':target[key]}),'../constants/colors':{},'../services/gitService':{
  saveLocalWorktreeFile:async(_,base,content)=>{writes.push(content);return {...base,text:content}},
  readLocalWorktreeFile:async()=>{throw Error('unused')},
 },
 '../services/diffService':{getFileVersions:async()=>{versionCalls++;if(wait)await wait.promise;if(fail)throw Error('read failed');return {...versions}}},
 '../components/LocalCodeEditor':{LocalCodeEditor:'LocalCodeEditor'},
 '../services/localCodeEditor':{createLocalCodeEditorController:options=>{const c=new global.EditorController(options);c.getContent=async()=>{c.reads=(c.reads||0)+1;if(c.nativeError)throw Error(c.nativeError);c.content=c.latestNative??c.content;return c.content};return c}},
 '../components/DiffViewer':{DiffViewer:'DiffViewer'},'../components/FileChangeSwitcher':{FileChangeSwitcher:'FileChangeSwitcher'},'../utils/editorDiff':{editorDiff:(...args)=>{diffCalls++;return editorDiff(...args)}},
})
function open(text=versions.current,initialHasChanges=true){return mount(LocalFileEditor,{initialHasChanges,bookmarkName:'repo',file:{path:'test.json',text},onClose:()=>closed++,onChanged:()=>{},onReload(){}})}
function find(h,type){h.render();return all(h.tree).find(n=>n.type===type)}
async function main(){
 const pause=()=>new Promise(r=>setTimeout(r,10))
 const h=open(),c=controllers.at(-1);assert.equal(find(h,'LocalCodeEditor').props.controller,c)
 assert.equal(h.tree.children[0].props.fullScreenCover,undefined)
 await pause();let bar=find(h,'FileChangeSwitcher');assert.equal(bar.props.selection.value,0)
 assert.equal(versionCalls,0);assert.equal(diffCalls,0);assert.equal(h.tree.children[0].props.safeAreaInset,undefined)
 assert.equal(h.tree.children[0].props.frame.maxHeight,Infinity)
 assert.equal(h.tree.props.preferredColorScheme,undefined);assert.deepEqual(h.tree.props.background,{light:'white',dark:'#242424'})
 assert.deepEqual(h.tree.children[0].props.background,{light:'white',dark:'#242424'});assert.equal(h.tree.children[0].props.ignoresSafeArea.edges,'bottom')
 assert.deepEqual(h.tree.children[0].props.toolbarBackground,{style:{light:'white',dark:'#242424'},bars:['navigationBar']})
 bar.props.selection.value=1;await pause();const diff=find(h,'DiffViewer');assert.equal(diff.props.compact,true);assert.equal(diff.props.appearance,'light');assert.ok(diff.props.diff.lines.some(l=>l.type==='del'));assert.ok(diff.props.diff.lines.some(l=>l.type==='add'&&l.segments.some(s=>s.type==='changed')))
 assert.equal(writes.length,0);assert.equal(c.disposed,undefined)
 bar.props.selection.value=0;assert.equal(find(h,'LocalCodeEditor').props.controller,c);assert.equal(controllers.length,1)
 c.content='{\n"value": 333\n}\n';c.onContentChanged();const before=diffCalls;await pause();assert.equal(diffCalls,before)
 bar.props.selection.value=1;await pause();assert.ok(find(h,'DiffViewer').props.diff.lines.some(l=>l.content.includes('333')))
 assert.equal(writes.length,0);assert.equal(versionCalls,1)
 await h.tree.children[0].props.toolbar.topBarLeading.props.action();assert.deepEqual(writes,[c.content]);assert.equal(closed,1)
 h.unmount();assert.equal(c.disposed,true);assert.equal(c.onContentChanged,undefined)
 const clean=open(versions.original,false);await pause();assert.equal(find(clean,'FileChangeSwitcher'),undefined);const cc=controllers.at(-1)
 const beforeCleanReads=versionCalls,beforeCleanDiff=diffCalls
 cc.content=versions.current;cc.onContentChanged();assert.ok(find(clean,'FileChangeSwitcher'));assert.equal(versionCalls,beforeCleanReads);assert.equal(diffCalls,beforeCleanDiff);clean.unmount()
 fail=true;const error=open();find(error,'FileChangeSwitcher').props.selection.value=1;await pause()
 const retry=all(error.render()).find(n=>n.props.title==='重试读取改动');assert.ok(retry);fail=false;await retry.props.action();assert.ok(find(error,'DiffViewer'));error.unmount()
 wait=deferred();const slow=open();let tabs=find(slow,'FileChangeSwitcher');tabs.props.selection.value=1;await pause();tabs.props.selection.value=0
 assert.equal(find(slow,'LocalCodeEditor').props.controller,controllers.at(-1));const beforeResolve=diffCalls
 slow.unmount();wait.resolve();await tick();assert.equal(slow.lateWrites,0);assert.equal(diffCalls,beforeResolve);wait=null
 // Opening stays immediate; after the first screen, real line counts arrive without selecting the changes tab.
 const counted=open(),countedController=controllers.at(-1),beforeStatsReads=versionCalls
 assert.equal(find(counted,'FileChangeSwitcher').props.stats,null)
 await new Promise(r=>setTimeout(r,540))
 assert.equal(versionCalls,beforeStatsReads+1);assert.equal(countedController.reads,undefined);assert.deepEqual(find(counted,'FileChangeSwitcher').props.stats,{added:1,deleted:1})
 countedController.content=versions.original;countedController.onContentChanged()
 assert.equal(find(counted,'FileChangeSwitcher').props.stats,null)
 await new Promise(r=>setTimeout(r,540))
 assert.deepEqual(find(counted,'FileChangeSwitcher').props.stats,{added:0,deleted:0});assert.equal(versionCalls,beforeStatsReads+1)
 assert.equal(find(counted,'FileChangeSwitcher').props.selection.value,0);counted.unmount()
 // Right-edge callback uses the same back/save path and synchronously fetches the latest native draft.
 const bridged=open(versions.original,false),bc=controllers.at(-1),closedBefore=closed
 bc.latestNative='last native input without a bridge event'
 await find(bridged,'LocalCodeEditor').props.onBack();assert.equal(writes.at(-1),bc.latestNative);assert.equal(closed,closedBefore+1);bridged.unmount()
 const blocked=open(),blc=controllers.at(-1),closedBeforeError=closed,writesBeforeError=writes.length
 blc.nativeError='native draft read failed'
 await find(blocked,'LocalCodeEditor').props.onBack();assert.equal(closed,closedBeforeError);assert.equal(writes.length,writesBeforeError)
 assert.match(JSON.stringify(blocked.render()),/native draft read failed/);blocked.unmount()
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
 const darkView=mount(DiffViewer,{diff:sample,compact:true,appearance:'dark'})
 const darkNodes=all(expand(darkView.tree))
 for(const bg of ['rgba(46, 160, 67, 0.22)','rgba(248, 81, 73, 0.22)','rgba(46, 160, 67, 0.48)'])assert.ok(darkNodes.some(n=>n.props.background===bg))
 assert.ok(darkNodes.some(n=>n.props.foregroundStyle==='#e6edf3'))
 assert.equal(darkNodes.some(n=>['#e6ffec','#ffebe9'].includes(n.props.background)),false)
 darkView.unmount()
 const labels=[]
 const tabUi=new Proxy(ui,{get:(target,key)=>key==='useColorScheme'?()=> 'light':key==='ImageRenderer'?{toUIImage:async node=>{labels.push(node);return {withTintColor:(color,mode)=>({label:node.children.join(''),color,mode})}}}:target[key]})
 const {FileChangeSwitcher}=load('components/FileChangeSwitcher.tsx',{scripting:tabUi,'../constants/colors':{COLOR_ORANGE:'systemOrange'}})
 const selection={value:0,setValue(value){this.value=value}}
 const switcher=mount(FileChangeSwitcher,{stats:{added:1,deleted:1},selection,content:__jsx('Editor',{}),changes:__jsx('Text',{},'diff'),disabled:false})
 await tick();switcher.render()
 assert.equal(switcher.tree.type,'TabView');assert.equal(switcher.tree.props.tabIndex,0)
 assert.deepEqual(switcher.tree.props.background,{light:'white',dark:'#242424'});assert.equal(switcher.tree.props.ignoresSafeArea.edges,'bottom')
 assert.deepEqual(switcher.tree.props.toolbarBackgroundVisibility,{visibility:'hidden',bars:['tabBar']})
 switcher.tree.props.onTabIndexChanged(1);assert.equal(selection.value,1)
 const items=all(switcher.tree).filter(n=>n.props.tabItem)
 assert.deepEqual(items.map(n=>n.props.tag),[0,1])
 for(const item of items){assert.deepEqual(item.props.toolbarBackgroundVisibility,{visibility:'hidden',bars:['tabBar']});assert.deepEqual(item.props.ignoresSafeArea,{regions:'container',edges:'bottom'})}
 const changedLabel=all(items[1].props.tabItem)
 assert.equal(changedLabel.find(n=>n.type==='Text').children.join(''),'改动项')
 assert.equal(changedLabel.find(n=>n.type==='Image').props.renderingMode,'original')
 assert.equal(changedLabel.find(n=>n.type==='Image').props.image.label,'-1 +1')
 assert.equal(labels[0].props.foregroundStyle,'systemOrange')
 assert.equal(changedLabel.find(n=>n.type==='Image').props.image.color,'systemOrange')
 assert.equal(changedLabel.find(n=>n.type==='Image').props.image.mode,'alwaysOriginal')
 assert.equal(changedLabel.find(n=>n.type==='Image').props.foregroundStyle,'systemOrange')
 assert.equal(changedLabel.some(n=>n.props.systemName),false)
 assert.equal(switcher.tree.props.safeAreaInset,undefined);assert.equal(switcher.tree.props.padding,undefined)
 switcher.unmount()
 console.log('PASS 首屏不等统计、后台真实增删计数/草稿更新、数字在标题上方且复用已修改橙色、无符号图标、输入当下不算差异、原生TabView不设边距偏移、默认全屏内容、条件双按钮、红删绿增/行内高亮、即时草稿、切换零写入、同一控制器、自动保存、重试及卸载安全')
}
main().catch(e=>{console.error(e);process.exitCode=1})
