/* Real local-file service + facade/coordinator + real isomorphic-git on disposable test repos. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),ts=require('typescript')
const {ui,mount,node,all,text,tick,deferred}=require('./remoteFiles.test.cjs')
global.self=globalThis
const project=path.resolve(__dirname,'..'),git=require('../vendor/index.umd.min.js')
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-local-test-')),dir=tmp+'/work',outside=tmp+'/outside'
fs.mkdirSync(dir);fs.mkdirSync(outside)
let observeState=null
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
  const req=name=>{if(name==='scripting')return new Proxy(ui,{get:(target,key)=>key==='Widget'?{reloadAll(){}}:key==='useState'?initial=>{const [value,set]=target.useState(initial);return [value,next=>{set(next);observeState?.()}]}:target[key]});let dest=path.resolve(path.dirname(file),name);dest=['.ts','.tsx'].map(ext=>dest+ext).find(fs.existsSync)||dest
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
 await test('bounded original browser image bytes, no text Editor payload; native copy/rename keep binary bytes and HEAD/index unchanged',async()=>{
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,255]);await disk('photo.png',bytes)
  const file=await service.openLocalWorktreeFile('repo','photo.png');assert.equal(file.text,null);assert.equal(file.previewDataUrl,'data:image/png;base64,'+bytes.toString('base64'));assert.equal(file.previewImage,undefined)
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
  assert.deepEqual(all(expand(h.tree)).find(n=>n.type==='DisclosureGroup').props.label.props.trailingSwipeActions.actions.map(a=>a.props.title),['删除'])
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
  await disk('click.png',Buffer.from([137,80,78,71]));props.files=[...props.files,'click.png'];h.render();const pic=all(expand(h.tree)).find(n=>n.type==='Button'&&!n.props.title&&JSON.stringify(n.children).includes('click.png'));await pic.props.action();assert.ok(opened.previewDataUrl);assert.equal(opened.text,null);h.unmount()
 })
 await test('copy link is a file-only context action, propagates through nested folders and leaves worktree/HEAD/index untouched',async()=>{
  const copied=[],props={files:['a.txt','folder/b.txt'],loading:false,bookmarkName:'repo',changes:[],onCopyLink:path=>copied.push(path)}
  const h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function nodes(){h.render();function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}return all(expand(h.tree))}
  const row=name=>nodes().find(n=>n.type==='Button'&&n.props.trailingSwipeActions&&JSON.stringify(n.children).includes(name))
  const action=name=>all(row(name).props.contextMenu.menuItems).find(n=>n.props.title==='复制链接')
  const original=fs.readFileSync(dir+'/a.txt'),index=fs.readFileSync(dir+'/.git/index'),head=await git.resolveRef({fs,dir,ref:'HEAD'})
  assert.deepEqual(all(row('a.txt').props.contextMenu.menuItems).filter(n=>n.type==='Button').map(n=>n.props.title),['重命名','复制文件','复制链接','移动到…'])
  assert.equal(action('a.txt').props.systemImage,undefined);assert.equal(action('a.txt').props.disabled,false);await action('a.txt').props.action()
  const folder=nodes().find(n=>n.type==='DisclosureGroup');assert.deepEqual(all(folder.props.contextMenu.menuItems).filter(n=>n.type==='Button').map(n=>n.props.title),['重命名','复制文件夹']);folder.props.onChanged(true)
  await action('b.txt').props.action();assert.deepEqual(copied,['a.txt','folder/b.txt'])
  props.changes=[{filepath:'a.txt',status:'*deleted',worktreeDeleted:true}];assert.equal(action('a.txt').props.disabled,true)
  props.loading=true;assert.equal(action('b.txt').props.disabled,true)
  assert.deepEqual(fs.readFileSync(dir+'/a.txt'),original);assert.deepEqual(fs.readFileSync(dir+'/.git/index'),index);assert.equal(await git.resolveRef({fs,dir,ref:'HEAD'}),head);h.unmount()
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
  const staged=[];const props={files:['swipe-folder/sub/a','swipe-folder-other/b'],loading:false,bookmarkName:'repo',changes:[{filepath:'swipe-folder/sub/a',status:'*modified'}],onWorktreeChanged:()=>updates++,onOpen(){},onPush:()=>pushes++,onStage:paths=>staged.push(paths),onRestore(){},mergeInProgress:false}
  const h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  function folders(){h.render();return all(expand(h.tree)).filter(n=>n.type==='DisclosureGroup')}
  let groups=folders();groups[0].props.onChanged(true);groups=folders();let a=groups[0].props.label.props.trailingSwipeActions.actions
  assert.match(JSON.stringify(groups[0].props.label),/已修改/);assert.match(JSON.stringify(groups[1].props.label),/已修改/);assert.doesNotMatch(JSON.stringify(groups.at(-1).props.label),/已修改/);assert.deepEqual(a.map(n=>n.props.title),['推送','还原','暂存','删除']);assert.ok(a.every(n=>!n.props.systemImage));assert.equal(groups[0].props.label.props.trailingSwipeActions.allowsFullSwipe,false)
  assert.deepEqual(groups.at(-1).props.label.props.trailingSwipeActions.actions.map(n=>n.props.title),['删除'])
  const by=t=>a.find(n=>n.props.title===t)
  assert.equal(by('暂存').props.tint,'systemPurple','folder 暂存 is purple');await by('暂存').props.action();assert.deepEqual(staged,[['swipe-folder/sub/a']],'folder 暂存 dispatches exactly its changed paths to Stash handler')
  await by('推送').props.action();assert.equal(pushes,1)
  confirm=false;await by('还原').props.action();assert.ok(fs.existsSync(dir+'/swipe-folder/sub/a'))
  confirm=false;await by('删除').props.action();assert.ok(fs.existsSync(dir+'/swipe-folder/sub/a'))
  confirm=true;await by('删除').props.action();assert.ok(!fs.existsSync(dir+'/swipe-folder'));assert.ok(updates>0);h.unmount()
 })
 await test('nested swipe scope: folder labels retain actions; unchanged/changed nested files inherit no duplicate delete/stash/restore/push',async()=>{
  const props={files:['nest/sub/clean','nest/sub/dirty'],changes:[{filepath:'nest/sub/dirty',status:'*modified'}],bookmarkName:'repo',loading:false,mergeInProgress:false,onWorktreeChanged(){},onOpen(){},onStage(){},onPush(){},onRestore(){}}
  const h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  const groups=()=>{h.render();return all(expand(h.tree)).filter(n=>n.type==='DisclosureGroup')}
  groups()[0].props.onChanged(true);groups()[1].props.onChanged(true)
  let checked=0
  function check(n,inherited=[]){
   if(!n||typeof n!=='object')return
   if(Array.isArray(n)){n.forEach(v=>check(v,inherited));return}
   const own=n.props?.trailingSwipeActions?.actions||[]
   if(n.type==='DisclosureGroup'){
    assert.equal(own.length,0,'container must not propagate folder actions to descendants')
    assert.deepEqual(n.props.label.props.trailingSwipeActions.actions.map(a=>a.props.title),['推送','还原','暂存','删除'])
   }
   if(n.type==='Button'&&n.props.contextMenu){
    const titles=[...inherited,...own].map(a=>a.props.title)
    const dirty=JSON.stringify(n.children).includes('dirty')
    assert.deepEqual(titles,dirty?['推送','还原','暂存','删除']:['删除'])
    assert.equal(new Set(titles).size,titles.length,'each legal action exactly once')
    // Apple SwiftUI: actions start at originating edge; trailing is right in LTR.
    assert.deepEqual([...titles].reverse(),dirty?['删除','暂存','还原','推送']:['删除']);checked++
   }
   check(n.children,[...inherited,...own])
  }
  h.render();check(expand(h.tree));assert.equal(checked,2);h.unmount()
 })
 await test('folder restore routes changed descendants to shared parent confirmation without changing disk',async()=>{
  await disk('folder/b.txt','changed inside');await disk('a.txt','changed outside');let request
  const props={files:['folder/b.txt','a.txt'],loading:false,bookmarkName:'repo',changes:[{filepath:'folder/b.txt',status:'*modified'},{filepath:'a.txt',status:'*modified'}],onWorktreeChanged(){},onOpen(){},onPush(){},onRestore:(...args)=>request=args,mergeInProgress:false}
  const h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  const group=all(expand(h.tree)).find(n=>n.type==='DisclosureGroup'),before=confirmations.length
  await group.props.label.props.trailingSwipeActions.actions.find(n=>n.props.title==='还原').props.action()
  assert.deepEqual(request,['folder',['folder/b.txt'],true]);assert.equal(confirmations.length,before)
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
 await test('real folder context menu uses copy sheet and centered rename prompt; cancel/no-op, refreshed paths incl empty dirs, unsafe and native errors visible',async()=>{
  await disk('form-folder/sub/a','nested');await disk('form-folder/untracked.bin',Buffer.from([0,255]));fs.mkdirSync(dir+'/form-folder/empty');let updates=0
  const props={files:['form-folder/sub/a'],loading:false,bookmarkName:'repo',changes:[],onWorktreeChanged:()=>updates++,onOpen(){},onPush(){},onRestore(){},mergeInProgress:false},h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  function group(name){h.render();return all(expand(h.tree)).find(n=>n.type==='DisclosureGroup'&&JSON.stringify(n.props.label).includes('"'+name+'"'))}
  function action(name,title){return all(group(name).props.contextMenu.menuItems).find(n=>n.props.title===title).props.action()}
  function form(){h.render();assert.equal(h.tree.props.sheet.isPresented,true);return h.tree.props.sheet.content.props}
  await action('form-folder','复制文件夹');assert.equal(form().initialName,'form-folder 副本');form().onCancel();h.render();assert.equal(h.tree.props.sheet.isPresented,false);assert.equal(updates,0)
  global.Dialog.prompt=async options=>{assert.equal(options.title,'重命名文件夹');assert.equal(options.defaultValue,'form-folder');h.render();assert.equal(h.tree.props.sheet.isPresented,false);return 'form-folder'};await action('form-folder','重命名');h.render();assert.equal(h.tree.props.sheet.isPresented,false);assert.equal(updates,0)
  await action('form-folder','复制文件夹');await form().onConfirm('../bad');assert.match(form().error,/合法/);assert.ok(fs.existsSync(dir+'/form-folder/sub/a'));form().onCancel()
  await action('form-folder','复制文件夹');await form().onConfirm('form copy');assert.ok(group('form copy'));group('form copy').props.onChanged(true);assert.ok(group('empty'));assert.ok(fs.existsSync(dir+'/form copy/untracked.bin'));const afterCopy=updates
  global.Dialog.prompt=async()=> 'form renamed';await action('form copy','重命名');assert.ok(group('form renamed'));assert.ok(!fs.existsSync(dir+'/form copy'));assert.equal(updates,afterCopy+1)
  const rename=FileManager.rename;FileManager.rename=async()=>{throw Error('UI denied')};global.Dialog.prompt=async()=> 'denied form';try{await action('form-folder','重命名')}finally{FileManager.rename=rename}assert.match(text(h),/UI denied/);assert.ok(fs.existsSync(dir+'/form-folder/sub/a'));h.render();assert.equal(h.tree.props.sheet.isPresented,false);h.unmount()
 })
 await test('folder rename uses centered prompt only: cancel, invalid/collision, busy duplicate, changed workspace, merge and unmount guards preserve source',async()=>{
  await disk('prompt-folder/sub/a','draft');await disk('prompt-collision/a','other');let updates=0,prompts=0
  const props={files:['prompt-folder/sub/a'],loading:false,bookmarkName:'repo',changes:[],onWorktreeChanged:()=>updates++,mergeInProgress:false}
  const h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function action(){
   h.render();const node=all(h.tree).find(n=>typeof n.type==='function'&&n.props.node?.path==='prompt-folder')
   const group=node.type(node.props)
   return all(group.props.contextMenu.menuItems).find(n=>n.props.title==='重命名').props.action()
  }
  const index=fs.readFileSync(dir+'/.git/index'),head=await git.resolveRef({fs,dir,ref:'HEAD'})
  global.Dialog.prompt=async opts=>{prompts++;assert.equal(opts.title,'重命名文件夹');assert.equal(opts.defaultValue,'prompt-folder');assert.equal(opts.cancelLabel,'取消');h.render();assert.equal(h.tree.props.sheet.isPresented,false);return null}
  await action();assert.equal(updates,0)
  for(const input of ['../escape','prompt-collision']){global.Dialog.prompt=async()=>input;await action();assert.match(text(h),/合法|存在|同名/);assert.equal(fs.readFileSync(dir+'/prompt-folder/sub/a','utf8'),'draft')}
  const gate=deferred();global.Dialog.prompt=async()=>{prompts++;return gate.promise};const pending=action();await tick();const before=prompts;await action();assert.equal(prompts,before);gate.resolve(null);await pending
  global.Dialog.prompt=async()=>{root=outside;return 'wrong-target'};try{await action()}finally{root=dir};assert.match(text(h),/工作区路径已变化/);assert.equal(fs.existsSync(outside+'/wrong-target'),false)
  props.mergeInProgress=true;global.Dialog.prompt=async()=>{throw Error('must not open')};await action();props.mergeInProgress=false
  const detached=deferred();global.Dialog.prompt=async()=>detached.promise;const late=action();await tick();h.unmount();detached.resolve('not-renamed');await late;assert.equal(h.lateWrites,0)
  assert.equal(fs.readFileSync(dir+'/prompt-folder/sub/a','utf8'),'draft');assert.equal(fs.readFileSync(dir+'/prompt-collision/a','utf8'),'other');assert.deepEqual(fs.readFileSync(dir+'/.git/index'),index);assert.equal(await git.resolveRef({fs,dir,ref:'HEAD'}),head)
 })
 await test('rename and restore never render deleted badges in any intermediate setter or changes-before-inventory frame; real delete clears immediately on restored status',async()=>{
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  for(const directory of [false,true]){
   const source=directory?'transition-source-dir':'transition-source.txt',target=directory?'transition-target-dir':'transition-target.txt',suffix=directory?'/child.txt':'';await disk(source+suffix,'bytes')
   const frames=[],beforeEntries={files:[source+suffix],directories:directory?[source]:[],untrackedDirectories:[]}
   const props={files:[source+suffix],worktreeEntries:beforeEntries,changes:[],bookmarkName:'repo',loading:false,mergeInProgress:false,onOpen(){},onPush(){},onStage(){},onRestore(){},onWorktreeChanged:async()=>{
    props.changes=[{filepath:source+suffix,status:'*deleted',worktreeDeleted:true},{filepath:target+suffix,status:'*added'}]
    capture('new status with OLD inventory');props.worktreeEntries={files:[target+suffix],directories:directory?[target]:[],untrackedDirectories:directory?[target]:[]};capture('matching new inventory')
   }}
   const h=mount(load('pages/FilesTab.tsx').FilesTab,props);let capturing=false
   function capture(label){if(capturing)return;capturing=true;try{h.render();frames.push([label,JSON.stringify(expand(h.tree))])}finally{capturing=false}}
   observeState=()=>capture('setter');global.Dialog.prompt=async()=>target
   try{
    h.render();const n=all(h.tree).find(n=>typeof n.type==='function'&&n.props.node?.path===source);const row=n.type(n.props)
    await all(row.props.contextMenu.menuItems).find(n=>n.props.title==='重命名').props.action()
    props.changes=[];capture('restored status before inventory');props.worktreeEntries=beforeEntries;capture('restored inventory')
    for(const [label,frame]of frames)assert.doesNotMatch(frame,/已删除/,label+' '+(directory?'folder':'file'))
   }finally{observeState=null;h.unmount()}
  }
  await disk('transition-delete.txt','bytes');const props={files:['transition-delete.txt'],changes:[],bookmarkName:'repo',loading:false,onWorktreeChanged(){},onOpen(){},onPush(){},onRestore(){},mergeInProgress:false},h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  h.render();const n=all(h.tree).find(n=>typeof n.type==='function'&&n.props.node?.path==='transition-delete.txt');await n.type(n.props).props.trailingSwipeActions.actions.find(n=>n.props.title==='删除').props.action();h.render();assert.match(JSON.stringify(expand(h.tree)),/已删除/)
  props.changes=[];h.render();assert.doesNotMatch(JSON.stringify(expand(h.tree)),/已删除/);h.unmount()
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
  assert.equal(row('icon-photo.png'),undefined)
  for(const status of ['*added','*modified']){props.changes=[...props.changes.filter(c=>c.filepath!=='icon-renamed.png'),{filepath:'icon-renamed.png',status}];assert.equal(color('icon-renamed.png'),'systemOrange');const text=JSON.stringify(row('icon-renamed.png').children);assert.match(text,/已重命名/);assert.doesNotMatch(text,/已修改|新增/);assert.equal(props.changes.at(-1).status,status)}
  props.changes=[...props.changes,{filepath:'icon-photo.png',status:'*deleted',worktreeDeleted:true}]
  assert.equal(row('icon-photo.png'),undefined);assert.ok(row('icon-deleted'))
  global.Dialog.prompt=async()=> 'icon-twice.png';await all(row('icon-renamed.png').props.contextMenu.menuItems).find(n=>n.props.title==='重命名').props.action()
  assert.equal(row('icon-photo.png'),undefined);assert.equal(row('icon-renamed.png'),undefined);assert.match(JSON.stringify(row('icon-twice.png').children),/已重命名/)
  global.Dialog.prompt=async()=> 'icon-photo.png';await all(row('icon-twice.png').props.contextMenu.menuItems).find(n=>n.props.title==='重命名').props.action()
  // A later status refresh reflects a rename back to the original path.
  props.changes=[];assert.ok(row('icon-photo.png'));h.unmount()
 })
 await test('rename folding preserves recreated sources and unrelated deletions with live inventory',async()=>{
  await disk('fold-original.txt','bytes');const index=fs.readFileSync(dir+'/.git/index'),head=await git.resolveRef({fs,dir,ref:'HEAD'})
  const props={files:['fold-original.txt','unrelated-deleted.txt'],loading:false,bookmarkName:'repo',changes:[],worktreeEntries:{files:['fold-original.txt'],directories:[],untrackedDirectories:[]},onWorktreeChanged(){},onOpen(){},onPush(){},onRestore(){},mergeInProgress:false}
  const h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function rows(){h.render();return all(h.tree).filter(n=>typeof n.type==='function'&&n.props.node?.type==='file')}
  const original=rows().find(n=>n.props.node.path==='fold-original.txt');global.Dialog.prompt=async()=> 'fold-new.txt'
  await all(original.type(original.props).props.contextMenu.menuItems).find(n=>n.props.title==='重命名').props.action()
  assert.equal(rows().some(n=>n.props.node.path==='fold-original.txt'),false)
  props.worktreeEntries={files:['fold-new.txt'],directories:[],untrackedDirectories:[]}
  props.changes=[{filepath:'fold-original.txt',status:'*deleted',worktreeDeleted:true},{filepath:'fold-new.txt',status:'*added'},{filepath:'unrelated-deleted.txt',status:'*deleted',worktreeDeleted:true}]
  assert.deepEqual(rows().map(n=>n.props.node.path).sort(),['fold-new.txt','unrelated-deleted.txt'])
  await disk('fold-original.txt','recreated');props.worktreeEntries={...props.worktreeEntries,files:['fold-new.txt','fold-original.txt']};props.changes=[...props.changes.filter(c=>c.filepath!=='fold-original.txt'),{filepath:'fold-original.txt',status:'*modified'}]
  assert.ok(rows().find(n=>n.props.node.path==='fold-original.txt'))
  assert.equal(fs.readFileSync(dir+'/fold-new.txt','utf8'),'bytes');assert.deepEqual(fs.readFileSync(dir+'/.git/index'),index);assert.equal(await git.resolveRef({fs,dir,ref:'HEAD'}),head);h.unmount()
 })
 await test('clean file presentation after ordinary status refresh',async()=>{
  await disk('icon-renamed.png','bytes');const props={files:['icon-renamed.png','icon-mod'],changes:[],bookmarkName:'repo',loading:false};const h=mount(load('pages/FilesTab.tsx').FilesTab,props)
  function row(name){h.render();const n=all(h.tree).find(n=>typeof n.type==='function'&&n.props.node?.path===name);return n.type(n.props)}
  const color=name=>all(row(name)).find(n=>n.type==='Image').props.foregroundStyle
  props.changes=[];assert.equal(color('icon-renamed.png'),'secondaryLabel');assert.doesNotMatch(JSON.stringify(row('icon-renamed.png').children),/已重命名/);assert.equal(color('icon-mod'),'secondaryLabel');h.unmount()
 })
 await test('folder rename collapses old tree and marks only renamed root; children and real Git changes preserved',async()=>{
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
  global.Dialog.prompt=async()=> 'target';await all(folder('source').props.contextMenu.menuItems).find(n=>n.props.title==='重命名').props.action();h.render();assert.equal(h.tree.props.sheet.isPresented,false)
  assert.match(label('target'),/已重命名/);assert.doesNotMatch(label('target'),/已修改/)
  folder('target').props.onChanged(true);folder('sub').props.onChanged(true)
  assert.doesNotMatch(label('sub'),/已重命名|新增/)
  for(const name of ['a.txt','b.txt']){assert.doesNotMatch(fileLabel(name),/已重命名|新增/);assert.equal(all(row(name)).find(n=>n.type==='Image').props.foregroundStyle,'secondaryLabel')}
  assert.equal(folder('source'),undefined)
  assert.match(label('ordinary'),/已修改/);assert.doesNotMatch(label('ordinary'),/已重命名/)
  assert.match(label('rename-parent'),/已修改/);assert.doesNotMatch(label('rename-parent'),/已重命名/)
  props.changes=[{filepath:'rename-parent/target/sub/a.txt',status:'*added'},{filepath:'rename-parent/target/b.txt',status:'*modified'},{filepath:'rename-parent/source/sub/a.txt',status:'*deleted',worktreeDeleted:true}]
  props.worktreeEntries={files:['rename-parent/target/sub/a.txt','rename-parent/target/b.txt'],directories:['rename-parent','rename-parent/target','rename-parent/target/sub'],untrackedDirectories:['rename-parent/target','rename-parent/target/sub']}
  assert.match(label('target'),/已重命名/);assert.doesNotMatch(label('sub'),/已重命名|新增/)
  for(const name of ['a.txt','b.txt'])assert.doesNotMatch(fileLabel(name),/已重命名|新增/)
  assert.match(fileLabel('b.txt'),/已修改/);assert.equal(folder('source'),undefined)
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
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));// This test selects rows by basename, so traverse only native-visible content.
   return {...n,children:(n.type==='DisclosureGroup'&&!n.props.isExpanded?[]:n.children||[]).map(expand)}}
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
  async function directoryAction(name,title,next){if(title==='重命名')global.Dialog.prompt=async()=>next;await all(folder(name).props.contextMenu.menuItems).find(n=>n.props.title===title).props.action();h.render();if(title==='重命名')assert.equal(h.tree.props.sheet.isPresented,false);else await h.tree.props.sheet.content.props.onConfirm(next)}
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
  assert.deepEqual(all(folder('gone').props.label.props.trailingSwipeActions.actions).filter(n=>n.type==='Button').map(n=>n.props.title),['推送','还原','暂存','删除'])
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
  // This disposable attack fixture points back to its own ancestor. Retire the link
  // after its rejection is verified, before later cases scan this shared Git repo.
  // Otherwise the native Node Git walker follows it repeatedly through worktree links.
  const cycle=outside+'/unsafe-dir-link/child'
  assert.equal(fs.lstatSync(cycle).isSymbolicLink(),true)
  fs.unlinkSync(cycle)
  assert.ok(fs.existsSync(outside+'/secret'),'unlink must preserve the target')
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
  assert.match(JSON.stringify(h.tree.props.header),/仓库文件.*（1）/);const groups=menu.children.filter(n=>n.type==='Section');assert.equal(groups.length,2);assert.doesNotMatch(JSON.stringify(menu),/仅诊断|拖动记录/);assert.match(JSON.stringify(groups[0].props.header),/添加到仓库/)
  assert.deepEqual(all(menu.children).filter(n=>n.type==='Button').map(n=>[n.props.title,n.props.systemImage]),[['创建文件','doc.text'],['创建目录','folder'],['导入文件','doc.text'],['导入目录','folder'],['导入图片','photo']])
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
  // Real directory picker -> facade/coordinator -> native mkdir -> FilesTab:
  // Git has no empty-directory rows, so labels must survive real changes refreshes.
  const emptyIndex=fs.readFileSync(dir+'/.git/index'),emptyHead=await git.resolveRef({fs,dir,ref:'HEAD'})
  const folderRow=name=>nodes().find(n=>n.type==='DisclosureGroup'&&all(n.props.label).some(t=>t.type==='Text'&&t.children.includes(name)))
  const assertAddedFolder=name=>{const row=folderRow(name);assert.ok(row,'directory visible: '+name);const label=all(row.props.label);assert.ok(label.some(n=>n.type==='Image'&&n.props.systemName==='folder'&&n.props.foregroundStyle==='systemGreen'),'green folder: '+name);assert.ok(label.some(n=>n.type==='Text'&&n.children.includes('新增')&&n.props.foregroundStyle==='systemGreen'),'green 新增: '+name);assert.deepEqual(row.props.label.props.trailingSwipeActions.actions.map(a=>a.props.title),['还原','删除'],'empty directory gains restore only; no push/Stash actions');return row}
  for(const [name,child] of [['UI Empty Imported',''],['UI Nested Empty','middle/leaf']]){
   selectedDirectory=outside+'/'+name;fs.mkdirSync(selectedDirectory+(child?'/'+child:''),{recursive:true});await dispatch('导入目录')
   for(let refresh=0;refresh<3;refresh++){
    if(refresh===0){props.changes=await service.getChanges('repo');props.files=await load('services/git/statusQueryService.ts').getTrackedFiles('repo')}
    else {props.changes=[...props.changes];props.files=[...props.files]}
    await tick();h.render()
    const rootRow=assertAddedFolder(name);assert.equal(props.changes.some(c=>c.filepath===name||c.filepath.startsWith(name+'/')),false)
    if(child){rootRow.props.onChanged(true);assertAddedFolder('middle').props.onChanged(true);assertAddedFolder('leaf')}
   }
   assert.deepEqual(fs.readdirSync(dir+'/'+name+(child?'/'+child:'')),[],'no .gitkeep or other placeholder')
   assert.deepEqual(fs.readdirSync(selectedDirectory+(child?'/'+child:'')),[],'source remains empty')
  }
  // Existing destination directories are NOT merged by the production import service.
  // A rejected conflict must not mark the existing folder or inject its source children.
  selectedDirectory=outside+'/folder';fs.mkdirSync(selectedDirectory+'/not-imported-empty',{recursive:true});await dispatch('导入目录');assert.match(text(h),/同名|存在/)
  assert.equal(fs.existsSync(dir+'/folder/not-imported-empty'),false);assert.doesNotMatch(JSON.stringify(folderRow('folder').props.label),/新增/)
  selectedDirectory=null;const cancelRefresh=updates;await dispatch('导入目录');assert.equal(updates,cancelRefresh);assertAddedFolder('UI Empty Imported')
  assert.deepEqual(fs.readFileSync(dir+'/.git/index'),emptyIndex);assert.equal(await git.resolveRef({fs,dir,ref:'HEAD'}),emptyHead)
  // Hints intentionally belong to this mounted FilesTab only, not new persistence.
  const reopened=mount(Host,props,{effectUpdates:true});assert.doesNotMatch(JSON.stringify(reopened.tree),/UI Empty Imported|UI Nested Empty/);reopened.unmount()
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
  assert.match(text(h),/未导入任何文件[\s\S]*ui-partial.bin：原生复制\/核对失败.*部分导入/);assert.doesNotMatch(text(h),/成功\d|批量导入结果/);assert.ok(!text(h).includes(outside),'no private source path in batch summary');assert.ok(updates>partialRefresh);assert.equal(fs.readFileSync(dir+'/ui-partial.bin','utf8'),'partial');assert.equal(fs.readFileSync(outside+'/ui-partial.bin','utf8'),'original')
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
 await test('Changes Git Stage remains: real addFiles stages chosen paths; HEAD unchanged, nothing committed or pushed',async()=>{
  await disk('stage-a.txt','a');await disk('stage-dir/b.txt','b');await disk('stage-dir/c.txt','c')
  const head=await git.resolveRef({fs,dir,ref:'HEAD'})
  const staged=async()=>(await git.statusMatrix({fs,dir})).filter(r=>r[0].startsWith('stage-')).map(r=>[r[0],r[2],r[3]]).sort()
  assert.deepEqual(await staged(),[['stage-a.txt',2,0],['stage-dir/b.txt',2,0],['stage-dir/c.txt',2,0]],'untracked before staging')
  // Production fs wrapper has promise exists(); the test fixture uses Node's fs, so shim only that call.
  const realFs=ctx.fs;ctx.fs=Object.assign({},realFs,{exists:async p=>fs.existsSync(dir+'/'+p)});try{
  await service.addFiles('repo','stage-a.txt')
  assert.deepEqual(await staged(),[['stage-a.txt',2,2],['stage-dir/b.txt',2,0],['stage-dir/c.txt',2,0]],'only the chosen file is staged')
  for(const p of ['stage-dir/b.txt','stage-dir/c.txt'])await service.addFiles('repo',p)
  assert.deepEqual(await staged(),[['stage-a.txt',2,2],['stage-dir/b.txt',2,2],['stage-dir/c.txt',2,2]],'folder stages every changed path under it')
  assert.equal(await git.resolveRef({fs,dir,ref:'HEAD'}),head,'no commit was created')
  const changes=await service.getChanges('repo');assert.ok(changes.filter(c=>c.filepath.startsWith('stage-')).every(c=>c.staged),'app reports them staged')
  for(const p of ['stage-a.txt','stage-dir/b.txt','stage-dir/c.txt'])await service.unstageFiles('repo',p)
  }finally{ctx.fs=realFs}
 })
 await test('long-press 移动到…: real FilesTab menu, folder list, native move, Git D/A only, cancel/busy/merge guards, no drag wiring',async()=>{
  await disk('mv-ui.txt','move bytes');await disk('mv-cancel.txt','cancel bytes');fs.mkdirSync(dir+'/mv-target');fs.mkdirSync(dir+'/mv-other')
  // 源文件必须是已被 Git 跟踪的文件，移动后才有「已删除」可显示。
  await git.add({fs,dir,filepath:'mv-ui.txt'});await git.commit({fs,dir,message:'track mv-ui',author:{name:'t',email:'t@t'}})
  const props={files:['mv-ui.txt','mv-cancel.txt','mv-target/existing','mv-other/x'],changes:[],bookmarkName:'repo',loading:false,mergeInProgress:false,onCreateEntry(){},onOpen(){},onPush(){},onRestore(){},onWorktreeChanged:async()=>{props.changes=await service.getChanges('repo');updates++}}
  let updates=0;const h=mount(load('pages/FilesTab.tsx').FilesTab,props,{effectUpdates:true})
  function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
  function nodes(){h.render();return all(expand(h.tree))}
  function file(name){return nodes().find(n=>n.type==='Button'&&n.props.contextMenu&&JSON.stringify(n.children).includes(name))}
  const moveItem=name=>all(file(name).props.contextMenu.menuItems).find(n=>n.props.title==='移动到…')
  assert.ok(moveItem('mv-ui.txt'),'file long-press menu offers 移动到…');assert.equal(file('mv-ui.txt').props.onDrag,undefined,'no drag wiring')
  assert.ok(nodes().every(n=>n.props?.onDrop===undefined),'no drop wiring anywhere')
  assert.ok(!JSON.stringify(h.tree).includes('查看拖动记录'),'diagnostic entry removed')
  // Cancel: choosing nothing changes nothing.
  global.Dialog.actionSheet=async()=>null;await moveItem('mv-cancel.txt').props.action();for(let i=0;i<10;i++){await tick();h.render()}
  assert.equal(fs.existsSync(dir+'/mv-cancel.txt'),true);assert.equal(updates,0)
  // The sheet lists existing folders (not the file's own parent) and a pick moves the file natively.
  let offered=null;global.Dialog.actionSheet=async o=>{offered=o.actions.map(a=>a.label);return offered.indexOf('mv-target')}
  const ORANGE=load('constants/colors.ts').COLOR_ORANGE;await moveItem('mv-ui.txt').props.action()
  for(let i=0;i<3000&&updates===0;i++){await new Promise(resolve=>setTimeout(resolve,1));await tick();h.render()}
  assert.ok(offered.includes('mv-target')&&offered.includes('mv-other'),'existing folders offered');assert.equal(fs.existsSync(dir+'/mv-ui.txt'),false);assert.equal(fs.readFileSync(dir+'/mv-target/mv-ui.txt','utf8'),'move bytes')
  assert.ok(props.changes.some(c=>c.filepath==='mv-target/mv-ui.txt'),'refresh reports the moved file')
  // 移动后的三处显示：①源位置显示红色「已删除」 ②目标文件夹橙色「已修改」 ③移入的文件绿色「新增」，图标同色。
  {const folderNode=name=>nodes().find(n=>n.type==='DisclosureGroup'&&JSON.stringify(n.props.label).includes(name))
   const labelOf=n=>all(n).filter(x=>x.type==='Text').map(x=>[x.children.join(''),x.props.foregroundStyle])
   const iconOf=n=>all(n).find(x=>x.type==='Image').props.foregroundStyle
   folderNode('mv-target').props.onChanged(true);h.render()
   const rows=nodes().filter(n=>n.type==='Button'&&n.props.contextMenu&&JSON.stringify(n.children).includes('mv-ui.txt'))
   const info=rows.map(r=>({texts:labelOf(r),icon:iconOf(r),disabled:r.props.disabled}))
   const added=info.find(r=>r.texts.some(([t])=>t==='新增')),gone=info.find(r=>r.texts.some(([t])=>t==='已删除'))
   assert.ok(added,'③ moved-in file shows 新增: '+JSON.stringify(info));assert.ok(added.texts.some(([t,c])=>t==='新增'&&c==='systemGreen'));assert.equal(added.icon,'systemGreen')
   assert.ok(gone,'① source location shows 已删除: '+JSON.stringify(info));assert.ok(gone.texts.some(([t,c])=>t==='已删除'&&c==='systemRed'));assert.equal(gone.icon,'systemRed')
   const fl=labelOf(folderNode('mv-target').props.label)
   assert.ok(fl.some(([t,c])=>t==='已修改'&&c==='systemOrange'),'② destination folder shows 已修改 in orange: '+JSON.stringify(fl));assert.equal(iconOf(folderNode('mv-target').props.label),'systemOrange')}
  // Name collision: destination already has the name, source must stay untouched and error is visible.
  await disk('mv-other/mv-cancel.txt','other');updates=0
  global.Dialog.actionSheet=async o=>o.actions.map(a=>a.label).indexOf('mv-other');await moveItem('mv-cancel.txt').props.action()
  for(let i=0;i<30;i++){await tick();h.render()}
  assert.equal(fs.readFileSync(dir+'/mv-cancel.txt','utf8'),'cancel bytes');assert.equal(fs.readFileSync(dir+'/mv-other/mv-cancel.txt','utf8'),'other');assert.match(text(h),/同名|已存在/)
  // Merge in progress: the action does nothing and never opens the sheet.
  let opened=0;global.Dialog.actionSheet=async()=>{opened++;return 0};props.mergeInProgress=true;h.render();await moveItem('mv-cancel.txt').props.action();assert.equal(opened,0)
  h.unmount()
 })
 console.log(`\n${count} local data/facade/UI groups passed; real disposable Git repo only, no network/user data.`)
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}))
