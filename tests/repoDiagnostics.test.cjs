/* Production read-only resolver/collector, real disposable split-gitdir repository, no phone data. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process')
const {load,mount,ui,all,tick,deferred}=require('./remoteFiles.test.cjs')
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-diagnostic-')),group=tmp+'/app-group',dir=tmp+'/elsewhere/All',gitdir=group+'/git-repos/rAll'
fs.mkdirSync(path.dirname(dir),{recursive:true});fs.mkdirSync(path.dirname(gitdir),{recursive:true})
const cmd=(...args)=>cp.execFileSync('git',['--git-dir='+gitdir,'--work-tree='+dir,...args],{encoding:'utf8'})
cp.execFileSync('git',['init','-q','-b','master','--separate-git-dir='+gitdir,dir])
cmd('config','user.name','Test');cmd('config','user.email','test@example.invalid')
const token='ghp_PRIVATE_TOKEN_123456',authUrl='https://user:'+token+'@example.invalid/private.git'
fs.writeFileSync(dir+'/private-work-file','PRIVATE_WORK_CONTENT '+token);cmd('add','.');cmd('commit','-qm','base');cmd('remote','add','origin',authUrl);cmd('update-ref','refs/remotes/origin/master','HEAD');cmd('symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/master');cmd('pack-refs','--all')
let repo={bookmarkName:'id',repoId:'rAll',name:'All',source:'clone',createdAt:1,workdir:'/stale/iCloud/git/All',workdirRelative:'All',accessBookmarkName:'parent',remoteUrl:authUrl}
let bookmarks={parent:tmp+'/elsewhere'},writes=0,reads=[],denied=null
const missing=p=>{try{return fs.lstatSync(p)}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return null;throw e}}
const readOnly={appGroupDocumentsDirectory:group,
 bookmarkExists:name=>Object.hasOwn(bookmarks,name),bookmarkedPath:name=>{if(bookmarks[name] instanceof Error)throw bookmarks[name];return bookmarks[name]},
 exists:async p=>{reads.push(['exists',p]);return !!missing(p)},isLink:async p=>!!missing(p)?.isSymbolicLink(),isDirectory:async p=>!!missing(p)?.isDirectory(),
 readDirectory:async p=>{reads.push(['directory',p]);if(p===denied)throw Object.assign(Error(authUrl),{code:'EACCES'});return fs.promises.readdir(p)},
 stat:async p=>fs.promises.stat(p),readAsString:async p=>{reads.push(['file',p]);assert.ok(p.startsWith(gitdir+'/'),'must not read worktree files');assert.ok(!p.endsWith('/config'),'must not read credential-bearing config');return fs.promises.readFile(p,'utf8')},
}
global.FileManager=new Proxy(readOnly,{get(target,key){if(key in target)return target[key];return ()=>{writes++;throw Error('FORBIDDEN MUTATION '+String(key))}}})
global.Storage={get:key=>{assert.equal(key,'gitgit.repos');return [repo]},set(){writes++;throw Error('FORBIDDEN Storage.set')},remove(){writes++;throw Error('FORBIDDEN Storage.remove')}}
const storage=load('services/storage.ts'),store=load('services/repoStore.ts',{'./cloneWorkspace':{isAppOwnedWorkdir:()=>false},'../utils/repoUpdated':{},'./storage':storage})
const diagnostics=load('services/repoDiagnostics.ts',{'./repoStore':store})
function snapshot(root){const out={};function walk(p){for(const item of fs.readdirSync(p)){const full=p+'/'+item,s=fs.lstatSync(full);if(s.isSymbolicLink())out[full]=['link',fs.readlinkSync(full)];else if(s.isDirectory()){out[full]=['directory'];walk(full)}else out[full]=['file',fs.readFileSync(full).toString('base64')]}}walk(root);return out}
let groups=0
async function test(name,fn){await fn();assert.equal(writes,0);console.log('PASS '+name);groups++}
async function main(){
 await test('existing bookmark + relative child yields actual non-iCloud workdir; report split gitdir/HEAD/packed local and origin refs; zero writes',async()=>{
  const before=snapshot(tmp),meta=JSON.stringify(repo),report=await diagnostics.collectRepoDiagnostics('id')
  assert.match(report,new RegExp(dir));assert.match(report,new RegExp(gitdir));assert.match(report,/路径来源：accessBookmark/);assert.match(report,/HEAD 原始值.*ref: refs\/heads\/master\\n/)
  assert.match(report,/refs\/heads\/master \[packed-refs\] = [0-9a-f]{40}/);assert.match(report,/refs\/remotes\/origin\/master \[packed-refs\]/);assert.match(report,/origin\/HEAD \[loose\] = ref: refs\/remotes\/origin\/master/)
  assert.match(report,/目录枚举成功/);assert.ok(!report.includes(token)&&!report.includes(authUrl)&&!report.includes('PRIVATE_WORK_CONTENT'))
  assert.deepEqual(snapshot(tmp),before);assert.equal(JSON.stringify(repo),meta)
  const files=reads.filter(r=>r[0]==='file').map(r=>r[1]);assert.ok(files.every(p=>/\/(HEAD|packed-refs)$|\/refs\//.test(p)));assert.ok(!files.includes(dir+'/.git'))
 })
 await test('readonly path fallback mirrors production root/relative/legacy/stored semantics without repairing bookmarks or metadata',async()=>{
  const original={...repo}
  delete repo.workdirRelative;repo.workdir=dir;assert.equal(store.resolveRepoPathsReadOnly('id').workdir,dir)
  repo.workdir='/old/path';assert.equal(store.resolveRepoPathsReadOnly('id').workdir,tmp+'/elsewhere','same fallback to bookmark root as runtime')
  bookmarks.parent=Error(authUrl);bookmarks.id=tmp+'/elsewhere';repo.workdirRelative='All';assert.equal(store.resolveRepoPathsReadOnly('id').source,'legacyBookmark');assert.equal(store.resolveRepoPathsReadOnly('id').workdir,dir)
  bookmarks={};assert.equal(store.resolveRepoPathsReadOnly('id').workdir,'/old/path');delete repo.workdir;assert.equal(store.resolveRepoPathsReadOnly('id').workdir,null)
  repo={...original};bookmarks={parent:tmp+'/elsewhere'}
 })
 await test('permission errors, malformed packed/loose refs and HEAD credentials are useful but do not leak native messages or raw secrets',async()=>{
  const packed=fs.readFileSync(gitdir+'/packed-refs'),head=fs.readFileSync(gitdir+'/HEAD')
  fs.appendFileSync(gitdir+'/packed-refs','\n'+authUrl+'\n^not-an-oid\n');fs.writeFileSync(gitdir+'/HEAD','ref: ref: refs/heads/master\n'+authUrl+' token=arbitrarySecret\n')
  fs.writeFileSync(gitdir+'/refs/heads/broken','password=anotherSecret')
  denied=dir;const before=snapshot(tmp),report=await diagnostics.collectRepoDiagnostics('id');denied=null
  assert.match(report,/工作目录 访问检查：EACCES/);assert.match(report,/packed-refs 第 .*格式异常/);assert.match(report,/无效 peeled/);assert.match(report,/refs\/heads\/broken：引用内容无效/);assert.match(report,/HEAD 原始值/)
  for(const secret of [token,authUrl,'arbitrarySecret','anotherSecret'])assert.ok(!report.includes(secret),secret+' must not leak')
  assert.deepEqual(snapshot(tmp),before);fs.writeFileSync(gitdir+'/packed-refs',packed);fs.writeFileSync(gitdir+'/HEAD',head);fs.unlinkSync(gitdir+'/refs/heads/broken')
 })
 await test('detached/missing/nonlocal HEAD, missing gitdir and oversized metadata are reported without guessing main/master or creating files',async()=>{
  const head=fs.readFileSync(gitdir+'/HEAD'),oid=cmd('rev-parse','HEAD').trim()
  fs.writeFileSync(gitdir+'/HEAD',oid+'\n');assert.match(await diagnostics.collectRepoDiagnostics('id'),/OID 形式，未指向命名分支/)
  fs.writeFileSync(gitdir+'/HEAD','ref: refs/remotes/origin/master\n');assert.match(await diagnostics.collectRepoDiagnostics('id'),/HEAD 原始值.*refs\/remotes\/origin\/master/)
  fs.unlinkSync(gitdir+'/HEAD');assert.match(await diagnostics.collectRepoDiagnostics('id'),/HEAD：ENOENT/);assert.ok(!fs.existsSync(gitdir+'/HEAD'))
  fs.writeFileSync(gitdir+'/HEAD','x'.repeat(5000));assert.match(await diagnostics.collectRepoDiagnostics('id'),/HEAD：超过诊断读取上限/);fs.writeFileSync(gitdir+'/HEAD',head)
  const id=repo.repoId;repo.repoId='missing';const report=await diagnostics.collectRepoDiagnostics('id');assert.match(report,/gitdir exists=false/);assert.ok(!fs.existsSync(group+'/git-repos/missing'));repo.repoId=id
 })
 await test('metadata symlinks are not followed; target content never read or exported',async()=>{
  const target=tmp+'/outside-refs';fs.mkdirSync(target);fs.writeFileSync(target+'/secret',token)
  const heads=gitdir+'/refs/heads';fs.renameSync(heads,heads+'.saved');fs.symlinkSync(target,heads)
  reads=[];const report=await diagnostics.collectRepoDiagnostics('id');assert.match(report,/refs\/heads：符号链接，未读取/);assert.ok(!reads.some(r=>r[1].startsWith(heads+'/')));assert.ok(!report.includes(token))
  fs.unlinkSync(heads);fs.renameSync(heads+'.saved',heads)
 })
 await test('proven branch-label fix: a local branch with same-named remote is local; remote-only remains remote',async()=>{
  const query=load('services/git/branchQueryService.ts',{'./runtime':{getCtx:async()=>({git:require('../vendor/index.umd.min.js'),fs,dir,gitdir}),resolveCurrentBranch:async()=>cmd('symbolic-ref','--short','HEAD').trim()}})
  global.self=globalThis
  const managed=await query.getManagedBranches('id');assert.deepEqual(managed.locals,['master']);assert.deepEqual(managed.remotes,[]);assert.deepEqual(managed.remoteNames,['master'])
  const C=load('components/RepoBranchSection.tsx',{scripting:ui,'../constants/colors':{},'../constants/git':{DEFAULT_BRANCH:'main'}}).RepoBranchSection
  const tree=C({branchInfo:{current:'master',branches:['master','only-remote']},remoteOnlyBranches:['only-remote'],remoteBranchNames:['master','only-remote'],mergeSources:[],deletableBranches:[],hasCommits:true,hasRemote:true})
  assert.deepEqual(all(tree).filter(n=>n.type==='Text'&&n.props.tag).map(n=>n.children.join('')),['master · 本地','only-remote · 远端'])
 })
 await test('diagnostic UI reads on entry, copy requires explicit action/localOnly; refresh single-flight, safe errors and no late writes',async()=>{
  const pending=deferred();let calls=0,copies=[],closed=0
  const Page=load('pages/RepoDiagnosticsPage.tsx',{scripting:ui,'../services/repoDiagnostics':{collectRepoDiagnostics:async()=>{calls++;if(calls===1)await pending.promise;return 'SAFE REPORT'}}}).RepoDiagnosticsPage
  global.Pasteboard={setItems:async(...args)=>copies.push(args)}
  const h=mount(Page,{bookmarkName:'id',onClose:()=>closed++});const button=title=>{h.render();return all(h.tree).find(n=>n.type==='Button'&&n.props.title===title)}
  assert.equal(calls,1);assert.equal(copies.length,0);assert.equal(button('复制诊断报告').props.disabled,true)
  button('正在读取…').props.action();assert.equal(calls,1);pending.resolve();await tick()
  button('复制诊断报告').props.action();await tick();assert.deepEqual(copies,[[[{'public.plain-text':'SAFE REPORT'}],{localOnly:true}]])
  button('完成').props.action();assert.equal(closed,1);h.unmount()
  const gate=deferred();const Late=load('pages/RepoDiagnosticsPage.tsx',{scripting:ui,'../services/repoDiagnostics':{collectRepoDiagnostics:()=>gate.promise}}).RepoDiagnosticsPage
  const late=mount(Late,{bookmarkName:'id',onClose(){}});late.unmount();gate.resolve('late');await tick();assert.equal(late.lateWrites,0)
 })
 await test('detail entry is visible before branches load; opening/closing diagnostics does not trigger parent data refresh',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../pages/RepoDetailPage.tsx'),'utf8'),mocks={scripting:ui},noop=()=>{}
  for(const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
   const [,names,module]=match;if(module==='scripting')continue;mocks[module]={};for(const token of names.split(',')){const name=token.trim();if(name)mocks[module][name]=name}
  }
  let skip=false,loads=0
  const hook=(module,name,value)=>mocks[module]={[name]:()=>value}
  hook('../hooks/useLocalEntryCreation','useLocalEntryCreation',{busy:false,open:noop});hook('../hooks/useToast','useToast',{});hook('../hooks/useOpBusy','useOpBusy',{})
  hook('../hooks/useRepoDetailData','useRepoDetailData',{displayName:'All',changes:[],branchInfo:{current:null},branchStateKnown:false,loadAll(){loads++}})
  hook('../hooks/useRepoDetailNavigation','useRepoDetailNavigation',{skipNextAppearLoad(){skip=true},consumeSkipNextAppearLoad(){const result=skip;skip=false;return result}})
  hook('../hooks/useRepoWorktreeActions','useRepoWorktreeActions',{commitSheetMode:null});hook('../hooks/useRepoPendingActions','useRepoPendingActions',{});hook('../hooks/useRepoBranchActions','useRepoBranchActions',{});hook('../hooks/useRepoSyncActions','useRepoSyncActions',{})
  mocks['../utils/format']={suggestCommitTitle:()=>'',shortOid:noop}
  const Page=load('pages/RepoDetailPage.tsx',mocks).RepoDetailPage,h=mount(Page,{bookmarkName:'id',name:'All'})
  const entry=all(h.tree).find(n=>n.type==='Button'&&n.props.title==='仓库诊断（只读）');assert.ok(entry);assert.ok(!entry.props.disabled)
  entry.props.action();h.render();const cover=h.tree.props.fullScreenCover[2];assert.equal(cover.isPresented,true);assert.equal(cover.content.type,'RepoDiagnosticsPage');assert.equal(cover.content.props.bookmarkName,'id');assert.equal(loads,0)
  cover.content.props.onClose();h.render();assert.equal(h.tree.props.fullScreenCover[2].isPresented,false);h.tree.props.onAppear();assert.equal(loads,0,'returning from read-only diagnostic skips data.loadAll/getCtx')
  h.unmount()
 })
 console.log(groups+' repository diagnostic groups passed; no phone state read, no network.')
}
const watchdog=setTimeout(()=>{console.error('FAIL diagnostic tests did not finish');process.exitCode=1},20000)
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{clearTimeout(watchdog);fs.rmSync(tmp,{recursive:true,force:true})})
