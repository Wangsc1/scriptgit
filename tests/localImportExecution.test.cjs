/* Deferred and immediate Thread callbacks. These tests validate JS handoff,
 * not native Photos/Timer queue affinity. REF mode checks the pre-fix regression. */
const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript')
const {execFileSync}=require('node:child_process')
const {load,ui,mount,all,tick,deferred}=require('./remoteFiles.test.cjs')
function execution(){
 if(!process.env.LOCAL_IMPORT_EXECUTION_REF)return load('services/localImportExecution.ts')
 const source=execFileSync('git',['show',process.env.LOCAL_IMPORT_EXECUTION_REF+':services/localImportExecution.ts'],{encoding:'utf8'})
 const mod={exports:{}};new Function('module','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(mod,mod.exports);return mod.exports
}
const api=execution();let main=false,pending=[],dispatches=0
function deliver(fn){const before=main;main=true;try{fn()}finally{main=before}}
function deferredThread(){pending=[];dispatches=0;main=false;global.Thread={get isMainThread(){return main},runInMain(fn){dispatches++;pending.push(fn)}}}
async function flush(){for(let i=0;i<30;i++){await tick();const batch=pending.splice(0);for(const fn of batch)deliver(fn)}}
async function testHelper(){
 deferredThread();let runs=0,settled=false
 const result=api.localImportOnMain('deferred',()=>{runs++;return 42});assert.ok(result instanceof Promise)
 result.then(()=>{settled=true},()=>{settled=true});await tick();assert.equal(settled,false);assert.equal(runs,0)
 const fn=pending.shift();deliver(fn);deliver(fn);assert.equal(await result,42);assert.equal(runs,1,'duplicate native callback must not duplicate side effects')
 deferredThread();const gate=deferred();const promise=api.localImportStep('promise',()=>gate.promise);deliver(pending.shift());let done=false;promise.then(()=>{done=true});await tick();assert.equal(done,false);gate.resolve('value');assert.equal(await promise,'value')
 for(const task of [()=>{throw Error('sync task failed')},()=>Promise.reject(Error('async task failed'))]){
  deferredThread();const failure=api.localImportOnMain('task-failure',task);const rejection=assert.rejects(failure,/导入:task-failure.*callMain=true.*task failed/);deliver(pending.shift());await rejection
 }
 global.Thread={isMainThread:false,runInMain(fn){deliver(fn)}};assert.equal(await api.localImportOnMain('immediate',()=>7),7)
 let dispatch=0;global.Thread={isMainThread:true,runInMain(){dispatch++;throw Error('must not dispatch current main context')}}
 assert.equal(await api.localImportOnMain('direct',()=>9),9);assert.equal(dispatch,0)
 deferredThread();global.Thread.runInMain=fn=>{pending.push(fn);throw Error('dispatch failed')};runs=0
 await assert.rejects(api.localImportOnMain('dispatch-failure',()=>{runs++}),/dispatch failed/);deliver(pending.shift());assert.equal(runs,0,'a queued callback after rejected dispatch must not run task')
 global.Thread={isMainThread:false,runInMain(fn){deliver(fn);throw Error('late dispatch throw')}};assert.equal(await api.localImportOnMain('already-started',()=>11),11)
 delete global.Thread;assert.equal(await api.localImportOnMain('old-runtime',()=>13),13)
}
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
async function testUI(){
 deferredThread();let moves=0,refreshes=0,loads=0
 global.FileManager={stat:async()=>({size:17,modificationDate:2})}
 global.UUID={string:()=>require('node:crypto').randomUUID()}
 global.ItemProvider={fromText:value=>({value,registeredTypes:['public.utf8-plain-text','public.url'],loadText:async()=>value})}
 const FilesTab=load('pages/FilesTab.tsx',{
 '../services/localImportBatchSummary':load('services/localImportBatchSummary.ts'),
  scripting:ui,'../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},'../constants/colors':{}, '../utils/fileTree':load('utils/fileTree.ts'),
  '../utils/fileListPerformance':load('utils/fileListPerformance.ts'),'../utils/format':{formatBytes:value=>'bytes:'+value,formatDate:String},
  '../services/localImportExecution':api,'../services/localFileImport':{},'../services/repoStore':{resolveWorkdir:()=>'/work'},
  '../services/gitService':{moveLocalWorktreeFile:async()=>{moves++;return 'folder/source.txt'}},
 }).FilesTab
 const props={files:['source.txt','folder/keep.txt'],changes:[],bookmarkName:'repo',loading:false,mergeInProgress:false,onCreateEntry(){},onWorktreeChanged:async()=>{refreshes++}}
 const h=mount(FilesTab,props,{effectUpdates:true});await flush();h.render()
 let nodes=()=>{h.render();return all(expand(h.tree))}
 assert.ok(nodes().some(n=>n.type==='Text'&&n.children.join('').includes('bytes:17')),'metadata result must arrive through deferred main callback')
 assert.ok(!JSON.stringify(h.tree).includes('元数据读取失败'))
 h.unmount()
 // A delayed metadata setter must re-check cancellation, not write after unmount.
 deferredThread();const detached=mount(FilesTab,props,{effectUpdates:true});await tick();detached.unmount();await flush();assert.equal(detached.lateWrites,0)
 delete global.UUID;delete global.ItemProvider
}
async function mainTest(){await testHelper();await testUI();console.log('PASS deferred/immediate Thread callback, direct-main path, one-shot execution, sync throw/async rejection/Promise result, deferred metadata UI and detached-unmount safety')}
mainTest().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{delete global.Thread;delete global.UUID;delete global.ItemProvider})
