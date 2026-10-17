/* Actual RepoDetailPage virtual nodes; native presentation is NOT emulated. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,all,tick}=require('./remoteFiles.test.cjs')
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(root+'/pages/RepoDetailPage.tsx','utf8')
const noop=()=>{},mocks={scripting:ui}
// Every dependency is explicit; exercise the real List/presentation state, not native UIKit.
for(const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
 const [,names,module]=match;if(module==='scripting')continue
 mocks[module]={};for(const token of names.split(',')){const name=token.trim();if(name)mocks[module][name]=name}
}
let refreshed=0,skippedReloads=0,closedOtherPages=0,mergeLoads=0
const nav={isPresented:false,skipNextAppearLoad(){skippedReloads++},closeAll(){closedOtherPages++;this.isPresented=false}}
const data={displayName:'test',changes:[],branchInfo:{current:'main'},tab:2,loadMergeState:()=>{mergeLoads++},refreshChangesAndSnapshot:async()=>{refreshed++}}
const hook=(module,name,value)=>mocks[module]={[name]:()=>value}
hook('../hooks/useLocalEntryCreation','useLocalEntryCreation',{busy:false,open(){}})
hook('../hooks/useToast','useToast',{})
hook('../hooks/useRepoDetailData','useRepoDetailData',data)
hook('../hooks/useOpBusy','useOpBusy',{})
hook('../hooks/useRepoDetailNavigation','useRepoDetailNavigation',nav)
hook('../hooks/useRepoWorktreeActions','useRepoWorktreeActions',{commitSheetMode:null})
hook('../hooks/useRepoPendingActions','useRepoPendingActions',{})
hook('../hooks/useRepoBranchActions','useRepoBranchActions',{})
hook('../hooks/useRepoSyncActions','useRepoSyncActions',{})
mocks['../utils/format']={suggestCommitTitle:()=>'',shortOid:noop}
const {RepoDetailPage}=load('pages/RepoDetailPage.tsx',mocks)
async function main(){
 const h=mount(RepoDetailPage,{bookmarkName:'repo',name:'test'})
 assert.equal(h.tree.type,'List');assert.equal(h.tree.props.fullScreenCover[0].isPresented,false)
 const tab=()=>{h.render();return all(h.tree).find(n=>n.type==='RepoDetailTabContent')}
 const file={path:'file.txt',text:'draft',version:{}}
 tab().props.onOpenLocalFile(file);h.render();let cover=h.tree.props.fullScreenCover[0]
 assert.equal(cover.isPresented,true);assert.equal(cover.content.type,'LocalFileEditor');assert.equal(cover.content.props.file,file)
 // Tab source content can change while the stable List owns the editor session.
 data.tab=0;h.render();assert.equal(h.tree.props.fullScreenCover[0].isPresented,true)
 await cover.content.props.onChanged('file.txt',false);assert.equal(refreshed,1)
 cover.content.props.onClose();h.render();assert.equal(h.tree.props.fullScreenCover[0].isPresented,false)
 tab().props.onOpenLocalFile({...file,previewImage:{nativeThumbnail:true},text:null});h.render();let destination=h.tree.props.fullScreenCover[1]
 assert.equal(h.tree.props.fullScreenCover[0].isPresented,false,'image uses its own cover entry, editor entry stays closed');assert.equal(destination.isPresented,true)
 assert.equal(destination.content.type,'LocalImagePreview');assert.deepEqual(destination.content.props.file.previewImage,{nativeThumbnail:true});assert.equal(destination.content.props.bookmarkName,'repo');assert.ok(!all(destination.content).some(n=>n.type==='LocalFileEditor'))
 const firstImageSession=destination.content.props.sessionId,oldReload=destination.content.props.onReload
 destination.content.props.onReload({...file,previewImage:{nativeThumbnail:'refreshed'},text:null});h.render();destination=h.tree.props.fullScreenCover[1]
 assert.equal(destination.isPresented,true);assert.ok(destination.content.props.sessionId>firstImageSession);assert.equal(destination.content.props.file.previewImage.nativeThumbnail,'refreshed')
 assert.equal(skippedReloads,0,'sheet does not push/pop the underlying page; no reload skip needed')
 destination.onChanged(false);h.render();assert.equal(h.tree.props.fullScreenCover[1].isPresented,false);assert.equal(h.tree.props.fullScreenCover[0].isPresented,false)
 oldReload({...file,previewImage:{nativeThumbnail:'stale'},text:null});h.render();assert.equal(h.tree.props.fullScreenCover[1].isPresented,false,'stale refresh cannot reopen popped image')
 assert.equal(mergeLoads,0);assert.equal(closedOtherPages,0,'image dismiss does not close or refresh unrelated routes')
 for(let i=0;i<3;i++){
  tab().props.onOpenLocalFile({...file,previewImage:{nativeThumbnail:true},text:null});h.render();destination=h.tree.props.fullScreenCover[1]
  assert.ok(destination.content.props.sessionId>firstImageSession+i,'same image gets a fresh session')
  destination.onChanged(false);h.render();assert.equal(h.tree.props.fullScreenCover[1].isPresented,false)
 }
 nav.isPresented=true;h.render();assert.equal(h.tree.props.navigationDestination.content.type,'RepoDetailDestination');h.tree.props.navigationDestination.onChanged(false);assert.equal(closedOtherPages,1);assert.equal(mergeLoads,1)
 tab().props.onOpenLocalFile({...file,previewImage:{nativeThumbnail:true},text:null});h.render();const afterUnmountReload=h.tree.props.fullScreenCover[1].content.props.onReload
 h.unmount();afterUnmountReload({...file,previewImage:{nativeThumbnail:true},text:null});assert.equal(h.lateWrites,0)
 const entry=fs.readFileSync(root+'/index.tsx','utf8');assert.match(entry,/await Navigation.present\(<View \/>\)/);assert.equal((entry.match(/Script.exit\(\)/g)||[]).length,1)
 for(const name of ['pages/FilesTab.tsx','pages/LocalFileEditor.tsx','services/git/localFileService.ts'])assert.doesNotMatch(fs.readFileSync(root+'/'+name,'utf8'),/Script.exit|Navigation.present/)
 // Capture actual WebView HTML for local/default modes; do not pretend to render native WebKit.
 const controllers=[];global.WebViewController=class{
  constructor(){controllers.push(this)}
  async addScriptMessageHandler(name,callback){this.close=callback}
  async loadHTML(html){this.html=html}
  dispose(){this.disposed=true}
 }
 const {ImageViewer}=load('components/ImageViewer.tsx',{scripting:ui});let closed=0
 const compact=mount(ImageViewer,{url:'data:image/png;base64,AA==',compactImage:true,onClose:()=>closed++});await tick();const local=controllers.at(-1)
 assert.equal(compact.tree.type,'ZStack');assert.equal(compact.tree.props.frame.maxHeight,'infinity');assert.equal(compact.tree.props.ignoresSafeArea.regions,'all')
 assert.match(local.html,/max-width: 80%/);assert.match(local.html,/max-height: 60%/);assert.match(local.html,/width: auto; height: auto; object-fit: contain/);assert.match(local.html,/box-sizing: border-box; padding: env\(safe-area-inset-top/);assert.match(local.html,/viewport-fit=cover/)
 assert.match(local.html,/background: #fff/);assert.match(local.html,/prefers-color-scheme: dark\) \{ html, body \{ background: #242424/);assert.match(local.html,/scale <= 1\.01 && \(edgeBack \|\| pullDown\)/);assert.match(local.html,/startX <= 24 && dx >= 80/);assert.match(local.html,/multiTouch/);assert.deepEqual(compact.tree.props.background,{light:'white',dark:'#242424'})
 assert.match(local.html,/initial-scale=1, minimum-scale=1, maximum-scale=6, user-scalable=yes/);assert.match(local.html,/图片加载失败/)
 // Execute the delivered touch handlers: edge right-back only, not ordinary panning/zoom/diagonal/multitouch.
 const vm=require('node:vm')
 function gesture({x=10,y=100,dx=100,dy=0,scale=1,multi=false,cancel=false,fast=false}={}){
  const listeners={},classes={add(){}},photo={complete:true,naturalWidth:1,classList:classes,addEventListener(){}},stage={},spinner={classList:classes};let count=0
  const context={document:{getElementById:id=>({photo,stage,spinner}[id]),addEventListener:(name,fn)=>listeners[name]=fn},window:{visualViewport:{scale},webkit:{messageHandlers:{closeViewer:{postMessage:()=>count++}}}}}
  vm.runInNewContext(local.html.match(/<script>([\s\S]*?)<\/script>/)[1],context)
  const touch={clientX:x,clientY:y};listeners.touchstart({touches:multi?[touch,touch]:[touch]})
  if(cancel)listeners.touchcancel({})
  const end={clientX:x+dx,clientY:y+dy};if(!fast){listeners.touchmove({touches:[end]});listeners.touchmove({touches:[end]})}listeners.touchend({touches:[],changedTouches:[end]});return count
 }
 assert.equal(gesture(),1);assert.equal(gesture({x:100}),0);assert.equal(gesture({scale:2}),0)
 assert.equal(gesture({dy:100}),0);assert.equal(gesture({multi:true}),0);assert.equal(gesture({cancel:true}),0)
 assert.equal(gesture({dx:0,dy:130}),1)
 assert.equal(gesture({fast:true}),1);assert.equal(gesture({fast:true,scale:2}),0)
 assert.equal(gesture({fast:true,multi:true}),0);assert.equal(gesture({fast:true,cancel:true}),0)
 assert.equal(gesture({fast:true,x:100}),0)
 local.close();local.close();assert.equal(closed,1);compact.unmount();assert.equal(local.disposed,true)
 const repeatProps={url:'data:image/png;base64,AA==',compactImage:true,sessionId:1,onClose:()=>closed++}
 let repeat=mount(ImageViewer,repeatProps);await tick();let prior=controllers.at(-1);prior.close();const beforeRepeat=closed
 for(let id=2;id<=4;id++){
  // Parent changes key with sessionId: React unmounts the prior viewer.
  repeat.unmount();repeatProps.sessionId=id;repeat=mount(ImageViewer,repeatProps);await tick();const fresh=controllers.at(-1)
  assert.notEqual(fresh,prior);assert.equal(prior.disposed,true)
  prior.close();assert.equal(closed,beforeRepeat+id-2,'stale close ignored')
  fresh.close();fresh.close();assert.equal(closed,beforeRepeat+id-1,'fresh close unlocked, once per session')
  prior=fresh
 }
 repeat.unmount()
 const normal=mount(ImageViewer,{url:'https://example.invalid/image.png',onClose(){}});await tick();const original=controllers.at(-1)
 assert.match(original.html,/background: #000/);assert.doesNotMatch(original.html,/touchmove|prefers-color-scheme|#242424/);assert.equal(normal.tree.props.background,'black');assert.match(original.html,/max-width: 100%/);assert.match(original.html,/max-height: 100%/);assert.doesNotMatch(original.html,/viewport-fit=cover|safe-area-inset|object-fit/)
 assert.doesNotMatch(original.html,/Fast swipes|startX <= 24/);normal.unmount()
 for(const name of ['DiffPage','CommitDiffPage','GitHubItemDetailPage'])assert.doesNotMatch(fs.readFileSync(root+'/pages/'+name+'.tsx','utf8'),/compactImage/)
 console.log('PASS compact local image HTML caps 80%/60% inside safe-area stage, intrinsic small-image sizing, full-screen container, unchanged close/zoom/error script and shared default mode.')
 console.log('PASS real RepoDetailPage keeps text cover, presents image in its own fullScreenCover entry (editor cover untouched) with close cleanup, refresh/stale/unmount guards and unrelated routes unchanged; no added Navigation.present/Script.exit path. Native lifecycle requires device validation.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
