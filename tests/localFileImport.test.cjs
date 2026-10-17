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
function photo(types,path){return {itemProvider:{registeredTypes:types,loadFilePath:async type=>{calls.push(['representation',type]);return path},loadUIImage:()=>{throw Error('must not transcode')},loadData:()=>{throw Error('must not load entire photo into JS')}}}}
async function main(){
 const progress=[];assert.equal(await pickLocalDirectory(message=>progress.push(message)),null);assert.match(progress.at(-1),/返回0项/);directory='/selected/Whole Folder/';const folder=await pickLocalDirectory(message=>progress.push(message));assert.match(progress.at(-1),/返回类型=目录/);assert.ok(progress.every(message=>!message.includes('/selected/')));assert.equal(folder.name,'Whole Folder');assert.equal(folder.sourcePath,'/selected/Whole Folder');await folder.release();assert.deepEqual(removed,[]);assert.deepEqual(bookmarks,[])
 assert.deepEqual(calls.find(c=>c[1]?.types)[1],{types:['public.folder'],allowsMultipleSelection:false,shouldShowFileExtensions:true})
 directory='/selected/not-a-folder.txt';await assert.rejects(pickLocalDirectory(message=>progress.push(message)),/未返回目录/);assert.match(progress.at(-1),/非目录/);assert.deepEqual(bookmarks,[])
 assert.equal(await pickLocalDocument(),null);assert.equal(await pickLocalPhoto(),null)
 documents=['/selected/原文件.ZIP'];let selected=await pickLocalDocument();assert.equal(selected.sourcePath,documents[0]);assert.equal(selected.name,'原文件.ZIP');await selected.release();assert.deepEqual(removed,[])
 assert.deepEqual(calls.find(c=>c[0]==='files'&&!c[1].types)[1],{allowsMultipleSelection:false,shouldShowFileExtensions:true})
 documents=['/selected/a','/selected/b'];await assert.rejects(pickLocalDocument(),/一次选择一个/)
 photos=[photo(['public.heic','public.image'],'/export/IMG_1234.HEIC')];selected=await pickLocalPhoto();assert.equal(selected.name,'IMG_1234.HEIC');assert.equal(selected.sourcePath,'/export/IMG_1234.HEIC');assert.deepEqual(calls.find(c=>c[0]==='photos')[1],{filter:'IMAGE_FILTER',limit:1});await selected.release();assert.deepEqual(removed,['/export/IMG_1234.HEIC'])
 photos=[photo(['public.png','public.image'],'/export/opaque-name')];selected=await pickLocalPhoto();assert.match(selected.name,/^image-.*\.png$/);assert.equal(selected.sourcePath,'/export/opaque-name');await selected.release()
 photos=[photo(['public.heic','public.jpeg'],'/export/wrong.jpg')];selected=await pickLocalPhoto();assert.match(selected.name,/\.heic$/);assert.equal(calls.filter(c=>c[0]==='representation').at(-1)[1],'public.heic')
 photos=[photo(['public.camera-raw-image','public.jpeg'],'/export/RAW.NEF')];const before=calls.length;await assert.rejects(pickLocalPhoto(),/原格式.*导入文件/);assert.equal(calls.slice(before).some(c=>c[0]==='representation'),false)
 photos=[photo(['public.image'],null)];await assert.rejects(pickLocalPhoto(),/原格式/)
 photos=[photo(['public.jpeg'],null)];await assert.rejects(pickLocalPhoto(),/无法取得/)
 console.log('PASS document/photo cancellation, exact authorized filename, native file representation, HEIC fidelity, format-correct generated name, no UIImage/Data/transcoding and only owned-temp cleanup')
}
main().catch(error=>{console.error(error);process.exitCode=1})
