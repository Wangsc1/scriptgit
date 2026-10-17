/* Real local-file service + facade/coordinator + real isomorphic-git on disposable test repos. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),ts=require('typescript')
const {ui,mount,node,all,text,tick,deferred}=require('./remoteFiles.test.cjs')
global.self=globalThis
const project=path.resolve(__dirname,'..'),git=require('../vendor/index.umd.min.js')
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-local-test-')),dir=tmp+'/work',outside=tmp+'/outside'
fs.mkdirSync(dir);fs.mkdirSync(outside)
let writes=0,removes=0,confirm=true,confirmations=[],controllers=[],root=dir
// Native FileManager semantics on a disposable directory; never touches user repositories.
global.FileManager={temporaryDirectory:tmp,scriptsDirectory:tmp,appGroupDocumentsDirectory:tmp,documentsDirectory:tmp,
 readDirectory:async p=>fs.promises.readdir(p),
 createDirectory:async p=>fs.promises.mkdir(p),
 exists:async p=>fs.existsSync(p),isLink:async p=>{try{return (await fs.promises.lstat(p)).isSymbolicLink()}catch(e){if(e.code==='ENOENT')return false;throw e}},
 isDirectory:async p=>(await fs.promises.stat(p)).isDirectory(),isFile:async p=>(await fs.promises.stat(p)).isFile(),
 stat:async p=>{const s=await fs.promises.stat(p);return {size:s.size,creationDate:s.birthtimeMs,modificationDate:s.mtimeMs,type:s.isDirectory()?'directory':'file'}},
 readAsData:async p=>new Data(await fs.promises.readFile(p)),writeAsData:async(p,data)=>{writes++;await fs.promises.writeFile(p,data.bytes)},
 copyFile:async (src,dest)=>fs.promises.copyFile(src,dest,fs.constants.COPYFILE_EXCL),rename:async (src,dest)=>fs.promises.rename(src,dest),
 remove:async p=>{removes++;await fs.promises.rm(p,{recursive:true})},
}
global.UIImage={fromFile:path=>({preparingThumbnail:size=>({nativeThumbnail:true,path,size})})}
global.Device={systemVersion:'26'}
global.EditorController=class{constructor(options){Object.assign(this,options);controllers.push(this)}dispose(){this.disposed=true}}
global.Dialog={confirm:async input=>{confirmations.push(input);return confirm}}
const ctx={git,fs,dir,gitdir:dir+'/.git'}
const runtime={runWithBackgroundKeepAlive:fn=>fn(),resolveGitdir:()=>ctx.gitdir,getCtx:async()=>ctx,checkoutWithEmptyDirCleanup:(git,fs,options)=>git.checkout({fs,...options})}
const store={async pickDirectory(){const path=await DocumentPicker.pickDirectory();return path?{path,name:path.split('/').pop(),accessBookmarkName:null}:null},writeSnapshot(){},resolveWorkdir:()=>root,findRepo:()=>({bookmarkName:'repo',name:'test',repoId:'repo'}),listRepos:()=>[],getGitdirPath:()=>ctx.gitdir}
function loader(overrides={}){
 const cache=new Map()
 function read(file){file=path.resolve(file);if(cache.has(file))return cache.get(file).exports
  const m={exports:{}};cache.set(file,m)
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'__jsx',jsxFragmentFactory:'__fragment'},fileName:file}).outputText
  const req=name=>{if(name==='scripting')return new Proxy(ui,{get:(target,key)=>key==='Widget'?{reloadAll(){}}:target[key]});let dest=path.resolve(path.dirname(file),name);dest=['.ts','.tsx'].map(ext=>dest+ext).find(fs.existsSync)||dest
   if(dest.replace(/\.tsx?$/,'')===project+'/components/LocalCodeEditor')return {LocalCodeEditor:'LocalCodeEditor'}
   if(dest.replace(/\.tsx?$/,'')===project+'/services/localCodeEditor')return {createLocalCodeEditorController:options=>{const c=new global.EditorController(options);c.getContent=async()=>c.content;return c}}
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
 await test('native path thumbnail preview, no JS image bytes or text Editor payload; native copy/rename keep binary bytes and HEAD/index unchanged',async()=>{
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,255]);await disk('photo.png',bytes)
  const file=await service.openLocalWorktreeFile('repo','photo.png');assert.equal(file.text,null);assert.equal(file.previewImage.nativeThumbnail,true);assert.deepEqual(file.previewImage.size,{width:1600,height:1600})
  assert.equal(await service.copyLocalWorktreeFile('repo',file,'photo 副本.png'),'photo 副本.png');assert.deepEqual(fs.readFileSync(dir+'/photo 副本.png'),bytes);assert.deepEqual(fs.readFileSync(dir+'/photo.png'),bytes)
  const copy=await service.readLocalWorktreeFile('repo','photo 副本.png');assert.equal(await service.renameLocalWorktreeFile('repo',copy,'renamed.png'),'renamed.png');assert.ok(!fs.existsSync(dir+'/photo 副本.png'));assert.deepEqual(fs.readFileSync(dir+'/renamed.png'),bytes)
  for(const name of ['../bad','a/b','a\\b','.git','.GIT','','..',' bad','bad.','bad:foo','PHOTO.PNG']) await assert.rejects(service.copyLocalWorktreeFile('repo',file,name),/合法|同名/)
  await assert.rejects(service.renameLocalWorktreeFile('repo',file,'PHOTO.PNG'),/同名/);await assert.rejects(service.copyLocalWorktreeFile('repo',file,'renamed.png'),/同名/)
  await disk('photo.png',Buffer.from('outside changed'));await assert.rejects(service.renameLocalWorktreeFile('repo',file,'moved.png'),/修改|变化/);assert.ok(!fs.existsSync(dir+'/moved.png'))
  await disk('large.png',Buffer.alloc(8*1024*1024+1));assert.ok((await service.openLocalWorktreeFile('repo','large.png')).previewImage)
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
  // 图片打开仅传原生显示缩略图，交由稳定父List路由LocalImagePreview。
  await disk('click.png',Buffer.from([137,80,78,71]));props.files=[...props.files,'click.png'];h.render();const pic=all(expand(h.tree)).find(n=>n.type==='Button'&&!n.props.title&&JSON.stringify(n.children).includes('click.png'));await pic.props.action();assert.ok(opened.previewImage);assert.equal(opened.text,null);h.unmount()
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
 await test('directory native recursion includes binary/untracked/empty dirs; real Git A/D, unchanged HEAD/index and no JS content reads',async()=>{
  await disk('recursive/sub/binary.bin',Buffer.alloc(1024*1024,0xa7));await disk('recursive/tracked.txt','tracked');fs.mkdirSync(dir+'/recursive/empty');await git.add({fs,dir,filepath:'recursive/tracked.txt'})
  const index=fs.readFileSync(dir+'/.git/index'),head=await git.resolveRef({fs,dir,ref:'HEAD'}),read=FileManager.readAsData
  FileManager.readAsData=async()=>{throw Error('must not read tree content into JS')}
  const copied=await service.copyLocalWorktreeDirectory('repo','recursive','recursive copy')
  assert.deepEqual(copied.files,['recursive copy/sub/binary.bin','recursive copy/tracked.txt']);assert.ok(copied.directories.includes('recursive copy/empty'))
  assert.deepEqual(fs.readFileSync(dir+'/recursive copy/sub/binary.bin'),Buffer.alloc(1024*1024,0xa7));assert.ok(fs.statSync(dir+'/recursive copy/empty').isDirectory())
  const renamed=await service.renameLocalWorktreeDirectory('repo','recursive','recursive renamed');assert.equal(renamed.path,'recursive renamed');assert.ok(!fs.existsSync(dir+'/recursive'));assert.equal(fs.readFileSync(dir+'/recursive renamed/tracked.txt','utf8'),'tracked');FileManager.readAsData=read
  assert.deepEqual(fs.readFileSync(dir+'/.git/index'),index);assert.equal(await git.resolveRef({fs,dir,ref:'HEAD'}),head)
  const matrix=await git.statusMatrix({fs,dir});assert.deepEqual(matrix.find(r=>r[0]==='recursive/tracked.txt'),['recursive/tracked.txt',0,0,3]);assert.deepEqual(matrix.find(r=>r[0]==='recursive renamed/tracked.txt'),['recursive renamed/tracked.txt',0,2,0])
 })
 await test('directory safety rejects roots/traversal/nested git/ancestor git/symlinks/collisions before mutation; failures never remove source or partial destination',async()=>{
  const originalRemove=removes
  for(const source of ['', '.', '..','../outside','.git','/tmp','linked-folder','protected-folder'])for(const fn of [service.copyLocalWorktreeDirectory,service.renameLocalWorktreeDirectory])await assert.rejects(fn('repo',source,'safe'))
  await disk('nested-repo/.git','gitdir: outside');await disk('nested-repo/inside/a','safe');await assert.rejects(service.copyLocalWorktreeDirectory('repo','nested-repo/inside','new'),/Git/)
  for(const name of ['', '.', '..','../escape','a/b','a\\b','.git','.GIT',' bad','bad.','bad:foo','RECURSIVE COPY','recursive renamed'])for(const fn of [service.copyLocalWorktreeDirectory,service.renameLocalWorktreeDirectory])await assert.rejects(fn('repo','recursive copy',name))
  fs.symlinkSync(outside+'/absent',dir+'/dangling-dir');await assert.rejects(service.copyLocalWorktreeDirectory('repo','recursive copy','dangling-dir'),/同名|存在/)
  await disk('partial/a','one');await disk('partial/b','two');const copy=FileManager.copyFile,rename=FileManager.rename
  FileManager.copyFile=async(src,dest)=>{if(src.endsWith('/b'))throw Error('copy denied');return copy(src,dest)}
  await assert.rejects(service.copyLocalWorktreeDirectory('repo','partial','partial target'),/copy denied.*部分复制/);FileManager.copyFile=copy
  assert.equal(fs.readFileSync(dir+'/partial/a','utf8'),'one');assert.equal(fs.readFileSync(dir+'/partial/b','utf8'),'two');assert.equal(fs.readFileSync(dir+'/partial target/a','utf8'),'one');assert.ok(!fs.existsSync(dir+'/partial target/b'))
  FileManager.rename=async()=>{throw Error('rename denied')};await assert.rejects(service.renameLocalWorktreeDirectory('repo','partial','denied-folder'),/rename denied/);FileManager.rename=rename;assert.ok(fs.existsSync(dir+'/partial/b'));assert.ok(!fs.existsSync(dir+'/denied-folder'));assert.equal(removes,originalRemove)
 })
 await test('directory revalidation rejects relocated workspace, malicious directory names and replaced destination parent without touching outside data',async()=>{
  const readDirectory=FileManager.readDirectory,createDirectory=FileManager.createDirectory,before=removes
  FileManager.readDirectory=async p=>{const names=await readDirectory(p);if(p===dir){root=outside}return names}
  await assert.rejects(service.copyLocalWorktreeDirectory('repo','partial','relocated'),/变化|不存在/);root=dir;FileManager.readDirectory=readDirectory;assert.ok(!fs.existsSync(dir+'/relocated'))
  FileManager.readDirectory=async p=>p===dir+'/partial'?[...(await readDirectory(p)),'../escape']:readDirectory(p)
  await assert.rejects(service.renameLocalWorktreeDirectory('repo','partial','malicious'),/不安全/);FileManager.readDirectory=readDirectory;assert.ok(fs.existsSync(dir+'/partial/b'));assert.ok(!fs.existsSync(dir+'/malicious'))
  FileManager.createDirectory=async p=>{await createDirectory(p);if(p===dir+'/replaced-target'){fs.rmdirSync(p);fs.symlinkSync(outside,p)}}
  await assert.rejects(service.copyLocalWorktreeDirectory('repo','partial','replaced-target'),/链接/);FileManager.createDirectory=createDirectory
  assert.ok(!fs.existsSync(outside+'/a'));assert.equal(fs.readFileSync(outside+'/secret','utf8'),'precious');assert.ok(fs.existsSync(dir+'/partial/b'));assert.equal(removes,before)
 })
 await test('directory mutation waits real read barrier, rejects duplicate writer, invalidates coordinator and preserves files',async()=>{
  const gate=deferred(),active=coordinator.read(ctx.gitdir,()=>gate.promise),revision=coordinator.revision(ctx.gitdir);let done=false
  const pending=service.copyLocalWorktreeDirectory('repo','partial','lock directory').then(()=>done=true);await tick();assert.equal(done,false);assert.ok(!fs.existsSync(dir+'/lock directory'))
  await assert.rejects(service.renameLocalWorktreeDirectory('repo','partial','blocked-directory'),/写|操作/);gate.resolve();await active;await pending;assert.ok(coordinator.revision(ctx.gitdir)>revision);assert.ok(fs.existsSync(dir+'/partial/b'))
 })
 await test('real folder context menu uses declarative form, cancel/no-op no changes; copy/rename refresh paths incl untracked/empty dirs, unsafe and native errors visible',async()=>{
  await disk('form-folder/sub/a','nested');await disk('form-folder/untracked.bin',Buffer.from([0,255]));fs.mkdirSync(dir+'/form-folder/empty');let updates=0
  const props={files:['form-folder/sub/a'],loading:false,bookmarkName:'repo',changes:[],onWorktreeChanged:()=>updates++,onOpen(){},onPush(){},onRestore(){},mergeInProgress:false},h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  function group(name){h.render();return all(expand(h.tree)).find(n=>n.type==='DisclosureGroup'&&JSON.stringify(n.props.label).includes('"'+name+'"'))}
  function action(name,title){return all(group(name).props.contextMenu.menuItems).find(n=>n.props.title===title).props.action()}
  function form(){h.render();assert.equal(h.tree.props.sheet.isPresented,true);return h.tree.props.sheet.content.props}
  await action('form-folder','复制文件夹');assert.equal(form().initialName,'form-folder 副本');form().onCancel();h.render();assert.equal(h.tree.props.sheet.isPresented,false);assert.equal(updates,0)
  await action('form-folder','重命名');await form().onConfirm('form-folder');h.render();assert.equal(h.tree.props.sheet.isPresented,false);assert.equal(updates,0)
  await action('form-folder','复制文件夹');await form().onConfirm('../bad');assert.match(form().error,/合法/);assert.ok(fs.existsSync(dir+'/form-folder/sub/a'));form().onCancel()
  await action('form-folder','复制文件夹');await form().onConfirm('form copy');assert.ok(group('form copy'));group('form copy').props.onChanged(true);assert.ok(group('empty'));assert.ok(fs.existsSync(dir+'/form copy/untracked.bin'));const afterCopy=updates
  await action('form copy','重命名');await form().onConfirm('form renamed');assert.ok(group('form renamed'));assert.ok(!fs.existsSync(dir+'/form copy'));assert.equal(updates,afterCopy+1)
  await action('form-folder','重命名');const rename=FileManager.rename;FileManager.rename=async()=>{throw Error('UI denied')};await form().onConfirm('denied form');FileManager.rename=rename;assert.match(form().error,/UI denied/);assert.ok(fs.existsSync(dir+'/form-folder/sub/a'));form().onCancel();h.unmount()
 })
 await test('real facade unpublished branch rename preserves HEAD/index; duplicate and native failure leave branch intact',async()=>{
  const index=fs.readFileSync(dir+'/.git/index'),head=await git.resolveRef({fs,dir,ref:'HEAD'})
  const actual=ctx.git;let network=0;ctx.git={...git,push:async()=>{network++;throw Error('remote writes forbidden')},fetch:async()=>{network++;throw Error('network forbidden')}}
  const result=await service.renameBranch('repo','main','renamed-local');assert.equal(result.pushedNewBranch,false);assert.equal(result.deletedOldRemoteBranch,false);assert.equal(network,0);assert.equal(await git.currentBranch({fs,dir,fullname:false}),'renamed-local')
  await git.branch({fs,dir,ref:'already-local'});await assert.rejects(service.renameBranch('repo','renamed-local','already-local'),/已存在/)
  ctx.git={...ctx.git,renameBranch:async()=>{throw Error('native ref denied')}};await assert.rejects(service.renameBranch('repo','renamed-local','denied-local'),/native ref denied/);assert.equal(await git.currentBranch({fs,dir,fullname:false}),'renamed-local')
  ctx.git=actual;await service.renameBranch('repo','renamed-local','main');assert.deepEqual(fs.readFileSync(dir+'/.git/index'),index);assert.equal(await git.resolveRef({fs,dir,ref:'HEAD'}),head)
 })
 await test('modified/renamed file icons orange; rename label wins over modified/added, original Git status stays true and fresh clean state clears hints',async()=>{
  for(const name of ['icon-normal','icon-mod','icon-add','icon-unstaged','icon-photo.png'])await disk(name,'data')
  const props={files:['icon-normal','icon-mod','icon-add','icon-deleted','icon-unstaged','icon-photo.png','icon-folder/a'],loading:false,bookmarkName:'repo',changes:[{filepath:'icon-mod',status:'*modified'},{filepath:'icon-add',status:'*added'},{filepath:'icon-deleted',status:'*deleted',worktreeDeleted:true},{filepath:'icon-unstaged',status:'unknown',unstaged:true}],onWorktreeChanged(){},onOpen(){},onPush(){},onRestore(){},mergeInProgress:false},h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  function row(name){h.render();return all(expand(h.tree)).find(n=>n.type==='Button'&&n.props.trailingSwipeActions&&JSON.stringify(n.children).includes('"'+name+'"'))}
  const color=name=>all(row(name)).find(n=>n.type==='Image'&&['doc.text','photo'].includes(n.props.systemName)).props.foregroundStyle
  assert.equal(color('icon-mod'),'systemOrange');assert.equal(color('icon-unstaged'),'systemOrange');assert.equal(color('icon-add'),'systemGreen');assert.equal(color('icon-deleted'),'systemRed');for(const name of ['icon-normal','icon-photo.png'])assert.equal(color(name),'secondaryLabel')
  assert.equal(all(expand(h.tree)).find(n=>n.type==='DisclosureGroup').props.label.children[0].props.foregroundStyle,'secondaryLabel')
  global.Dialog.prompt=async()=> 'icon-renamed.png';await all(row('icon-photo.png').props.contextMenu.menuItems).find(n=>n.props.title==='重命名').props.action();assert.equal(color('icon-renamed.png'),'systemOrange');assert.match(JSON.stringify(row('icon-renamed.png').children),/已重命名/)
  for(const status of ['*added','*modified']){props.changes=[...props.changes.filter(c=>c.filepath!=='icon-renamed.png'),{filepath:'icon-renamed.png',status}];assert.equal(color('icon-renamed.png'),'systemOrange');const text=JSON.stringify(row('icon-renamed.png').children);assert.match(text,/已重命名/);assert.doesNotMatch(text,/已修改|新增/);assert.equal(props.changes.at(-1).status,status)}
  props.changes=[];assert.equal(color('icon-renamed.png'),'secondaryLabel');assert.doesNotMatch(JSON.stringify(row('icon-renamed.png').children),/已重命名/);assert.equal(color('icon-mod'),'secondaryLabel');h.unmount()
 })
 await test('folder rename marks only relocated folders/files; ordinary parent modifications and clean refresh remain correct',async()=>{
  await disk('rename-parent/source/sub/a.txt','a');await disk('rename-parent/source/b.txt','b');await disk('rename-parent/ordinary/x.txt','x')
  const props={files:['rename-parent/source/sub/a.txt','rename-parent/source/b.txt','rename-parent/ordinary/x.txt'],loading:false,bookmarkName:'repo',changes:[{filepath:'rename-parent/ordinary/x.txt',status:'*modified'}],onWorktreeChanged(){},onOpen(){},onPush(){},onRestore(){},mergeInProgress:false}
  const h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  function nodes(){h.render();return all(expand(h.tree))}
  function folder(name){return nodes().findLast(n=>n.type==='DisclosureGroup'&&JSON.stringify(n.props.label).includes('"'+name+'"'))}
  function row(name){return nodes().find(n=>n.type==='Button'&&n.props.trailingSwipeActions&&!n.props.disabled&&JSON.stringify(n.children).includes('"'+name+'"'))}
  const label=name=>JSON.stringify(folder(name).props.label)
  const fileLabel=name=>JSON.stringify(row(name).children)
  folder('rename-parent').props.onChanged(true);folder('source').props.onChanged(true)
  assert.match(label('rename-parent'),/已修改/);assert.doesNotMatch(label('rename-parent'),/已重命名/)
  await all(folder('source').props.contextMenu.menuItems).find(n=>n.props.title==='重命名').props.action();h.render();await h.tree.props.sheet.content.props.onConfirm('target')
  assert.match(label('target'),/已重命名/);assert.doesNotMatch(label('target'),/已修改/)
  folder('target').props.onChanged(true);folder('sub').props.onChanged(true)
  assert.match(label('sub'),/已重命名/)
  for(const name of ['a.txt','b.txt']){assert.match(fileLabel(name),/已重命名/);assert.equal(all(row(name)).find(n=>n.type==='Image').props.foregroundStyle,'systemOrange')}
  assert.match(label('ordinary'),/已修改/);assert.doesNotMatch(label('ordinary'),/已重命名/)
  assert.match(label('rename-parent'),/已修改/);assert.doesNotMatch(label('rename-parent'),/已重命名/)
  props.changes=[{filepath:'rename-parent/target/sub/a.txt',status:'*added'},{filepath:'rename-parent/target/b.txt',status:'*modified'},{filepath:'rename-parent/source/sub/a.txt',status:'*deleted',worktreeDeleted:true}]
  assert.match(label('target'),/已重命名/);assert.match(label('sub'),/已重命名/)
  for(const name of ['a.txt','b.txt'])assert.match(fileLabel(name),/已重命名/)
  // Commit/restore refresh contains no target changes: neither folder nor files retain hints.
  props.changes=[]
  for(const name of ['target','sub','rename-parent'])assert.doesNotMatch(label(name),/已重命名|已修改/)
  for(const name of ['a.txt','b.txt']){assert.doesNotMatch(fileLabel(name),/已重命名/);assert.equal(all(row(name)).find(n=>n.type==='Image').props.foregroundStyle,'secondaryLabel')}
  h.unmount()
 })
 await test('photo symbols, green added files/folders and copies; HEAD parent boundaries, rename/deletion priority and clean refresh',async()=>{
  await disk('green-source/sub/picture.PNG','image bytes');await disk('green-source/plain.txt','text');fs.mkdirSync(dir+'/green-source/empty')
  await disk('green-photo.jpg','photo');await disk('green-empty/.temporary','x');fs.unlinkSync(dir+'/green-empty/.temporary')
  const images=['png','jpg','jpeg','gif','webp','bmp','ico'].map(ext=>'symbol.'+ext.toUpperCase())
  const props={files:['green-source/sub/picture.PNG','green-source/plain.txt','green-photo.jpg','existing/base.txt','mixed/base.txt',...images,'unsupported.svg','normal.txt','deleted.jpg'],loading:false,bookmarkName:'repo',changes:[
   {filepath:'existing/new.jpg',status:'*added'}, {filepath:'new-dir/sub/a.png',status:'added'},
   {filepath:'mixed/base.txt',status:'*modified'}, {filepath:'mixed/new.txt',status:'*added'},
   {filepath:'mixed-new/a',status:'*added'}, {filepath:'mixed-new/b',status:'*modified'},
   {filepath:'deleted.jpg',status:'*deleted',worktreeDeleted:true},
  ],onWorktreeChanged(){},onOpen(){},onPush(){},onRestore(){},mergeInProgress:false}
  const h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  function nodes(){h.render();return all(expand(h.tree))}
  function folder(name){return nodes().find(n=>n.type==='DisclosureGroup'&&JSON.stringify(n.props.label).includes('"'+name+'"'))}
  function row(name){return nodes().find(n=>n.type==='Button'&&n.props.trailingSwipeActions&&JSON.stringify(n.children).includes('"'+name+'"'))}
  const icon=n=>all(n).find(n=>n.type==='Image')
  function badge(n,text,color){const labels=all(n).filter(n=>n.type==='Text'&&n.props.font==='caption2');assert.ok(labels.some(n=>n.children.includes(text)&&n.props.foregroundStyle===color),JSON.stringify(n));assert.equal(icon(n).props.foregroundStyle,color)}
  for(const name of images){assert.equal(icon(row(name)).props.systemName,'photo');assert.equal(icon(row(name)).props.foregroundStyle,'secondaryLabel')}
  for(const name of ['normal.txt','green-photo.jpg'])assert.equal(icon(row(name)).props.foregroundStyle,'secondaryLabel')
  assert.equal(icon(folder('green-source').props.label).props.foregroundStyle,'secondaryLabel')
  for(const name of ['normal.txt','unsupported.svg'])assert.equal(icon(row(name)).props.systemName,'doc.text')
  assert.equal(icon(row('deleted.jpg')).props.systemName,'photo');assert.equal(row('deleted.jpg').props.disabled,true);assert.match(JSON.stringify(row('deleted.jpg')),/已删除/);badge(row('deleted.jpg'),'已删除','systemRed');assert.doesNotMatch(JSON.stringify(row('deleted.jpg')),/不可编辑/)
  badge(folder('new-dir').props.label,'新增','systemGreen');folder('new-dir').props.onChanged(true);badge(folder('sub').props.label,'新增','systemGreen')
  for(const name of ['existing','mixed','mixed-new'])badge(folder(name).props.label,'已修改','systemOrange')
  folder('existing').props.onChanged(true);badge(row('new.jpg'),'新增','systemGreen');assert.equal(icon(row('new.jpg')).props.systemName,'photo')
  // Immediate file copy must be green before the asynchronous status refresh.
  global.Dialog.prompt=async()=> 'green-photo copy.jpg';await all(row('green-photo.jpg').props.contextMenu.menuItems).find(n=>n.props.title==='复制文件').props.action()
  badge(row('green-photo copy.jpg'),'新增','systemGreen');assert.equal(icon(row('green-photo copy.jpg')).props.systemName,'photo')
  async function directoryAction(name,title,next){await all(folder(name).props.contextMenu.menuItems).find(n=>n.props.title===title).props.action();h.render();await h.tree.props.sheet.content.props.onConfirm(next)}
  await directoryAction('green-source','复制文件夹','green-copy');badge(folder('green-copy').props.label,'新增','systemGreen')
  folder('green-copy').props.onChanged(true);badge(folder('empty').props.label,'新增','systemGreen');badge(row('plain.txt'),'新增','systemGreen')
  await directoryAction('empty','复制文件夹','empty-copy');badge(folder('empty-copy').props.label,'新增','systemGreen')
  // A copied file renamed before scan keeps the rename label, never the green added label.
  global.Dialog.prompt=async()=> 'green-renamed.jpg';await all(row('green-photo copy.jpg').props.contextMenu.menuItems).find(n=>n.props.title==='重命名').props.action()
  badge(row('green-renamed.jpg'),'已重命名','systemOrange');assert.equal(icon(row('green-renamed.jpg')).props.systemName,'photo')
  await directoryAction('green-copy','重命名','green-renamed-folder');badge(folder('green-renamed-folder').props.label,'已重命名','systemOrange');folder('green-renamed-folder').props.onChanged(true)
  props.changes=[{filepath:'green-renamed.jpg',status:'*added'},{filepath:'green-renamed-folder/plain.txt',status:'*added'},{filepath:'green-renamed-folder/sub/picture.PNG',status:'*added'}]
  badge(row('green-renamed.jpg'),'已重命名','systemOrange');badge(folder('green-renamed-folder').props.label,'已重命名','systemOrange')
  assert.doesNotMatch(JSON.stringify(folder('empty-copy').props.label),/新增/)
  props.changes=[]
  for(const name of ['green-renamed-folder','empty-copy']){assert.doesNotMatch(JSON.stringify(folder(name).props.label),/新增|已修改|已重命名/);assert.equal(icon(folder(name).props.label).props.foregroundStyle,'secondaryLabel')}
  assert.equal(folder('new-dir'),undefined)
  assert.doesNotMatch(JSON.stringify(row('green-renamed.jpg')),/新增|已重命名/);assert.equal(icon(row('green-renamed.jpg')).props.foregroundStyle,'secondaryLabel')
  h.unmount()
 })
 await test('fully deleted folders are red; partial deletion, surviving siblings and index-only deletion stay modified',async()=>{
  const props={files:['gone/a','gone/nested/b','partial/deleted','partial/normal','mixed/deleted','mixed/edited','index-only/file','parent/gone/a','parent/live'],loading:false,bookmarkName:'repo',changes:[
   ...['gone/a','gone/nested/b','partial/deleted','mixed/deleted','parent/gone/a'].map(filepath=>({filepath,status:'*deleted',worktreeDeleted:true})),
   {filepath:'mixed/edited',status:'*modified'}, {filepath:'index-only/file',status:'deleted',worktreeDeleted:false},
  ],onWorktreeChanged(){},onOpen(){},onPush(){},onRestore(){},mergeInProgress:false}
  const h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  function folders(){h.render();return all(expand(h.tree)).filter(n=>n.type==='DisclosureGroup')}
  function folder(name){return folders().find(n=>JSON.stringify(n.props.label).includes('"'+name+'"'))}
  function badge(n,label,color){assert.ok(all(n.props.label).some(n=>n.type==='Text'&&n.children.includes(label)&&n.props.foregroundStyle===color));assert.equal(all(n.props.label).find(n=>n.type==='Image').props.foregroundStyle,color)}
  badge(folder('gone'),'已删除','systemRed');folder('gone').props.onChanged(true);badge(folder('nested'),'已删除','systemRed')
  for(const name of ['partial','mixed','index-only','parent']){badge(folder(name),'已修改','systemOrange');assert.doesNotMatch(JSON.stringify(folder(name).props.label),/已删除/)}
  folder('parent').props.onChanged(true)
  const nestedGone=folders().filter(n=>JSON.stringify(n.props.label).includes('"gone"')).at(-1);badge(nestedGone,'已删除','systemRed')
  assert.deepEqual(all(folder('gone').props.trailingSwipeActions.actions).filter(n=>n.type==='Button').map(n=>n.props.title),['还原','提交','删除'])
  // A restored leaf makes its parent modified rather than deleted; fully clean refresh clears both.
  props.changes=props.changes.filter(c=>c.filepath!=='gone/a');badge(folder('gone'),'已修改','systemOrange')
  props.changes=[];assert.doesNotMatch(JSON.stringify(folder('gone').props.label),/已删除|已修改/);assert.equal(all(folder('gone').props.label).find(n=>n.type==='Image').props.foregroundStyle,'secondaryLabel')
  h.unmount()
 })
 await test('root additions create empty arbitrary-extension files/empty dirs and native binary imports; real Git A with unchanged HEAD/index',async()=>{
  const index=fs.readFileSync(dir+'/.git/index'),head=await git.resolveRef({fs,dir,ref:'HEAD'})
  assert.equal(await service.createLocalWorktreeEntry('repo','created.tsx',false,dir),'created.tsx');assert.equal(fs.readFileSync(dir+'/created.tsx').length,0)
  await service.createLocalWorktreeEntry('repo','README-without-extension',false,dir);await service.createLocalWorktreeEntry('repo','empty-created',true,dir)
  assert.deepEqual(fs.readdirSync(dir+'/empty-created'),[])
  const source=outside+'/original binary.BIN',bytes=Buffer.from([0,255,4,128,0,13,10]);fs.writeFileSync(source,bytes)
  const read=FileManager.readAsData;FileManager.readAsData=async()=>{throw Error('must not read import payload into JS')}
  try{assert.equal(await service.importLocalWorktreeFile('repo',source,'original binary.BIN',dir),'original binary.BIN')}finally{FileManager.readAsData=read}
  assert.deepEqual(fs.readFileSync(dir+'/original binary.BIN'),bytes);assert.deepEqual(fs.readFileSync(source),bytes)
  const matrix=await git.statusMatrix({fs,dir});assert.deepEqual(matrix.find(r=>r[0]==='created.tsx').slice(1),[0,2,0]);assert.deepEqual(matrix.find(r=>r[0]==='original binary.BIN').slice(1),[0,2,0]);assert.equal(matrix.some(r=>r[0].startsWith('empty-created/')),false)
  assert.deepEqual(fs.readFileSync(dir+'/.git/index'),index);assert.equal(await git.resolveRef({fs,dir,ref:'HEAD'}),head)
 })
 await test('batch facade holds one real coordinator lock, continues failures/skips, native bytes and originals/index/HEAD intact; cleanup warning never recopies',async()=>{
  const index=fs.readFileSync(dir+'/.git/index'),head=await git.resolveRef({fs,dir,ref:'HEAD'}),start=coordinator.revision(ctx.gitdir)
  const bytes=Buffer.from([0,255,128,0,13,10]),source=outside+'/batch-source';fs.writeFileSync(source,bytes);let acquired=0,released=0
  const item=(name,missing=false,cleanup=false)=>({name,async acquire(){acquired++;return {sourcePath:missing?outside+'/batch-missing':source,name,async release(){released++;if(cleanup)throw Error('cleanup failed private path')}}}})
  const read=FileManager.readAsData;FileManager.readAsData=async()=>{throw Error('batch must not read payload into JS')}
  let result;try{result=await service.importLocalWorktreeFiles('repo',[item('batch-a.bin'),item('BATCH-A.BIN'),item('batch-bad.bin',true),item('batch-c.HEIC',false,true),item('batch-last.bin')],dir,()=>{})}finally{FileManager.readAsData=read}
  assert.deepEqual(result.entries.map(e=>e.status),['success','skipped','failed','success','success']);assert.equal(result.entries[3].cleanupFailed,true);assert.equal(acquired,5);assert.equal(released,5);assert.equal(coordinator.revision(ctx.gitdir)-start,2)
  assert.deepEqual(fs.readFileSync(dir+'/batch-c.HEIC'),bytes);assert.deepEqual(fs.readFileSync(dir+'/batch-last.bin'),bytes);assert.deepEqual(fs.readFileSync(source),bytes);assert.ok(!fs.existsSync(dir+'/batch-bad.bin'));assert.deepEqual(fs.readFileSync(dir+'/.git/index'),index);assert.equal(await git.resolveRef({fs,dir,ref:'HEAD'}),head)
  const gate=deferred(),reader=coordinator.read(ctx.gitdir,()=>gate.promise),before=acquired
  const pending=service.importLocalWorktreeFiles('repo',[item('batch-wait.bin')],dir,()=>{});await tick();assert.equal(acquired,before);await assert.rejects(service.importLocalWorktreeFiles('repo',[],dir,()=>{}),/写|操作/);gate.resolve();await reader;await pending
  let allowed=true,unvisited=0
  const stopped=await service.importLocalWorktreeFiles('repo',[{name:'batch-stop.bin',async acquire(){allowed=false;return {sourcePath:source,name:'batch-stop.bin',release:async()=>{released++}}}},{name:'batch-unvisited.bin',async acquire(){unvisited++;throw Error('must not acquire')}}],dir,()=>{if(!allowed)throw Error('state changed')})
  assert.deepEqual(stopped.entries.map(e=>e.status),['skipped','skipped']);assert.equal(unvisited,0);assert.ok(!fs.existsSync(dir+'/batch-stop.bin'))
 })
 await test('root addition safety, case/Unicode conflict, exact selected file without probing system ancestors, identity change and partial copy preservation',async()=>{
  const source=outside+'/original binary.BIN'
  for(const name of ['', '.', '..', '../escape','folder/escape','/tmp/escape','a\\b','.git','.GIT',' bad','bad.']){
   await assert.rejects(service.createLocalWorktreeEntry('repo',name,false));await assert.rejects(service.importLocalWorktreeFile('repo',source,name))
  }
  for(const name of ['CREATED.TSX','empty-created','ORIGINAL BINARY.bin'])await assert.rejects(service.createLocalWorktreeEntry('repo',name,false),/同名|存在/)
  await disk('é.txt','kept');await assert.rejects(service.createLocalWorktreeEntry('repo','e\u0301.txt',false),/同名/)
  fs.symlinkSync(source,outside+'/import-link');await assert.rejects(service.importLocalWorktreeFile('repo',outside+'/import-link','unsafe.bin'),/符号链接/)
  // Access to a selected file does not authorize probing its system ancestors.
  const isLink=FileManager.isLink,ancestors=new Set();let ancestor=path.dirname(source)
  while(ancestor!==path.dirname(ancestor)){ancestors.add(ancestor);ancestor=path.dirname(ancestor)}ancestors.add(ancestor)
  let ancestorProbes=0
  FileManager.isLink=async p=>{if(ancestors.has(p)){ancestorProbes++;throw Error('ungranted ancestor access')}return isLink(p)}
  try{await service.importLocalWorktreeFile('repo',source,'ancestor-denied.bin')}finally{FileManager.isLink=isLink}
  assert.equal(ancestorProbes,0);assert.deepEqual(fs.readFileSync(dir+'/ancestor-denied.bin'),fs.readFileSync(source))
  // Model a normal system directory alias such as /var -> /private/var.
  fs.mkdirSync(outside+'/real');fs.writeFileSync(outside+'/real/file','safe');fs.symlinkSync(outside+'/real',outside+'/parent-link')
  FileManager.isLink=async p=>{if(p===outside+'/parent-link')ancestorProbes++;return isLink(p)}
  try{await service.importLocalWorktreeFile('repo',outside+'/parent-link/file','system-alias.bin')}finally{FileManager.isLink=isLink}
  assert.equal(ancestorProbes,0);assert.equal(fs.readFileSync(dir+'/system-alias.bin','utf8'),'safe')
  assert.ok(fs.lstatSync(outside+'/parent-link').isSymbolicLink());assert.equal(fs.readFileSync(outside+'/real/file','utf8'),'safe')
  await assert.rejects(service.importLocalWorktreeFile('repo',outside,'folder-source'),/普通文件/)
  await assert.rejects(service.createLocalWorktreeEntry('repo','wrong-root',false,outside),/工作区/)
  const readDir=FileManager.readDirectory;FileManager.readDirectory=async p=>{const names=await readDir(p);if(p===dir)root=outside;return names}
  try{await assert.rejects(service.createLocalWorktreeEntry('repo','relocated',true),/工作区/)}finally{root=dir;FileManager.readDirectory=readDir}
  const stat=FileManager.stat;let checks=0;FileManager.stat=async p=>{const value=await stat(p);if(p===dir&&++checks>1)value.creationDate++;return value}
  try{await assert.rejects(service.createLocalWorktreeEntry('repo','replaced-root',true),/身份/)}finally{FileManager.stat=stat}
  const copy=FileManager.copyFile;FileManager.copyFile=async(s,d)=>{fs.writeFileSync(d,'partial');throw Error('disk full')}
  try{await assert.rejects(service.importLocalWorktreeFile('repo',source,'partial-import.bin'),/disk full.*部分导入/)}finally{FileManager.copyFile=copy}
  assert.equal(fs.readFileSync(dir+'/partial-import.bin','utf8'),'partial');assert.ok(fs.existsSync(source));assert.ok(!fs.existsSync(outside+'/relocated'))
  // External creation between preflight and native copy must never be overwritten.
  FileManager.copyFile=async(s,d)=>{fs.writeFileSync(d,'external');return copy(s,d)}
  try{await assert.rejects(service.createLocalWorktreeEntry('repo','race-create.txt',false),/存在|EEXIST|核对/)}finally{FileManager.copyFile=copy}
  assert.equal(fs.readFileSync(dir+'/race-create.txt','utf8'),'external')
 })
 await test('selected directory native import preserves multi-level binary/untracked/empty dirs, source scope and Git HEAD/index',async()=>{
  const source=outside+'/Whole Folder';fs.mkdirSync(source+'/sub/empty',{recursive:true});fs.writeFileSync(source+'/sub/bytes.bin',Buffer.from([0,255,128,4]));fs.writeFileSync(source+'/note.txt','中文\r\n');fs.mkdirSync(source+'/empty-root')
  const index=fs.readFileSync(dir+'/.git/index'),head=await git.resolveRef({fs,dir,ref:'HEAD'})
  const read=FileManager.readAsData,readDir=FileManager.readDirectory,isLink=FileManager.isLink
  FileManager.readAsData=async()=>{throw Error('no JS payload reads')}
  FileManager.readDirectory=async p=>{assert.ok(p===source||p.startsWith(source+'/')||p===dir||p.startsWith(dir+'/'),'must not enumerate unselected parents');return readDir(p)}
  FileManager.isLink=async p=>{if(p===outside||source.startsWith(p+'/')&&p!==source)throw Error('ungranted system ancestor');return isLink(p)}
  let result;try{result=await service.importLocalWorktreeDirectory('repo',source,dir)}finally{FileManager.readAsData=read;FileManager.readDirectory=readDir;FileManager.isLink=isLink}
  assert.equal(result.path,'Whole Folder');assert.deepEqual(result.files,['Whole Folder/note.txt','Whole Folder/sub/bytes.bin']);assert.ok(result.directories.includes('Whole Folder/sub/empty'));assert.deepEqual(fs.readFileSync(dir+'/Whole Folder/sub/bytes.bin'),fs.readFileSync(source+'/sub/bytes.bin'));assert.deepEqual(fs.readdirSync(dir+'/Whole Folder/empty-root'),[]);assert.equal(fs.readFileSync(source+'/note.txt','utf8'),'中文\r\n')
  fs.mkdirSync(outside+'/Only Empty');await service.importLocalWorktreeDirectory('repo',outside+'/Only Empty',dir);assert.deepEqual(fs.readdirSync(dir+'/Only Empty'),[])
  const rows=await git.statusMatrix({fs,dir});assert.deepEqual(rows.find(r=>r[0]==='Whole Folder/sub/bytes.bin').slice(1),[0,2,0]);assert.equal(rows.some(r=>r[0].startsWith('Only Empty/')),false);assert.deepEqual(fs.readFileSync(dir+'/.git/index'),index);assert.equal(await git.resolveRef({fs,dir,ref:'HEAD'}),head)
 })
 await test('directory import preflight rejects .git/gitdir files, links, traversal/provider names, special files and case conflicts without creating targets',async()=>{
  const removesBefore=removes
  for(const [name,make] of [
   ['unsafe-git',p=>{fs.mkdirSync(p+'/deep',{recursive:true});fs.writeFileSync(p+'/deep/.git','gitdir: elsewhere')}],
   ['unsafe-link',p=>{fs.mkdirSync(p);fs.symlinkSync(outside+'/original binary.BIN',p+'/leaf')}],
   ['unsafe-dir-link',p=>{fs.mkdirSync(p);fs.symlinkSync(outside,p+'/child')}],
   ['unsafe-case',p=>{fs.mkdirSync(p);fs.writeFileSync(p+'/A','first');fs.writeFileSync(p+'/a','second')}],
  ]){make(outside+'/'+name);await assert.rejects(service.importLocalWorktreeDirectory('repo',outside+'/'+name),/\.git|符号链接|重名/);assert.equal(fs.existsSync(dir+'/'+name),false)}
  fs.symlinkSync(outside+'/Whole Folder',outside+'/directory-link');await assert.rejects(service.importLocalWorktreeDirectory('repo',outside+'/directory-link'),/符号链接/)
  for(const source of [outside+'/../outside/Whole Folder',outside+'/.git/folder',outside+'/Whole Folder/./sub'])await assert.rejects(service.importLocalWorktreeDirectory('repo',source),/不安全/)
  fs.mkdirSync(outside+'/whole folder');await assert.rejects(service.importLocalWorktreeDirectory('repo',outside+'/whole folder'),/同名/)
  const readDir=FileManager.readDirectory;FileManager.readDirectory=async p=>p===outside+'/Only Empty'?['../escape']:readDir(p)
  try{await assert.rejects(service.importLocalWorktreeDirectory('repo',outside+'/Only Empty'),/合法|路径/)}finally{FileManager.readDirectory=readDir}
  fs.mkdirSync(outside+'/special-tree');fs.writeFileSync(outside+'/special-tree/special','not plain');const isFile=FileManager.isFile;FileManager.isFile=async p=>p===outside+'/special-tree/special'?false:isFile(p)
  try{await assert.rejects(service.importLocalWorktreeDirectory('repo',outside+'/special-tree'),/非普通/)}finally{FileManager.isFile=isFile}
  assert.equal(fs.existsSync(dir+'/special-tree'),false);assert.equal(removes,removesBefore)
 })
 await test('directory import detects root/source/target changes, preserves partial target and original; coordinates against active readers and writers',async()=>{
  const source=outside+'/failure-tree';fs.mkdirSync(source);fs.writeFileSync(source+'/a.bin',Buffer.from([0,255]));fs.writeFileSync(source+'/b.txt','source')
  const gate=deferred(),active=coordinator.read(ctx.gitdir,()=>gate.promise);const pending=service.importLocalWorktreeDirectory('repo',source,dir);await tick();assert.equal(fs.existsSync(dir+'/failure-tree'),false);await assert.rejects(service.createLocalWorktreeEntry('repo','blocked-by-import',false),/写|操作/)
  gate.resolve();await active
  const copy=FileManager.copyFile;FileManager.copyFile=async(s,d)=>{if(d.endsWith('/b.txt')){fs.writeFileSync(d,'partial');throw Error('disk full')}return copy(s,d)}
  try{await assert.rejects(pending,/disk full.*部分导入/)}finally{FileManager.copyFile=copy}
  assert.deepEqual(fs.readFileSync(source+'/a.bin'),Buffer.from([0,255]));assert.equal(fs.readFileSync(source+'/b.txt','utf8'),'source');assert.equal(fs.readFileSync(dir+'/failure-tree/b.txt','utf8'),'partial')
  fs.mkdirSync(outside+'/move-root');const readDir=FileManager.readDirectory;FileManager.readDirectory=async p=>{const names=await readDir(p);if(p===dir)root=outside;return names}
  try{await assert.rejects(service.importLocalWorktreeDirectory('repo',outside+'/move-root',dir),/工作区/)}finally{root=dir;FileManager.readDirectory=readDir}
  assert.equal(fs.existsSync(dir+'/move-root'),false)
  fs.mkdirSync(outside+'/replaced-import-root');const statRoot=FileManager.stat;let rootChecks=0
  FileManager.stat=async p=>{const value=await statRoot(p);if(p===dir&&++rootChecks>1)value.creationDate++;return value}
  try{await assert.rejects(service.importLocalWorktreeDirectory('repo',outside+'/replaced-import-root'),/身份/)}finally{FileManager.stat=statRoot}
  assert.equal(fs.existsSync(dir+'/replaced-import-root'),false)
  fs.mkdirSync(outside+'/changed-source');fs.writeFileSync(outside+'/changed-source/a','safe');let scans=0
  FileManager.readDirectory=async p=>{const names=await readDir(p);if(p===outside+'/changed-source'&&++scans===2)fs.writeFileSync(p+'/late','changed');return names}
  try{await assert.rejects(service.importLocalWorktreeDirectory('repo',outside+'/changed-source'),/变化/)}finally{FileManager.readDirectory=readDir}
  assert.equal(fs.existsSync(dir+'/changed-source'),false)
  fs.mkdirSync(outside+'/target-swap');fs.writeFileSync(outside+'/target-swap/a','safe');const mkdir=FileManager.createDirectory
  FileManager.createDirectory=async p=>{await mkdir(p);if(p===dir+'/target-swap'){fs.rmdirSync(p);fs.symlinkSync(outside,p)}}
  try{await assert.rejects(service.importLocalWorktreeDirectory('repo',outside+'/target-swap'),/链接.*部分导入/)}finally{FileManager.createDirectory=mkdir}
  assert.equal(fs.existsSync(outside+'/a'),false)
 })
 await test('root addition facade waits status reader and rejects concurrent writers; no extra snapshot scan',async()=>{
  const gate=deferred(),ctxRevision=coordinator.revision(ctx.gitdir);let started=false
  const read=coordinator.read(ctx.gitdir,async()=>{started=true;await gate.promise});await tick();assert.equal(started,true)
  const create=service.createLocalWorktreeEntry('repo','locked-created',true)
  await tick();assert.equal(fs.existsSync(dir+'/locked-created'),false)
  await assert.rejects(service.importLocalWorktreeFile('repo',outside+'/original binary.BIN','locked-import.bin'),/写|操作/)
  gate.resolve();await read;await create;assert.ok(fs.existsSync(dir+'/locked-created'));assert.ok(coordinator.revision(ctx.gitdir)>ctxRevision)
 })
 await test('actual root add menu order/group/icon, centered prompt creation, import/cancel/conflict/partial refresh and merge/busy guards',async()=>{
  let updates=0,selected=[],selectedDirectory=null,pickCalls=0,photoCalls=0,createInput=null;const createErrors=[],createPrompts=[]
  global.Dialog.prompt=async options=>{createPrompts.push(options);return createInput}
  global.DocumentPicker={pickFiles:async opts=>{pickCalls++;if(opts.types){assert.deepEqual(opts,{types:['public.folder'],allowsMultipleSelection:false,shouldShowFileExtensions:true});return selectedDirectory?[selectedDirectory]:[]}assert.deepEqual(opts,{allowsMultipleSelection:true,shouldShowFileExtensions:true});return selected}}
  global.PHPickerFilter={images:()=> 'images'};global.Photos={pick:async()=>{photoCalls++;return []}}
  const props={files:['folder/b.txt'],loading:false,bookmarkName:'repo',changes:[],onWorktreeChanged:async()=>{updates++},onOpen(){},onPush(){},onRestore(){},mergeInProgress:false}
  const FilesTab=load('pages/FilesTab.tsx').FilesTab,{useLocalEntryCreation}=load('hooks/useLocalEntryCreation.ts');let creation
  function Host(){creation=useLocalEntryCreation({bookmarkName:props.bookmarkName,unavailable:props.mergeInProgress,onChanged:props.onWorktreeChanged,onError:message=>createErrors.push(message)});return FilesTab({...props,creationActive:creation.busy,onCreateEntry:creation.open})}
  const h=mount(Host,props,{effectUpdates:true})
  function nodes(){h.render();function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}return all(expand(h.tree))}
  function action(title){h.render();return all(h.tree.props.header).find(n=>n.type==='Button'&&n.props.title===title)}
  async function settleImport(){for(let i=0;i<1000;i++){h.render();if(!action('导入文件').props.disabled)return;await tick()}throw Error('import did not settle')}
  async function dispatch(title){action(title).props.action();h.render();await settleImport()}
  const menu=all(h.tree.props.header).find(n=>n.type==='Menu');assert.equal(menu.props.label.props.systemName,'plus')
  assert.match(JSON.stringify(h.tree.props.header),/工作区文件.*（1）/);const groups=menu.children.filter(n=>n.type==='Section');assert.equal(groups.length,3);assert.match(JSON.stringify(groups[2].props.header),/仅诊断，不改仓库/);assert.match(JSON.stringify(groups[0].props.header),/添加到仓库/)
  assert.deepEqual(all(menu.children).filter(n=>n.type==='Button').map(n=>[n.props.title,n.props.systemImage]),[['创建文件','doc.text'],['创建目录','folder'],['导入文件','doc.text'],['导入目录','folder'],['导入图片','photo'],['查看拖动记录','list.bullet.rectangle']])
  nodes().find(n=>n.type==='DisclosureGroup').props.onChanged(true)
  await dispatch('创建文件');assert.equal(createPrompts.at(-1).title,'创建文件');assert.equal(createPrompts.at(-1).defaultValue,'');assert.equal(updates,0)
  createInput='ui-created.json';await dispatch('创建文件');assert.equal(fs.readFileSync(dir+'/ui-created.json').length,0);assert.equal(fs.existsSync(dir+'/folder/ui-created.json'),false)
  assert.ok(nodes().some(n=>n.type==='Text'&&n.children.includes('新增')&&n.props.foregroundStyle==='systemGreen'))
  createInput='ui-empty';await dispatch('创建目录');assert.ok(nodes().some(n=>n.type==='DisclosureGroup'&&JSON.stringify(n.props.label).includes('ui-empty')));assert.deepEqual(fs.readdirSync(dir+'/ui-empty'),[])
  for(let refresh=0;refresh<3;refresh++){
   props.changes=[...props.changes];const emptyRow=nodes().find(n=>n.type==='DisclosureGroup'&&JSON.stringify(n.props.label).includes('ui-empty'));const label=all(emptyRow.props.label)
   assert.ok(label.some(n=>n.type==='Image'&&n.props.systemName==='folder'&&n.props.foregroundStyle==='systemGreen'),'created empty directory stays green after actual changes-array replacement')
   assert.ok(label.some(n=>n.type==='Text'&&n.children.includes('新增')&&n.props.foregroundStyle==='systemGreen'))
  }

  createInput='UI-CREATED.JSON';await dispatch('创建文件');assert.match(createErrors.at(-1),/同名/)
  const before=updates;await dispatch('导入文件');await dispatch('导入目录');await dispatch('导入图片');assert.equal(updates,before);assert.equal(photoCalls,1)
  selectedDirectory=outside+'/UI Imported';fs.mkdirSync(selectedDirectory+'/empty',{recursive:true});fs.writeFileSync(selectedDirectory+'/bytes.bin',Buffer.from([0,255]));await dispatch('导入目录');assert.deepEqual(fs.readFileSync(dir+'/UI Imported/bytes.bin'),Buffer.from([0,255]));assert.ok(nodes().some(n=>n.type==='DisclosureGroup'&&JSON.stringify(n.props.label).includes('UI Imported')));assert.ok(fs.existsSync(dir+'/UI Imported/empty'));await dispatch('导入目录');assert.match(text(h),/同名/)
  const photoBytes=Buffer.from([137,80,78,71,13,10,26,10,0,255]);fs.writeFileSync(outside+'/picker-original.PNG',photoBytes)
  global.Photos.pick=async opts=>{assert.deepEqual(opts,{filter:'images',limit:50});return [{itemProvider:{registeredTypes:['public.png','public.image'],hasRepresentationConforming:type=>type==='public.png',loadFilePath:async type=>{assert.equal(type,'public.png');return outside+'/picker-original.PNG'}}}]}
  global.ImageIO={readMetadata:async path=>{assert.equal(path,outside+'/picker-original.PNG');return {pixelWidth:1}}}
  await dispatch('导入图片');assert.deepEqual(fs.readFileSync(dir+'/picker-original.PNG'),photoBytes);assert.equal(fs.existsSync(outside+'/picker-original.PNG'),false)
  fs.writeFileSync(outside+'/picker-original.PNG',Buffer.from([1,2,3]));const photoRefresh=updates;await dispatch('导入图片');assert.match(text(h),/同名|存在/);assert.deepEqual(fs.readFileSync(dir+'/picker-original.PNG'),photoBytes);assert.equal(fs.existsSync(outside+'/picker-original.PNG'),false,'conflict still releases the owned export');assert.ok(updates>photoRefresh)
  assert.ok(nodes().some(n=>n.type==='Image'&&n.props.systemName==='photo'&&n.props.foregroundStyle==='systemGreen'))
  const bytes=Buffer.from([0,255,20]);fs.writeFileSync(outside+'/ui-native.bin',bytes);selected=[outside+'/ui-native.bin'];await dispatch('导入文件');assert.deepEqual(fs.readFileSync(dir+'/ui-native.bin'),bytes)
  await dispatch('导入文件');assert.match(text(h),/同名|存在/);assert.ok(fs.existsSync(outside+'/ui-native.bin'))
  const originalCopy=FileManager.copyFile;FileManager.copyFile=async(s,d)=>{fs.writeFileSync(d,'partial');throw Error('UI disk full')}
  fs.writeFileSync(outside+'/ui-partial.bin','original');selected=[outside+'/ui-partial.bin'];const partialRefresh=updates
  try{await dispatch('导入文件')}finally{FileManager.copyFile=originalCopy}
  assert.match(text(h),/成功0\/跳过0\/失败1[\s\S]*ui-partial.bin：原生复制\/核对失败.*部分导入/);assert.ok(!text(h).includes(outside),'no private source path in batch summary');assert.ok(updates>partialRefresh);assert.equal(fs.readFileSync(dir+'/ui-partial.bin','utf8'),'partial');assert.equal(fs.readFileSync(outside+'/ui-partial.bin','utf8'),'original')
  selectedDirectory=outside+'/UI Partial Directory';fs.mkdirSync(selectedDirectory);fs.writeFileSync(selectedDirectory+'/file','original');const dirRefresh=updates
  FileManager.copyFile=async(s,d)=>{fs.writeFileSync(d,'partial');throw Error('directory disk full')}
  try{await dispatch('导入目录')}finally{FileManager.copyFile=originalCopy}
  assert.match(text(h),/directory disk full.*部分导入/);assert.ok(updates>dirRefresh);assert.equal(fs.readFileSync(dir+'/UI Partial Directory/file','utf8'),'partial');assert.equal(fs.readFileSync(selectedDirectory+'/file','utf8'),'original')
  const gate=deferred();global.DocumentPicker.pickFiles=async()=>{pickCalls++;await gate.promise;return []}
  action('导入文件').props.action();h.render();await tick();const busyCalls=pickCalls;assert.equal(action('创建文件').props.disabled,true);action('导入文件').props.action();assert.equal(pickCalls,busyCalls);gate.resolve();await settleImport()
  props.mergeInProgress=true;assert.equal(action('创建文件').props.disabled,true);action('创建文件').props.action();action('导入文件').props.action();assert.equal(pickCalls,busyCalls)
  props.mergeInProgress=false;const detached=deferred();fs.writeFileSync(outside+'/detached-import.bin','not copied')
  global.DocumentPicker.pickFiles=async()=>{await detached.promise;return [outside+'/detached-import.bin']}
  action('导入文件').props.action();h.render();h.unmount();detached.resolve();await tick();await tick()
  assert.equal(fs.existsSync(dir+'/detached-import.bin'),false);assert.equal(h.lateWrites,0)
 })
 await test('parent editor controller lifecycle: single controller across renders, disposal only unmount, initialization failure visible, binary has no controller',async()=>{
  await disk('lifecycle.txt','draft');const file=await service.readLocalWorktreeFile('repo','lifecycle.txt');let closed=0
  const props={bookmarkName:'repo',file,onClose:()=>closed++,onReload(){},onChanged(){}}
  const before=controllers.length,h=mount(Editor,props),controller=controllers.at(-1)
  h.render();h.render();assert.equal(controllers.length,before+1);assert.equal(controller.disposed,undefined);assert.equal(node(h,'LocalCodeEditor').props.controller,controller)
  await node(h,'Button','返回').props.action();assert.equal(closed,1);assert.equal(controller.disposed,undefined);h.unmount();assert.equal(controller.disposed,true)
  const reopened=mount(Editor,props);assert.notEqual(controllers.at(-1),controller);reopened.unmount()
  const Native=global.EditorController;global.EditorController=class{constructor(){throw Error('native init rejected')}}
  const failed=mount(Editor,props);assert.match(text(failed),/编辑器初始化失败.*native init rejected/);assert.equal(all(failed.tree).filter(n=>n.type==='LocalCodeEditor').length,0);await node(failed,'Button','返回').props.action();failed.unmount()
  const binary=mount(Editor,{...props,file:{...file,text:null,readOnlyReason:'binary'}});assert.equal(all(binary.tree).filter(n=>n.type==='LocalCodeEditor').length,0);assert.doesNotMatch(text(binary),/初始化失败/);binary.unmount();global.EditorController=Native
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
  await back(h);assert.equal(fs.readFileSync(dir+'/autosave.txt','utf8'),'new draft');assert.equal(closed,1);assert.equal(changed,0);await new Promise(r=>setTimeout(r,380));assert.equal(changed,1);assert.deepEqual((await git.statusMatrix({fs,dir,filepaths:['autosave.txt']}))[0],['autosave.txt',0,2,0]);h.unmount()
  const warn=console.warn,warnings=[];console.warn=m=>warnings.push(m);await disk('autosave2.txt','old');const f2=await service.readLocalWorktreeFile('repo','autosave2.txt')
  const r=mount(Editor,{bookmarkName:'repo',file:f2,onClose:()=>closed++,onReload(){},onChanged:async()=>{throw Error('status failed')}}),c2=controllers.at(-1);c2.content='saved2';await back(r);r.unmount();await new Promise(r=>setTimeout(r,380));console.warn=warn;assert.equal(fs.readFileSync(dir+'/autosave2.txt','utf8'),'saved2');assert.equal(closed,2);assert.ok(warnings.some(x=>/status failed/.test(x)));r.unmount()
 })
 await test('back critical path reads latest native draft and saves before closing, never waits blocked status scan; IME/read failure stays on page',async()=>{
  await disk('back-latency.txt','old');const file=await service.readLocalWorktreeFile('repo','back-latency.txt'),gate=deferred();let closed=0,scans=0,finished=false
  const h=mount(Editor,{bookmarkName:'repo',file,onClose:()=>{assert.equal(fs.readFileSync(dir+'/back-latency.txt','utf8'),'native latest');closed++},onReload(){},onChanged:async()=>{scans++;await gate.promise;finished=true}}),c=controllers.at(-1)
  c.content='stale bridge';c.getContent=async()=>{c.content='native latest';return c.content}
  await back(h);assert.equal(closed,1);assert.equal(scans,0);h.unmount();await new Promise(r=>setTimeout(r,380));assert.equal(scans,1);assert.equal(finished,false);gate.resolve();await tick();assert.equal(finished,true)
  const bad=mount(Editor,{bookmarkName:'repo',file:await service.readLocalWorktreeFile('repo','back-latency.txt'),onClose:()=>closed++,onReload(){},onChanged:()=>scans++}),bc=controllers.at(-1);bc.content='IME draft';bc.getContent=async()=>{throw Error('中文输入尚未完成')};await back(bad);assert.equal(closed,1);assert.equal(scans,1);assert.match(text(bad),/中文输入尚未完成.*未返回/);assert.equal(fs.readFileSync(dir+'/back-latency.txt','utf8'),'native latest');bad.unmount()
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
  FileManager.writeAsData=write;await back(h);assert.equal(fs.readFileSync(dir+'/io-error.txt','utf8'),'important draft');assert.equal(closed,1);assert.equal(changed,0);h.unmount();await new Promise(r=>setTimeout(r,380));assert.equal(changed,1)
 })
 await test('FilesTab actual tree dispatches current worktree to parent; directories retained, deleted leaf disabled and opening does not trigger mutation refresh',async()=>{
  const FilesTab=load('pages/FilesTab.tsx').FilesTab;let updates=0,opened=null
  const h=mount(FilesTab,{files:['folder/b.txt','a.txt','image.bin'],loading:false,bookmarkName:'repo',changes:[{filepath:'image.bin',status:'*deleted',worktreeDeleted:true}],onWorktreeChanged:()=>updates++,onOpen:file=>opened=file})
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  let expanded=expand(h.tree);assert.ok(all(expanded).some(n=>n.type==='DisclosureGroup'));const deleted=all(expanded).find(n=>n.type==='Button'&&JSON.stringify(n.children).includes('image.bin'));assert.equal(deleted.props.disabled,true)
  const leaf=all(expanded).find(n=>n.type==='Button'&&JSON.stringify(n.children).includes('a.txt'));await leaf.props.action();h.render();assert.equal(h.tree.props.fullScreenCover,undefined);assert.equal(opened.text,fs.readFileSync(dir+'/a.txt','utf8'));assert.equal(updates,0);h.unmount()
 })
 await test('drag move uses real native rename, Git D/A only, same name/Unicode/path/link/root/lock protections and failure preserves bytes',async()=>{
  await disk('drag-source.bin',Buffer.from([0,255,6]));await git.add({fs,dir,filepath:'drag-source.bin'});await git.commit({fs,dir,author:{name:'test',email:'test@example.invalid'},message:'drag baseline'})
  fs.mkdirSync(dir+'/drag-target');const index=fs.readFileSync(dir+'/.git/index'),head=await git.resolveRef({fs,dir,ref:'HEAD'}),removedBefore=removes
  assert.equal(await service.moveLocalWorktreeFile('repo','drag-source.bin','drag-target',dir),'drag-target/drag-source.bin')
  assert.equal(fs.existsSync(dir+'/drag-source.bin'),false);assert.deepEqual(fs.readFileSync(dir+'/drag-target/drag-source.bin'),Buffer.from([0,255,6]));assert.equal(removes,removedBefore)
  const matrix=await git.statusMatrix({fs,dir});assert.deepEqual(matrix.find(r=>r[0]==='drag-source.bin'),['drag-source.bin',1,0,1]);assert.deepEqual(matrix.find(r=>r[0]==='drag-target/drag-source.bin'),['drag-target/drag-source.bin',0,2,0]);assert.deepEqual(fs.readFileSync(dir+'/.git/index'),index);assert.equal(await git.resolveRef({fs,dir,ref:'HEAD'}),head)
  const changes=await service.getChanges('repo');assert.ok(changes.some(c=>c.filepath==='drag-source.bin'&&c.worktreeDeleted));assert.ok(changes.some(c=>c.filepath==='drag-target/drag-source.bin'&&c.status==='*added'))
  await disk('drag-conflict','source');await disk('drag-target/DRAG-CONFLICT','target');await assert.rejects(service.moveLocalWorktreeFile('repo','drag-conflict','drag-target',dir),/同名/)
  await disk('é.txt','unicode');await disk('drag-target/e\u0301.txt','target');await assert.rejects(service.moveLocalWorktreeFile('repo','é.txt','drag-target',dir),/同名/)
  for(const [src,dest] of [['../outside/a','drag-target'],['.git/config','drag-target'],['drag-conflict','../outside'],['drag-conflict','.git'],['drag-target','folder'],['drag-conflict','drag-conflict'],['folder/b.txt','folder']])await assert.rejects(service.moveLocalWorktreeFile('repo',src,dest,dir))
  fs.symlinkSync(dir+'/drag-conflict',dir+'/drag-link');fs.symlinkSync(dir+'/drag-target',dir+'/drag-link-dir');await assert.rejects(service.moveLocalWorktreeFile('repo','drag-link','folder',dir),/符号链接/);await assert.rejects(service.moveLocalWorktreeFile('repo','drag-conflict','drag-link-dir',dir),/符号链接/)
  await assert.rejects(service.moveLocalWorktreeFile('repo','drag-conflict','folder',outside),/工作区路径/)
  const nativeRename=FileManager.rename;FileManager.rename=async()=>{throw Error('native move denied')};try{await assert.rejects(service.moveLocalWorktreeFile('repo','drag-conflict','folder',dir),/native move denied/)}finally{FileManager.rename=nativeRename}
  assert.equal(fs.readFileSync(dir+'/drag-conflict','utf8'),'source');assert.equal(fs.existsSync(dir+'/folder/drag-conflict'),false);assert.equal(removes,removedBefore)
  const gate=deferred();let began=false;const lock=coordinator.mutate(ctx.gitdir,async()=>{began=true;await gate.promise});while(!began)await tick();await assert.rejects(service.moveLocalWorktreeFile('repo','drag-conflict','folder',dir),/其它写操作/);gate.resolve();await lock;fs.unlinkSync(dir+'/drag-link');fs.unlinkSync(dir+'/drag-link-dir')
 })
 await test('actual file onDrag and directory onDrop wiring: authenticated session, synchronous load, move refresh, menu retained, busy/merge/external/cancel guards',async()=>{
  global.UUID={string:()=>require('node:crypto').randomUUID()};global.ItemProvider={fromText:text=>({registeredTypes:['public.utf8-plain-text','public.url'],loadText:async()=>text})}
  await disk('drag-ui.txt','move bytes');await disk('drag-cancel.txt','cancel bytes');fs.mkdirSync(dir+'/drag-ui-target')
  const props={files:['drag-ui.txt','drag-cancel.txt','drag-ui-target/existing'],changes:[],bookmarkName:'repo',loading:false,mergeInProgress:false,onCreateEntry(){},onOpen(){},onPush(){},onRestore(){},onWorktreeChanged:async()=>{props.changes=await service.getChanges('repo');updates++}}
  let updates=0;const h=mount(load('pages/FilesTab.tsx').FilesTab,props,{effectUpdates:true})
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  function nodes(){h.render();return all(expand(h.tree))}
  function file(name){return nodes().find(n=>n.type==='Button'&&n.props.onDrag&&JSON.stringify(n.children).includes(name))}
  function folder(){return nodes().find(n=>n.type==='DisclosureGroup'&&JSON.stringify(n.props.label).includes('drag-ui-target'))}
  function target(){return folder().props.label}
  const events=[]
  function info(provider){let inScope=true;return {hasItemsConforming:types=>{events.push('validate');assert.deepEqual(types,['public.utf8-plain-text','public.plain-text']);assert.equal(types.includes('public.url'),false);return types.some(type=>provider.registeredTypes.includes(type))},itemProviders:types=>{events.push('providers');assert.deepEqual(types,['public.utf8-plain-text','public.plain-text']);assert.equal(inScope,true);return [{loadText(){events.push('load');assert.equal(inScope,true,'load must start within performDrop');inScope=false;return provider.loadText()}}]}}}
  assert.ok(all(file('drag-ui.txt').props.contextMenu.menuItems).some(n=>n.props.title==='重命名'))
  assert.equal(folder().props.onDrag,undefined);assert.equal(folder().props.onDrop,undefined);assert.equal(target().type,'HStack');assert.deepEqual(target().props.frame,{maxWidth:Infinity,alignment:'leading'});assert.deepEqual(target().props.contentShape,{kind:'interaction',shape:'rect'});assert.ok(all(folder().props.contextMenu.menuItems).some(n=>n.props.title==='重命名'));assert.equal(target().props.onDrop.validateDrop(info(ItemProvider.fromText('external'))),false)
  const cancelled=file('drag-cancel.txt').props.onDrag.data();await tick();assert.equal(updates,0);assert.equal(fs.existsSync(dir+'/drag-cancel.txt'),true)
  const provider=file('drag-ui.txt').props.onDrag.data(),drop=target().props.onDrop;assert.equal(drop.validateDrop(info({registeredTypes:['public.url'],loadText:()=>{throw Error('URL-only representation must not load')}})),false);assert.equal(drop.validateDrop(info(provider)),true);assert.equal(drop.dropUpdated(info(provider)),'move');assert.equal(drop.performDrop(info(provider)),true);assert.deepEqual(events.slice(-3),['validate','providers','load'])
  assert.equal(drop.performDrop(info(provider)),false,'duplicate while busy rejected')
  for(let i=0;i<3000&&updates===0;i++){await new Promise(resolve=>setTimeout(resolve,10));h.render()}h.render();assert.equal(updates,1);assert.equal(fs.existsSync(dir+'/drag-ui.txt'),false);assert.equal(fs.readFileSync(dir+'/drag-ui-target/drag-ui.txt','utf8'),'move bytes')
  assert.ok(props.changes.some(c=>c.filepath==='drag-ui-target/drag-ui.txt'&&c.status==='*added'));folder().props.onChanged(true);assert.ok(nodes().some(n=>n.type==='Text'&&n.children.includes('已重命名')))
  for(let i=0;i<10;i++){await tick();h.render()}
  file('drag-cancel.txt').props.onDrag.data();assert.equal(target().props.onDrop.performDrop(info(ItemProvider.fromText(JSON.stringify({path:'drag-cancel.txt',bookmarkName:'repo'})))),true)
  for(let i=0;i<20;i++){await tick();h.render()}assert.match(text(h),/外来或过期/);assert.equal(fs.existsSync(dir+'/drag-cancel.txt'),true);assert.equal(updates,1)
  const stale=file('drag-cancel.txt').props.onDrag.data();props.mergeInProgress=true;assert.equal(target().props.onDrop,undefined);props.mergeInProgress=false;nodes();assert.equal(target().props.onDrop.validateDrop(info(stale)),false)
  file('drag-cancel.txt').props.onDrag.data();props.bookmarkName='other';nodes();assert.equal(target().props.onDrop.validateDrop(info(cancelled)),false)
  h.unmount();delete global.UUID;delete global.ItemProvider
 })
 console.log(`\n${count} local data/facade/UI groups passed; real disposable Git repo only, no network/user data.`)
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}))
