/* Real service classification + real native-preview view wiring, native decoder modeled. */
const assert=require('node:assert/strict')
const {load,mount,ui,all,tick,deferred}=require('./remoteFiles.test.cjs')
function viewportNodes(h){const geometry=all(h.tree).find(n=>n.type==='GeometryReader');return geometry?all(geometry.children[0]({size:{width:320,height:520}})):all(h.tree)}
const execution=load('services/localImportExecution.ts')
let bytesReads=0,writes=0,decodes=[],thumbs=[],fail='',changed=false
const files=new Map(),links=new Set()
const root='/authorized/work'
global.FileManager={
 isLink:async p=>links.has(p),exists:async p=>files.has(p)||p===root,
 isDirectory:async p=>p===root,isFile:async p=>files.has(p),readDirectory:async()=>[],
 stat:async p=>({size:files.get(p)?.size||0,modificationDate:changed?2:1}),
 readAsData:async()=>{bytesReads++;throw Error('image/big binary must not enter whole-file JS read')},
 writeAsData:async()=>{writes++;throw Error('preview must not write')},
 remove:async p=>files.delete(p),
}
global.UIImage={fromFile:p=>{decodes.push(p);if(fail==='throw')throw Error('native decode failed');if(fail==='decode')return null;return {preparingThumbnail:size=>{thumbs.push(size);if(fail==='thumb')return null;if(fail==='change')changed=true;return {native:true,width:size.width,height:size.height}}}}}
const service=load('services/git/localFileService.ts',{'../repoStore':{resolveWorkdir:()=>root},'../localImportExecution':execution})
let opened=[],readFailure=false,gate=null
const page=load('components/LocalImagePreview.tsx',{'../utils/localImageZoom':load('utils/localImageZoom.ts'),scripting:ui,'../services/localImportExecution':execution,'../services/gitService':{openLocalWorktreeFile:async(_,path)=>{opened.push(path);if(gate)await gate.promise;if(readFailure)throw Error('reopen failed');return service.readLocalFileForOpenInternal('repo',path)}}}).LocalImagePreview
async function main(){
 for(const name of ['camera.HEIC','camera.heic','camera.HeIf','camera.HEIF','photo.PNG','photo.JPEG','photo.jpg','small.png']){
  files.set(root+'/'+name,{size:name==='small.png'?15:3*1024*1024})
  const file=await service.readLocalFileInternal('repo',name)
  assert.equal(file.text,null);assert.equal(file.image,true);assert.ok(!file.readOnlyReason.includes('512'));assert.equal(file.version.bytes,undefined)
  const opened=await service.readLocalFileForOpenInternal('repo',name);assert.equal(opened.previewImage.native,true)
  assert.deepEqual(thumbs.at(-1),{width:1600,height:1600});assert.equal(decodes.at(-1),root+'/'+name)
  await assert.rejects(service.saveLocalFileInternal('repo',opened,'edit'),/只读/)
 }
 files.set(root+'/large.bin',{size:1024*1024});const binary=await service.readLocalFileForOpenInternal('repo','large.bin');assert.equal(binary.image,undefined);assert.equal(binary.text,null);assert.match(binary.readOnlyReason,/512 KiB/)
 for(const failure of ['decode','thumb','throw']){fail=failure;await assert.rejects(service.readLocalFileForOpenInternal('repo','camera.HEIC'),/图片|native decode failed/)}
 fail='change';await assert.rejects(service.readLocalFileForOpenInternal('repo','camera.HEIC'),/修改|变化/);fail='';changed=false
 for(const path of ['../camera.HEIC','.git/a.HEIC','folder/../camera.HEIC'])await assert.rejects(service.readLocalFileForOpenInternal('repo',path),/路径/)
 links.add(root+'/camera.HEIC');await assert.rejects(service.readLocalFileForOpenInternal('repo','camera.HEIC'),/符号链接/);links.clear()
 assert.equal(bytesReads,0);assert.equal(writes,0)
 const file=await service.readLocalFileForOpenInternal('repo','camera.HEIC');let closes=0,reloaded=[]
 const h=mount(page,{bookmarkName:'repo',file,onReload:f=>reloaded.push(f)})
 const bar=()=>{h.render();return all(h.tree).find(n=>n.type==='VStack').props.toolbar}
 assert.equal(viewportNodes(h).find(n=>n.type==='Image').props.image,file.previewImage)
 assert.ok(!all(h.tree).some(n=>n.type==='LocalCodeEditor'||n.type==='WebView'))
 await bar().topBarTrailing.props.action();assert.equal(reloaded.length,1);assert.ok(reloaded[0].previewImage)
 readFailure=true;await bar().topBarTrailing.props.action();h.render();assert.match(JSON.stringify(h.tree),/图片刷新失败/);assert.equal(reloaded.length,1);assert.equal(viewportNodes(h).find(n=>n.type==='Image').props.image,file.previewImage);readFailure=false
 assert.equal(h.tree.type,'VStack');assert.equal(bar().topBarLeading,undefined,'retain the system navigation back button, no custom override');assert.equal(h.tree.props.navigationBarBackButtonHidden,false);assert.ok(!JSON.stringify(h.tree).includes('显示缩略图'));assert.ok(!JSON.stringify(h.tree).includes('图片只读'))
 gate=deferred();const loading=bar().topBarTrailing.props.action();await tick();await bar().topBarTrailing.props.action();assert.equal(opened.length,3,'duplicate refresh locked');h.unmount();gate.resolve();await loading;assert.equal(h.lateWrites,0);assert.equal(reloaded.length,1)
 const absent=mount(page,{bookmarkName:'repo',file:{...file,previewImage:undefined},onClose(){},onReload(){}});assert.match(JSON.stringify(absent.tree),/图片预览不可用/);absent.unmount()
 assert.ok(!all(h.tree).some(n=>n.type==='NavigationStack'));assert.equal(h.tree.props.gesture,undefined);assert.equal(h.tree.props.simultaneousGesture,undefined)
 const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../pages/FilesTab.tsx'),'utf8');assert.ok(!source.includes('pickerStatus'));assert.ok(source.includes('pickLocalDirectory()'));assert.ok(source.includes('dragTrace'))
 assert.equal(bytesReads,0);assert.equal(writes,0)
 console.log('PASS case-insensitive HEIC/HEIF/PNG/JPEG before text size check, native path thumbnail, no JS Data/base64/write; safety/read-only/version checks; refresh/lock/failure/close/unmount view wiring')
 console.log('LIMIT native HEIC/HEIF decoding and device rendering remain unverified; no private photo input used')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{delete global.UIImage})
