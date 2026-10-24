const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),ts=require('typescript')
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-rm-'))
const docs=tmp+'/Documents',ext=tmp+'/Ext',icl=tmp+'/iCloud'
for(const d of [docs+'/git',ext+'/git',icl+'/git',tmp+'/gitdir'])fs.mkdirSync(d,{recursive:true})
let repos=[],removed=[],failRemove=null,failRepoRemove=false
const fm={documentsDirectory:docs,isiCloudEnabled:true,iCloudDocumentsDirectory:icl,
 bookmarkExists:n=>n==='bm',bookmarkedPath:n=>n==='bm'?ext:null,
 exists:async p=>fs.existsSync(p),isLink:async p=>{try{return fs.lstatSync(p).isSymbolicLink()}catch{return false}},
 isDirectory:async p=>fs.statSync(p).isDirectory(),
 remove:async p=>{if(failRemove&&p.includes(failRemove)){fs.rmSync(p+'/a.txt',{force:true});throw new Error('EPERM partial')}fs.rmSync(p,{recursive:true,force:true})}}
global.FileManager=fm
const mocks={'./repoStore':{listRepos:()=>repos,findRepo:b=>repos.find(r=>r.bookmarkName===b),resolveRepoPathsReadOnly:b=>{const r=repos.find(x=>x.bookmarkName===b);if(!r)throw new Error('x');return{workdir:r.resolved||r.workdir}},removeRepo:async b=>{if(failRepoRemove)throw new Error('cache busy');removed.push(b);repos=repos.filter(r=>r.bookmarkName!==b)}},'./git/runtime':{resolveGitdir:b=>tmp+'/gitdir/'+b}}
const m={exports:{}};const code=ts.transpileModule(fs.readFileSync(__dirname+'/../services/cloneRemoval.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText
new Function('module','exports','require',code)(m,m.exports,n=>mocks[n]||require(n))
const S=m.exports
function mk(root,name,extra={}){const w=root+'/git/'+name;fs.mkdirSync(w,{recursive:true});fs.writeFileSync(w+'/a.txt','x');fs.writeFileSync(w+'/dirty.txt','u')
 const r={name,bookmarkName:'id-'+name,repoId:'id-'+name,workdir:w,source:'clone',createdAt:5,...extra};repos.push(r);return r}
const t=async(n,f)=>{repos=[];removed=[];failRemove=null;failRepoRemove=false;await f();console.log('PASS',n)}
;(async()=>{
await t('local clone: plan ok, uncommitted file deleted, record removed after folder',async()=>{const r=mk(docs,'a');const p=S.planCloneRemoval(r.bookmarkName);assert.equal(p.ok,true);assert.equal(p.label,'git/a')
 assert.equal(await S.removeClonedRepositoryInternal(S.identityOf(r)),'deleted');assert.ok(!fs.existsSync(r.workdir));assert.deepEqual(removed,['id-a']);assert.ok(fs.existsSync(docs+'/git'))})
await t('icloud + external bookmark clones allowed',async()=>{const a=mk(icl,'i');assert.equal(S.planCloneRemoval(a.bookmarkName).location,'icloud')
 const b=mk(ext,'e',{accessBookmarkName:'bm',workdirRelative:'git/e'});assert.equal(S.planCloneRemoval(b.bookmarkName).location,'external');await S.removeClonedRepositoryInternal(S.identityOf(b));assert.ok(!fs.existsSync(b.workdir))})
await t('non-clone source never planned/deleted',async()=>{const r=mk(docs,'loc',{source:'local'});assert.equal(S.planCloneRemoval(r.bookmarkName).ok,false);await assert.rejects(S.removeClonedRepositoryInternal(S.identityOf(r)),/未删除任何文件/);assert.ok(fs.existsSync(r.workdir));assert.deepEqual(removed,[])})
await t('clone root itself, parent, HOME-like, arbitrary dirs rejected',async()=>{
 for(const w of [docs+'/git',docs,tmp,'/','/Users',docs+'/other/x',docs+'/git/a/b',docs+'/git/..',docs+'/git/./a','relative/git/a',docs+'/git/.hidden']){repos=[{name:'n',bookmarkName:'z',repoId:'z',workdir:w,source:'clone',createdAt:5}];assert.equal(S.planCloneRemoval('z').ok,false,w)}
 assert.ok(fs.existsSync(docs+'/git'))})
await t('similar prefix (/Documents2/git/x, /Documents/git2/x) rejected',async()=>{fs.mkdirSync(docs+'2/git/x',{recursive:true});fs.mkdirSync(docs+'/git2/x',{recursive:true})
 for(const w of [docs+'2/git/x',docs+'/git2/x']){repos=[{name:'x',bookmarkName:'z',repoId:'z',workdir:w,source:'clone',createdAt:5}];assert.equal(S.planCloneRemoval('z').ok,false);await assert.rejects(S.removeClonedRepositoryInternal({bookmarkName:'z',repoId:'z',createdAt:5,workdir:w}));assert.ok(fs.existsSync(w))}})
await t('external bookmark escape / mismatched relative rejected',async()=>{const r=mk(ext,'esc',{accessBookmarkName:'bm',workdirRelative:'git/other'});assert.equal(S.planCloneRemoval(r.bookmarkName).ok,false)
 repos=[{name:'q',bookmarkName:'q',repoId:'q',workdir:tmp+'/Elsewhere/git/q',accessBookmarkName:'bm',workdirRelative:'git/q',source:'clone',createdAt:5}];assert.equal(S.planCloneRemoval('q').ok,false)})
await t('symlink workdir and symlinked git folder refuse; target untouched',async()=>{const real=tmp+'/real';fs.mkdirSync(real);fs.writeFileSync(real+'/keep','k')
 fs.symlinkSync(real,docs+'/git/ln');const r={name:'ln',bookmarkName:'ln',repoId:'ln',workdir:docs+'/git/ln',source:'clone',createdAt:5};repos=[r]
 await assert.rejects(S.removeClonedRepositoryInternal(S.identityOf(r)),/符号链接/);assert.ok(fs.existsSync(real+'/keep'));assert.deepEqual(removed,[])
 fs.mkdirSync(tmp+'/Docs3/real-git/z',{recursive:true});fs.writeFileSync(tmp+'/Docs3/real-git/z/f','1');fs.mkdirSync(tmp+'/Docs3x');fs.symlinkSync(tmp+'/Docs3/real-git',tmp+'/Docs3x/git')
 const saved=fm.documentsDirectory;fm.documentsDirectory=tmp+'/Docs3x';const r2={name:'z',bookmarkName:'z',repoId:'z',workdir:tmp+'/Docs3x/git/z',source:'clone',createdAt:5};repos=[r2]
 await assert.rejects(S.removeClonedRepositoryInternal(S.identityOf(r2)),/符号链接/);fm.documentsDirectory=saved;assert.ok(fs.existsSync(tmp+'/Docs3/real-git/z/f'))})
await t('record changed / replaced since confirm: nothing deleted',async()=>{const r=mk(docs,'chg');const id=S.identityOf(r);repos[repos.indexOf(r)]={...r,createdAt:99}
 await assert.rejects(S.removeClonedRepositoryInternal(id),/记录已变化/);assert.ok(fs.existsSync(r.workdir));repos=[];await assert.rejects(S.removeClonedRepositoryInternal(id),/已变化/)})
await t('name mismatch with stored workdir rejected',async()=>{const r=mk(docs,'nm');fs.mkdirSync(docs+'/git/other');r.resolved=docs+'/git/other';assert.match(S.planCloneRemoval(r.bookmarkName).reason,/不一致/);await assert.rejects(S.removeClonedRepositoryInternal(S.identityOf(r)),/未删除任何文件/);assert.ok(fs.existsSync(docs+'/git/other'))})
await t('merge/unfinished marker refuses',async()=>{const r=mk(docs,'mg');fs.mkdirSync(tmp+'/gitdir/id-mg');fs.writeFileSync(tmp+'/gitdir/id-mg/gitgit-merge-state.json','{}')
 await assert.rejects(S.removeClonedRepositoryInternal(S.identityOf(r)),/未完成/);assert.ok(fs.existsSync(r.workdir));assert.deepEqual(removed,[])})
await t('folder already missing: records cleaned',async()=>{const r=mk(docs,'gone');fs.rmSync(r.workdir,{recursive:true});assert.equal(await S.removeClonedRepositoryInternal(S.identityOf(r)),'missing');assert.deepEqual(removed,['id-gone'])})
await t('folder delete fails (partial): record kept, explicit error',async()=>{const r=mk(docs,'fail');failRemove='fail';await assert.rejects(S.removeClonedRepositoryInternal(S.identityOf(r)),/可能已部分删除.*记录已保留/);assert.deepEqual(removed,[]);assert.ok(repos.some(x=>x.bookmarkName==='id-fail'))})
await t('folder deleted but cache cleanup fails: explicit inconsistency message',async()=>{const r=mk(docs,'cf');failRepoRemove=true;await assert.rejects(S.removeClonedRepositoryInternal(S.identityOf(r)),/文件夹已删除，但清理仓库记录失败/);assert.ok(!fs.existsSync(r.workdir))})
await t('alert text: explicit path, irreversible, risks; unprovable offers record-only',async()=>{const r=mk(docs,'ui');const p=S.planCloneRemoval(r.bookmarkName)
 let a=S.cloneRemovalAlert('ui',p,{uncommitted:3,ahead:2,newDirectories:1});assert.match(a.message,/永久删除.*git\/ui/);assert.match(a.message,/3 项未提交/);assert.match(a.message,/2 个提交尚未推送/);assert.doesNotMatch(a.message,/不会删除工作区文件/);assert.equal(a.confirm,'永久删除');assert.ok(!a.message.includes(tmp))
 a=S.cloneRemovalAlert('ui',p,undefined);assert.match(a.message,/未能确认/);a=S.cloneRemovalAlert('ui',p,{uncommitted:0,ahead:0});assert.match(a.message,/可能不是最新/)
 a=S.cloneRemovalAlert('ui',{ok:false,reason:'r'},{uncommitted:0,ahead:0});assert.equal(a.confirm,'仅移除记录');assert.match(a.message,/不会删除任何文件/)})
await t('container symlink / ancestor symlink / dangling link all refused',async()=>{
 const real=tmp+'/real-container';fs.mkdirSync(real+'/git/anc',{recursive:true});fs.writeFileSync(real+'/git/anc/keep','x')
 fs.symlinkSync(real,tmp+'/linked-container')
 const old=fm.documentsDirectory
 for(const root of [tmp+'/linked-container',tmp+'/linked-container/sub']){
  if(root.endsWith('/sub'))fs.mkdirSync(real+'/sub/git/anc',{recursive:true})
  fm.documentsDirectory=root
  const r={name:'anc',bookmarkName:'anc',repoId:'anc',workdir:root+'/git/anc',source:'clone',createdAt:5};repos=[r]
  await assert.rejects(S.removeClonedRepositoryInternal(S.identityOf(r)),/祖先包含符号链接/);assert.deepEqual(removed,[])
 }
 fm.documentsDirectory=old
 fs.symlinkSync(tmp+'/missing-target',docs+'/git/dangling')
 const r={name:'dangling',bookmarkName:'dangling',repoId:'dangling',workdir:docs+'/git/dangling',source:'clone',createdAt:5};repos=[r]
 assert.equal(await fm.exists(r.workdir),false);await assert.rejects(S.removeClonedRepositoryInternal(S.identityOf(r)),/符号链接/);assert.ok(fs.lstatSync(r.workdir).isSymbolicLink())
 assert.ok(fs.existsSync(real+'/git/anc/keep'))
})
await t('confirmation binds bookmark fields, relative fields, source and exact resolved path',async()=>{
 for(const patch of [{accessBookmarkName:'new-bm'},{workdirRelative:'git/else'},{workdirDocumentsRelative:'git/else'},{source:'local'}]){
  repos=[];const r=mk(docs,'credential-'+Object.keys(patch)[0]);const id=S.identityOf(r);Object.assign(r,patch)
  await assert.rejects(S.removeClonedRepositoryInternal(id),/记录已变化/);assert.ok(fs.existsSync(r.workdir));assert.deepEqual(removed,[])
 }
 repos=[];const r=mk(ext,'moved',{accessBookmarkName:'bm',workdirRelative:'git/moved'});const id=S.identityOf(r)
 const root2=tmp+'/MovedRoot';fs.mkdirSync(root2+'/git/moved',{recursive:true});fs.writeFileSync(root2+'/git/moved/keep','k')
 const saved=fm.bookmarkedPath;fm.bookmarkedPath=()=>root2;r.resolved=root2+'/git/moved'
 await assert.rejects(S.removeClonedRepositoryInternal(id),/书签解析结果已变化/);fm.bookmarkedPath=saved
 assert.ok(fs.existsSync(root2+'/git/moved/keep'));assert.ok(fs.existsSync(r.workdir));assert.deepEqual(removed,[])
})
await t('same/parent/child workdir referenced by another record blocks deletion',async()=>{
 for(const relation of ['same','parent','child']){
  repos=[];const r=mk(docs,'overlap-'+relation);const otherPath=relation==='same'?r.workdir:relation==='parent'?docs+'/git':r.workdir+'/nested'
  if(relation==='child')fs.mkdirSync(otherPath)
  repos.push({name:'other',bookmarkName:'other',workdir:otherPath,source:'local',createdAt:1})
  await assert.rejects(S.removeClonedRepositoryInternal(S.identityOf(r)),/共享或嵌套/);assert.ok(fs.existsSync(r.workdir+'/dirty.txt'));assert.deepEqual(removed,[])
 }
})
await t('shared external bookmark refuses even sibling repositories',async()=>{
 const a=mk(ext,'shared-a',{accessBookmarkName:'bm',workdirRelative:'git/shared-a'});mk(ext,'shared-b',{accessBookmarkName:'bm',workdirRelative:'git/shared-b'})
 await assert.rejects(S.removeClonedRepositoryInternal(S.identityOf(a)),/书签被其他仓库共享/);assert.ok(fs.existsSync(a.workdir+'/dirty.txt'));assert.deepEqual(removed,[])
})
await t('sibling local records not sharing a bookmark remain safe to remove',async()=>{
 const a=mk(docs,'sibling-a'),b=mk(docs,'sibling-b');await S.removeClonedRepositoryInternal(S.identityOf(a));assert.ok(fs.existsSync(b.workdir+'/dirty.txt'))
})
const page=fs.readFileSync(__dirname+'/../pages/RepoListPage.tsx','utf8')
await t('page wiring: gates, barrier, no scan in alert',async()=>{assert.match(page,/if \(!repo \|\| deleting\.current\) return/);assert.match(page,/removeClonedRepository\(planned\.identity\)/);assert.match(page,/pullBusy|pulling\.current \|\| singlePull\.current/);assert.doesNotMatch(page.slice(page.indexOf('const activeAlert'),page.indexOf('const showRemovingOverlay')),/getRepoListStatus|getChanges/)
 assert.match(page,/setRemovingWorkdir\(planned\?\.plan.ok === true\)/);assert.match(page,/message=\{removingWorkdir \?/);assert.doesNotMatch(page,/message=\{deletePlan.current/);
 const g=fs.readFileSync(__dirname+'/../services/gitService.ts','utf8');assert.match(g,/removeClonedRepository[\s\S]{0,200}runRepoMutation/)})
await t('production repoStore + real filesystem: folder first, cache/record/snapshot removed with no orphan',async()=>{
 const {load}=require('./remoteFiles.test.cjs');repos=[];const r=mk(docs,'realstore');fm.appGroupDocumentsDirectory=tmp+'/group';let snapshots={[r.bookmarkName]:{name:r.name}},writes=0
 const store=load('services/repoStore.ts',{
  './cloneWorkspace':{isAppOwnedWorkdir:()=>true},'../utils/repoUpdated':{},
  './storage':{readRepos:()=>repos,writeRepos:value=>{assert.ok(!fs.existsSync(r.workdir),'folder must be gone before metadata write');repos=value;writes++},readSnapshots:()=>snapshots,writeSnapshots:value=>{snapshots=value}},
 })
 const cache=store.getGitdirPath(r);fs.mkdirSync(cache,{recursive:true});fs.writeFileSync(cache+'/index','x')
 const removal=load('services/cloneRemoval.ts',{'./repoStore':store,'./git/runtime':{resolveGitdir:()=>cache}})
 await removal.removeClonedRepositoryInternal(removal.identityOf(r));assert.equal(writes,1);assert.deepEqual(repos,[]);assert.deepEqual(snapshots,{});assert.ok(!fs.existsSync(cache))
 // Both removal facade routes disable runRepoMutation's snapshot refresh; the status barrier only invalidates caches.
 const facade=fs.readFileSync(__dirname+'/../services/gitService.ts','utf8')
 assert.match(facade,/runRepoMutation\(identity.bookmarkName, \(\) => removeClonedRepositoryInternal\(identity\), false\)/)
 assert.match(facade,/if \(started && refreshSnapshot\) await refreshRepoSnapshot/)
 const barrier=fs.readFileSync(__dirname+'/../services/git/statusScanService.ts','utf8').split('export async function runStatusMutation')[1].split('\n}')[0]
 assert.doesNotMatch(barrier,/writeSnapshot|refreshRepoSnapshot|getRepoListStatus/)
})
await t('real homepage: cancel has no writes; destructive overlay survives pending-plan reset',async()=>{
 const {page}=require('./homePullAll.test.cjs'),{mount,all,deferred,tick}=require('./remoteFiles.test.cjs')
 repos=[];const r=mk(docs,'overlay'),gate=deferred();let calls=0
 const h=mount(page([r],async()=>{},()=>{},{}, {
  '../services/cloneRemoval':S,
  '../services/gitService':{removeClonedRepository:async id=>{calls++;assert.equal(id.confirmedPath,r.workdir);await gate.promise},removeRepo:async()=>{throw new Error('wrong route')}},
  '../components/BusyOverlay':{BusyOverlay:'BusyOverlay'},
  '../hooks/useRepoListStatus':{useRepoListStatus:()=>({statusMap:{},snapshotMap:{},repoRefreshMap:{},githubUpdatedProgress:{},forgetRepo:()=>{}})},
 }),{})
 const open=()=>{h.render();all(h.tree).find(n=>n.type==='Button'&&n.props.title==='删除').props.action();h.render()}
 open();let buttons=all(h.tree.props.alert.actions).filter(n=>n.type==='Button');buttons.find(n=>n.props.role==='cancel').props.action();h.render();assert.equal(calls,0)
 open();buttons=all(h.tree.props.alert.actions).filter(n=>n.type==='Button');const done=buttons.find(n=>n.props.role==='destructive').props.action();await tick();h.render()
 assert.equal(calls,1);assert.equal(h.tree.props.alert.isPresented,false);assert.match(h.tree.props.overlay.content.props.message,/正在删除.*文件夹并清理缓存/)
 gate.resolve();await done;h.render();assert.equal(h.tree.props.overlay,undefined);h.unmount()
})
fs.rmSync(tmp,{recursive:true,force:true});fs.rmSync(docs+'2',{recursive:true,force:true})
})().catch(e=>{console.error(e);process.exit(1)})
