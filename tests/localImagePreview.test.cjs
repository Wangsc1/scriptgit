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
 readAsData:async p=>{bytesReads++;const f=files.get(p);if(f.readFailure)throw Error('read failed');if(f.mutate)changed=true;return {size:f.returnSize??f.size,toBase64String:()=>f.base64||'ORIGINAL_ALPHA_BYTES'}},
 writeAsData:async()=>{writes++;throw Error('preview must not write')},
 remove:async p=>files.delete(p),
}
global.UIImage={fromFile:p=>{decodes.push(p);if(fail==='throw')throw Error('native decode failed');if(fail==='decode')return null;return {preparingThumbnail:size=>{thumbs.push(size);if(fail==='thumb')return null;if(fail==='change')changed=true;return {native:true,width:size.width,height:size.height,toPNGBase64String:()=>'PNG',toJPEGBase64String:q=>'JPG'+q}}}}}
const service=load('services/git/localFileService.ts',{'../repoStore':{resolveWorkdir:()=>root},'../localImportExecution':execution})
let opened=[],readFailure=false,gate=null
const page=load('components/LocalImagePreview.tsx',{'./ImageViewer':{ImageViewer:'ImageViewer',LOCAL_IMAGE_BACKGROUND:{light:'#F7F9FA',dark:'#1C1C1E'}},'../utils/localImageDisplay':load('utils/localImageDisplay.ts'),scripting:ui,'../services/localImportExecution':execution,'../services/gitService':{openLocalWorktreeFile:async(_,path)=>{opened.push(path);if(gate)await gate.promise;if(readFailure)throw Error('reopen failed');return service.readLocalFileForOpenInternal('repo',path)}}}).LocalImagePreview
async function main(){
 for(const name of ['camera.HEIC','camera.heic','camera.HeIf','camera.HEIF','photo.PNG','photo.JPEG','photo.jpg','small.png']){
  files.set(root+'/'+name,{size:name==='small.png'?15:3*1024*1024})
  const file=await service.readLocalFileInternal('repo',name)
  assert.equal(file.text,null);assert.equal(file.image,true);assert.ok(!file.readOnlyReason.includes('512'));assert.equal(file.version.bytes,undefined)
  const before=bytesReads,beforeDecode=decodes.length
  const opened=await service.readLocalFileForOpenInternal('repo',name)
  if (/\.hei[cf]$/i.test(name)) {assert.equal(opened.previewImage.native,true);assert.deepEqual(thumbs.at(-1),{width:1600,height:1600});assert.equal(decodes.at(-1),root+'/'+name);assert.equal(bytesReads,before)}
  else {assert.match(opened.previewDataUrl,/^data:image\/(png|jpeg);base64,ORIGINAL_ALPHA_BYTES$/);assert.equal(opened.previewImage,undefined);assert.equal(decodes.length,beforeDecode);assert.equal(bytesReads,before+1)}
  await assert.rejects(service.saveLocalFileInternal('repo',opened,'edit'),/只读/)
 }
 files.set(root+'/large.bin',{size:1024*1024});const binary=await service.readLocalFileForOpenInternal('repo','large.bin');assert.equal(binary.image,undefined);assert.equal(binary.text,null);assert.match(binary.readOnlyReason,/512 KiB/)
 for(const failure of ['decode','thumb','throw']){fail=failure;await assert.rejects(service.readLocalFileForOpenInternal('repo','camera.HEIC'),/图片|native decode failed/)}
 fail='change';await assert.rejects(service.readLocalFileForOpenInternal('repo','camera.HEIC'),/修改|变化/);fail='';changed=false
 for(const path of ['../camera.HEIC','.git/a.HEIC','folder/../camera.HEIC'])await assert.rejects(service.readLocalFileForOpenInternal('repo',path),/路径/)
 links.add(root+'/camera.HEIC');await assert.rejects(service.readLocalFileForOpenInternal('repo','camera.HEIC'),/符号链接/);links.clear()
 assert.equal(writes,0)
 // Genuine 1x1 RGBA PNG fixture: the pixel alpha is zero. The service must
 // return EXACT source bytes, without invoking native decode or either encoder.
 {const zlib=require('node:zlib');function chunk(type,data){const name=Buffer.from(type),payload=Buffer.concat([name,data]);let crc=0xffffffff;for(const byte of payload){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}const len=Buffer.alloc(4),end=Buffer.alloc(4);len.writeUInt32BE(data.length);end.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([len,payload,end])}
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6 // RGBA
 const raw=Buffer.from([0,255,255,255,0]),idat=zlib.deflateSync(raw)
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))]);assert.equal(zlib.inflateSync(idat)[4],0)
 files.set(root+'/transparent.png',{size:png.length,base64:png.toString('base64')});const prior=decodes.length;const r=await service.readLocalFileForOpenInternal('repo','transparent.png');assert.deepEqual(Buffer.from(r.previewDataUrl.split(',')[1],'base64'),png);assert.equal(decodes.length,prior,'transparent source never enters UIImage')}
 // Bounded original-byte route: rejects before read, guards path/version and actual read size.
 for(const ext of ['png','gif','webp','bmp','ico','jpg','jpeg']){const name='direct.'+ext;files.set(root+'/'+name,{size:7,base64:'ALPHA_PAYLOAD'});const r=await service.readLocalFileForOpenInternal('repo',name);assert.ok(r.previewDataUrl.endsWith(',ALPHA_PAYLOAD'));assert.equal(r.previewImage,undefined)}
 files.set(root+'/limit.png',{size:service.LOCAL_BROWSER_IMAGE_LIMIT});assert.ok((await service.readLocalFileForOpenInternal('repo','limit.png')).previewDataUrl)
 const pre=bytesReads;files.set(root+'/over.png',{size:service.LOCAL_BROWSER_IMAGE_LIMIT+1});await assert.rejects(service.readLocalFileForOpenInternal('repo','over.png'),/8 MiB/);assert.equal(bytesReads,pre)
 for(const [name,extra,pattern]of [['changed.png',{mutate:true},/修改|变化/],['short.png',{returnSize:6},/大小已变化/],['unreadable.jpg',{readFailure:true},/read failed/]]){files.set(root+'/'+name,{size:7,...extra});await assert.rejects(service.readLocalFileForOpenInternal('repo',name),pattern);changed=false}
 links.add(root+'/direct.png');const readCount=bytesReads;await assert.rejects(service.readLocalFileForOpenInternal('repo','direct.png'),/符号链接/);assert.equal(bytesReads,readCount);links.clear()
 const direct=await service.readLocalFileForOpenInternal('repo','direct.png');const directView=mount(page,{file:direct,onClose(){}});assert.equal(all(directView.tree).find(n=>n.type==='ImageViewer').props.url,direct.previewDataUrl);directView.unmount()
 const file=await service.readLocalFileForOpenInternal('repo','camera.HEIC');let closes=0,reloaded=[]
 let closed=0;const h=mount(page,{file,sessionId:5,onClose(){closed++}})
 const viewer=()=>all(h.tree).find(n=>n.type==='ImageViewer');assert.equal(viewer().props.url,'data:image/png;base64,PNG');assert.deepEqual(h.tree.props.background,{light:'#F7F9FA',dark:'#1C1C1E'});assert.deepEqual(h.tree.props.ignoresSafeArea,{regions:'all',edges:'all'});assert.equal(viewer().props.compactImage,true);assert.ok(!all(h.tree).some(n=>n.type==='Image'||n.type==='ScrollView'))
 assert.ok(!all(h.tree).some(n=>n.type==='Button'),'no refresh/overlay button');assert.doesNotMatch(JSON.stringify(h.tree),/刷新/);viewer().props.onClose();assert.equal(closed,1);assert.equal(viewer().props.sessionId,5)
 assert.ok(!all(h.tree).some(n=>n.type==='LocalCodeEditor'||n.type==='WebView'))
 assert.equal(h.tree.type,'ZStack');assert.ok(!JSON.stringify(h.tree).includes('显示缩略图'));assert.ok(!JSON.stringify(h.tree).includes('图片只读'))
 const absent=mount(page,{file:{...file,previewImage:undefined},onClose(){}});assert.match(JSON.stringify(absent.tree),/图片预览不可用/);assert.ok(!all(absent.tree).some(n=>n.type==='ImageViewer'));absent.unmount()
 h.unmount();assert.equal(h.lateWrites,0);assert.equal(opened.length,0,'no reopen/read path remains')
 assert.equal(h.tree.props.gesture,undefined);assert.equal(h.tree.props.simultaneousGesture,undefined)
 const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../pages/FilesTab.tsx'),'utf8');assert.ok(!source.includes('pickerStatus'));assert.ok(source.includes('pickLocalDirectory()'));assert.ok(source.includes('dragTrace'))
 assert.equal(writes,0)
 // Display copy comes from the in-memory thumbnail object; failure/oversize are explicit and never fall back to source reads.
 const encoder=load('utils/localImageDisplay.ts'),MAX=encoder.LOCAL_IMAGE_DATA_URL_MAX_CHARS
 const spy=()=>{const c={png:0,jpg:[],thumbs:[]};return c}
 // Transparent PNG icon / HEIC: PNG only, JPEG never called, alpha not flattened.
 for(const name of ['icon.png','icon.PNG','live.heic','x.HEIF','anim.gif']){const c=spy();const r=encoder.localImageDisplayDataUrl({width:1600,height:1600,toPNGBase64String:()=>(c.png++,'AA'),toJPEGBase64String:()=>{throw Error('alpha image must not use JPEG')}},name);assert.deepEqual(r,{url:'data:image/png;base64,AA'});assert.equal(c.png,1)}
 // Opaque JPEG photo keeps JPEG and quality fallback.
 {const q=[];assert.deepEqual(encoder.localImageDisplayDataUrl({toPNGBase64String:()=>{throw Error('no PNG for jpeg photos')},toJPEGBase64String:v=>(q.push(v),'AA')},'p.JPG'),{url:'data:image/jpeg;base64,AA'});assert.deepEqual(q,[0.85])
  const q2=[];assert.match(encoder.localImageDisplayDataUrl({toJPEGBase64String:v=>(q2.push(v),'A'.repeat(MAX))},'p.jpeg').error,/过大/);assert.deepEqual(q2,[0.85,0.6,0.4])
  assert.equal(encoder.localImageDisplayDataUrl({toJPEGBase64String:v=>v<0.5?'A':'A'.repeat(MAX)},'p.jpg').url.endsWith('base64,A'),true)}
 // Oversize PNG shrinks the thumbnail (never JPEG), and each retry still PNG.
 {const sizes=[];const make=(w,h,big)=>({width:w,height:h,toPNGBase64String:()=>big?'A'.repeat(MAX):'SMALL',toJPEGBase64String:()=>{throw Error('no JPEG downgrade')},preparingThumbnail:s=>{sizes.push(s);return make(s.width,s.height,s.width>800)}})
  const r=encoder.localImageDisplayDataUrl(make(1600,1200,true),'big.png');assert.deepEqual(r,{url:'data:image/png;base64,SMALL'});assert.deepEqual(sizes,[{width:1120,height:840},{width:784,height:588}])}
 assert.match(encoder.localImageDisplayDataUrl({width:1600,height:1600,toPNGBase64String:()=>'A'.repeat(MAX)},'big.png').error,/过大/)
 assert.match(encoder.localImageDisplayDataUrl({width:10,height:10,toPNGBase64String:()=>'A'.repeat(MAX),preparingThumbnail:()=>null},'big.png').error,/过大/)
 assert.match(encoder.localImageDisplayDataUrl({toPNGBase64String:()=>null},'a.png').error,/无法编码/);assert.match(encoder.localImageDisplayDataUrl({},'a.png').error,/无法生成/);assert.match(encoder.localImageDisplayDataUrl({toPNGBase64String:()=>{throw Error('x')}},'a.png').error,/无法编码/)
 const badEnc=mount(page,{file:{...file,previewImage:{toPNGBase64String:()=>null}},sessionId:7,onClose(){closes++}});assert.match(JSON.stringify(badEnc.tree),/无法编码显示图片/);assert.ok(!all(badEnc.tree).some(n=>n.type==='ImageViewer'));all(badEnc.tree).find(n=>n.type==='Button'&&n.props.title==='关闭').props.action();assert.equal(closes,1);badEnc.unmount()
 console.log('PASS case-insensitive HEIC/HEIF/PNG/JPEG before text size check, bounded original browser bytes/native fallback, no source write; safety/read-only/version checks; no refresh entry, close wiring, PNG alpha path/JPEG photo/oversize shrink/encode failure')
 console.log('LIMIT native HEIC/HEIF decoding and device rendering remain unverified; no private photo input used')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{delete global.UIImage})
