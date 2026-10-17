/* Real service classification + real native-preview view wiring, native decoder modeled. */
const assert=require('node:assert/strict')
const {load,mount,ui,all,tick,deferred}=require('./remoteFiles.test.cjs')
function viewportNodes(h){return all(h.tree)}
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
global.UIImage={fromFile:p=>{decodes.push(p);if(fail==='throw')throw Error('native decode failed');if(fail==='decode')return null;return {preparingThumbnail:size=>{thumbs.push(size);if(fail==='thumb')return null;if(fail==='change')changed=true;return {native:true,width:size.width,height:size.height,toJPEGBase64String:q=>'THUMB'+q}}}}}
const service=load('services/git/localFileService.ts',{'../repoStore':{resolveWorkdir:()=>root},'../localImportExecution':execution})
let opened=[],readFailure=false,gate=null
const page=load('components/LocalImagePreview.tsx',{'./ImageViewer':{ImageViewer:'ImageViewer'},'../utils/localImageDisplay':load('utils/localImageDisplay.ts'),scripting:ui,'../services/localImportExecution':execution,'../services/gitService':{openLocalWorktreeFile:async(_,path)=>{opened.push(path);if(gate)await gate.promise;if(readFailure)throw Error('reopen failed');return service.readLocalFileForOpenInternal('repo',path)}}}).LocalImagePreview
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
 const h=mount(page,{bookmarkName:'repo',file,onClose(){},onReload:f=>reloaded.push(f)})
 const refreshButton=()=>{h.render();return all(h.tree).find(n=>n.type==='Button'&&/刷新/.test(n.props.title))},bar=()=>({topBarTrailing:refreshButton(),topBarLeading:{props:{title:'关闭'}}})
 const viewer=()=>all(h.tree).find(n=>n.type==='ImageViewer');assert.equal(viewer().props.url,'data:image/jpeg;base64,THUMB0.85');assert.equal(viewer().props.compactImage,true);assert.ok(!all(h.tree).some(n=>n.type==='Image'||n.type==='ScrollView'))
 assert.ok(!all(h.tree).some(n=>n.type==='LocalCodeEditor'||n.type==='WebView'))
 await bar().topBarTrailing.props.action();assert.equal(reloaded.length,1);assert.ok(reloaded[0].previewImage)
 readFailure=true;await bar().topBarTrailing.props.action();h.render();assert.match(JSON.stringify(h.tree),/图片刷新失败/);assert.equal(reloaded.length,1);assert.equal(viewer().props.url,'data:image/jpeg;base64,THUMB0.85');assert.equal(viewer().props.compactImage,true);assert.ok(!all(h.tree).some(n=>n.type==='Image'||n.type==='ScrollView'));readFailure=false
 assert.equal(h.tree.type,'ZStack');assert.ok(!JSON.stringify(h.tree).includes('显示缩略图'));assert.ok(!JSON.stringify(h.tree).includes('图片只读'))
 gate=deferred();const loading=bar().topBarTrailing.props.action();await tick();await bar().topBarTrailing.props.action();assert.equal(opened.length,3,'duplicate refresh locked');h.unmount();gate.resolve();await loading;assert.equal(h.lateWrites,0);assert.equal(reloaded.length,1)
 const absent=mount(page,{bookmarkName:'repo',file:{...file,previewImage:undefined},onClose(){},onReload(){}});assert.match(JSON.stringify(absent.tree),/图片预览不可用/);assert.ok(!all(absent.tree).some(n=>n.type==='ImageViewer'));absent.unmount()
 assert.equal(h.tree.props.gesture,undefined);assert.equal(h.tree.props.simultaneousGesture,undefined)
 const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../pages/FilesTab.tsx'),'utf8');assert.ok(!source.includes('pickerStatus'));assert.ok(source.includes('pickLocalDirectory()'));assert.ok(source.includes('dragTrace'))
 assert.equal(bytesReads,0);assert.equal(writes,0)
 // Display copy comes from the in-memory thumbnail object; failure/oversize are explicit and never fall back to source reads.
 const encoder=load('utils/localImageDisplay.ts'),encCalls=[]
 assert.deepEqual(encoder.localImageDisplayDataUrl({toJPEGBase64String:q=>(encCalls.push(q),'AA')}),{url:'data:image/jpeg;base64,AA'});assert.deepEqual(encCalls,[0.85])
 assert.match(encoder.localImageDisplayDataUrl({toJPEGBase64String:()=>null}).error,/无法编码/);assert.match(encoder.localImageDisplayDataUrl({}).error,/无法生成/);assert.match(encoder.localImageDisplayDataUrl({toJPEGBase64String:()=>{throw Error('x')}}).error,/无法编码/)
 const encQs=[];assert.match(encoder.localImageDisplayDataUrl({toJPEGBase64String:q=>(encQs.push(q),'A'.repeat(encoder.LOCAL_IMAGE_DATA_URL_MAX_CHARS))}).error,/过大/);assert.deepEqual(encQs,[0.85,0.6,0.4])
 assert.equal(encoder.localImageDisplayDataUrl({toJPEGBase64String:q=>q<0.5?'A':'A'.repeat(encoder.LOCAL_IMAGE_DATA_URL_MAX_CHARS)}).url.endsWith('base64,A'),true)
 const badEnc=mount(page,{bookmarkName:'repo',file:{...file,previewImage:{toJPEGBase64String:()=>null}},sessionId:7,onClose(){},onReload(){}});assert.match(JSON.stringify(badEnc.tree),/无法编码显示图片/);assert.ok(!all(badEnc.tree).some(n=>n.type==='ImageViewer'));badEnc.unmount()
 const sessEnc=mount(page,{bookmarkName:'repo',file,sessionId:9,onClose(){},onReload(){}});assert.equal(all(sessEnc.tree).find(n=>n.type==='ImageViewer').props.sessionId,9);sessEnc.unmount()
 console.log('PASS case-insensitive HEIC/HEIF/PNG/JPEG before text size check, native path thumbnail, no JS Data/base64/write; safety/read-only/version checks; refresh/lock/failure/close/unmount view wiring')
 console.log('LIMIT native HEIC/HEIF decoding and device rendering remain unverified; no private photo input used')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{delete global.UIImage})
