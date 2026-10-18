/* Disposable native-file simulation: no real Photos, user files, or remote I/O. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {load,ui,mount,all,tick,deferred}=require('./remoteFiles.test.cjs')
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-batch-')),work=tmp+'/work',library=tmp+'/library',exportsDir=tmp+'/exports'
for(const p of [work,library,exportsDir])fs.mkdirSync(p)
let root=work,copyCount=0,exportCount=0,peak=0,cleanupFail='',selectedDocs=[],selectedPhotos=[],pickerCalls=[],writeAllowed=true,locks=0,refreshes=0,refreshFailure=false
const failSources=new Set(),originals=new Map()
global.Thread={isMainThread:true}
global.FileManager={
 isLink:async p=>{try{return fs.lstatSync(p).isSymbolicLink()}catch{return false}},
 exists:async p=>fs.existsSync(p),isFile:async p=>fs.statSync(p).isFile(),isDirectory:async p=>fs.statSync(p).isDirectory(),
 stat:async p=>{const s=fs.statSync(p);return {size:s.size,creationDate:s.birthtimeMs,modificationDate:s.mtimeMs}},
 readDirectory:async p=>fs.readdirSync(p),
 copyFile:async(s,d)=>{copyCount++;if(failSources.has(s))throw Error('copy failed '+s);fs.copyFileSync(s,d,fs.constants.COPYFILE_EXCL)},
 remove:async p=>{if(p===cleanupFail)throw Error('cleanup failed '+p);fs.unlinkSync(p)},
 readAsData(){throw Error('must not whole-file read into JS')},writeAsData(){throw Error('must not reencode/write data')},
}
global.DocumentPicker={pickFiles:async opts=>{pickerCalls.push(opts);return selectedDocs}}
global.Photos={pick:async opts=>{pickerCalls.push(opts);return selectedPhotos}}
global.PHPickerFilter={images:()=> 'images'}
global.ImageIO={readMetadata:async()=>({pixelWidth:100})}
const execution=load('services/localImportExecution.ts')
const picker=load('services/localFileImport.ts',{'./localImportExecution':execution})
const internal=load('services/git/localFileService.ts',{'../repoStore':{resolveWorkdir:()=>root},'../localImportExecution':execution})
const {localImportBatchSummary:summary}=load('services/localImportBatchSummary.ts')
const {StatusCoordinator}=load('utils/statusCoordinator.ts'),coordinator=new StatusCoordinator()
const guard=()=>{if(!writeAllowed)throw Error('state changed')}
async function batch(sources){locks++;return coordinator.mutate('repo',()=>internal.importLocalFilesInternal('repo',sources,work,guard))}
function doc(name,bytes,folder='doc'){const dir=library+'/'+folder;fs.mkdirSync(dir,{recursive:true});const p=dir+'/'+name;fs.writeFileSync(p,Buffer.from(bytes));originals.set(p,Buffer.from(bytes));return p}
function photo(name,bytes,{fail=false,cleanup=false}={}){
 const original=doc(name,bytes,'photo-'+originals.size)
 return {itemProvider:{registeredTypes:['com.private.metadata',name.toLowerCase().endsWith('.heic')?'public.heic':'public.image'],hasRepresentationConforming:type=>type==='public.heic'||type==='public.image',async loadFilePath(){
  exportCount++;if(fail)throw Error('native failed '+original)
  const dest=exportsDir+'/'+name;fs.copyFileSync(original,dest);if(cleanup)cleanupFail=dest
  peak=Math.max(peak,fs.readdirSync(exportsDir).filter(n=>exportsDir+'/'+n!==cleanupFail).length)
  return dest
 },loadData(){throw Error('must not load Data')},loadUIImage(){throw Error('must not UIImage transcode')}}}
}
async function testAdaptersAndBatch(){
 assert.deepEqual(await picker.pickLocalDocuments(),[]);assert.deepEqual(await picker.pickLocalPhotos(),[]);assert.equal(copyCount,0)
 selectedDocs=[doc('one.bin',[0,255,1]),doc('same.bin',[1,2,3],'first'),doc('same.bin',[4,5,6],'second'),doc('failed.bin',[9]),doc('later.bin',[128,0])]
 failSources.add(selectedDocs[3]);const sources=await picker.pickLocalDocuments();assert.deepEqual(pickerCalls.at(-1),{allowsMultipleSelection:true,shouldShowFileExtensions:true});assert.equal(copyCount,0)
 const before=coordinator.revision('repo'),result=await batch(sources)
 assert.deepEqual(result.entries.map(e=>e.status),['success','success','skipped','failed','success']);assert.equal(coordinator.revision('repo')-before,2,'one begin/end write barrier for all items')
 assert.deepEqual(fs.readFileSync(work+'/one.bin'),Buffer.from([0,255,1]));assert.deepEqual(fs.readFileSync(work+'/same.bin'),Buffer.from([1,2,3]));assert.ok(fs.existsSync(work+'/later.bin'))
 assert.match(summary(result),/^部分文件未导入\n/);assert.ok(!/成功\d|批量导入结果|\d\//.test(summary(result)),'no success statistics');assert.ok(!summary(result).includes(tmp));assert.equal(summary({entries:[{name:'a',status:'success'},{name:'b',status:'success'}]}),'','all success: no prompt')
 const again=await batch([sources[0]]);assert.match(summary(again),/^未导入任何文件\n/);assert.ok(!/成功0|跳过1\//.test(summary(again)))
 selectedPhotos=[photo('bad.HEIC',[0],{fail:true}),photo('camera.HEIC',[0,255,128],{cleanup:true}),photo('camera.jpeg',[255,216,0]),photo('camera.jpeg',[3,4]),photo('after.png',[1,2])]
 const beforeExports=exportCount,photos=await picker.pickLocalPhotos();assert.deepEqual(pickerCalls.at(-1),{filter:'images',limit:50});assert.equal(exportCount,beforeExports,'selection is lazy: zero exported copies yet')
 const photoResult=await batch(photos);assert.deepEqual(photoResult.entries.map(e=>e.status),['failed','success','success','skipped','success']);assert.equal(photoResult.entries[1].cleanupFailed,true);assert.match(summary(photoResult),/清理失败/);assert.ok(!/成功3/.test(summary(photoResult)));assert.ok(!summary(photoResult).includes(tmp))
 assert.deepEqual(fs.readFileSync(work+'/camera.HEIC'),Buffer.from([0,255,128]));assert.equal(peak,1,'only one live export at a time, excluding the explicitly failed native cleanup');assert.deepEqual(fs.readdirSync(exportsDir),['camera.HEIC'])
 for(const [p,bytes]of originals)assert.deepEqual(fs.readFileSync(p),bytes,'picker originals remain untouched')
 cleanupFail='';fs.unlinkSync(exportsDir+'/camera.HEIC')
 // A failed candidate's native cleanup is reported too, not just successful exports.
 selectedPhotos=[photo('no-extension',[1],{cleanup:true}),photo('after-candidate-cleanup.jpg',[2])]
 const candidateCleanup=await batch(await picker.pickLocalPhotos());assert.equal(candidateCleanup.entries[0].status,'failed');assert.equal(candidateCleanup.entries[0].cleanupFailed,true);assert.equal(candidateCleanup.entries[1].status,'success');assert.match(summary(candidateCleanup),/临时副本清理失败/);cleanupFail='';fs.unlinkSync(exportsDir+'/no-extension')
 // Change merge/alive state during the last awaited source stat: recheck BEFORE native write.
 const blocked=doc('blocked.bin',[1]),later=doc('not-acquired.bin',[2]);let acquired=0,statCalls=0
 const stat=FileManager.stat;FileManager.stat=async p=>{const r=await stat(p);if(p===blocked&&++statCalls===2)writeAllowed=false;return r}
 try{const stopped=await batch([{name:'blocked.bin',acquire:async()=>({sourcePath:blocked,name:'blocked.bin',release:async()=>{}})},{name:'not-acquired.bin',acquire:async()=>{acquired++;return {sourcePath:later,name:'not-acquired.bin',release:async()=>{}}}}]);assert.deepEqual(stopped.entries.map(e=>e.status),['failed','skipped']);assert.equal(acquired,0);assert.ok(!fs.existsSync(work+'/blocked.bin'))}finally{FileManager.stat=stat;writeAllowed=true}
 // Workspace switch after export: release acquired copy, don't export the rest.
 let stateReleases=0,otherAcquires=0
 const switched=await batch([{name:'switch.bin',async acquire(){root=tmp+'/other-work';return {sourcePath:later,name:'switch.bin',release:async()=>{stateReleases++}}}},{name:'unvisited',async acquire(){otherAcquires++;throw Error('must not acquire')}}]);root=work
 assert.deepEqual(switched.entries.map(e=>e.status),['skipped','skipped']);assert.equal(stateReleases,1);assert.equal(otherAcquires,0)
 // A main-queue callback may be delivered much later than preflight completed.
 let main=false,callbacks=[],copyQueued=false,settled=false
 const step=execution.localImportStep
 global.Thread={get isMainThread(){return main},runInMain(fn){callbacks.push(fn)}}
 execution.localImportStep=(phase,task)=>{if(phase==='批量.原生文件复制')copyQueued=true;return step(phase,task)}
 const delayed=batch([{name:'delayed-block.bin',acquire:async()=>({sourcePath:later,name:'delayed-block.bin',release:async()=>{}})}]);delayed.finally(()=>{settled=true})
 try{
  for(let i=0;i<200&&!copyQueued;i++){await tick();if(!copyQueued&&callbacks.length){main=true;try{callbacks.shift()()}finally{main=false}}}
  assert.equal(copyQueued,true);writeAllowed=false
  for(let i=0;i<200&&!settled;i++){await tick();for(const callback of callbacks.splice(0)){main=true;try{callback()}finally{main=false}}}
  const delayedResult=await delayed;assert.equal(delayedResult.entries[0].status,'failed');assert.ok(!fs.existsSync(work+'/delayed-block.bin'))
 }finally{execution.localImportStep=step;global.Thread={isMainThread:true};writeAllowed=true}
 const gate=deferred(),reader=coordinator.read('repo',()=>gate.promise);let exportsStarted=0
 const pending=batch([{name:'wait.bin',acquire:async()=>{exportsStarted++;return {sourcePath:later,name:'wait.bin',release:async()=>{}}}}]);await tick();assert.equal(exportsStarted,0);await assert.rejects(batch([]),/写|操作/);gate.resolve();await reader;await pending
}
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
async function testUI(){
 const FilesTab=load('pages/FilesTab.tsx',{
  scripting:ui, '../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},'../constants/colors':{}, '../utils/fileTree':load('utils/fileTree.ts'),'../utils/fileListPerformance':load('utils/fileListPerformance.ts'),'../utils/format':{formatBytes:String,formatDate:String},
  '../services/localImportExecution':execution,'../services/localFileImport':picker,'../services/localImportBatchSummary':{localImportBatchSummary:summary},'../services/repoStore':{resolveWorkdir:()=>root},
  '../services/gitService':{importLocalWorktreeFiles:async(_,sources,expectedRoot,canWrite)=>{locks++;assert.equal(expectedRoot,work);return coordinator.mutate('repo',()=>internal.importLocalFilesInternal('repo',sources,work,canWrite))}},
 }).FilesTab
 const props={files:[],changes:[],bookmarkName:'repo',loading:false,mergeInProgress:false,onCreateEntry(){},onWorktreeChanged:async()=>{refreshes++;if(refreshFailure)throw Error('refresh denied')},onOpen(){},onPush(){},onRestore(){}}
 const h=mount(FilesTab,props,{effectUpdates:true});const button=t=>{h.render();return all(h.tree.props.header).find(n=>n.type==='Button'&&n.props.title===t)}
 async function settle(){for(let i=0;i<200;i++){await tick();h.render();if(!all(h.tree.props.header).find(n=>n.type==='Menu').props.disabled)return}throw Error('UI busy did not settle')}
 selectedDocs=[doc('ui-a.bin',[0,255]),doc('ui-b.bin',[3,4])];let before=locks;button('导入文件').props.action();h.render();await settle();assert.equal(locks-before,1);assert.equal(refreshes,1);assert.doesNotMatch(JSON.stringify(h.tree),/成功\d|批量导入结果|未导入任何文件/,'all-success shows no prompt')
 selectedDocs=[];before=locks;button('导入文件').props.action();h.render();await settle();assert.equal(locks,before);assert.equal(refreshes,1,'cancel does not write/refresh')
 selectedPhotos=[photo('ui-photo.HEIC',[8,9]),photo('ui-next.jpg',[4,5])];const gate=deferred(),originalLoad=selectedPhotos[0].itemProvider.loadFilePath;selectedPhotos[0].itemProvider.loadFilePath=async()=>{await gate.promise;return originalLoad()}
 button('导入图片').props.action();h.render();await tick();assert.equal(button('导入文件').props.disabled,true,'busy includes export');const exportingLocks=locks;button('导入文件').props.action();h.render();assert.equal(locks,exportingLocks);gate.resolve();await settle();assert.equal(refreshes,2);assert.doesNotMatch(JSON.stringify(h.tree),/成功\d|批量导入结果|未导入任何文件/,'all-success shows no prompt')
 refreshFailure=true;selectedDocs=[doc('refresh-once.bin',[3])];button('导入文件').props.action();h.render();await settle();assert.equal(refreshes,3,'refresh failure is not retried');assert.doesNotMatch(JSON.stringify(h.tree),/成功\d|批量导入结果/);assert.match(JSON.stringify(h.tree),/refresh denied/);refreshFailure=false
 // Busy lasts through cleanup; a cleanup error never causes a second copy.
 selectedPhotos=[photo('cleanup-ui.jpg',[1,255])];const cleanupGate=deferred(),remove=FileManager.remove;let cleanupEntered=false
 FileManager.remove=async p=>{if(p.endsWith('/cleanup-ui.jpg')){cleanupEntered=true;await cleanupGate.promise;throw Error('native cleanup failed private path')}return remove(p)}
 button('导入图片').props.action();h.render();for(let i=0;i<100&&!cleanupEntered;i++)await tick();assert.equal(cleanupEntered,true);assert.equal(button('导入文件').props.disabled,true);const copiesAfterWrite=copyCount;cleanupGate.resolve();await settle();FileManager.remove=remove;assert.equal(copyCount,copiesAfterWrite);assert.match(JSON.stringify(h.tree),/临时副本清理失败/)
 selectedPhotos=[photo('merge-blocked.HEIC',[1]),photo('merge-unvisited.jpg',[2])];const mergeGate=deferred(),nativeLoad=selectedPhotos[0].itemProvider.loadFilePath;selectedPhotos[0].itemProvider.loadFilePath=async()=>{await mergeGate.promise;return nativeLoad()};const exportBefore=exportCount;button('导入图片').props.action();h.render();await tick();props.mergeInProgress=true;h.render();mergeGate.resolve();for(let i=0;i<100;i++){await tick();h.render()};assert.ok(!fs.existsSync(work+'/merge-blocked.HEIC'));assert.equal(exportCount-exportBefore,1);assert.ok(!fs.existsSync(exportsDir+'/merge-blocked.HEIC'));assert.match(JSON.stringify(h.tree),/未导入任何文件/);h.unmount()
 // Unmount after export begins: acquired copy cleaned, no later source exported.
 const detachedProps={...props,mergeInProgress:false},detached=mount(FilesTab,detachedProps,{effectUpdates:true})
 selectedPhotos=[photo('unmount-blocked.HEIC',[1]),photo('unmount-next.jpg',[2])];const unmountGate=deferred(),unmountLoad=selectedPhotos[0].itemProvider.loadFilePath;selectedPhotos[0].itemProvider.loadFilePath=async()=>{await unmountGate.promise;return unmountLoad()}
 all(detached.tree.props.header).find(n=>n.type==='Button'&&n.props.title==='导入图片').props.action();detached.render();await tick();const unmountExports=exportCount;detached.unmount();unmountGate.resolve();for(let i=0;i<100;i++)await tick();assert.equal(exportCount-unmountExports,1);assert.ok(!fs.existsSync(work+'/unmount-blocked.HEIC'));assert.ok(!fs.existsSync(exportsDir+'/unmount-blocked.HEIC'));assert.equal(detached.lateWrites,0)

}
async function main(){await testAdaptersAndBatch();await testUI();console.log('PASS batch file/photo exact multi-select parameters, lazy serial HEIC/native byte copies, duplicate/exists skips, failure continuation, cleanup warnings, no original removal, one lock/refresh, cancellation and merge-before-write guard; no JS payload reads');console.log('LIMIT picker UI, iCloud exports and native decoder behavior need device verification')}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{delete global.Thread;fs.rmSync(tmp,{recursive:true,force:true})})
