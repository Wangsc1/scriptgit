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
 copyFile:async (src,dest)=>fs.promises.copyFile(src,dest,fs.constants.COPYFILE_EXCL),rename:async (src,dest)=>fs.promises.rename(src,dest),
 remove:async p=>{removes++;await fs.promises.rm(p,{recursive:true})},
}
global.Device={systemVersion:'26'}
global.EditorController=class{constructor(options){Object.assign(this,options);controllers.push(this)}dispose(){this.disposed=true}}
global.Dialog={confirm:async input=>{confirmations.push(input);return confirm}}
const ctx={git,fs,dir,gitdir:dir+'/.git'}
const runtime={resolveGitdir:()=>ctx.gitdir,getCtx:async()=>ctx,checkoutWithEmptyDirCleanup:(git,fs,options)=>git.checkout({fs,...options})}
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
 await test('image safe data preview, bounded reads, no text Editor payload; native copy/rename keep binary bytes and HEAD/index unchanged',async()=>{
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,255]);await disk('photo.png',bytes)
  const file=await service.openLocalWorktreeFile('repo','photo.png');assert.equal(file.text,null);assert.equal(file.previewUrl,'data:image/png;base64,'+bytes.toString('base64'))
  assert.equal(await service.copyLocalWorktreeFile('repo',file,'photo 副本.png'),'photo 副本.png');assert.deepEqual(fs.readFileSync(dir+'/photo 副本.png'),bytes);assert.deepEqual(fs.readFileSync(dir+'/photo.png'),bytes)
  const copy=await service.readLocalWorktreeFile('repo','photo 副本.png');assert.equal(await service.renameLocalWorktreeFile('repo',copy,'renamed.png'),'renamed.png');assert.ok(!fs.existsSync(dir+'/photo 副本.png'));assert.deepEqual(fs.readFileSync(dir+'/renamed.png'),bytes)
  for(const name of ['../bad','a/b','a\\b','.git','.GIT','','..',' bad','bad.','bad:foo','PHOTO.PNG']) await assert.rejects(service.copyLocalWorktreeFile('repo',file,name),/合法|同名/)
  await assert.rejects(service.renameLocalWorktreeFile('repo',file,'PHOTO.PNG'),/同名/);await assert.rejects(service.copyLocalWorktreeFile('repo',file,'renamed.png'),/同名/)
  await disk('photo.png',Buffer.from('outside changed'));await assert.rejects(service.renameLocalWorktreeFile('repo',file,'moved.png'),/修改|变化/);assert.ok(!fs.existsSync(dir+'/moved.png'))
  await disk('large.png',Buffer.alloc(8*1024*1024+1));await assert.rejects(service.openLocalWorktreeFile('repo','large.png'),/8 MiB/)
  const matrix=await git.statusMatrix({fs,dir});assert.deepEqual(matrix.find(r=>r[0]==='renamed.png').slice(1),[0,2,0])
 })
 await test('copy/rename failures, symlinks, outside changes and real mutation read barrier preserve originals; large binary native copy does not load into JS',async()=>{
  await disk('native.bin',Buffer.alloc(1024*1024,0xa5));const file=await service.readLocalWorktreeFile('repo','native.bin')
  const copy=FileManager.copyFile,rename=FileManager.rename,read=FileManager.readAsData
  FileManager.readAsData=async()=>{throw Error('large binary must not be read into JS')}
  await service.copyLocalWorktreeFile('repo',file,'native copied.bin');assert.deepEqual(fs.readFileSync(dir+'/native copied.bin'),fs.readFileSync(dir+'/native.bin'));FileManager.readAsData=read
  FileManager.copyFile=async()=>{throw Error('copy denied')};await assert.rejects(service.copyLocalWorktreeFile('repo',file,'denied.bin'),/copy denied/);assert.ok(fs.existsSync(dir+'/native.bin'));assert.ok(!fs.existsSync(dir+'/denied.bin'));FileManager.copyFile=copy
  FileManager.rename=async()=>{throw Error('rename denied')};await assert.rejects(service.renameLocalWorktreeFile('repo',file,'denied.bin'),/rename denied/);assert.ok(fs.existsSync(dir+'/native.bin'));FileManager.rename=rename
  fs.symlinkSync(outside+'/missing',dir+'/dangling.bin');await assert.rejects(service.copyLocalWorktreeFile('repo',file,'dangling.bin'),/同名|存在/);assert.ok(fs.lstatSync(dir+'/dangling.bin').isSymbolicLink())
  const gate=deferred(),active=coordinator.read(ctx.gitdir,()=>gate.promise);let done=false
  const pending=service.copyLocalWorktreeFile('repo',file,'barrier.bin').then(()=>done=true);await tick();assert.equal(done,false);assert.ok(!fs.existsSync(dir+'/barrier.bin'))
  await assert.rejects(service.renameLocalWorktreeFile('repo',file,'blocked.bin'),/写|操作/);gate.resolve();await active;await pending;assert.ok(fs.existsSync(dir+'/barrier.bin'));assert.ok(fs.existsSync(dir+'/native.bin'))
 })
 await test('file swipe/context menus: folder delete available, cancel preserves row, confirm binary delete, copy/rename prompt/new tree and errors visible',async()=>{
  await disk('menu.bin',Buffer.from([0,255,1]));let updates=0,opened=null
  const FilesTab=load('pages/FilesTab.tsx').FilesTab,props={files:['menu.bin','folder/b.txt'],loading:false,bookmarkName:'repo',changes:[],onWorktreeChanged:()=>updates++,onOpen:f=>opened=f}
  const h=mount(FilesTab,props)
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  const row=name=>{h.render();return all(expand(h.tree)).find(n=>n.type==='Button'&&n.props.trailingSwipeActions&&JSON.stringify(n.children).includes(name))}
  const action=(name,title)=>all(row(name).props.contextMenu.menuItems).find(n=>n.type==='Button'&&n.props.title===title)
  const swipe=()=>row('menu.bin').props.trailingSwipeActions.actions[0]
  assert.equal(swipe().props.title,'删除');assert.equal(swipe().props.role,undefined);assert.equal(row('menu.bin').props.trailingSwipeActions.allowsFullSwipe,false)
  assert.deepEqual(all(expand(h.tree)).find(n=>n.type==='DisclosureGroup').props.trailingSwipeActions.actions.map(a=>a.props.title),['删除'])
  confirm=false;await swipe().props.action();assert.ok(fs.existsSync(dir+'/menu.bin'));assert.equal(swipe().props.disabled,false);assert.equal(updates,0)
  let next=null;global.Dialog.prompt=async()=>next
  await action('menu.bin','复制文件').props.action();await action('menu.bin','重命名').props.action();assert.ok(!fs.existsSync(dir+'/menu 副本.bin'));assert.ok(fs.existsSync(dir+'/menu.bin'));assert.equal(updates,0)
  next='menu 副本.bin';await action('menu.bin','复制文件').props.action();assert.deepEqual(fs.readFileSync(dir+'/menu 副本.bin'),Buffer.from([0,255,1]));assert.ok(row('menu 副本.bin'));assert.equal(updates,1)
  next='../bad';await action('menu.bin','重命名').props.action();assert.match(text(h),/合法/);assert.ok(fs.existsSync(dir+'/menu.bin'))
  next='menu renamed.bin';await action('menu 副本.bin','重命名').props.action();assert.ok(row('menu renamed.bin'));assert.ok(!fs.existsSync(dir+'/menu 副本.bin'));assert.equal(updates,2)
  // 删除确认期间更改外部内容：拒绝删除，行保留且有可见错误。
  global.Dialog.confirm=async()=>{await disk('menu.bin','changed');return true};await swipe().props.action();assert.match(text(h),/修改|变化/);assert.ok(fs.existsSync(dir+'/menu.bin'));assert.equal(swipe().props.disabled,false)
  global.Dialog.confirm=async input=>{confirmations.push(input);return confirm};confirm=true;await swipe().props.action();assert.ok(!fs.existsSync(dir+'/menu.bin'));assert.equal(swipe().props.disabled,true);assert.equal(updates,3)
  // 图片打开仅传预览快照，交由稳定父List路由ImageViewer。
  await disk('click.png',Buffer.from([137,80,78,71]));props.files=[...props.files,'click.png'];h.render();const pic=all(expand(h.tree)).find(n=>n.type==='Button'&&!n.props.title&&JSON.stringify(n.children).includes('click.png'));await pic.props.action();assert.match(opened.previewUrl,/^data:image\/png;base64,/);assert.equal(opened.text,null);h.unmount()
 })
 await test('folder deletion: recursive content, root/traversal/symlink and nested Git protection; index/HEAD unchanged',async()=>{
  const index=fs.readFileSync(dir+'/.git/index'),head=await git.resolveRef({fs,dir,ref:'HEAD'})
  await disk('delete-folder/sub/untracked','data');await disk('delete-folder/a','data')
  await service.deleteLocalWorktreeDirectory('repo','delete-folder');assert.ok(!fs.existsSync(dir+'/delete-folder'))
  for(const unsafe of ['', '.', '..', '../outside', '.git', '/tmp']) await assert.rejects(service.deleteLocalWorktreeDirectory('repo',unsafe))
  await disk('protected-folder/.git/config','nested git');await assert.rejects(service.deleteLocalWorktreeDirectory('repo','protected-folder'),/Git/);assert.ok(fs.existsSync(dir+'/protected-folder/.git/config'))
  await disk('linked-folder/keep','data');fs.symlinkSync(outside,dir+'/linked-folder/link');await assert.rejects(service.deleteLocalWorktreeDirectory('repo','linked-folder'),/链接/);assert.ok(fs.existsSync(dir+'/linked-folder/keep'))
  assert.deepEqual(fs.readFileSync(dir+'/.git/index'),index);assert.equal(await git.resolveRef({fs,dir,ref:'HEAD'}),head)
 })
 await test('folder swipe: nested changes show three text buttons, boundary excludes siblings, cancel and confirm recursive delete',async()=>{
  await disk('swipe-folder/sub/a','data');let updates=0,pushes=0
  const props={files:['swipe-folder/sub/a','swipe-folder-other/b'],loading:false,bookmarkName:'repo',changes:[{filepath:'swipe-folder/sub/a',status:'*modified'}],onWorktreeChanged:()=>updates++,onOpen(){},onPush:()=>pushes++,onRestore(){},mergeInProgress:false}
  const h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  function folders(){h.render();return all(expand(h.tree)).filter(n=>n.type==='DisclosureGroup')}
  let groups=folders();groups[0].props.onChanged(true);groups=folders();let a=groups[0].props.trailingSwipeActions.actions
  assert.match(JSON.stringify(groups[0].props.label),/已修改/);assert.match(JSON.stringify(groups[1].props.label),/已修改/);assert.doesNotMatch(JSON.stringify(groups.at(-1).props.label),/已修改/);assert.deepEqual(a.map(n=>n.props.title),['还原','提交','删除']);assert.ok(a.every(n=>!n.props.systemImage));assert.equal(groups[0].props.trailingSwipeActions.allowsFullSwipe,false)
  assert.deepEqual(groups.at(-1).props.trailingSwipeActions.actions.map(n=>n.props.title),['删除'])
  await a[1].props.action();assert.equal(pushes,1)
  confirm=false;await a[0].props.action();assert.ok(fs.existsSync(dir+'/swipe-folder/sub/a'))
  confirm=false;await a[2].props.action();assert.ok(fs.existsSync(dir+'/swipe-folder/sub/a'))
  confirm=true;await a[2].props.action();assert.ok(!fs.existsSync(dir+'/swipe-folder'));assert.ok(updates>0);h.unmount()
 })
 await test('folder restore routes changed descendants to shared parent confirmation without changing disk',async()=>{
  await disk('folder/b.txt','changed inside');await disk('a.txt','changed outside');let request
  const props={files:['folder/b.txt','a.txt'],loading:false,bookmarkName:'repo',changes:[{filepath:'folder/b.txt',status:'*modified'},{filepath:'a.txt',status:'*modified'}],onWorktreeChanged(){},onOpen(){},onPush(){},onRestore:(...args)=>request=args,mergeInProgress:false}
  const h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  const group=all(expand(h.tree)).find(n=>n.type==='DisclosureGroup'),before=confirmations.length
  await group.props.trailingSwipeActions.actions[0].props.action()
  assert.deepEqual(request,['folder',['folder/b.txt']]);assert.equal(confirmations.length,before)
  assert.equal(fs.readFileSync(dir+'/folder/b.txt','utf8'),'changed inside');assert.equal(fs.readFileSync(dir+'/a.txt','utf8'),'changed outside');h.unmount()
 })
 await test('documented Editor lifecycle: single controller across renders, disposal only unmount, initialization failure visible, binary has no controller',async()=>{
  await disk('lifecycle.txt','draft');const file=await service.readLocalWorktreeFile('repo','lifecycle.txt');let closed=0
  const props={bookmarkName:'repo',file,onClose:()=>closed++,onReload(){},onChanged(){}}
  const before=controllers.length,h=mount(Editor,props),controller=controllers.at(-1)
  h.render();h.render();assert.equal(controllers.length,before+1);assert.equal(controller.disposed,undefined);assert.equal(node(h,'Editor').props.controller,controller)
  await node(h,'Button','返回').props.action();assert.equal(closed,1);assert.equal(controller.disposed,undefined);h.unmount();assert.equal(controller.disposed,true)
  const reopened=mount(Editor,props);assert.notEqual(controllers.at(-1),controller);reopened.unmount()
  const Native=global.EditorController;global.EditorController=class{constructor(){throw Error('native init rejected')}}
  const failed=mount(Editor,props);assert.match(text(failed),/编辑器初始化失败.*native init rejected/);assert.equal(all(failed.tree).filter(n=>n.type==='Editor').length,0);await node(failed,'Button','返回').props.action();failed.unmount()
  const binary=mount(Editor,{...props,file:{...file,text:null,readOnlyReason:'binary'}});assert.equal(all(binary.tree).filter(n=>n.type==='Editor').length,0);assert.doesNotMatch(text(binary),/初始化失败/);binary.unmount();global.EditorController=Native
 })
 const bar=h=>{h.render();assert.equal(h.tree.type,'NavigationStack');return h.tree.children[0].props.toolbar}
 const back=h=>bar(h).topBarLeading.props.action(),refresh=h=>bar(h).topBarTrailing.props.action()
 await test('toolbar text/no stale controls; back with no change leaves without write; binary back does not save',async()=>{
  await disk('embyicon.json','initial');const file=await service.readLocalWorktreeFile('repo','embyicon.json');let closed=0,changed=0;const before=writes
  const h=mount(Editor,{bookmarkName:'repo',file,onClose:()=>closed++,onReload(){},onChanged:()=>changed++})
  assert.equal(h.tree.children[0].props.navigationTitle,'embyicon.json');assert.equal(bar(h).topBarLeading.props.title,'返回');assert.equal(bar(h).topBarTrailing.props.title,'刷新');const body=h.tree.children[0].children;assert.equal(all(body).some(n=>n.type==='List'),false);assert.equal(all(body).some(n=>n.type==='Button'),false)
  assert.doesNotMatch(text(h),/保存|关闭|删除文件|重新加载文件|下拉刷新|修改仅保存到本地工作区/);assert.equal(all(h.tree).filter(n=>n.type==='Text'&&n.children.includes('embyicon.json')).length,0);assert.equal(h.tree.children[0].children.at(-1).props.refreshable,undefined)
  await back(h);assert.equal(closed,1);assert.equal(writes,before);assert.equal(changed,0);h.unmount()
  await disk('ro.bin',Buffer.from([0,255]));const bin=await service.readLocalWorktreeFile('repo','ro.bin'),r=mount(Editor,{bookmarkName:'repo',file:bin,onClose:()=>closed++,onReload(){},onChanged:()=>changed++});await back(r);assert.equal(closed,2);assert.equal(writes,before);r.unmount()
 })
 await test('back automatically saves dirty text then closes; stage/commit untouched; success refreshes changes once',async()=>{
  await disk('autosave.txt','old');const file=await service.readLocalWorktreeFile('repo','autosave.txt');let closed=0,changed=0
  const h=mount(Editor,{bookmarkName:'repo',file,onClose:()=>closed++,onReload(){},onChanged:p=>{assert.equal(p,'autosave.txt');changed++}}),c=controllers.at(-1);c.content='new draft'
  await back(h);assert.equal(fs.readFileSync(dir+'/autosave.txt','utf8'),'new draft');assert.equal(closed,1);assert.equal(changed,1);assert.deepEqual((await git.statusMatrix({fs,dir,filepaths:['autosave.txt']}))[0],['autosave.txt',0,2,0]);h.unmount()
  const warn=console.warn,warnings=[];console.warn=m=>warnings.push(m);await disk('autosave2.txt','old');const f2=await service.readLocalWorktreeFile('repo','autosave2.txt')
  const r=mount(Editor,{bookmarkName:'repo',file:f2,onClose:()=>closed++,onReload(){},onChanged:async()=>{throw Error('status failed')}}),c2=controllers.at(-1);c2.content='saved2';await back(r);console.warn=warn;assert.equal(fs.readFileSync(dir+'/autosave2.txt','utf8'),'saved2');assert.equal(closed,2);assert.ok(warnings.some(x=>/status failed/.test(x)));r.unmount()
 })
 await test('back stays on page for write failure, external conflict, in-flight save; draft/file preserved; no double operations',async()=>{
  await disk('back-conflict.txt','old');const file=await service.readLocalWorktreeFile('repo','back-conflict.txt');let closed=0,changed=0
  const h=mount(Editor,{bookmarkName:'repo',file,onClose:()=>closed++,onReload(){},onChanged:()=>changed++}),c=controllers.at(-1);c.content='my draft';await disk('back-conflict.txt','external edit')
  await back(h);assert.equal(closed,0);assert.equal(changed,0);assert.match(text(h),/外部修改.*未返回/);assert.equal(c.content,'my draft');assert.equal(fs.readFileSync(dir+'/back-conflict.txt','utf8'),'external edit');assert.equal(bar(h).topBarLeading.props.disabled,false)
  await disk('back-failure.txt','old');const f2=await service.readLocalWorktreeFile('repo','back-failure.txt'),r=mount(Editor,{bookmarkName:'repo',file:f2,onClose:()=>closed++,onReload(){},onChanged:()=>changed++}),c2=controllers.at(-1);c2.content='draft2'
  const write=FileManager.writeAsData;FileManager.writeAsData=async()=>{throw Error('permission denied')};await back(r);FileManager.writeAsData=write;assert.equal(closed,0);assert.match(text(r),/permission denied.*未返回/);assert.equal(c2.content,'draft2');assert.equal(fs.readFileSync(dir+'/back-failure.txt','utf8'),'old')
  await back(r);assert.equal(closed,1);assert.equal(fs.readFileSync(dir+'/back-failure.txt','utf8'),'draft2');r.unmount();h.unmount()
  await disk('back-inflight.txt','base');const f3=await service.readLocalWorktreeFile('repo','back-inflight.txt'),gate=deferred(),started=deferred();let call=0;const native=FileManager.writeAsData;FileManager.writeAsData=async(p,data)=>{call++;started.resolve();await gate.promise;await native(p,data)}
  const x=mount(Editor,{bookmarkName:'repo',file:f3,onClose:()=>closed++,onReload(){},onChanged(){}}),c3=controllers.at(-1);c3.content='slow';const first=back(x);await started.promise;assert.equal(bar(x).topBarLeading.props.disabled,true);assert.equal(bar(x).topBarTrailing.props.disabled,true);await back(x);await refresh(x);assert.equal(call,1);assert.equal(closed,1);gate.resolve();await first;assert.equal(closed,2);assert.equal(fs.readFileSync(dir+'/back-inflight.txt','utf8'),'slow');FileManager.writeAsData=native;x.unmount()
 })
 await test('refresh preserves draft by confirmation; cancel/fail/in-flight lock; no automatic save on refresh',async()=>{
  await disk('refresh.txt','initial');const fresh=await service.readLocalWorktreeFile('repo','refresh.txt');let reloaded=0,changed=0,closed=0
  const r=mount(Editor,{bookmarkName:'repo',file:fresh,onClose:()=>closed++,onReload:f=>{assert.equal(f.text,'disk new');reloaded++},onChanged:()=>changed++}),c=controllers.at(-1)
  c.content='draft';await disk('refresh.txt','disk new');confirm=false;await refresh(r);assert.equal(reloaded,0);assert.equal(c.content,'draft');assert.match(confirmations.at(-1).title,/刷新并放弃草稿/);assert.equal(fs.readFileSync(dir+'/refresh.txt','utf8'),'disk new');assert.equal(changed,0)
  const gate=deferred();let prompts=0;global.Dialog.confirm=async()=>{prompts++;return gate.promise}
  const pending=refresh(r);await tick();assert.equal(bar(r).topBarLeading.props.disabled,true);assert.equal(bar(r).topBarTrailing.props.disabled,true);await refresh(r);await back(r);assert.equal(prompts,1);assert.equal(closed,0)
  gate.resolve(true);await pending;assert.equal(reloaded,1);assert.equal(bar(r).topBarTrailing.props.disabled,false)
  global.Dialog.confirm=async input=>{confirmations.push(input);return true};const read=FileManager.readAsData;FileManager.readAsData=async()=>{throw Error('reload denied')};await refresh(r);FileManager.readAsData=read
  assert.match(text(r),/reload denied/);assert.equal(c.content,'draft');assert.equal(c.disposed,undefined);assert.equal(reloaded,1);global.Dialog.confirm=async()=>{throw Error('confirm failed')};await refresh(r);assert.match(text(r),/confirm failed/);assert.equal(c.content,'draft');assert.equal(bar(r).topBarTrailing.props.disabled,false)
  r.unmount();assert.equal(c.disposed,true);global.Dialog.confirm=async input=>{confirmations.push(input);return confirm}
 })
 await test('native write errors keep draft; retry only writes after success',async()=>{
  await disk('io-error.txt','old');const file=await service.readLocalWorktreeFile('repo','io-error.txt');let changed=0,closed=0
  const h=mount(Editor,{bookmarkName:'repo',file,onClose:()=>closed++,onReload(){},onChanged:()=>changed++}),c=controllers.at(-1);c.content='important draft'
  const write=FileManager.writeAsData
  FileManager.writeAsData=async()=>{throw Error('permission denied')};await back(h);assert.equal(c.content,'important draft');assert.equal(closed,0);assert.equal(fs.readFileSync(dir+'/io-error.txt','utf8'),'old')
  FileManager.writeAsData=write;await back(h);assert.equal(fs.readFileSync(dir+'/io-error.txt','utf8'),'important draft');assert.equal(closed,1);assert.equal(changed,1);h.unmount()
 })
 await test('FilesTab actual tree dispatches current worktree to parent; directories retained, deleted leaf disabled and opening does not trigger mutation refresh',async()=>{
  const FilesTab=load('pages/FilesTab.tsx').FilesTab;let updates=0,opened=null
  const h=mount(FilesTab,{files:['folder/b.txt','a.txt','image.bin'],loading:false,bookmarkName:'repo',changes:[{filepath:'image.bin',status:'*deleted',worktreeDeleted:true}],onWorktreeChanged:()=>updates++,onOpen:file=>opened=file})
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  let expanded=expand(h.tree);assert.ok(all(expanded).some(n=>n.type==='DisclosureGroup'));const deleted=all(expanded).find(n=>n.type==='Button'&&JSON.stringify(n.children).includes('image.bin'));assert.equal(deleted.props.disabled,true)
  const leaf=all(expanded).find(n=>n.type==='Button'&&JSON.stringify(n.children).includes('a.txt'));await leaf.props.action();h.render();assert.equal(h.tree.props.fullScreenCover,undefined);assert.equal(opened.text,fs.readFileSync(dir+'/a.txt','utf8'));assert.equal(updates,0);h.unmount()
 })
 console.log(`\n${count} local data/facade/UI groups passed; real disposable Git repo only, no network/user data.`)
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}))
