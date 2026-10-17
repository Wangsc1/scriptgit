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
const FilesTab=load('pages/FilesTab.tsx',{
 '../services/localImportBatchSummary':load('services/localImportBatchSummary.ts'),
 './DragDropTestPage':{DragDropTestPage:'DragDropTestPage'},
 scripting:ui,'../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},'../constants/colors':{},
 '../utils/localFileDrag':load('utils/localFileDrag.ts'),'../utils/fileTree':load('utils/fileTree.ts'),
 '../utils/fileListPerformance':load('utils/fileListPerformance.ts'),'../utils/format':{formatBytes:String,formatDate:String},
 '../services/localImportExecution':execution,'../services/localFileImport':{},'../services/repoStore':{resolveWorkdir:()=>'/work'},
 '../services/gitService':{moveLocalWorktreeFile:async()=>{moves++;return 'folder/source.txt'}},
}).FilesTab
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
async function flush(){for(let i=0;i<20;i++){await tick();for(const fn of pending.splice(0))deliver(fn)}}
function host(){const h=mount(FilesTab,{files:['source.txt','folder/keep'],changes:[],bookmarkName:'repo',loading:false,mergeInProgress:false,onCreateEntry(){},onWorktreeChanged:async()=>{refreshes++}},{effectUpdates:true});return h}
function parts(h){h.render();const nodes=all(expand(h.tree));return {file:nodes.find(n=>n.type==='Button'&&n.props.onDrag),drop:nodes.find(n=>n.type==='DisclosureGroup').props.label.props.onDrop}}
function trace(h){h.render();return all(h.tree).filter(n=>n.type==='Text').flatMap(n=>n.children).filter(s=>typeof s==='string'&&s.startsWith('拖动：')).join('\n')}
async function start(h){const provider=parts(h).file.props.onDrag.data();await flush();return provider}
async function mainTest(){
 const h=host();await flush();let provider=await start(h),drop=parts(h).drop
 const failInfo={hasItemsConforming(){throw Error('bridge hasItems original')},itemProviders(){throw Error('must not reach providers')}}
 assert.equal(drop.validateDrop(failInfo),false);await flush()
 assert.match(trace(h),/validateDrop 入口\n拖动：validateDrop.hasItemsConforming 异常：bridge hasItems original/)
 assert.equal(drop.dropUpdated(failInfo),'forbidden');await flush();assert.match(trace(h),/dropUpdated 入口\n拖动：dropUpdated.hasItemsConforming 异常：bridge hasItems original/)
 drop.dropEntered(failInfo);await flush();assert.match(trace(h),/dropEntered 入口\n拖动：dropEntered.hasItemsConforming 异常：bridge hasItems original/)
 assert.equal(drop.performDrop(failInfo),false);await flush();assert.match(trace(h),/performDrop 入口\n拖动：performDrop.hasItemsConforming 异常：bridge hasItems original/)
 assert.ok(trace(h).split('\n').length<=8)
 // New drag clears old failure trace; a precondition rejection never calls native capability checks.
 provider=await start(h);assert.ok(!trace(h).includes('bridge hasItems original'))
 drop=parts(h).drop
 const noType={hasItemsConforming:()=>false,itemProviders(){throw Error('must not load rejected content')}}
 assert.equal(drop.validateDrop(noType),false);await flush();assert.match(trace(h),/validateDrop → 文本类型不匹配/)
 drop.dropExited(noType);await flush();assert.match(trace(h),/dropExited 入口/)
 // Same callback/result repeated at high frequency produces no further dispatches/renders.
 drop.dropUpdated(noType);await flush();const before=dispatches,oldTrace=trace(h)
 for(let i=0;i<500;i++)assert.equal(drop.dropUpdated(noType),'forbidden')
 await flush();assert.equal(dispatches,before);assert.equal(trace(h),oldTrace)
 provider=await start(h);drop=parts(h).drop
 const badProviders={hasItemsConforming:()=>true,itemProviders(){throw Error('bridge providers original')}}
 assert.equal(drop.performDrop(badProviders),false);await flush();assert.match(trace(h),/performDrop 入口[\s\S]*performDrop.itemProviders 异常：bridge providers original/)
 assert.equal(moves,0)
 // Normal sequence: independent entry markers survive delayed UI dispatch; load is synchronous.
 provider=await start(h);drop=parts(h).drop
 const gate=deferred(),calls=[]
 const info={hasItemsConforming(){calls.push('hasItems');return true},itemProviders(){calls.push('providers');return [{loadText(){calls.push('loadText');return gate.promise}}]}}
 assert.equal(drop.validateDrop(info),true);drop.dropEntered(info);assert.equal(drop.dropUpdated(info),'move')
 await flush();assert.match(trace(h),/validateDrop 入口[\s\S]*dropEntered 入口[\s\S]*dropUpdated 入口/)
 assert.equal(drop.performDrop(info),true);assert.deepEqual(calls.slice(-3),['hasItems','providers','loadText']);await flush()
 assert.match(trace(h),/performDrop 入口[\s\S]*performDrop.itemProviders 返回1项[\s\S]*performDrop.loadText 已启动/)
 const countBefore=dispatches
 assert.equal(drop.performDrop(info),false);await flush();assert.match(trace(h),/performDrop → 忙碌、合并或表单占用/)
 assert.equal(calls.filter(s=>s==='providers').length,1)
 gate.resolve(await provider.loadText());await flush();assert.equal(moves,1);assert.equal(refreshes,1);assert.match(trace(h),/移动成功，已刷新工作区/)
 assert.ok(trace(h).split('\n').length<=8);assert.ok(!trace(h).includes('scriptgit-local-move:'));assert.ok(!trace(h).includes('/work'))
 h.unmount()
 // No delayed UI write after unmount.
 const detached=host();await flush();parts(detached).file.props.onDrag.data();detached.unmount();await flush();assert.equal(detached.lateWrites,0)
 // Failed diagnostic dispatch must not alter synchronous accepted drop/loading or successful move.
 const safe=host();await flush();const safeProvider=await start(safe),safeDrop=parts(safe).drop
 const original=execution.localImportOnMain
 execution.localImportOnMain=(phase,task)=>phase==='拖动阶段提示'?Promise.reject(Error('diagnostic UI unavailable')):original(phase,task)
 try{assert.equal(safeDrop.performDrop({hasItemsConforming:()=>true,itemProviders:()=>[safeProvider]}),true);await flush();assert.equal(moves,2)}finally{execution.localImportOnMain=original;safe.unmount()}
 console.log('PASS bounded eight-event drop trace: distinct callback entries before native methods, hasItems/itemProviders exceptions, precondition rejection, normal synchronous loading/move, high-frequency dedup, diagnostic failure isolation and unmount guard')
 console.log('LIMIT: diagnostic tests do not establish native onDrop delivery or fix the reported native failure')
}
mainTest().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{delete global.Thread;delete global.UUID;delete global.ItemProvider})
