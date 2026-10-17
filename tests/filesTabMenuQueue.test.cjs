/* Simulated JS queues/commits, NOT an iOS/native presentation test. */
const assert=require('node:assert/strict'),{AsyncLocalStorage}=require('node:async_hooks')
const {load,ui,mount,all,tick,deferred}=require('./remoteFiles.test.cjs')
const queue=new AsyncLocalStorage(),trace=[]
const on=(phase,fn)=>queue.run({main:phase!=='menu',phase},fn)
function mainOnly(api){trace.push({api,...queue.getStore()});assert.equal(queue.getStore()?.main,true,api+' ran on menu queue')}
const timeout=global.setTimeout,errorText='Timer requires its active script on the main JS execution queue'
global.setTimeout=(fn,ms,...args)=>{trace.push({api:'Timer',stack:new Error().stack,...queue.getStore()});if(!queue.getStore()?.main)throw Error(errorText);return timeout(fn,ms,...args)}
const {StatusCoordinator}=load('utils/statusCoordinator.ts'),coordinator=new StatusCoordinator({writeWaitMs:10000})
let selected=null,gate=null,mutations=0,refreshes=0
async function pick(kind){mainOnly(kind);assert.equal(queue.getStore().phase,'effect');if(gate)await gate.promise;return selected}
const scripting=new Proxy({},{get:(_,key)=>key==='useEffect'?(fn,deps)=>ui.useEffect(()=>on('effect',fn),deps):ui[key]})
const FilesTab=load('pages/FilesTab.tsx',{
 scripting,'../services/localImportExecution':load('services/localImportExecution.ts'),'../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},'../constants/colors':{},
 '../utils/localFileDrag':load('utils/localFileDrag.ts'),'../utils/fileTree':load('utils/fileTree.ts'),'../utils/fileListPerformance':load('utils/fileListPerformance.ts'),
 '../utils/format':{formatBytes:String,formatDate:String},
 '../services/repoStore':{resolveWorkdir(){mainOnly('root');return '/authorized/work'}},
 '../services/localFileImport':{pickLocalDirectory:()=>pick('DocumentPicker.pickDirectory'),pickLocalDocument:()=>pick('DocumentPicker'),pickLocalPhoto:()=>pick('Photos.pick')},
 '../services/gitService':{
  createLocalWorktreeEntry:async(_,name)=>{mainOnly('create');return coordinator.mutate('repo',async()=>{mutations++;return name})},
  importLocalWorktreeDirectory:async(_,source,root)=>{mainOnly('import-directory');assert.equal(root,'/authorized/work');assert.equal(source,'/picker/Folder');return coordinator.mutate('repo',async()=>{mutations++;return {path:'Folder',files:['Folder/a.bin'],directories:['Folder','Folder/empty']}})},
  importLocalWorktreeFile:async(_,source,name,root)=>{mainOnly('import');assert.equal(root,'/authorized/work');assert.equal(source,'/picker/original.png');return coordinator.mutate('repo',async()=>{mutations++;return name})},
 },
}).FilesTab
let parentForm=null
const props={creationActive:false,onCreateEntry(directory,onCreated){mainOnly('parent-create');parentForm={directory,onCreated};props.creationActive=true},files:[],changes:[],bookmarkName:'repo',loading:false,mergeInProgress:false,onWorktreeChanged:async()=>{mainOnly('refresh');refreshes++},onOpen(){},onPush(){},onRestore(){}}
let h
const render=()=>on('render',()=>h.render())
const button=title=>all(h.tree.props.header).find(n=>n.type==='Button'&&n.props.title===title)
const menu=title=>on('menu',()=>button(title).props.action())
async function settle(){for(let i=0;i<100;i++){render();if(!button('导入文件').props.disabled)return;await tick()}throw Error('request did not settle')}
async function main(){
 // Exact real coordinator timer fails under the modeled non-main condition.
 await assert.rejects(on('menu',()=>coordinator.mutate('baseline',async()=>{})),new RegExp('StatusCoordinator.writeWaitTimer.*'+errorText))
 assert.match(trace.find(e=>e.api==='Timer').stack,/StatusCoordinator.mutate/);assert.equal(coordinator.isWriting('baseline'),false)
 h=on('render',()=>mount(FilesTab,props,{effectUpdates:true}));trace.length=0
 for(const title of ['创建文件','创建目录']){
  menu(title);menu('导入图片');assert.deepEqual(trace,[]);assert.equal(h.tree.props.sheet.isPresented,false)
  render();assert.equal(h.tree.props.sheet.isPresented,false,'intent commit must not already present sheet')
  assert.equal(trace.filter(e=>e.api==='parent-create').length,1);assert.equal(trace[0].phase,'effect')
  render();assert.equal(h.tree.props.sheet.isPresented,false,'creation is never presented on Section');assert.equal(parentForm.directory,title==='创建目录')
  menu('导入文件');assert.equal(trace.some(e=>e.api==='DocumentPicker'),false)
  props.creationActive=false;parentForm=null
  render();trace.length=0
 }
 assert.equal(mutations,0);assert.equal(refreshes,0)
 for(const title of ['导入文件','导入目录','导入图片']){
  menu(title);assert.deepEqual(trace,[]);render();await settle()
  assert.equal(trace.filter(e=>e.api===(title==='导入图片'?'Photos.pick':title==='导入目录'?'DocumentPicker.pickDirectory':'DocumentPicker')).length,1)
  assert.equal(trace.some(e=>e.api==='Timer'),false,'cancellation must not enter mutation');trace.length=0
 }
 selected={sourcePath:'/picker/original.png',name:'original.png',release:async()=>mainOnly('release')}
 menu('导入图片');assert.deepEqual(trace,[]);render();await settle();assert.equal(mutations,1);assert.equal(refreshes,1)
 assert.ok(trace.some(e=>e.api==='Timer'&&e.main&&e.stack.includes('StatusCoordinator.mutate')));assert.equal(trace.some(e=>e.main===false),false)
 trace.length=0;selected={sourcePath:'/picker/Folder',name:'Folder',release:async()=>mainOnly('release')}
 menu('导入目录');assert.deepEqual(trace,[]);render();await settle();assert.equal(mutations,2);assert.equal(refreshes,2)
 assert.ok(trace.some(e=>e.api==='DocumentPicker.pickDirectory'&&e.phase==='effect'));assert.ok(trace.some(e=>e.api==='import-directory'&&e.main))
 trace.length=0;menu('创建文件');props.mergeInProgress=true;render();render();assert.equal(h.tree.props.sheet.isPresented,false);assert.deepEqual(trace,[])
 props.mergeInProgress=false;render();trace.length=0;menu('导入目录');props.bookmarkName='other-repo';render();render()
 assert.equal(mutations,2);assert.equal(trace.some(e=>e.api==='DocumentPicker.pickDirectory'),false);props.bookmarkName='repo';render();trace.length=0
 gate=deferred();menu('导入目录');render();await tick();h.unmount();gate.resolve();await tick();await tick()
 assert.equal(mutations,2);assert.equal(h.lateWrites,0);assert.equal(trace.filter(e=>e.api==='release').length,1)
 h=on('render',()=>mount(FilesTab,props,{effectUpdates:true}));trace.length=0;menu('创建目录');h.unmount();assert.deepEqual(trace,[])
 console.log('PASS real coordinator Timer error reproduced on simulated non-main queue; menu only enqueues; post-commit forms/pickers, cancellation/duplicate/merge/unmount guards')
 console.log('LIMIT: effect queue/native menu dismissal and presentation are modeled, not verified on iOS')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{global.setTimeout=timeout})
