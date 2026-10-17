/* Official gesture callbacks and native scroll content layout modeled in JS.
 * This is not a native gesture/arbitration or UIScrollView rendering test. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,all}=require('./remoteFiles.test.cjs')
const math=load('utils/localImageZoom.ts'),execution=load('services/localImportExecution.ts')
let sourceCalls=0,refreshes=0
const image={width:1600,height:800,native:true},file={path:'synthetic.HEIC',text:null,previewImage:image,version:{}}
const Page=load('components/LocalImagePreview.tsx',{scripting:ui,'../utils/localImageZoom':math,'../services/localImportExecution':execution,'../services/gitService':{openLocalWorktreeFile:async()=>{refreshes++;return {...file,previewImage:{...image,native:'refreshed'}}}}}).LocalImagePreview
function scene(h,width=320,height=520){h.render();const g=all(h.tree).find(n=>n.type==='GeometryReader');const tree=g.children[0]({size:{width,height}});const nodes=all(tree);return {scroll:tree,image:nodes.find(n=>n.type==='Image'),content:nodes.find(n=>n.type==='ZStack'),gesture:tree.props.simultaneousGesture}}
function nativeBoundaries(s){assert.equal(s.scroll.type,'ScrollView');assert.equal(s.scroll.props.axes,'all');assert.equal(s.scroll.props.scrollClipDisabled,false);assert.equal(s.scroll.props.defaultScrollAnchor,'center');assert.ok(s.content.props.frame.width>=s.scroll.props.frame.width);assert.ok(s.content.props.frame.height>=s.scroll.props.frame.height);assert.equal(s.scroll.props.gesture,undefined);assert.equal(s.scroll.props.highPriorityGesture,undefined);assert.equal(s.scroll.props.defersSystemGestures,undefined)}
async function main(){
 for(const [value,expected]of [[0,1],[-1,1],[1,1],[1.25,1.25],[99,4],[Infinity,1],[NaN,1]])assert.equal(math.localImageZoomScale(value),expected)
 for(const size of [{width:1600,height:800},{width:400,height:1600},{width:1,height:1}])for(const viewport of [{width:320,height:520},{width:768,height:400}])for(const scale of [1,2,4]){
  const layout=math.localImageZoomLayout(size,viewport,scale);assert.ok(layout.displayWidth<=viewport.width*scale+1e-9);assert.ok(layout.displayHeight<=viewport.height*scale+1e-9);assert.equal(layout.contentWidth,Math.max(viewport.width,layout.displayWidth));assert.equal(layout.contentHeight,Math.max(viewport.height,layout.displayHeight));assert.equal(layout.displayWidth/layout.displayHeight,size.width/size.height)
 }
 const fallback=math.localImageZoomLayout({width:NaN,height:0},{width:0,height:NaN},NaN);assert.ok(Object.values(fallback).every(Number.isFinite))
 global.FileManager=new Proxy({},{get:()=>()=>{sourceCalls++;throw Error('zoom must not access a source file')}})
 let reloaded=null;const h=mount(Page,{bookmarkName:'repo',file,onReload:f=>{reloaded=f}})
 let s=scene(h);nativeBoundaries(s);assert.equal(s.scroll.props.scrollDisabled,true);assert.deepEqual(s.image.props.frame,{width:320,height:160});assert.equal(s.scroll.props.onTapGesture,undefined);assert.equal(h.tree.props.gesture,undefined);assert.equal(h.tree.props.navigationBarBackButtonHidden,false);assert.equal(h.tree.props.toolbar.topBarLeading,undefined)
 const pinch=s.gesture;assert.equal(pinch.kind,'magnify');assert.equal(pinch.minScaleDelta,0.01)
 pinch.changed({magnification:1.5});pinch.changed({magnification:2});s=scene(h);assert.deepEqual(s.image.props.frame,{width:640,height:320});assert.equal(s.scroll.props.scrollDisabled,false);assert.deepEqual(s.content.props.frame,{width:640,height:520});pinch.ended({magnification:2})
 s=scene(h);s.gesture.changed({magnification:10});s.gesture.ended({magnification:10});s=scene(h);assert.deepEqual(s.image.props.frame,{width:1280,height:640});assert.deepEqual(s.content.props.frame,{width:1280,height:640});nativeBoundaries(s)
 // Existing UIImage identity is reused for all gestures, no new decode/read.
 assert.equal(s.image.props.image,image);assert.equal(sourceCalls,0)
 for(const invalid of [NaN,Infinity,0,-1])s.gesture.changed({magnification:invalid})
 assert.deepEqual(scene(h).image.props.frame,{width:1280,height:640})
 s=scene(h);assert.equal(s.scroll.props.onTapGesture.count,2);s.scroll.props.onTapGesture.perform();s=scene(h);assert.equal(s.scroll.props.scrollDisabled,true);assert.deepEqual(s.content.props.frame,{width:320,height:520});assert.deepEqual(s.image.props.frame,{width:320,height:160})
 s.gesture.changed({magnification:2});s.gesture.ended({magnification:2});s=scene(h);s.gesture.changed({magnification:0.01});s.gesture.ended({magnification:0.01});s=scene(h);assert.equal(s.scroll.props.scrollDisabled,true)
 // Rotation/layout changes update both viewport and native pan bounds.
 const wide=scene(h,800,400);assert.deepEqual(wide.image.props.frame,{width:800,height:400});nativeBoundaries(wide)
 s=scene(h);s.gesture.ended({magnification:3});s=scene(h);await h.tree.props.toolbar.topBarTrailing.props.action();assert.equal(refreshes,1);assert.ok(reloaded)
 const stale=s.gesture,oldReset=s.scroll.props.onTapGesture.perform;h.unmount();stale.changed({magnification:1.5});stale.ended({magnification:1.5});oldReset();assert.equal(h.lateWrites,0)
 // Real parent keys refreshed images to remount; the new native scroll starts 1x.
 const fresh=mount(Page,{bookmarkName:'repo',file:reloaded,onReload(){}});assert.equal(scene(fresh).scroll.props.scrollDisabled,true);fresh.unmount();assert.equal(sourceCalls,0)
 const src=fs.readFileSync(path.join(__dirname,'../components/LocalImagePreview.tsx'),'utf8');assert.doesNotMatch(src,/zoomScale=|minimumZoomScale|highPriorityGesture=|defersSystemGestures=|DragGesture|Data\.|base64|writeImage/)
 console.log('PASS 1–4x native MagnifyGesture wiring, non-compounding scale, two-axis native scroll content/pan bounds, 1x disabled pan, double-tap reset, resize, refresh remount and stale/unmount guards; unchanged UIImage, no source access')
 console.log('LIMIT native pinch, scrolling/clamping and system edge-pop arbitration need real-device verification; magnifies the existing 1600 display thumbnail only')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{delete global.FileManager})
