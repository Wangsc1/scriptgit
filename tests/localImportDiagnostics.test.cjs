/* Fault injection validates phase attribution and documented Thread-call usage.
 * It cannot establish native Photos/Timer queue affinity or real picker success.
 */
const assert=require('node:assert/strict')
const {load,ui,mount,all,tick}=require('./remoteFiles.test.cjs')
const execution=load('services/localImportExecution.ts'),{StatusCoordinator}=load('utils/statusCoordinator.ts')
const performance=load('utils/fileListPerformance.ts')
const timerText='Timer requires its active script on the main JS execution queue'
const nativeTimeout=global.setTimeout
let mode='',main=false,dispatchCalls=0,refreshes=0
const initiation=[]
global.Thread={get isMainThread(){return main},runInMain(fn){dispatchCalls++;const before=main;main=true;try{fn()}finally{main=before}}}
const coordinator=new StatusCoordinator({writeWaitMs:10000})
global.setTimeout=(fn,ms,...args)=>{if(mode==='write'&&ms===10000)throw Error(timerText);return nativeTimeout(fn,ms,...args)}
global.PHPickerFilter={images:()=>{initiation.push(['filter',main]);return 'images'}}
global.Photos={pick:async()=>{
 initiation.push(['Photos.pick',main]);if(mode==='photos')throw Error(timerText)
 return [{itemProvider:{registeredTypes:['public.png','public.image'],hasRepresentationConforming:()=>{initiation.push(['hasRepresentationConforming',main]);return true},loadFilePath:async()=>{
  initiation.push(['loadFilePath',main]);main=false // Model a native callback resuming off the initiating context.
  if(mode==='load')throw Error(timerText);return '/owned-temporary/original.png'
 }}}]
}}
global.ImageIO={readMetadata:async()=>{initiation.push(['ImageIO.readMetadata',main]);return {pixelWidth:1}}}
const created=new Set()
global.FileManager={stat:async()=>({size:3,creationDate:1,modificationDate:1}),isLink:async()=>false,isFile:async()=>true,isDirectory:async p=>p==='/work',readDirectory:async()=>[],exists:async p=>p==='/work'||created.has(p),copyFile:async(s,d)=>{initiation.push(['copyFile',main]);created.add(d)},remove:async()=>{if(mode==='cleanup')throw Error(timerText)}}
const batchInternal=load('services/git/localFileService.ts',{'../repoStore':{resolveWorkdir:()=>'/work'},'../localImportExecution':execution})
const picker=load('services/localFileImport.ts',{'./localImportExecution':execution})
const FilesTab=load('pages/FilesTab.tsx',{
 '../services/localImportBatchSummary':load('services/localImportBatchSummary.ts'),
 './DragDropTestPage':{DragDropTestPage:'DragDropTestPage'},
 scripting:ui,'../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},'../constants/colors':{},
 '../utils/localFileDrag':load('utils/localFileDrag.ts'),'../utils/fileTree':load('utils/fileTree.ts'),'../utils/fileListPerformance':performance,'../utils/format':{formatBytes:String,formatDate:String},
 '../services/localImportExecution':execution,'../services/localFileImport':picker,'../services/repoStore':{resolveWorkdir:()=>'/work'},
 '../services/gitService':{importLocalWorktreeFiles:async(_,sources,root,canWrite)=>{
  initiation.push(['writer',main]);return coordinator.mutate('repo',()=>batchInternal.importLocalFilesInternal('repo',sources,root,canWrite))
 }},
}).FilesTab
async function runCase(nextMode,pattern){
 mode=nextMode;refreshes=0;initiation.length=0;created.clear()
 const h=mount(FilesTab,{files:[],changes:[],bookmarkName:'repo',loading:false,mergeInProgress:false,onCreateEntry(){},onWorktreeChanged:async()=>{refreshes++;if(mode==='refresh')throw Error(timerText)}},{effectUpdates:true})
 all(h.tree.props.header).find(n=>n.type==='Button'&&n.props.title==='导入图片').props.action();h.render()
 for(let i=0;i<100;i++){await tick();h.render();if(!all(h.tree.props.header).find(n=>n.type==='Menu').props.disabled)break}
 const errors=all(h.tree).filter(n=>n.type==='Text'&&n.props.foregroundStyle==='red').map(n=>n.children.join(' ')).join('\n')
 assert.match(errors,pattern);assert.doesNotMatch(errors,/成功\d|批量导入结果/);if(mode!=='load'&&mode!=='cleanup')assert.ok(errors.includes(timerText),'original error must survive phase wrapping outside privacy-safe photo candidate diagnostics')
 assert.ok(initiation.every(([,flag])=>flag===true),'every separate native/writer initiation explicitly calls the documented API')
 if(mode==='photos'||mode==='load')assert.equal(refreshes,0,'pre-write picker errors must not be masked by a needless refresh')
 assert.equal(coordinator.isWriting('repo'),false);h.unmount();return errors
}
async function mainTest(){
 const photos=await runCase('photos',/导入:Photos\.pick.*Timer requires/);assert.match(photos,/callMain=true/)
 const file=await runCase('load',/registeredTypes=.*public.png.*loadFilePath异常/);assert.ok(!file.includes('/owned-temporary/'))
 await runCase('write',/批量文件写入\/协调锁.*StatusCoordinator\.writeWaitTimer.*Timer requires/)
 await runCase('refresh',/导入:批量刷新改动.*Timer requires/)
 await runCase('cleanup',/临时副本清理失败/)
 assert.ok(dispatchCalls>0)
 // Actual timer sites reject with exact source labels, not swallowed/hung scans.
 mode='';global.setTimeout=()=>{throw Error(timerText)}
 const scan=new StatusCoordinator({slowScanMs:8000})
 await assert.rejects(scan.scan('repo','详情',async()=>7),/StatusCoordinator\.slowScanTimer.*Timer requires/)
 await assert.rejects(performance.readMetadataBatched(['a','b','c','d','e'],async()=>({size:1,modified:1}),()=>false),/readMetadataBatched\.yieldTimer.*Timer requires/)
 global.setTimeout=nativeTimeout
 assert.equal(await scan.scan('repo','重试',async()=>7),7,'timer registration failure must not leave a phantom active scan')
 const nativeClear=global.clearTimeout
 global.clearTimeout=timer=>{nativeClear(timer);throw Error(timerText)}
 try {
  await assert.rejects(coordinator.mutate('clear-writer',async()=>{throw Error('must not start task after timer cleanup failure')}),/StatusCoordinator.clearWriteWaitTimer.*Timer requires/)
  await assert.rejects(scan.scan('repo','清理失败',async()=>7),/StatusCoordinator.clearSlowScanTimer.*Timer requires/)
 } finally {global.clearTimeout=nativeClear}
 assert.equal(coordinator.isWriting('clear-writer'),false)
 assert.equal(await scan.scan('repo','清理后重试',async()=>9),9)
 const admission=new StatusCoordinator({writeWaitMs:5});let release,entered=false
 const read=admission.read('locked',()=>new Promise(resolve=>{release=resolve}));await tick()
 await assert.rejects(admission.mutate('locked',async()=>{entered=true}),/状态读取未结束/);assert.equal(entered,false)
 release();await read;await admission.mutate('locked',async()=>{entered=true});assert.equal(entered,true)
 delete global.Thread
 await assert.rejects(execution.localImportStep('unsupported-runtime',async()=>{throw Error(timerText)}),/Thread=unavailable.*Timer requires/)
 console.log('PASS injected Photos/loadFilePath/write-wait/refresh/cleanup errors retain distinct phases (photo candidate errors privacy-safe); explicit Thread API invocation, scan rejection/retry and metadata timer attribution')
 console.log('LIMIT: no native Timer/Photos fix or folder UI success is inferred from these mocks')
}
mainTest().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{global.setTimeout=nativeTimeout;delete global.Thread})
