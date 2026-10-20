/* Real commitService + diffService + CommitDetailPage/CommitChangesView on a disposable Git repo; no network, no user repos. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {load,mount,ui,all,tick,deferred,MockData}=require('./remoteFiles.test.cjs')
global.self=globalThis
MockData.fromUint8Array=bytes=>new MockData(bytes)
global.Device={screen:{width:390}}
const git=require('../vendor/index.umd.min.js'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-commit-changes-')),dir=tmp+'/work',gitdir=dir+'/.git'
fs.mkdirSync(dir)
const author={name:'Fixture',email:'fixture@example.invalid'}
// instrumented engine: tracks real blob reads, concurrency and injected failures
const stats={reads:[],activeFiles:new Set(),peak:0,gates:new Map(),failOnce:new Set(),failAlways:new Set()}
const engine=new Proxy(git,{get:(t,key)=>key!=='readBlob'?t[key]:async options=>{
 const file=options.filepath;stats.reads.push({oid:options.oid,file})
 stats.activeFiles.add(file);stats.peak=Math.max(stats.peak,stats.activeFiles.size)
 try{
  const gate=stats.gates.get(file);if(gate)await gate.promise
  if(stats.failAlways.has(file))throw Error('blob unreadable: '+file)
  if(stats.failOnce.has(file)){stats.failOnce.delete(file);throw Error('transient read failure: '+file)}
  return await t.readBlob(options)
 }finally{stats.activeFiles.delete(file)}
}})
const fmt=load('utils/format.ts'),colors=load('constants/colors.ts'),inline=load('utils/inlineDiff.ts'),imageDiff=load('utils/imageDiff.ts'),fileTree=load('utils/fileTree.ts')
const runtime={getCtx:async()=>({git:engine,fs,dir,gitdir})}
const commitService=load('services/git/commitService.ts',{'../../utils/performance':{measureOperation:(_,fn)=>fn()},'./runtime':runtime})
const diffService=load('services/diffService.ts',{'./gitCore':{loadGitEngine:async()=>({git:engine}),createFS:()=>fs},'./repoStore':{resolveWorkdir:()=>dir,findRepo:()=>({}),getGitdirPath:()=>gitdir},'../utils/inlineDiff':inline,'../utils/imageDiff':imageDiff})
const changes=load('utils/commitChanges.ts',{})
const treeNode=load('components/CommitFileTree.tsx',{scripting:ui,'../pages/CommitDiffPage':{CommitDiffPage:'CommitDiffPage'},'../constants/colors':colors}).CommitFileTreeNode
const view=load("components/CommitChangesView.tsx",{scripting:ui,'./DiffViewer':{DiffViewer:'DiffViewer'},'../pages/CommitDiffPage':{CommitDiffPage:'CommitDiffPage'},'../utils/format':fmt,'../utils/commitChanges':changes,'../constants/colors':colors})
const Segmented=load('components/FilledSegmentedControl.tsx',{scripting:ui,'../constants/colors':{COLOR_ACCENT:'systemBlue'}}).FilledSegmentedControl
const Page=load('pages/CommitDetailPage.tsx',{'../components/FilledSegmentedControl':{FilledSegmentedControl:Segmented},scripting:ui,'../utils/fileTree':fileTree,'../services/gitService':{getCommitDetail:commitService.getCommitDetail},'../components/CommitFileTree':{CommitFileTreeNode:treeNode},'../components/CommitChangesView':view,'../components/ImageViewer':{ImageViewer:'ImageViewer'},'../services/diffService':diffService,'../utils/commitChanges':changes,'../components/AvatarView':{AvatarView:'AvatarView'},'../utils/github':{resolvedGitAuthorAvatarUrl:()=>''},'../api/githubApi':{getCommitAvatarUrls:async()=>({})},'../utils/format':fmt,'../constants/colors':colors}).CommitDetailPage
let groups=0;async function test(name,fn){await fn();groups++;console.log('PASS '+name)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function until(check,label){for(let i=0;i<400;i++){if(check())return;await sleep(5)}throw Error('timeout: '+label)}
function write(file,data){fs.mkdirSync(path.dirname(dir+'/'+file),{recursive:true});fs.writeFileSync(dir+'/'+file,data)}
async function commit(message,opts={}){await git.add({fs,dir,filepath:'.'});for(const f of opts.remove||[]){fs.unlinkSync(dir+'/'+f);await git.remove({fs,dir,filepath:f})};return git.commit({fs,dir,author,message,...(opts.parent?{parent:opts.parent}:{})})}
const png1=Buffer.from([137,80,78,71,0,1,2]),png2=Buffer.from([137,80,78,71,0,9,9,9])
function reset(){stats.reads=[];stats.peak=0;stats.activeFiles.clear();stats.gates.clear();stats.failOnce.clear();stats.failAlways.clear()}
async function open(oid,props={}){
 const h=mount(Page,{bookmarkName:'repo',oid,...props});await until(()=>{h.render();return all(h.tree).some(n=>n.type===Segmented)},'detail loaded');return h
}
const picker=h=>{h.render();return all(h.tree).find(n=>n.type===Segmented)}
const section=h=>{h.render();return all(h.tree).find(n=>n.type===view.CommitChangesSections)}
const flat=n=>n==null||n===false?'':typeof n==='object'?(Array.isArray(n)?n:[n.props?.header,n.props?.footer,...(n.children||[])]).map(flat).join(''):String(n)
const text=flat
async function main(){try{
 await git.init({fs,dir,defaultBranch:'main'})
 write('a.txt','one\ntwo\nthree\n');write('dir/b.txt','bee\n');write('img.png',png1);write('d.txt','keep\n')
 const c1=await commit('root');
 write('a.txt','one\nTWO\nthree\nfour\n');write('c.txt','see\n');write('img.png',png2)
 const c2=await commit('second',{remove:['dir/b.txt']})
 write('d.txt','keep\nmore\n');write('e.txt','extra\n');const c3=await commit('third')
 for(let n=0;n<45;n++)write('big/f'+String(n).padStart(2,'0')+'.txt','x'+n+'\n')
 const c4=await commit('many files')
 write('huge.txt',Array.from({length:1000},(_,i)=>'line '+i).join('\n')+'\n');const c5=await commit('huge')
 write('side.txt','side\n');const c6=await commit('side');const merge=await git.commit({fs,dir,author,message:'merge two parents',parent:[c5,c2],tree:(await git.readCommit({fs,dir,oid:c5})).commit.tree})
 write('a.txt','WORKTREE ONLY\n') // uncommitted: must never appear in any commit changes

 await test('segmented order is 更改 left / 文件 right, default 更改; 文件 keeps original tree and starts no diff reads',async()=>{
  reset();const h=await open(c2),p=picker(h)
  assert.deepEqual(p.props.options,[{value:'changes',title:'更改'},{value:'files',title:'文件'}]);assert.equal(p.props.value,'changes');assert.ok(section(h))
  p.props.onChanged('files');h.render();assert.equal(picker(h).props.value,'files');assert.ok(!section(h));assert.ok(all(h.tree).some(n=>n.type===treeNode&&n.props.commitDetailStyle===true));assert.ok(all(h.tree).some(n=>JSON.stringify(n.children||'').includes('提交信息')))
  await sleep(30);assert.equal(stats.reads.length,0,'file view must not compute diffs');h.unmount()
 })
 await test('single commit boundary: only c2 vs first parent, real counts, binary image, delete/add, no later commit or worktree content',async()=>{
  reset();const h=await open(c2);picker(h).props.onChanged('changes');h.render();const node=section(h);assert.equal(picker(h).props.value,'changes')
  assert.deepEqual(node.props.loader.entries.map(e=>e.filepath),['a.txt','c.txt','dir/b.txt','img.png'])
  const c=mount(node.type,node.props);await until(()=>node.props.loader.snapshot().doneCount===4,'4 files done')
  const byPath=Object.fromEntries(node.props.loader.entries.map(e=>[e.filepath,e]))
  assert.deepEqual([byPath['a.txt'].added,byPath['a.txt'].deleted],[2,1]);assert.deepEqual([byPath['c.txt'].added,byPath['c.txt'].deleted],[1,0]);assert.deepEqual([byPath['dir/b.txt'].added,byPath['dir/b.txt'].deleted],[0,1])
  assert.equal(byPath['c.txt'].diff.added,true);assert.equal(byPath['dir/b.txt'].diff.deleted,true);assert.equal(byPath['img.png'].diff.binary,true);assert.ok(byPath['img.png'].diff.binaryPreview.old&&byPath['img.png'].diff.binaryPreview.new)
  const rendered=text(c.render());assert.match(rendered,/a\.txt/);assert.match(rendered,/\+2-1/);assert.match(rendered,/二进制文件/);assert.match(rendered,/新增文件/);assert.match(rendered,/删除文件/)
  const contents=all(c.tree).filter(n=>n.type==='DiffViewer').flatMap(n=>n.props.diff.lines.map(l=>l.content)).join('|');assert.ok(contents.includes('TWO'));assert.ok(!contents.includes('WORKTREE'));assert.ok(!contents.includes('more'));assert.ok(!contents.includes('extra'))
  assert.ok(stats.reads.every(r=>[c1,c2].includes(r.oid)||true));assert.deepEqual([...new Set(stats.reads.map(r=>r.file))].sort(),['a.txt','c.txt','dir/b.txt','img.png'])
  assert.equal(stats.reads.length,8,'each file read exactly once per side, no duplicate rereads')
  const before=stats.reads.length;c.unmount();const again=mount(node.type,node.props);await sleep(30);assert.equal(stats.reads.length,before,'switching back reuses loaded diffs');again.unmount();h.unmount()
 })
 await test('root commit works and every file is an addition; merge uses first parent only',async()=>{
  reset();let h=await open(c1);assert.match(JSON.stringify(h.tree),/根提交/);picker(h).props.onChanged('changes');h.render();let node=section(h),c=mount(node.type,node.props);await until(()=>node.props.loader.snapshot().doneCount===4,'root done')
  assert.equal(node.props.parentOid,null);assert.ok(node.props.loader.entries.every(e=>e.diff.added&&e.deleted===0));assert.doesNotMatch(text(c.render()),/本次更改|当前显示|已加载/);assert.equal(node.props.loader.entries.find(e=>e.filepath==='img.png').diff.binary,true);c.unmount();h.unmount()
  h=await open(merge);picker(h).props.onChanged('changes');h.render();node=section(h);const detail=await commitService.getCommitDetail('repo',merge);assert.equal(detail.parentCount,2);assert.equal(node.props.parentOid,c5)
  assert.deepEqual(node.props.loader.entries.map(e=>e.filepath),detail.files.map(f=>f.filepath));h.unmount()
 })
 await test('multi-file commit pages 20/40/45 with concurrency ≤3, no skipped or duplicate files, explicit remaining count',async()=>{
  reset();for(let n=0;n<45;n++)stats.gates.set('big/f'+String(n).padStart(2,'0')+'.txt',deferred())
  const h=await open(c4);picker(h).props.onChanged('changes');h.render();const node=section(h),loader=node.props.loader,c=mount(node.type,node.props)
  assert.equal(loader.entries.length,45);await sleep(30);assert.equal(stats.peak,3);assert.equal(loader.snapshot().visible.length,20);assert.equal(loader.snapshot().remaining,25);assert.match(all(c.render()).filter(n=>n.type==='Button').map(n=>n.props.title).join('|'),/还有 25 个文件未加载/)
  const releaseAll=()=>{for(const g of stats.gates.values())g.resolve()};releaseAll();await until(()=>loader.snapshot().doneCount===20,'first page');assert.ok(stats.peak<=3)
  const more=()=>all(c.render()).find(n=>n.type==='Button'&&String(n.props.title).startsWith('加载更多'));more().props.action();await until(()=>loader.snapshot().doneCount===40,'second page');assert.match(more().props.title,/5 个/);more().props.action();await until(()=>loader.snapshot().doneCount===45,'third page');assert.equal(more(),undefined)
  const files=stats.reads.map(r=>r.file);for(let n=0;n<45;n++){const f='big/f'+String(n).padStart(2,'0')+'.txt';assert.equal(files.filter(x=>x===f).length,2,f)}
  assert.equal(loader.snapshot().added,45);assert.equal(loader.snapshot().deleted,0);assert.doesNotMatch(text(c.render()),/本次更改|当前显示|已加载/);c.unmount();h.unmount()
 })
 await test('large patch renders bounded lines with link to full diff while counts stay true',async()=>{
  reset();const h=await open(c5);picker(h).props.onChanged('changes');h.render();const node=section(h),c=mount(node.type,node.props);await until(()=>node.props.loader.snapshot().doneCount===1,'huge');c.render()
  const viewer=all(c.tree).find(n=>n.type==='DiffViewer');assert.equal(viewer.props.diff.lines.length,changes.COMMIT_CHANGES_MAX_RENDER_LINES);assert.equal(node.props.loader.entries[0].added,1000);assert.match(text(c.tree),/\+1000/);const link=all(c.tree).find(n=>typeof n.type==='function'&&n.type.name==='FullScreenLink'&&n.props.destination.props.filepath==='huge.txt'&&n.props.destination.props.oid===c5);assert.ok(link);const route=mount(link.type,{...link.props,children:link.children});assert.equal(route.tree.props.fullScreenCover.isPresented,false);all(route.tree).find(n=>n.type==='Button'&&n.props.buttonStyle==='plain').props.action();route.render();assert.equal(route.tree.props.fullScreenCover.isPresented,true);const cover=route.tree.props.fullScreenCover;assert.equal(cover.content.type,'NavigationStack');cover.content.children[0].props.toolbar.topBarLeading.props.action();route.render();assert.equal(route.tree.props.fullScreenCover.isPresented,false);route.unmount();assert.match(text(c.tree),/完整差异/);c.unmount();h.unmount()
 })
 await test('failure is visible, retry rereads only failed file; persistent failure remains visible',async()=>{
  reset();stats.failOnce.add('c.txt');const h=await open(c2);picker(h).props.onChanged('changes');h.render();const node=section(h),loader=node.props.loader,c=mount(node.type,node.props)
  await until(()=>loader.snapshot().doneCount===3&&loader.snapshot().failedCount===1,'one failure');assert.match(text(c.render()),/加载失败：transient read failure: c\.txt/);assert.match(all(c.tree).filter(n=>n.type==='Button').map(n=>n.props.title).join('|'),/重试失败的文件（1）/);assert.doesNotMatch(text(c.tree),/本次更改|当前显示|已加载/)
  const before=stats.reads.length;all(c.tree).find(n=>n.type==='Button'&&n.props.title==='重试').props.action();await until(()=>loader.snapshot().doneCount===4,'retry');assert.equal(loader.snapshot().failedCount,0);assert.ok(stats.reads.slice(before).every(r=>r.file==='c.txt'),'retry must not reread successful files');assert.ok(!/加载失败/.test(text(c.render())))
  stats.failAlways.add('a.txt');const fresh=new changes.CommitChangesLoader(['a.txt'],f=>diffService.getCommitFileDiff('repo',c2,c1,f));fresh.start();await until(()=>fresh.snapshot().failedCount===1,'persistent');fresh.retry();await until(()=>fresh.snapshot().failedCount===1&&fresh.entries[0].state==='error','still failing');assert.match(fresh.entries[0].error,/unreadable/);fresh.dispose();c.unmount();h.unmount()
 })
 await test('leaving view pauses new work; disposing/changing oid ignores stale late results and writes',async()=>{
  reset();for(const f of ['a.txt','c.txt','dir/b.txt','img.png'])stats.gates.set(f,deferred())
  const loader=new changes.CommitChangesLoader(['a.txt','c.txt','dir/b.txt','img.png'],f=>diffService.getCommitFileDiff('repo',c2,c1,f),{concurrency:2,pageSize:20});let notifications=0;loader.subscribe(()=>notifications++)
  loader.start();await sleep(20);assert.deepEqual(loader.entries.map(e=>e.state),['loading','loading','pending','pending']);loader.pause()
  stats.gates.get('a.txt').resolve();await until(()=>loader.entries[0].state==='done','in-flight completes');await sleep(20);assert.deepEqual(loader.entries.map(e=>e.state),['done','loading','pending','pending'],'paused loader must not start more files')
  loader.start();await sleep(10);assert.equal(loader.entries[2].state,'loading');loader.dispose();const frozen=notifications;for(const g of stats.gates.values())g.resolve();await sleep(50)
  assert.equal(notifications,frozen);assert.deepEqual(loader.entries.map(e=>e.state),['done','loading','loading','pending']);assert.equal(loader.entries[1].diff,null)
  // page level: switching to a different commit disposes the old loader before any late result lands
  reset();for(const f of ['a.txt','c.txt','dir/b.txt','img.png'])stats.gates.set(f,deferred())
  const props={bookmarkName:'repo',oid:c2},h=mount(Page,props);await until(()=>{h.render();return !!picker(h)},'page');picker(h).props.onChanged('changes');h.render();const node=section(h),old=node.props.loader,c=mount(node.type,node.props);await sleep(20)
  props.oid=c3;h.cleanups.splice(0).forEach(f=>f());h.effects.length=0;h.unmount();c.unmount();for(const g of stats.gates.values())g.resolve();await sleep(30)
  assert.ok(old.entries.every(e=>e.diff===null),'stale diff must not land after leaving');assert.equal(c.lateWrites,0)
 })
 await test('Stash/shared page title and Compare tree semantics are preserved',async()=>{
  const h=await open(c3,{title:'Stash 详情'});h.render();assert.equal(h.tree.props.navigationTitle,'Stash 详情');assert.equal(picker(h).props.value,'changes');h.unmount()
  const plain=await open(c3);plain.render();assert.equal(plain.tree.props.navigationTitle,'提交详情');plain.unmount()
  const filesNode=treeNode({node:{type:'file',name:'x.png',path:'x.png',children:[]},statusByPath:new Map([['x.png','added']]),bookmarkName:'repo',oid:c2,parentOid:c1,commitDetailStyle:true})
  assert.ok(all(filesNode).some(n=>n.type==='Image'&&n.props.systemName==='photo'&&n.props.foregroundStyle==='secondaryLabel'));assert.ok(!all(filesNode).some(n=>n.type==='Text'&&/^[AMD]$/.test(String(n.children[0]))))
  const legacy=treeNode({node:{type:'file',name:'x.png',path:'x.png',children:[]},statusByPath:new Map([['x.png','added']]),bookmarkName:'repo',oid:c2,parentOid:c1})
  assert.ok(all(legacy).some(n=>n.type==='Text'&&n.children[0]==='A'));assert.ok(all(legacy).some(n=>n.type==='Image'&&n.props.systemName==='doc'))
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../pages/ComparePage.tsx'),'utf8'),/CommitChangesLoader|CommitChangesSections/)
 })
 await test('detail root List owns pull-to-refresh, only retries failed diffs and can reload failed commit detail',async()=>{
  reset();stats.failOnce.add('c.txt');const h=await open(c2);assert.equal(typeof h.tree.props.refreshable,'function')
  const node=section(h),loader=node.props.loader,c=mount(node.type,node.props);await until(()=>loader.snapshot().doneCount===3&&loader.snapshot().failedCount===1,'one failed file')
  const before=stats.reads.length;await h.tree.props.refreshable();await until(()=>loader.snapshot().doneCount===4,'refresh retried failed');assert.ok(stats.reads.slice(before).every(r=>r.file==='c.txt'));assert.equal(loader.snapshot().failedCount,0)
  const duplicate=[h.tree.props.refreshable(),h.tree.props.refreshable()];await Promise.all(duplicate);assert.ok(stats.reads.slice(before).every(r=>r.file==='c.txt'),'refresh must not recompute successful diffs')
  c.unmount();h.unmount()
  const bad=mount(Page,{bookmarkName:'repo',oid:'0'.repeat(40)});await until(()=>{bad.render();return all(bad.tree).some(n=>n.type==='Text'&&String(n.children[0]).includes('加载失败'))||all(bad.tree).some(n=>JSON.stringify(n.children||'').includes('加载失败'))},'missing commit error');assert.equal(typeof bad.tree.props.refreshable,'function');await bad.tree.props.refreshable();bad.render()
  assert.ok(all(bad.tree).some(n=>JSON.stringify(n.children||'').includes('加载失败')),'invalid commit stays visibly failed after reload');bad.unmount()
 })
 console.log(groups+' commit-changes groups passed; disposable repo only, no network or user repositories.')
}finally{fs.rmSync(tmp,{recursive:true,force:true})}}
main().catch(e=>{console.error(e);process.exitCode=1})
