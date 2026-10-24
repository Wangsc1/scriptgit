/* Production FilesTab JS tree contract. Native iOS frame animation is not simulated. */
const assert=require('node:assert/strict')
const {load,mount,ui,all,tick}=require('./remoteFiles.test.cjs')
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
let reads=[];global.FileManager={stat:async p=>{reads.push(p);return{size:1,modificationDate:2}}}
const FilesTab=load('pages/FilesTab.tsx',{
 scripting:ui,'../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},'../utils/fileTree':load('utils/fileTree.ts'),'../utils/fileListPerformance':load('utils/fileListPerformance.ts'),
 '../utils/format':{formatBytes:String,formatDate:String},'../services/repoStore':{resolveWorkdir:()=>'/mock'},
 '../services/gitService':{openLocalWorktreeFile:async()=>{throw Error('open failed')}},'../constants/colors':{COLOR_PURPLE:'systemPurple'},
 '../services/localImportExecution':load('services/localImportExecution.ts'),'../services/localFileImport':{},'../services/localImportBatchSummary':{},
}).FilesTab
;(async()=>{
 const props={files:['a/deep/one.txt','b/two.txt'],changes:[],bookmarkName:'mock',loading:true,onOpen(){},onWorktreeChanged(){},onPush(){},onStage(){},onRestore(){},onCreateEntry(){},mergeInProgress:false}
 const h=mount(FilesTab,props,{effectUpdates:true})
 const nodes=()=>{h.render();return all(expand(h.tree))}
 const group=p=>nodes().find(n=>n.type==='DisclosureGroup'&&all(n.props.label).some(t=>t.type==='Text'&&t.children.includes(p)))
 const keys=()=>nodes().filter(n=>n.type==='DisclosureGroup'||n.type==='Button'&&n.props.trailingSwipeActions).map(n=>[n.type,n.key,n.props.isExpanded])
 assert.ok(!nodes().some(n=>n.type==='Text'&&n.children.includes('加载中…')))
 assert.equal(nodes().find(n=>n.type==='Menu').props.disabled,true)
 assert.equal(nodes().filter(n=>n.type==='DisclosureGroup').length,2);assert.equal(reads.length,0)
 props.loading=false;group('a').props.onChanged(true);group('deep').props.onChanged(true);await tick();h.render();await tick()
 const opened=keys();const before=group('a').children
 assert.ok(nodes().some(n=>n.type==='Button'&&n.props.trailingSwipeActions))
 group('a').props.onChanged(false)
 assert.equal(group('a').props.isExpanded,false);assert.equal(group('deep').props.isExpanded,true)
 assert.equal(nodes().filter(n=>n.type==='DisclosureGroup').length,3)
 assert.equal(group('a').children.length,before.length)
 assert.deepEqual(keys().map(([t,k])=>[t,k]),opened.map(([t,k])=>[t,k]))
 await tick();h.render();await tick();const readCount=reads.length;await tick();assert.equal(reads.length,readCount)
 // Inventory publishes later, then refresh rebuilds the tree. Stable path keys and expansion survive.
 props.worktreeEntries={files:[...props.files,'a/deep/new.txt'],directories:['a','a/deep','empty'],untrackedDirectories:['empty']}
 props.files=[...props.files];nodes();assert.equal(group('a').props.isExpanded,false);assert.equal(group('deep').props.isExpanded,true)
 assert.equal(group('empty').props.isExpanded,false)
 group('a').props.onChanged(true);assert.equal(group('deep').props.isExpanded,true)
 assert.equal(nodes().filter(n=>n.type==='Button'&&n.props.trailingSwipeActions).length,2)
 assert.equal(group('b').children.flat(Infinity).filter(Boolean).length,0) // untouched subtree never built
 // Metadata-only rerender must not change row identity or expansion.
 const snapshot=keys();await tick();h.render();await tick();assert.deepEqual(keys(),snapshot)
 // File-row swipe scope/order/colors and error text preserved.
 props.changes=[{filepath:'a/deep/one.txt',status:'*modified'}]
 let row=nodes().find(n=>n.type==='Button'&&n.props.trailingSwipeActions&&n.props.trailingSwipeActions.actions.length===4)
 assert.deepEqual(row.props.trailingSwipeActions.actions.map(a=>[a.props.title,a.props.tint]),[['推送','systemGreen'],['还原','systemOrange'],['暂存','systemPurple'],['删除','systemRed']])
 await row.props.action();assert.ok(nodes().some(n=>n.type==='Text'&&n.children.includes('open failed')))
 props.loading=true;assert.ok(nodes().filter(n=>n.type==='Button'&&n.props.trailingSwipeActions).every(n=>n.props.disabled))
 h.unmount();console.log('PASS loading text removed only; native disclosure retains keyed content on collapse, nested intent + phased inventory preserved, unopened lazy, metadata visible-only, swipe/guards/error unchanged')
})().catch(e=>{console.error(e);process.exitCode=1})
