/* Actual disk inventory -> Git status wrapper/cache/snapshot -> homepage + detail hook. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),cp=require('node:child_process'),path=require('node:path')
const {load,mount,ui,all,tick}=require('./remoteFiles.test.cjs'),{page}=require('./homePullAll.test.cjs');global.self=globalThis
const tmp=fs.mkdtempSync(os.tmpdir()+'/scriptgit-home-directories-'),git=require('../vendor/index.umd.min.js'),rows=['empty','mixed','clean'].map(name=>({name,bookmarkName:name,repoId:name,source:'local',createdAt:1})),snapfile=tmp+'/snapshots.json'
const contexts={};for(const repo of rows){const dir=tmp+'/'+repo.name;fs.mkdirSync(dir);const cmd=(...args)=>cp.execFileSync('git',['-C',dir,...args]);cmd('init','-qb','master');cmd('config','user.name','T');cmd('config','user.email','t@example.invalid');fs.mkdirSync(dir+'/tracked');fs.writeFileSync(dir+'/tracked/base','base');fs.writeFileSync(dir+'/.gitignore','ignored/\n');cmd('add','.');cmd('commit','-qm','base');contexts[repo.name]={git,fs,dir,gitdir:dir+'/.git'}}
fs.mkdirSync(contexts.empty.dir+'/nested/leaf',{recursive:true});fs.mkdirSync(contexts.mixed.dir+'/with-file');fs.writeFileSync(contexts.mixed.dir+'/with-file/new','new');for(const ctx of Object.values(contexts))fs.mkdirSync(ctx.dir+'/ignored')
let enumerations=0
const exists=p=>{try{fs.lstatSync(p);return true}catch{return false}}
global.FileManager={exists:async p=>exists(p),isLink:async p=>exists(p)&&fs.lstatSync(p).isSymbolicLink(),isDirectory:async p=>exists(p)&&fs.statSync(p).isDirectory(),isFile:async p=>exists(p)&&fs.statSync(p).isFile(),readDirectory:async p=>{enumerations++;return fs.readdirSync(p)},stat:async p=>{const s=fs.statSync(p);return {size:s.size,creationDate:s.birthtimeMs,modificationDate:s.mtimeMs}},createDirectory:async p=>fs.mkdirSync(p),remove:async p=>fs.rmSync(p,{recursive:true})}
const {StatusCoordinator}=load('utils/statusCoordinator.ts'),coordinator=new StatusCoordinator()
const runtime={resolveGitdir:key=>contexts[key].gitdir,getCtx:async key=>contexts[key]},measure={measureOperation:(_,fn)=>fn()}
const statusScan=load('services/git/statusScanService.ts',{'./runtime':runtime,'./matrixScanService':{statusCoordinator:coordinator,scanStatusMatrix:async(_,ctx)=>git.statusMatrix(ctx)},'../../utils/statusFreshness':load('utils/statusFreshness.ts')})
const store={listRepos:()=>rows,findRepo:key=>rows.find(r=>r.bookmarkName===key),resolveWorkdir:key=>contexts[key].dir,resolveRepoPathsReadOnly:key=>({workdir:contexts[key].dir,gitdir:contexts[key].gitdir}),writeSnapshot:async(key,snapshot)=>{const data=exists(snapfile)?JSON.parse(fs.readFileSync(snapfile)):{};data[key]=snapshot;fs.writeFileSync(snapfile,JSON.stringify(data))},readSnapshots:async()=>exists(snapfile)?JSON.parse(fs.readFileSync(snapfile)):{} }
const inventory=load('services/git/worktreeTreeService.ts',{'../repoStore':store,'../gitCore':{loadGitEngine:async()=>({git}),createFS:()=>fs},'./statusScanService':statusScan,'../../utils/lru':load('utils/lru.ts'),'../../utils/fileListPerformance':load('utils/fileListPerformance.ts')})
const query=load('services/git/statusQueryService.ts',{'./runtime':runtime,'./statusScanService':statusScan,'../../utils/performance':measure,'../../utils/history':{},'../../utils/lru':load('utils/lru.ts')})
const internal=load('services/git/repoStatusService.ts',{'./commitTraversal':load('services/git/commitTraversal.ts',{'../../utils/remoteProgress':{}}),'./runtime':runtime,'../repoStore':store,'./statusQueryService':query,'./statusScanService':statusScan,'../../utils/performance':measure,'../../utils/gitSync':{},'../../utils/remoteProgress':{}})
const status=load('services/git/repoStatusReadService.ts',{scripting:{Widget:{reloadAll(){}}},'../repoStore':store,'./mergeConflictService':{getMergeConflictState:async()=>null},'./repoStatusService':internal,'./worktreeTreeService':inventory,'./statusScanService':statusScan,'../../utils/performance':measure})
const local=load('services/git/localFileService.ts',{'../repoStore':store,'../localImportExecution':{}})
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
const text=n=>JSON.stringify(expand(n))
function homepage(statusMap,snapshotMap={}){return mount(page(rows,async()=>{},async()=>{},()=>{},{'../hooks/useRepoListStatus':{useRepoListStatus:()=>({statusMap,snapshotMap,repoRefreshMap:{},githubUpdatedProgress:{}})},'../utils/mergeConflict':{formatRepoListMergeSummary:()=>null}}),{})}
const swipes=h=>all(h.tree).filter(n=>n.props.trailingSwipeActions).map(n=>n.props.trailingSwipeActions.actions.map(a=>a.props.title))
let groups=0;async function test(name,fn){await fn();groups++;console.log('PASS '+name)}
async function main(){
 let values={}
 await test('empty-only repo reports new directory separately, mixed file parent is not double counted, ignored/HEAD dirs excluded; real snapshot/cache/UI/action visibility agree',async()=>{
  for(const row of rows)values[row.bookmarkName]=await status.getRepoListStatus(row.bookmarkName,undefined,{force:true})
  assert.equal(values.empty.uncommitted,0);assert.equal(values.empty.newDirectories,1);assert.equal(values.mixed.uncommitted,1);assert.equal(values.mixed.newDirectories,0);assert.equal(values.clean.uncommitted,0);assert.equal(values.clean.newDirectories,0)
  const h=homepage(values);assert.match(text(h.tree),/1 新增目录/);const actions=swipes(h);assert.deepEqual(actions[0],['拉取','还原','删除'],'directory-only offers restore, never push/Stash');assert.deepEqual(actions[1],['拉取','推送','还原','暂存','删除']);assert.deepEqual(actions[2],['拉取','删除']);h.unmount()
  const snapshots=await store.readSnapshots();assert.equal(snapshots.empty.newDirectories,1);assert.equal(snapshots.empty.uncommitted,0);assert.equal(statusScan.getCachedRepoStatus('empty').newDirectories,1)
  const reopened=homepage({},snapshots);assert.match(text(reopened.tree),/1 新增目录/);assert.deepEqual(swipes(reopened)[0],['拉取','还原','删除']);reopened.unmount()
 })
 await test('explicit fresh scan sees external directory add/delete at unchanged revision; old cache is used only when explicitly requested',async()=>{
  fs.mkdirSync(contexts.empty.dir+'/another');assert.equal((await status.getRepoListStatus('empty',undefined,{force:true})).newDirectories,2)
  fs.rmdirSync(contexts.empty.dir+'/another');const before=enumerations;assert.equal((await status.getRepoListStatus('empty',undefined,{force:false})).newDirectories,2);assert.equal(enumerations,before)
  assert.equal((await status.getRepoListStatus('empty',undefined,{force:true})).newDirectories,1)
 })
 await test('detail create/delete -> actual hook refresh -> status cache and persisted snapshot; just-read inventory is reused without a second walk; multiple repos isolated',async()=>{
  let summaries=0
  const hook=load('hooks/useRepoDetailData.ts',{scripting:ui,'../services/gitService':{getChanges:async key=>query.getChanges(key),getTrackedFiles:query.getTrackedFiles,getWorktreeEntries:inventory.getWorktreeEntries,getRepoListStatus:async(...args)=>{const before=enumerations;const result=await status.getRepoListStatus(...args);assert.equal(enumerations,before,'summary must reuse just-completed same-revision inventory');summaries++;return result}},'../services/repoStore':{},'../utils/format':{},'../utils/github':{},'../utils/statusFreshness':{}}).useRepoDetailData
  const h=mount(hook,{bookmarkName:'empty',name:'empty',showToast(){}})
  await statusScan.runStatusMutation('empty',()=>local.createLocalEntryInternal('empty','created',true,contexts.empty.dir));await h.tree.refreshChangesAndSnapshot();h.render();assert.equal(statusScan.getCachedRepoStatus('empty').newDirectories,2);assert.equal((await store.readSnapshots()).empty.newDirectories,2)
  await statusScan.runStatusMutation('empty',()=>local.deleteLocalDirectoryInternal('empty','created'));await h.tree.refreshChangesAndSnapshot();h.render();assert.equal((await store.readSnapshots()).empty.newDirectories,1);assert.equal(statusScan.getCachedRepoStatus('mixed').uncommitted,1);assert.equal(summaries,2)
  fs.mkdirSync(tmp+'/Imported Empty');await statusScan.runStatusMutation('empty',()=>local.importLocalDirectoryInternal('empty',tmp+'/Imported Empty',contexts.empty.dir));await h.tree.refreshChangesAndSnapshot();h.render();assert.equal((await store.readSnapshots()).empty.newDirectories,2);assert.equal(summaries,3);h.unmount()
 })
 await test('startup/return remains cache+snapshot only, no inventory on render/appear; detail updated cache is restored',async()=>{
  let reads=0
  const hook=load('hooks/useRepoListStatus.ts',{scripting:ui,'../services/repoStore':store,'../services/gitService':{getCachedRepoStatus:statusScan.getCachedRepoStatus,getRepoListStatus:async(...args)=>{reads++;return status.getRepoListStatus(...args)}},'../utils/repoSort':{sortReposByGithubUpdated:r=>r},'./useRepoGithubUpdated':{useRepoGithubUpdated:()=>({progress:{},stop(){},refresh:async()=>{}})}}).useRepoListStatus
  const h=mount(hook,()=>{}),before=enumerations;h.tree.appear();await tick();h.render();assert.equal(reads,0);assert.equal(enumerations,before);assert.equal(h.tree.statusMap.empty.newDirectories,2);assert.equal(h.tree.snapshotMap.empty.newDirectories,2);h.tree.disappear();h.tree.appear();await tick();h.render();assert.equal(reads,0)
  fs.mkdirSync(contexts.empty.dir+'/explicit-refresh');await h.tree.refreshAll(true);h.render();assert.equal(reads,3);assert.equal(h.tree.statusMap.empty.newDirectories,3);assert.equal((await store.readSnapshots()).empty.newDirectories,3);h.unmount()
 })
 await test('a file parent plus separate empty child reports 1 Git change + 1 directory; removing empty dirs never changes Git FileChange semantics',async()=>{
  fs.mkdirSync(contexts.mixed.dir+'/with-file/empty');const mixed=await status.getRepoListStatus('mixed',undefined,{force:true});assert.equal(mixed.uncommitted,1);assert.equal(mixed.newDirectories,1);const h=homepage({mixed});assert.match(text(h.tree),/1 改动/);assert.match(text(h.tree),/1 新增目录/);h.unmount();assert.equal((await query.getChanges('empty')).length,0)
 })
 await test('directory read failure is not cached/persisted as clean; retry recovers without changing Git counts',async()=>{
  const previous=await store.readSnapshots(),read=FileManager.readDirectory;FileManager.readDirectory=async p=>{if(p===contexts.empty.dir)throw Error('denied');return read(p)}
  const failed=await status.getRepoListStatus('empty',undefined,{force:true});assert.match(failed.error,/目录状态读取失败/);assert.equal(failed.uncommitted,0);assert.equal(statusScan.getCachedRepoStatus('empty'),undefined);assert.deepEqual(await store.readSnapshots(),previous);FileManager.readDirectory=read;assert.equal((await status.getRepoListStatus('empty',undefined,{force:true})).newDirectories,3)
 })
 console.log(groups+' directory homepage production status/cache/snapshot/action groups passed; no phone/network or placeholder files.')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}))
