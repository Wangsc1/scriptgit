/* Official picker adapters: mock authorized path results, never user Photos/Files. */
const assert=require('node:assert/strict')
const {load}=require('./remoteFiles.test.cjs')

let directory=null,documents=[],photos=[],calls=[],removed=[],bookmarks=[]
global.DocumentPicker={pickDirectoryBookmark:async()=>{throw Error('must use explicit public.folder filter')},pickDirectory:async()=>{throw Error('must use explicit public.folder filter')},pickFiles:async options=>{calls.push(['files',options]);return options.types?.[0]==='public.folder'?(directory?[directory]:[]):documents}}
global.Photos={pick:async options=>{calls.push(['photos',options]);return photos}}
global.PHPickerFilter={images:()=> 'IMAGE_FILTER'}
global.FileManager={isLink:async()=>false,isFile:async()=>true,appGroupDocumentsDirectory:'/app',isDirectory:async p=>p.startsWith('/selected/Whole Folder'),removeFileBookmark:name=>bookmarks.push(name),remove:async p=>removed.push(p)}
const execution=load('services/localImportExecution.ts')
const {pickLocalDirectory,pickLocalDocument,pickLocalPhoto}=load('services/localFileImport.ts',{'./localImportExecution':execution})
global.ImageIO={readMetadata:async path=>{calls.push(['metadata',path]);if(path.endsWith('.mov')||path.endsWith('.plist'))throw Error('not image');return {pixelWidth:100}}}
function photo(types,path){return {itemProvider:{registeredTypes:types,hasRepresentationConforming:type=>types.includes(type),loadFilePath:async type=>{calls.push(['representation',type]);return path},loadUIImage:()=>{throw Error('must not transcode')},loadData:()=>{throw Error('must not load entire photo into JS')}}}}
async function main(){
 const progress=[];assert.equal(await pickLocalDirectory(message=>progress.push(message)),null);assert.match(progress.at(-1),/返回0项/);directory='/selected/Whole Folder/';const folder=await pickLocalDirectory(message=>progress.push(message));assert.match(progress.at(-1),/返回类型=目录/);assert.ok(progress.every(message=>!message.includes('/selected/')));assert.equal(folder.name,'Whole Folder');assert.equal(folder.sourcePath,'/selected/Whole Folder');await folder.release();assert.deepEqual(removed,[]);assert.deepEqual(bookmarks,[])
 assert.deepEqual(calls.find(c=>c[1]?.types)[1],{types:['public.folder'],allowsMultipleSelection:false,shouldShowFileExtensions:true})
 directory='/selected/not-a-folder.txt';await assert.rejects(pickLocalDirectory(message=>progress.push(message)),/未返回目录/);assert.match(progress.at(-1),/非目录/);assert.deepEqual(bookmarks,[])
 assert.equal(await pickLocalDocument(),null);assert.equal(await pickLocalPhoto(),null)
 documents=['/selected/原文件.ZIP'];let selected=await pickLocalDocument();assert.equal(selected.sourcePath,documents[0]);assert.equal(selected.name,'原文件.ZIP');await selected.release();assert.deepEqual(removed,[])
 assert.deepEqual(calls.find(c=>c[0]==='files'&&!c[1].types)[1],{allowsMultipleSelection:false,shouldShowFileExtensions:true})
 documents=['/selected/a','/selected/b'];await assert.rejects(pickLocalDocument(),/一次选择一个/)
 photos=[photo(['public.heic','public.image'],'/export/IMG_1234.HEIC')];selected=await pickLocalPhoto();assert.equal(selected.name,'IMG_1234.HEIC');assert.equal(selected.sourcePath,'/export/IMG_1234.HEIC');assert.deepEqual(calls.find(c=>c[0]==='photos')[1],{filter:'IMAGE_FILTER',limit:1});await selected.release();assert.deepEqual(removed,['/export/IMG_1234.HEIC'])
 // Filename, not requested UTI, describes the system-exported file.
 photos=[photo(['public.heic','public.jpeg'],'/export/compatible.jpg')];selected=await pickLocalPhoto();assert.equal(selected.name,'compatible.jpg');await selected.release()
 for(const [types,path] of [
  [['public.jpeg'],'/export/camera.JPG'],
  [['public.camera-raw-image','public.jpeg'],'/export/RAW.DNG'],
  [['com.private.metadata','public.heic'],'/export/photo.HEIC'],
  [['dyn.actual-format'],'/export/sensor.RAWX'],
  [['public.image'],'/export/generic.heic'],
  [['public.jpeg'],'/export/system-only-jpeg.jpeg'],
 ]){
  photos=[photo(types,path)];selected=await pickLocalPhoto();assert.equal(selected.name,path.split('/').pop());assert.equal(selected.sourcePath,path);await selected.release();const count=removed.length;await selected.release();assert.equal(removed.length,count,'release is idempotent')
 }
 photos=[photo(['public.png'],'/export/no-suffix')];await assert.rejects(pickLocalPhoto(),/registeredTypes=.*public.png.*文件名\/扩展名缺失/);assert.ok(removed.includes('/export/no-suffix'))
 photos=[photo(['public.image'],null)];await assert.rejects(pickLocalPhoto(),/registeredTypes=.*public.image.*loadFilePath=null/)
 photos=[photo(['com.private.metadata','dyn.image'],'/export/unused')]
 photos[0].itemProvider.loadFilePath=async type=>{calls.push(['representation',type]);return type==='com.private.metadata'?'/export/metadata.plist':'/export/real.HEIC'}
 selected=await pickLocalPhoto();assert.equal(selected.name,'real.HEIC');assert.ok(removed.includes('/export/metadata.plist'));assert.ok(!removed.includes('/export/real.HEIC'));await selected.release()
 // Failed native candidate falls through without leaking error paths/names.
 photos=[photo(['public.heic','public.image'],'/export/fallback.jpg')]
 photos[0].itemProvider.loadFilePath=async type=>{if(type==='public.heic')throw Error('private /secret/photo.heic');return '/export/fallback.jpg'}
 selected=await pickLocalPhoto();assert.equal(selected.name,'fallback.jpg');await selected.release()
 photos=[photo(['dyn.bad'],'/export/clip.mov')];await assert.rejects(pickLocalPhoto(),e=>{assert.match(e.message,/dyn.bad:ImageIO.readMetadata异常/);assert.ok(!e.message.includes('/export/'));return true});assert.ok(removed.includes('/export/clip.mov'))
 photos=[{itemProvider:{get registeredTypes(){throw Error('/private/asset')}}}];await assert.rejects(pickLocalPhoto(),/itemProvider\/registeredTypes读取失败/)
 photos=[photo(['public.jpeg'],null)];photos[0].itemProvider.hasRepresentationConforming=()=>{throw Error('native check')};await assert.rejects(pickLocalPhoto(),/hasRepresentationConforming异常/)
 // Failure cleanup is attempted before fallback; cleanup failures are explicit,
 // not hidden by another candidate or a successful write.
 photos=[photo(['dyn.bad'],'/export/no-extension-cleanup')]
 const remove=FileManager.remove;FileManager.remove=async()=>{throw Error('/private/cleanup-target')}
 try{await assert.rejects(pickLocalPhoto(),e=>{assert.match(e.message,/临时副本清理失败/);assert.ok(!e.message.includes('/private/'));return true})}finally{FileManager.remove=remove}
 photos=[photo(['public.jpeg'],'/export/safe.JPG')];selected=await pickLocalPhoto()
 let attempts=0;FileManager.remove=async p=>{attempts++;if(attempts===1)throw Error('temporary failure');removed.push(p)}
 try{await assert.rejects(selected.release(),/temporary failure/);await selected.release();assert.equal(attempts,2)}finally{FileManager.remove=remove}
 photos=[];assert.equal(await pickLocalPhoto(),null)
 console.log('PASS system-exported HEIC/JPEG/RAW/dynamic/generic image files, metadata-first list, strict capability check, candidate fallback/native failure, unknown suffix rejection, cancellation, no UIImage/Data/transcoding and owned failed/success copy cleanup')
}
main().catch(error=>{console.error(error);process.exitCode=1})
