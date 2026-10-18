/* Real FS + bundled Git + production scan/hook/FilesTab, no phone or network. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),cp=require('node:child_process')
const {load,mount,ui,all,tick}=require('./remoteFiles.test.cjs');global.self=globalThis
const tmp=fs.mkdtempSync(os.tmpdir()+'/scriptgit-worktree-'),dir=tmp+'/work',gitdir=dir+'/metadata-storage',outside=tmp+'/outside'
fs.mkdirSync(dir);fs.mkdirSync(outside)
cp.execFileSync('git',['init','-qb','master','--separate-git-dir='+gitdir,dir])
const cmd=(...a)=>cp.execFileSync('git',['--git-dir='+gitdir,'--work-tree='+dir,...a],{encoding:'utf8'})
cmd('config','user.name','T');cmd('config','user.email','t@example.invalid')
function write(p,body){fs.mkdirSync(require('node:path').dirname(dir+'/'+p),{recursive:true});fs.writeFileSync(dir+'/'+p,body)}
write('.gitignore','ignored/\ntracked/ignored/\n*.skip\n');write('tracked/base','HEAD');write('tracked/ignored/kept','tracked despite ignore');cmd('add','-f','.gitignore','tracked');cmd('commit','-qm','base')
fs.mkdirSync(dir+'/app-temp');fs.mkdirSync(dir+'/nested/empty/leaf',{recursive:true});write('untracked/file','untracked bytes');write('tracked/ignored/hidden','do not show');write('ignored/private/file','do not scan');write('ignored-file.skip','do not show')
write('index-only/base','index');cmd('add','index-only/base');fs.mkdirSync(dir+'/index-only/empty');fs.mkdirSync(outside+'/target');fs.writeFileSync(outside+'/target/secret','OUTSIDE');fs.symlinkSync(outside+'/target',dir+'/linked-folder');fs.symlinkSync(outside+'/target/secret',dir+'/linked-file');fs.mkdirSync(dir+'/nested-repo');fs.mkdirSync(dir+'/nested-repo/.git');fs.writeFileSync(dir+'/nested-repo/file','nested repo')
let listings=[],absolute=false,denied=null,contentReads=[]
function readAllowed(p){assert.ok(p.startsWith(gitdir+'/')||p.endsWith('/.gitignore'),'no worktree payload read: '+p);contentReads.push(p)}
const exists=p=>{try{fs.lstatSync(p);return true}catch{return false}}
global.FileManager={
 isLink:async p=>exists(p)&&fs.lstatSync(p).isSymbolicLink(),isDirectory:async p=>exists(p)&&fs.statSync(p).isDirectory(),isFile:async p=>exists(p)&&fs.statSync(p).isFile(),exists:async p=>exists(p),
 readDirectory:async p=>{listings.push(p);if(p===denied)throw Error('permission denied');const names=fs.readdirSync(p);return absolute?names.map(n=>p+'/'+n):names},
 readAsString:async p=>{readAllowed(p);return fs.readFileSync(p,'utf8')},readAsBytes:async p=>{readAllowed(p);return new Uint8Array(fs.readFileSync(p))},
 stat:async p=>{const s=fs.statSync(p);return {size:s.size,creationDate:s.birthtimeMs,modificationDate:s.mtimeMs}},createDirectory:async p=>fs.mkdirSync(p),copyFile:async(a,b)=>fs.copyFileSync(a,b,fs.constants.COPYFILE_EXCL),remove:async p=>fs.rmSync(p,{recursive:true}),
}
const git=require('../vendor/index.umd.min.js'),readonlyFs={...fs,promises:{...fs.promises}}
for(const method of ['writeFile','mkdir','unlink','rmdir','rename','symlink']){const deny=()=>{throw Error('scan attempted write: '+method)};readonlyFs[method]=deny;readonlyFs.promises[method]=deny}
const {StatusCoordinator}=load('utils/statusCoordinator.ts'),coordinator=new StatusCoordinator()
const store={resolveRepoPathsReadOnly:()=>({workdir:dir,gitdir}),resolveWorkdir:()=>dir}
const scan=load('services/git/worktreeTreeService.ts',{'../repoStore':store,'../gitCore':{loadGitEngine:async()=>({git}),createFS:()=>readonlyFs},'./statusScanService':{runStatusRead:(_,task)=>coordinator.read(gitdir,task),statusRevision:()=>coordinator.revision(gitdir),canPublishStatus:(_,rev)=>rev===coordinator.revision(gitdir)&&!coordinator.isWriting(gitdir)},'../../utils/lru':load('utils/lru.ts'),'../../utils/fileListPerformance':load('utils/fileListPerformance.ts')})
const internal=load('services/git/localFileService.ts',{'../repoStore':store,'../localImportExecution':{}})
const FilesTab=load('pages/FilesTab.tsx',{scripting:ui,'../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},'../utils/fileTree':load('utils/fileTree.ts'),'../utils/fileListPerformance':load('utils/fileListPerformance.ts'),'../utils/format':{formatBytes:String,formatDate:String},'../services/repoStore':store,'../services/gitService':{deleteLocalWorktreeDirectory:internal.deleteLocalDirectoryInternal},'../constants/colors':{COLOR_SECONDARY_LABEL:'secondaryLabel',COLOR_ORANGE:'systemOrange'},'../services/localImportExecution':load('services/localImportExecution.ts'),'../services/localFileImport':{},'../services/localImportBatchSummary':{}}).FilesTab
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
function snapshot(){const out={};function walk(p){for(const n of fs.readdirSync(p)){const c=p+'/'+n,s=fs.lstatSync(c);out[c]=s.isDirectory()?'directory':s.isSymbolicLink()?['link',fs.readlinkSync(c)]:fs.readFileSync(c).toString('base64');if(s.isDirectory())walk(c)}}walk(tmp);return out}
let groups=0;async function test(name,fn){await fn();groups++;console.log('PASS '+name)}
async function main(){
 let entries
 await test('first entry finds root/nested empty + untracked-content directories; HEAD/index directories not invented green; scan writes nothing',async()=>{
  const before=snapshot();entries=await scan.getWorktreeEntries('repo');assert.deepEqual(snapshot(),before)
  for(const p of ['app-temp','nested','nested/empty','nested/empty/leaf','untracked','tracked','tracked/ignored','index-only','index-only/empty'])assert.ok(entries.directories.includes(p),p)
  for(const p of ['app-temp','nested/empty/leaf','untracked','index-only/empty'])assert.ok(entries.untrackedDirectories.includes(p),p)
  for(const p of ['tracked','tracked/ignored','index-only'])assert.ok(!entries.untrackedDirectories.includes(p),'known dir is neutral '+p)
  assert.ok(entries.files.includes('untracked/file'));assert.ok(entries.files.includes('tracked/ignored/kept'));assert.ok(!entries.files.includes('tracked/ignored/hidden'))
  for(const p of ['ignored','linked-folder','nested-repo','metadata-storage'])assert.ok(!entries.directories.includes(p),p)
  assert.ok(!listings.some(p=>p===gitdir||p.startsWith(gitdir+'/')||p.startsWith(outside)||p===dir+'/ignored'||p===dir+'/linked-folder'||p===dir+'/nested-repo/.git'))
  assert.equal(new Set(listings).size,listings.length,'one readDirectory per traversed directory');assert.ok(!entries.files.includes('ignored-file.skip'))
 })
 await test('relative/absolute direct-child APIs produce same result; unreadable path fails explicitly instead of claiming empty success',async()=>{
  absolute=true;const next=await scan.getWorktreeEntries('repo');for(const key of ['files','directories','untrackedDirectories'])assert.deepEqual([...next[key]].sort(),[...entries[key]].sort());absolute=false
  denied=dir+'/nested';await assert.rejects(scan.getWorktreeEntries('repo'),/permission/);denied=null
 })
 await test('production FileManager Git fs adapter enumerates same tree without opening arbitrary file contents or changing disk',async()=>{
  const core=load('services/gitCore.ts',{'../polyfills':{}})
  const actual=load('services/git/worktreeTreeService.ts',{'../repoStore':store,'../gitCore':{loadGitEngine:async()=>({git}),createFS:core.createFS},'./statusScanService':{runStatusRead:(_,task)=>coordinator.read(gitdir,task),statusRevision:()=>coordinator.revision(gitdir),canPublishStatus:(_,rev)=>rev===coordinator.revision(gitdir)&&!coordinator.isWriting(gitdir)},'../../utils/lru':load('utils/lru.ts'),'../../utils/fileListPerformance':load('utils/fileListPerformance.ts')})
  const before=snapshot(),next=await actual.getWorktreeEntries('repo');assert.deepEqual(snapshot(),before);for(const key of ['files','directories','untrackedDirectories'])assert.deepEqual([...next[key]].sort(),[...entries[key]].sort());assert.ok(contentReads.length>0)
 })
 const head=await git.listFiles({fs,dir,gitdir,ref:'HEAD'})
 const props={files:head,worktreeEntries:entries,changes:[],bookmarkName:'repo',loading:false,mergeInProgress:false,onWorktreeChanged:async()=>{props.worktreeEntries=await scan.getWorktreeEntries('repo')},onOpen(){},onPush(){},onStage(){},onRestore(){},onCreateEntry(){}}
 let h
 function folder(name){h.render();return all(expand(h.tree)).find(n=>n.type==='DisclosureGroup'&&all(n.props.label).some(n=>n.type==='Text'&&n.children.includes(name)))}
 function badge(name,green){const row=folder(name);assert.ok(row,'visible '+name);const label=all(row.props.label);assert.equal(label.some(n=>n.type==='Text'&&n.children.includes('新增')),green,'badge '+name);assert.equal(label.find(n=>n.type==='Image').props.foregroundStyle,green?'systemGreen':'secondaryLabel');return row}
 await test('actual FilesTab first mount/refresh/remount shows empty directories green; tracked directories neutral, real modified tracked directory orange; empty folders retain management/delete and gain scoped restore only',async()=>{
  for(let i=0;i<3;i++){
   props.worktreeEntries=await scan.getWorktreeEntries('repo');h=mount(FilesTab,props,{effectUpdates:true});badge('app-temp',true);badge('nested',true).props.onChanged(true);badge('empty',true).props.onChanged(true);badge('leaf',true);badge('untracked',true);badge('tracked',false);badge('index-only',false)
   const row=folder('app-temp');assert.deepEqual(row.props.label.props.trailingSwipeActions.actions.map(n=>n.props.title),['还原','删除']);assert.ok(all(row.props.contextMenu.menuItems).some(n=>n.props.title==='重命名'))
   props.worktreeEntries=await scan.getWorktreeEntries('repo');await tick();badge('app-temp',true);h.unmount()
  }
  props.changes=[{filepath:'tracked/base',status:'*modified',unstaged:true}];h=mount(FilesTab,props,{effectUpdates:true});const label=all(folder('tracked').props.label);assert.ok(label.some(n=>n.type==='Text'&&n.children.includes('已修改')));assert.equal(label.find(n=>n.type==='Image').props.foregroundStyle,'systemOrange');h.unmount();props.changes=[]
 })
 await test('production empty import discovered after refresh without session hints and after remount; existing directory collision stays zero-write; managed delete disappears on refresh',async()=>{
  fs.mkdirSync(outside+'/Imported Empty');await internal.importLocalDirectoryInternal('repo',outside+'/Imported Empty',dir);props.worktreeEntries=await scan.getWorktreeEntries('repo');h=mount(FilesTab,props,{effectUpdates:true});badge('Imported Empty',true);h.unmount();h=mount(FilesTab,props,{effectUpdates:true});badge('Imported Empty',true)
  const before=snapshot();await assert.rejects(internal.importLocalDirectoryInternal('repo',outside+'/Imported Empty',dir),/同名/);assert.deepEqual(snapshot(),before)
  global.Dialog={confirm:async()=>true};await folder('app-temp').props.label.props.trailingSwipeActions.actions.find(a=>a.props.title==='删除').props.action();await tick();h.render();assert.ok(!folder('app-temp'));assert.ok(!fs.existsSync(dir+'/app-temp'));h.unmount()
 })
 await test('actual detail data hook loads scan on initial files load, operation refresh, file-tab return and remount; read barrier blocks inventory behind writer',async()=>{
  let scans=0
  const hook=load('hooks/useRepoDetailData.ts',{scripting:ui,'../services/gitService':{getTrackedFiles:async()=>head,getWorktreeEntries:async()=>{scans++;return scan.getWorktreeEntries('repo')},getChanges:async()=>[],getRepoListStatus:async()=>({})},'../services/repoStore':{},'../utils/format':{},'../utils/github':{},'../utils/statusFreshness':{}}).useRepoDetailData
  const mounted=mount(hook,{bookmarkName:'repo',name:'Repo',showToast(){}});await mounted.tree.loadTrackedFiles();mounted.render();assert.ok(mounted.tree.worktreeEntries.directories.includes('Imported Empty'));await mounted.tree.refreshChangesAndSnapshot();mounted.render();await mounted.tree.handleTabChange(2).catch(()=>{});mounted.render();await mounted.tree.handleTabChange(0);mounted.render();assert.equal(scans,3);mounted.unmount()
  const fresh=mount(hook,{bookmarkName:'repo',name:'Repo',showToast(){}});await fresh.tree.loadTrackedFiles();fresh.render();assert.equal(scans,4);assert.ok(fresh.tree.worktreeEntries.directories.includes('Imported Empty'));fresh.unmount()
  let release,entered=false;const gate=new Promise(r=>release=r),writer=coordinator.mutate(gitdir,()=>gate);const pending=scan.getWorktreeEntries('repo').then(()=>entered=true);await tick();assert.equal(entered,false);release();await writer;await pending;assert.equal(entered,true)
 })
 console.log(groups+' disk tree/production FilesTab/detail-hook groups passed; temporary FS cleaned; phone app-temp origin/content not assumed.')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}))
