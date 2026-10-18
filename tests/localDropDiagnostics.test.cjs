/* Diagnostic JS event coverage only; no claim about native drop delivery. */
const assert=require('node:assert/strict')
const {load,ui,mount,all,tick,deferred}=require('./remoteFiles.test.cjs')
const execution=load('services/localImportExecution.ts')
let pending=[],dispatches=0,main=false,moves=0,refreshes=0
function deliver(fn){const previous=main;main=true;try{fn()}finally{main=previous}}
global.Thread={get isMainThread(){return main},runInMain(fn){dispatches++;pending.push(fn)}}
global.UUID={string:()=>require('node:crypto').randomUUID()}
global.ItemProvider={fromText:token=>({registeredTypes:['public.utf8-plain-text','public.url'],loadText:async()=>token})}
global.FileManager={stat:async()=>({size:1,modificationDate:1})}
const filesModule=load('pages/FilesTab.tsx',{
 '../services/localImportBatchSummary':load('services/localImportBatchSummary.ts'),
 './DragDropTestPage':{DragDropTestPage:'DragDropTestPage'},
 scripting:ui,'../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},'../constants/colors':{},
 '../utils/localFileDrag':load('utils/localFileDrag.ts'),'../utils/fileTree':load('utils/fileTree.ts'),
 '../utils/fileListPerformance':load('utils/fileListPerformance.ts'),'../utils/format':{formatBytes:String,formatDate:String},
 '../services/localImportExecution':execution,'../services/localFileImport':{},'../services/repoStore':{resolveWorkdir:()=>'/work'},
 '../services/gitService':{moveLocalWorktreeFile:async()=>{moves++;return 'folder/source.txt'}},
})
const {FilesTab}=filesModule
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type({...n.props,children:n.children}));return {...n,children:(n.children||[]).map(expand)}}
async function flush(){for(let i=0;i<20;i++){await tick();for(const fn of pending.splice(0))deliver(fn)}}
function host(){const h=mount(FilesTab,{files:['source.txt','folder/keep'],changes:[],bookmarkName:'repo',loading:false,mergeInProgress:false,onCreateEntry(){},onWorktreeChanged:async()=>{refreshes++}},{effectUpdates:true});return h}
function parts(h){h.render();const nodes=all(expand(h.tree));return {file:nodes.find(n=>n.type==='Button'&&n.props.onDrag),drop:nodes.find(n=>n.type==='DisclosureGroup').props.onDrop}}
function shown(h){h.render();return all(h.tree).filter(n=>n.type==='Text').flatMap(n=>n.children).filter(s=>typeof s==='string'&&s.startsWith('拖动记录')).join('\n')}
async function view(h){h.render();all(h.tree.props.header).find(n=>n.type==='Button'&&n.props.title==='查看拖动记录').props.action();await flush();h.render();return shown(h)}
function liveText(h){h.render();return JSON.stringify(h.tree)}
async function start(h){const before=dispatches,provider=parts(h).file.props.onDrag.data();assert.equal(dispatches,before,'drag start never dispatches UI work');await flush();return provider}
async function mainTest(){
 const h=host();await flush()
 // Zero-entry state is explicit and viewing performs no native callback.
 let text=await view(h);assert.match(text,/回调计数 onDrag=0 validateDrop=0 dropEntered=0 dropUpdated=0 dropExited=0 performDrop=0\n尚无拖动记录/)
 let provider=await start(h),drop=parts(h).drop
 const renderBase=liveText(h)
 assert.equal(shown(h),text,'drag start changes no visible row; old snapshot stays until viewed')
 const failInfo={hasItemsConforming(){throw Error('bridge hasItems original')},itemProviders(){throw Error('must not reach providers')}}
 const dispatchBase=dispatches;let renders=0
 assert.equal(drop.validateDrop(failInfo),false);assert.equal(drop.dropUpdated(failInfo),'forbidden');drop.dropEntered(failInfo);assert.equal(drop.performDrop(failInfo),false)
 assert.equal(dispatches,dispatchBase,'callbacks never dispatch to main queue');await flush();assert.equal(dispatches,dispatchBase);assert.equal(liveText(h),renderBase,'callbacks cause no state change/render')
 text=await view(h)
 assert.match(text,/onDrag=1 validateDrop=1 dropEntered=1 dropUpdated=1 dropExited=0 performDrop=1/)
 assert.match(text,/validateDrop 入口\n拖动：validateDrop.hasItemsConforming 异常：bridge hasItems original/)
 assert.match(text,/dropUpdated 入口\n拖动：dropUpdated.hasItemsConforming 异常：bridge hasItems original/)
 assert.match(text,/dropEntered 入口\n拖动：dropEntered.hasItemsConforming 异常：bridge hasItems original/)
 assert.match(text,/performDrop 入口\n拖动：performDrop.hasItemsConforming 异常：bridge hasItems original/)
 assert.ok(text.split('\n').length<=9)
 // New drag clears old counts and failures.
 provider=await start(h);text=await view(h);assert.ok(!text.includes('bridge hasItems original'));assert.match(text,/onDrag=1 validateDrop=0 dropEntered=0 dropUpdated=0 dropExited=0 performDrop=0/)
 drop=parts(h).drop
 const noType={hasItemsConforming:()=>false,itemProviders(){throw Error('must not load rejected content')}}
 assert.equal(drop.validateDrop(noType),false);drop.dropExited(noType)
 text=await view(h);assert.match(text,/validateDrop → 文本类型不匹配/);assert.match(text,/dropExited 入口/)
 // High-frequency same callback: every call is counted exactly, but no lines/dispatch/render.
 drop.dropUpdated(noType);const before=dispatches,oldLive=liveText(h)
 for(let i=0;i<500;i++)assert.equal(drop.dropUpdated(noType),'forbidden')
 await flush();assert.equal(dispatches,before);assert.equal(liveText(h),oldLive)
 text=await view(h);assert.match(text,/dropUpdated=501/);assert.ok(text.split('\n').length<=9)
 provider=await start(h);drop=parts(h).drop
 const badProviders={hasItemsConforming:()=>true,itemProviders(){throw Error('bridge providers original')}}
 const errorBase=liveText(h),dBase=dispatches
 assert.equal(drop.performDrop(badProviders),false);await flush();assert.equal(dispatches,dBase,'synchronous throw path sets no error state');assert.equal(liveText(h),errorBase)
 text=await view(h);assert.match(text,/performDrop 入口[\s\S]*performDrop.itemProviders 异常：bridge providers original/)
 assert.equal(moves,0)
 // Normal sequence: provider is loaded synchronously inside performDrop; business move is unchanged.
 provider=await start(h);drop=parts(h).drop
 const gate=deferred(),calls=[]
 const info={hasItemsConforming(){calls.push('hasItems');return true},itemProviders(){calls.push('providers');return [{loadText(){calls.push('loadText');return gate.promise}}]}}
 const d0=dispatches
 assert.equal(drop.validateDrop(info),true);drop.dropEntered(info);assert.equal(drop.dropUpdated(info),'move');assert.equal(dispatches,d0)
 assert.equal(drop.performDrop(info),true);assert.deepEqual(calls.slice(-3),['hasItems','providers','loadText'])
 text=await view(h);assert.match(text,/performDrop 入口[\s\S]*performDrop.itemProviders 返回1项[\s\S]*performDrop.loadText 已启动/)
 assert.equal(drop.performDrop(info),false);assert.equal(calls.filter(s=>s==='providers').length,1)
 gate.resolve(await provider.loadText());await flush();assert.equal(moves,1);assert.equal(refreshes,1)
 text=await view(h);assert.match(text,/移动成功，已刷新工作区/)
 assert.ok(text.split('\n').length<=9);assert.ok(!text.includes('scriptgit-local-move:'));assert.ok(!text.includes('/work'))
 h.unmount()
 // Unmount: nothing is written afterwards and old callbacks are inert.
 const detached=host();await flush();parts(detached).file.props.onDrag.data();detached.unmount();await flush();assert.equal(detached.lateWrites,0)
 const late=parts(detached).drop;assert.equal(late.validateDrop({hasItemsConforming:()=>true}),false)
 // Diagnostics have no dispatch path, so even a failing diagnostic dispatcher cannot alter drop or move.
 const safe=host();await flush();const safeProvider=await start(safe),safeDrop=parts(safe).drop
 const original=execution.localImportOnMain
 execution.localImportOnMain=(phase,task)=>phase==='拖动阶段提示'?Promise.reject(Error('diagnostic UI unavailable')):original(phase,task)
 try{assert.equal(safeDrop.performDrop({hasItemsConforming:()=>true,itemProviders:()=>[safeProvider]}),true);await flush();assert.equal(moves,2)}finally{execution.localImportOnMain=original;safe.unmount()}
 console.log('PASS ref-only drag trace: exact callback counts incl. zero, latest-eight lines, no state/dispatch/render from drag start or validate/enter/update/exit/perform, sync throw paths recorded only in ref, manual snapshot view, new-drag reset, normal synchronous load/move, unmount guard')
 console.log('LIMIT: diagnostic tests do not establish native onDrop delivery or fix the reported native failure')
}
mainTest().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{delete global.Thread;delete global.UUID;delete global.ItemProvider})
