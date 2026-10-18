/* Intent + actual FilesTab actions. Native recognizer arbitration still needs iOS. */
const assert=require('node:assert/strict')
const {load,mount,ui,all,tick}=require('./remoteFiles.test.cjs')
const {FileRowSwipeIntent}=load('utils/fileRowSwipe.ts')
const sample=(x,y,time=100,startX=100)=>({time,startLocation:{x:startX,y:20},translation:{width:x,height:y}})
function policy(){
 const run=(samples,native=false)=>{const p=new FileRowSwipeIntent();p.changed('a',samples[0]);if(native)p.nativeDrag();for(const v of samples.slice(1,-1))p.changed('a',v);return p.ended('a',samples.at(-1))}
 assert.equal(run([sample(0,0),sample(-60,2,150)]),'open')
 assert.equal(run([sample(0,0),sample(60,2,150)]),'close')
 assert.equal(run([sample(0,0),sample(-100,1,150)],true),null)
 assert.equal(run([sample(0,0),sample(-100,1,650)]),null,'long hold never becomes a swipe')
 assert.equal(run([sample(0,0),sample(2,40,120),sample(-100,45,160)]),null,'vertical lock stays vertical')
 assert.equal(run([sample(0,0),sample(-10,1,120)]),null)
 assert.equal(run([sample(0,0,100,5),sample(100,0,150,5)]),null,'system leading-edge gesture ignored')
 assert.equal(run([sample(0,0),sample(-60,50,150)]),null,'diagonal ignored')
 const p=new FileRowSwipeIntent();p.changed('a',sample(0,0));p.nativeDrag();assert.equal(p.ended('a',sample(-100,0,150)),null)
 p.changed('a',sample(0,0,300));assert.equal(p.ended('a',sample(-60,0,350)),'open','next independent gesture works after native drag')
}
let setters=0,deletes=0,pushes=0,restores=[],refreshes=0
const observed=new Proxy(ui,{get(target,key){if(key!=='useState')return target[key];return initial=>{const [v,set]=target.useState(initial);return [v,next=>{setters++;set(next)}]}}})
global.FileManager={stat:async()=>({size:1,modificationDate:1})}
global.UUID={string:()=>require('node:crypto').randomUUID()}
global.ItemProvider={fromText:value=>({registeredTypes:['public.utf8-plain-text','public.url'],loadText:async()=>value})}
global.Dialog={confirm:async()=>false}
const FilesTab=load('pages/FilesTab.tsx',{
 scripting:observed,'../utils/fileRowSwipe':{FileRowSwipeIntent},'../utils/localFileDrag':load('utils/localFileDrag.ts'),
 '../utils/fileTree':load('utils/fileTree.ts'),'../utils/fileListPerformance':load('utils/fileListPerformance.ts'),
 '../utils/format':{formatBytes:String,formatDate:String},'../constants/colors':{},'../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},
 '../services/repoStore':{resolveWorkdir:()=>'/work'},'../services/localImportExecution':load('services/localImportExecution.ts'),
 '../services/localFileImport':{},'../services/localImportBatchSummary':load('services/localImportBatchSummary.ts'),
 '../services/gitService':{readLocalWorktreeFile:async()=>({}),deleteLocalWorktreeFile:async()=>{deletes++},deleteLocalWorktreeDirectory:async()=>{deletes++}},
}).FilesTab
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type({...n.props,children:n.children}));return {...n,props:{...n.props,...(n.props?.label?{label:expand(n.props.label)}:{})},children:(n.children||[]).map(expand)}}
async function flush(h){for(let i=0;i<10;i++){await tick();h.render()}}
async function main(){
 policy()
 const props={files:['file.txt','other.txt','dest/keep'],changes:[{filepath:'file.txt',status:'*modified'},{filepath:'dest/keep',status:'*modified'}],bookmarkName:'repo',loading:false,mergeInProgress:false,onCreateEntry(){},onPush(){pushes++},onRestore:(...args)=>restores.push(args),onWorktreeChanged(){refreshes++}}
 const h=mount(FilesTab,props,{effectUpdates:true});await flush(h)
 const nodes=()=>{h.render();return all(expand(h.tree))}
 const gesture=name=>nodes().find(n=>n.props?.simultaneousGesture&&JSON.stringify(n.children).includes('"'+name+'"')).props.simultaneousGesture
 const buttons=()=>nodes().filter(n=>n.type==='Button'&&['删除','提交','还原','收起'].includes(n.props.title))
 function swipe(name,x=-90){const g=gesture(name);g.changed(sample(0,0));g.changed(sample(x,2,150));g.ended(sample(x,2,180));h.render()}
 assert.equal(buttons().length,0)
 let g=gesture('file.txt'),before=setters;g.changed(sample(0,0));for(let i=0;i<100;i++)g.changed(sample(-50,1,110));assert.equal(setters,before,'tracking uses ref only');g.ended(sample(-90,2,160))
 assert.deepEqual(buttons().map(n=>n.props.title),['删除','提交','还原','收起'])
 assert.deepEqual(buttons().slice(0,3).map(n=>n.props.tint),['systemRed','systemGreen','systemOrange'])
 assert.equal(deletes,0,'full left gesture never executes delete')
 swipe('other.txt');assert.deepEqual(buttons().map(n=>n.props.title),['删除','收起'],'at most one row is open')
 swipe('other.txt',90);assert.equal(buttons().length,0)
 swipe('file.txt');await buttons().find(n=>n.props.title==='提交').props.action();assert.equal(pushes,1);assert.equal(buttons().length,0)
 swipe('file.txt');await buttons().find(n=>n.props.title==='还原').props.action();assert.deepEqual(restores.at(-1),['file.txt',undefined]);assert.equal(buttons().length,0)
 swipe('file.txt');await buttons().find(n=>n.props.title==='删除').props.action();await flush(h);assert.equal(deletes,0,'cancelled confirmation preserves file');assert.equal(refreshes,0)
 swipe('dest');assert.deepEqual(buttons().map(n=>n.props.title),['删除','提交','还原','收起'])
 const folder=nodes().find(n=>n.type==='DisclosureGroup');folder.props.onChanged(true);assert.equal(buttons().length,0,'expanding closes operation strip')
 swipe('dest');await buttons().find(n=>n.props.title==='还原').props.action();assert.deepEqual(restores.at(-1),['dest',['dest/keep']])
 swipe('file.txt');props.mergeInProgress=true;h.render();h.render();assert.equal(buttons().length,0)
 before=setters;g=gesture('file.txt');g.changed(sample(0,0));g.ended(sample(-90,1,170));assert.equal(setters,before,'busy rows do not change state')
 props.mergeInProgress=false;h.render();h.render()
 g=gesture('file.txt');g.changed(sample(0,0));const provider=nodes().find(n=>n.type==='Button'&&n.props.onDrag&&JSON.stringify(n.children).includes('file.txt')).props.onDrag.data();before=setters;g.changed(sample(-90,1,150));g.ended(sample(-90,1,180));assert.equal(setters,before,'native drag suppresses simultaneous row swipe without rendering');assert.equal(provider instanceof Promise,false);assert.equal(buttons().length,0)
 assert.ok(!nodes().some(n=>n.props?.trailingSwipeActions),'ignored List-only swipe prop is gone')
 assert.ok(!nodes().some(n=>n.props?.highPriorityGesture||n.props?.defersSystemGestures),'never override scroll or system edges')
 h.unmount()
 console.log('PASS actual custom row left/right/open/close, exact button order/color, one-open-row, click-only actions, cancel/no writes, folder expand/restore, busy, ref-only tracking/native-drag suppression; vertical/diagonal/hold/edge policy')
 console.log('LIMIT simultaneous native drag/context-menu/scroll/back gesture recognition is not established by JS tests')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{delete global.FileManager;delete global.UUID;delete global.ItemProvider;delete global.Dialog})
