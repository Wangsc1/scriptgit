/* Real local-file service + facade/coordinator + real isomorphic-git on disposable test repos. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),ts=require('typescript')
const {ui,mount,node,all,text,tick,deferred}=require('./remoteFiles.test.cjs')
global.self=globalThis
const project=path.resolve(__dirname,'..'),git=require('../vendor/index.umd.min.js')
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-local-test-')),dir=tmp+'/work',outside=tmp+'/outside'
fs.mkdirSync(dir);fs.mkdirSync(outside)
let writes=0,removes=0,confirm=true,confirmations=[],controllers=[],root=dir
// Native FileManager semantics on a disposable directory; never touches user repositories.
global.FileManager={scriptsDirectory:tmp,appGroupDocumentsDirectory:tmp,documentsDirectory:tmp,
 readDirectory:async p=>fs.promises.readdir(p),
 exists:async p=>fs.existsSync(p),isLink:async p=>{try{return (await fs.promises.lstat(p)).isSymbolicLink()}catch(e){if(e.code==='ENOENT')return false;throw e}},
 isDirectory:async p=>(await fs.promises.stat(p)).isDirectory(),isFile:async p=>(await fs.promises.stat(p)).isFile(),
 stat:async p=>{const s=await fs.promises.stat(p);return {size:s.size,modificationDate:s.mtimeMs,type:s.isDirectory()?'directory':'file'}},
 readAsData:async p=>new Data(await fs.promises.readFile(p)),writeAsData:async(p,data)=>{writes++;await fs.promises.writeFile(p,data.bytes)},
 remove:async p=>{removes++;await fs.promises.unlink(p)},
}
global.Device={systemVersion:'26'}
global.EditorController=class{constructor(options){Object.assign(this,options);controllers.push(this)}dispose(){this.disposed=true}}
global.Dialog={confirm:async input=>{confirmations.push(input);return confirm}}
const ctx={git,fs,dir,gitdir:dir+'/.git'}
const runtime={resolveGitdir:()=>ctx.gitdir,getCtx:async()=>ctx}
const store={resolveWorkdir:()=>root,findRepo:()=>({bookmarkName:'repo',name:'test',repoId:'repo'}),listRepos:()=>[],getGitdirPath:()=>ctx.gitdir}
function loader(overrides={}){
 const cache=new Map()
 function read(file){file=path.resolve(file);if(cache.has(file))return cache.get(file).exports
  const m={exports:{}};cache.set(file,m)
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'__jsx',jsxFragmentFactory:'__fragment'},fileName:file}).outputText
  const req=name=>{if(name==='scripting')return ui;let dest=path.resolve(path.dirname(file),name);dest=['.ts','.tsx'].map(ext=>dest+ext).find(fs.existsSync)||dest
   if(dest===project+'/services/repoStore.ts')return store
   if(dest===project+'/services/git/runtime.ts')return runtime
   if(overrides[dest])return overrides[dest]
   return read(dest)}
  new Function('require','module','exports',code)(req,m,m.exports);return m.exports
 }
 return relative=>read(project+'/'+relative)
}
const load=loader(),service=load('services/gitService.ts'),coordinator=load('services/git/matrixScanService.ts').statusCoordinator
let count=0
async function test(name,fn){await fn();console.log('PASS '+name);count++}
async function disk(name,bytes){await fs.promises.mkdir(path.dirname(dir+'/'+name),{recursive:true});await fs.promises.writeFile(dir+'/'+name,bytes)}
async function main(){
 await git.init({fs,dir,defaultBranch:'main'});await disk('a.txt','HEAD text');await disk('folder/b.txt','nested');await disk('image.bin',Buffer.from([0,255,4]));await git.add({fs,dir,filepath:'.'});await git.commit({fs,dir,author:{name:'test',email:'test@example.invalid'},message:'baseline'})
 await test('reads current worktree not HEAD; lossless UTF8/BOM/CRLF/empty saves; real Git matrix M with unchanged index/HEAD',async()=>{
  await disk('a.txt','worktree text');let file=await service.readLocalWorktreeFile('repo','a.txt');assert.equal(file.text,'worktree text')
  const originalIndex=fs.readFileSync(dir+'/.git/index'),head=await git.resolveRef({fs,dir,ref:'HEAD'})
  for(const value of ['\ufeff中文😀\r\nnext\r\n','']){file=await service.saveLocalWorktreeFile('repo',file,value);assert.equal(fs.readFileSync(dir+'/a.txt','utf8'),value);assert.equal(file.text,value)}
  assert.deepEqual(fs.readFileSync(dir+'/.git/index'),originalIndex);assert.equal(await git.resolveRef({fs,dir,ref:'HEAD'}),head)
  const matrix=await git.statusMatrix({fs,dir});assert.deepEqual(matrix.find(r=>r[0]==='a.txt'),['a.txt',1,2,1]);const changes=await service.getChanges('repo');assert.equal(changes.find(c=>c.filepath==='a.txt').status,'*modified');assert.equal(changes.find(c=>c.filepath==='a.txt').staged,false)
  await disk('new-untracked.txt','new');const tracked=await load('services/git/statusQueryService.ts').getTrackedFiles('repo');assert.ok(!tracked.includes('new-untracked.txt'));assert.ok(tracked.includes('a.txt'))
 })
 await test('real binary/invalid UTF8/large text readonly; single binary deletion yields real Git D without staging',async()=>{
  let image=await service.readLocalWorktreeFile('repo','image.bin');assert.equal(image.text,null);await assert.rejects(service.saveLocalWorktreeFile('repo',image,'bad'),/只读|UTF-8/)
  await disk('invalid.bin',Buffer.from([0xc3,0x28]));assert.equal((await service.readLocalWorktreeFile('repo','invalid.bin')).text,null)
  await disk('large.txt','x'.repeat(512*1024+1));const large=await service.readLocalWorktreeFile('repo','large.txt');assert.equal(large.text,null);await assert.rejects(service.saveLocalWorktreeFile('repo',large,'small'),/512/)
  await service.deleteLocalWorktreeFile('repo',image);assert.ok(!fs.existsSync(dir+'/image.bin'));assert.deepEqual((await git.statusMatrix({fs,dir})).find(r=>r[0]==='image.bin'),['image.bin',1,0,1])
  await assert.rejects(service.readLocalWorktreeFile('repo','image.bin'),/不存在/)
  const change=(await service.getChanges('repo')).find(c=>c.filepath==='image.bin');assert.equal(change.status,'*deleted');assert.equal(change.worktreeDeleted,true);assert.equal(change.staged,false)
 })
 await test('unsafe paths, .git, directories, root, symlink leaf/ancestor and changed-to-symlink refused; outside bytes preserved',async()=>{
  fs.writeFileSync(outside+'/secret','precious');fs.symlinkSync(outside,dir+'/linkdir');fs.symlinkSync(outside+'/secret',dir+'/linkfile')
  const before=[writes,removes]
  for(const value of ['', '.', '..','../outside/secret','/etc/passwd','a/../../x','.git/config','folder/.GIT/config','folder//b.txt','folder/./b.txt','folder','linkfile','linkdir/secret','a\\b'])await assert.rejects(service.readLocalWorktreeFile('repo',value))
  await disk('swap.txt','original');const file=await service.readLocalWorktreeFile('repo','swap.txt');fs.unlinkSync(dir+'/swap.txt');fs.symlinkSync(outside+'/secret',dir+'/swap.txt')
  await assert.rejects(service.saveLocalWorktreeFile('repo',file,'overwrite'),/符号链接/);await assert.rejects(service.deleteLocalWorktreeFile('repo',file),/符号链接/)
  assert.deepEqual([writes,removes],before);assert.equal(fs.readFileSync(outside+'/secret','utf8'),'precious')
 })
 await test('external changes checked by bytes even if size/time restored; directory replacement and bookmark target relocation refused',async()=>{
  await disk('conflict.txt','before');const file=await service.readLocalWorktreeFile('repo','conflict.txt');await disk('conflict.txt','AFTER!');fs.utimesSync(dir+'/conflict.txt',new Date(file.version.modified),new Date(file.version.modified))
  await assert.rejects(service.saveLocalWorktreeFile('repo',file,'draft'),/外部修改|变化/);await assert.rejects(service.deleteLocalWorktreeFile('repo',file),/外部修改|变化/);assert.equal(fs.readFileSync(dir+'/conflict.txt','utf8'),'AFTER!')
  const fresh=await service.readLocalWorktreeFile('repo','conflict.txt');fs.unlinkSync(dir+'/conflict.txt');fs.mkdirSync(dir+'/conflict.txt');await assert.rejects(service.deleteLocalWorktreeFile('repo',fresh),/目录/)
  await disk('relocate.txt','same');const r=await service.readLocalWorktreeFile('repo','relocate.txt');root=outside;fs.writeFileSync(outside+'/relocate.txt','same');await assert.rejects(service.saveLocalWorktreeFile('repo',r,'bad'),/外部修改/);root=dir
 })
 await test('production facade waits real read barrier and invalidates cache revision; duplicate mutation rejected, no hidden snapshot scan',async()=>{
  await disk('lock.txt','old');const file=await service.readLocalWorktreeFile('repo','lock.txt'),gate=deferred();let entered=false
  const pendingRead=coordinator.read(ctx.gitdir,()=>gate.promise);const start=coordinator.revision(ctx.gitdir)
  const oldGit=ctx.git;let scans=0;ctx.git={...git,statusMatrix:async options=>{scans++;return git.statusMatrix(options)}}
  const saving=service.saveLocalWorktreeFile('repo',file,'new').then(r=>{entered=true;return r});await tick();assert.equal(entered,false);assert.equal(fs.readFileSync(dir+'/lock.txt','utf8'),'old')
  await assert.rejects(service.deleteLocalWorktreeFile('repo',file),/写|操作/);gate.resolve();await pendingRead;await saving;assert.ok(coordinator.revision(ctx.gitdir)>start);assert.equal(fs.readFileSync(dir+'/lock.txt','utf8'),'new');assert.equal(scans,0);ctx.git=oldGit
 })
 const Editor=load('pages/LocalFileEditor.tsx').LocalFileEditor
 await test('UI save single-flight; errors preserve latest draft; typed-during-save remains dirty; close cancellation/protection and disposal',async()=>{
  await disk('ui.txt','old');const file=await service.readLocalWorktreeFile('repo','ui.txt');let closed=0,changed=0
  const h=mount(Editor,{bookmarkName:'repo',file,onClose:()=>closed++,onReload(){},onChanged:()=>changed++}),controller=controllers.at(-1)
  controller.content='draft';await disk('ui.txt','external');await node(h,'Button','保存到本地').props.action();assert.match(text(h),/外部修改/);assert.equal(controller.content,'draft');assert.equal(changed,0)
  confirm=false;await node(h,'Button','关闭').props.action();assert.equal(closed,0);assert.equal(controller.content,'draft');confirm=true;await node(h,'Button','关闭').props.action();assert.equal(closed,1);h.unmount();assert.ok(controller.disposed)
  await disk('ui.txt','base');const fresh=await service.readLocalWorktreeFile('repo','ui.txt'),gate=deferred();const native=FileManager.writeAsData;let call=0;const started=deferred()
  FileManager.writeAsData=async(p,data)=>{call++;started.resolve();await gate.promise;await native(p,data)}
  const second=mount(Editor,{bookmarkName:'repo',file:fresh,onClose:()=>closed++,onReload(){},onChanged:()=>changed++}),c=controllers.at(-1);c.content='saved'
  const save=node(second,'Button','保存到本地').props.action();await started.promise;await node(second,'Button','保存到本地').props.action();await node(second,'Button','关闭').props.action();assert.equal(call,1);assert.equal(closed,1)
  c.content='typed later';gate.resolve();await save;assert.equal(fs.readFileSync(dir+'/ui.txt','utf8'),'saved');assert.equal(c.content,'typed later');assert.match(text(second),/新的未保存/);assert.equal(changed,1);second.unmount();FileManager.writeAsData=native
 })
 await test('native write/remove errors keep file and editor draft; retry only writes after success',async()=>{
  await disk('io-error.txt','old');const file=await service.readLocalWorktreeFile('repo','io-error.txt');let changed=0,closed=0
  const h=mount(Editor,{bookmarkName:'repo',file,onClose:()=>closed++,onReload(){},onChanged:()=>changed++}),c=controllers.at(-1);c.content='important draft'
  const write=FileManager.writeAsData,remove=FileManager.remove
  FileManager.writeAsData=async()=>{throw Error('permission denied')};await node(h,'Button','保存到本地').props.action();assert.equal(c.content,'important draft');assert.match(text(h),/permission denied/);assert.equal(fs.readFileSync(dir+'/io-error.txt','utf8'),'old');assert.equal(changed,0)
  FileManager.remove=async()=>{throw Error('delete failed')};confirm=true;await node(h,'Button','删除文件').props.action();assert.equal(c.content,'important draft');assert.equal(closed,0);assert.ok(fs.existsSync(dir+'/io-error.txt'))
  FileManager.writeAsData=write;FileManager.remove=remove;await node(h,'Button','保存到本地').props.action();assert.equal(fs.readFileSync(dir+'/io-error.txt','utf8'),'important draft');assert.equal(changed,1);h.unmount()
 })
 await test('UI delete requires explicit confirmation including binary; cancel leaves bytes, confirm deletes once; reload draft protection',async()=>{
  await disk('ui-delete.bin',Buffer.from([0,255]));let closed=0,changed=0,reloaded=0;const file=await service.readLocalWorktreeFile('repo','ui-delete.bin')
  const h=mount(Editor,{bookmarkName:'repo',file,onClose:()=>closed++,onReload:()=>reloaded++,onChanged:(_,d)=>{assert.equal(d,true);changed++}})
  assert.equal(all(h.tree).some(n=>n.props?.title==='保存到本地'),false);confirm=false;await node(h,'Button','删除文件').props.action();assert.ok(fs.existsSync(dir+'/ui-delete.bin'));assert.match(confirmations.at(-1).message,/只删除当前工作区这个文件/)
  confirm=true;await node(h,'Button','删除文件').props.action();assert.equal(changed,1);assert.equal(closed,1);assert.ok(!fs.existsSync(dir+'/ui-delete.bin'));h.unmount()
  await disk('reload.txt','initial');const fresh=await service.readLocalWorktreeFile('repo','reload.txt'),r=mount(Editor,{bookmarkName:'repo',file:fresh,onClose(){},onReload:f=>{assert.equal(f.text,'disk new');reloaded++},onChanged(){}}),c=controllers.at(-1);c.content='draft';await disk('reload.txt','disk new')
  confirm=false;await node(r,'Button','重新加载文件').props.action();assert.equal(reloaded,0);assert.equal(c.content,'draft');confirm=true;await node(r,'Button','重新加载文件').props.action();assert.equal(reloaded,1);r.unmount()
 })
 await test('FilesTab actual tree opens worktree/editor, directory disclosure retained; deleted leaf disabled and refresh callback runs once',async()=>{
  const FilesTab=load('pages/FilesTab.tsx').FilesTab;let updates=0
  const h=mount(FilesTab,{files:['folder/b.txt','a.txt','image.bin'],loading:false,bookmarkName:'repo',changes:[{filepath:'image.bin',status:'*deleted',worktreeDeleted:true}],onWorktreeChanged:()=>updates++})
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  let expanded=expand(h.tree);assert.ok(all(expanded).some(n=>n.type==='DisclosureGroup'));const deleted=all(expanded).find(n=>n.type==='Button'&&JSON.stringify(n.children).includes('image.bin'));assert.equal(deleted.props.disabled,true)
  const leaf=all(expanded).find(n=>n.type==='Button'&&JSON.stringify(n.children).includes('a.txt'));await leaf.props.action();h.render();const cover=h.tree.props.fullScreenCover;assert.equal(cover.isPresented,true);assert.equal(cover.content.props.file.text,fs.readFileSync(dir+'/a.txt','utf8'))
  await cover.content.props.onChanged('a.txt',true);h.render();expanded=expand(h.tree);assert.equal(all(expanded).find(n=>n.type==='Button'&&JSON.stringify(n.children).includes('a.txt')).props.disabled,true);assert.equal(updates,1);h.unmount()
 })
 console.log(`\n${count} local data/facade/UI groups passed; real disposable Git repo only, no network/user data.`)
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}))
