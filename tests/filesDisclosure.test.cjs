/* Real standard-row output; iOS frame rendering is not simulated. */
const assert=require('node:assert/strict')
const {load,mount,ui,all,tick}=require('./remoteFiles.test.cjs')
const {isFolderRow,folderExpanded}=require('./standardTreeHelpers.js')
const missing=new Set(['Transition','Animation','withAnimation'])
const safeUi=new Proxy(ui,{get(t,k){return missing.has(k)?undefined:t[k]}})
const standard=load('components/StandardFolderRow.tsx',{scripting:safeUi})
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function'){const result=expand(n.type(n.props));return n.props.node?{...result,key:n.props.key}:result}return {...n,children:(n.children||[]).map(expand)}}
let reads=[];global.FileManager={stat:async p=>{reads.push(p);return{size:1,modificationDate:2}}}
const FilesTab=load('pages/FilesTab.tsx',{
 scripting:safeUi,'../components/StandardFolderRow':standard,'../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},'../utils/fileTree':load('utils/fileTree.ts'),'../utils/fileListPerformance':load('utils/fileListPerformance.ts'),
 '../utils/format':{formatBytes:String,formatDate:String},'../services/repoStore':{resolveWorkdir:()=>'/mock'},
 '../services/gitService':{openLocalWorktreeFile:async()=>{throw Error('open failed')}},'../constants/colors':{COLOR_PURPLE:'systemPurple'},
 '../services/localImportExecution':load('services/localImportExecution.ts'),'../services/localFileImport':{},'../services/localImportBatchSummary':{},
}).FilesTab
;(async()=>{
 const props={files:['a/deep/one.txt','b/two.txt'],changes:[],bookmarkName:'mock',loading:true,onOpen(){},onWorktreeChanged(){},onPush(){},onStage(){},onRestore(){},onCreateEntry(){},mergeInProgress:false}
 const h=mount(FilesTab,props,{effectUpdates:true})
 const nodes=()=>{h.render();return all(expand(h.tree))}
 const group=p=>nodes().find(n=>isFolderRow(n)&&n.props.accessibilityLabel==='文件夹 '+p)
 const fileRows=()=>nodes().filter(n=>n.type==='Button'&&!isFolderRow(n)&&n.props.trailingSwipeActions)
 const keys=()=>nodes().filter(n=>isFolderRow(n)||n.type==='Button'&&n.props.trailingSwipeActions).map(n=>n.key)
 assert.ok(!nodes().some(n=>n.type==='DisclosureGroup'))
 assert.deepEqual(keys(),['a','b']);assert.equal(reads.length,0);assert.equal(fileRows().length,0)
 assert.equal(group('a').props.disabled,true);group('a').props.action();assert.deepEqual(keys(),['a','b'])
 props.loading=false;group('a').props.action();assert.deepEqual(keys(),['a','a/deep','b'])
 group('a/deep').props.action();assert.deepEqual(keys(),['a','a/deep','a/deep/one.txt','b'])
 const metadataLine=()=>nodes().filter(n=>n.type==='Text'&&n.props.font==='caption2'&&n.props.lineLimit===1)
 assert.equal(metadataLine().length,1);assert.equal(metadataLine()[0].children[0],' ')
 await tick();h.render();await tick();assert.ok(metadataLine()[0].children[0]!==' ')
 assert.ok(reads.every(p=>p==='/mock/a/deep/one.txt'),'no hidden-file metadata')
 const openedKeys=keys();group('a').props.action();assert.deepEqual(keys(),['a','b']);assert.equal(folderExpanded(group('a')),false)
 group('a').props.action();assert.deepEqual(keys(),openedKeys);assert.equal(folderExpanded(group('a/deep')),true)
 // Inventory refresh does not reset intent or leave removed files in the flat list.
 props.worktreeEntries={files:[...props.files,'a/deep/new.txt'],directories:['a','a/deep','empty'],untrackedDirectories:['empty']}
 props.files=[...props.files];assert.ok(keys().includes('a/deep/new.txt'));assert.equal(folderExpanded(group('empty')),false)
 props.files=['a/deep/replacement.txt','b/two.txt'];props.worktreeEntries={files:[...props.files],directories:['a','a/deep','b'],untrackedDirectories:[]}
 assert.deepEqual(keys(),['a','a/deep','a/deep/replacement.txt','b']);assert.equal(folderExpanded(group('a/deep')),true)
 props.files=['a/deep/one.txt','b/two.txt'];props.worktreeEntries={files:[...props.files],directories:['a','a/deep','b'],untrackedDirectories:[]}
 props.changes=[{filepath:'a/deep/one.txt',status:'*modified'}]
 const row=fileRows()[0]
 assert.deepEqual(row.props.trailingSwipeActions.actions.map(a=>[a.props.title,a.props.tint]),[['推送','systemGreen'],['还原','systemOrange'],['暂存','systemPurple'],['删除','systemRed']])
 assert.deepEqual(group('a').props.trailingSwipeActions.actions.map(a=>[a.props.title,a.props.tint]),[['推送','systemGreen'],['还原','systemOrange'],['暂存','systemPurple'],['删除','systemRed']])
 assert.deepEqual(all(group('a').props.contextMenu.menuItems).filter(n=>n.type==='Button').map(n=>n.props.title),['重命名','复制文件夹'])
 await row.props.action();assert.ok(nodes().some(n=>n.type==='Text'&&n.children.includes('open failed')))
 props.loading=true;assert.ok(nodes().filter(n=>n.type==='Button'&&n.props.trailingSwipeActions).every(n=>n.props.disabled))
 // Arbitrarily deep data remains readable: indent increases then caps, keeps exact hierarchy.
 const deep='d0/d1/d2/d3/d4/d5/d6/d7/d8/d9/file.txt'
 const tree=load('utils/fileTree.ts').buildFileTree([deep]),expanded=new Set(deep.split('/').slice(0,-1).map((_,i)=>deep.split('/').slice(0,i+1).join('/')))
 const flattened=standard.visibleTreeRows(tree,expanded);assert.equal(flattened.length,11)
 assert.deepEqual(flattened.map(r=>r.depth),Array.from({length:11},(_,i)=>i));assert.equal(standard.treeRowIndent(10),112)
 assert.equal(standard.treeRowIndent(1),16)
 assert.equal(row.children[0].props.padding.leading,32)
 h.unmount();console.log('PASS no Transition/Animation export needed to import/render/open/collapse; flat visible keyed rows, nested intent, refresh/add/delete, depth, metadata, menus/swipe/busy/error preserved')
})().catch(e=>{console.error(e);process.exitCode=1})
