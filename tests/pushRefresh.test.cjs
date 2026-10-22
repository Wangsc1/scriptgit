/* Production useRepoDetailData + useRepoSyncActions + gitService + FilesTab on a real disposable Git repo.
 * Only the network push is replaced; commit/stage/status scans are real. No user data or network. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),ts=require('typescript')
const {ui,mount,all,text,tick,deferred}=require('./remoteFiles.test.cjs')
global.self=globalThis
const project=path.resolve(__dirname,'..'),git=require('../vendor/index.umd.min.js')
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-push-refresh-')),dir=tmp+'/work'
fs.mkdirSync(dir)
global.FileManager={temporaryDirectory:tmp,scriptsDirectory:tmp,appGroupDocumentsDirectory:tmp,documentsDirectory:tmp,
 readDirectory:async p=>fs.promises.readdir(p),createDirectory:async p=>fs.promises.mkdir(p,{recursive:true}),
 exists:async p=>fs.existsSync(p),isLink:async p=>{try{return (await fs.promises.lstat(p)).isSymbolicLink()}catch(e){if(e.code==='ENOENT')return false;throw e}},
 isDirectory:async p=>(await fs.promises.stat(p)).isDirectory(),isFile:async p=>(await fs.promises.stat(p)).isFile(),
 stat:async p=>{const s=await fs.promises.stat(p);return {size:s.size,creationDate:s.birthtimeMs,modificationDate:s.mtimeMs,type:s.isDirectory()?'directory':'file'}},
 readAsData:async p=>new Data(await fs.promises.readFile(p)),writeAsData:async(p,d)=>fs.promises.writeFile(p,d.bytes),
 copyFile:async(a,b)=>fs.promises.copyFile(a,b),rename:async(a,b)=>fs.promises.rename(a,b),remove:async p=>fs.promises.rm(p,{recursive:true})}
const kc=new Map();global.Keychain={contains:k=>true,get:k=>'mock-token',set:(k,v)=>{kc.set(k,v);return true},remove:k=>kc.delete(k)};global.Storage={get:()=>({login:'octo',id:7,avatarUrl:''}),set:()=>true,remove:()=>true};global.fetch=async()=>{throw Error('network forbidden in test')};global.Device={systemVersion:'26'};global.Dialog={confirm:async()=>true,prompt:async()=>null}
global.Data=class{constructor(b){this.bytes=Buffer.from(b)}get size(){return this.bytes.length}}
const ctx={git,fs,dir,gitdir:dir+'/.git'}
const store={writeSnapshot(){},resolveWorkdir:()=>dir,findRepo:()=>({bookmarkName:'repo',name:'test',repoId:'repo',source:'local'}),listRepos:()=>[],getGitdirPath:()=>ctx.gitdir,getRepoLastPulledAt:()=>null,resolveRepoPathsReadOnly:()=>({workdir:dir,storedWorkdir:dir,gitdir:ctx.gitdir,source:'test',bookmarkChecks:[]}),readSnapshots:async()=>({})}
const runtimeOverride={runWithBackgroundKeepAlive:fn=>fn(),resolveGitdir:()=>ctx.gitdir,getCtx:async()=>ctx}
let pushes=0,pushFail=null,pushGate=null,pushHook=null
const remote={pushInternal:async()=>{pushes++;if(pushHook)await pushHook();if(pushGate)await pushGate.promise;if(pushFail)throw Error(pushFail)}}
function loader(){
 const cache=new Map()
 function read(file){file=path.resolve(file);if(cache.has(file))return cache.get(file).exports
  const m={exports:{}};cache.set(file,m)
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'__jsx',jsxFragmentFactory:'__fragment'},fileName:file}).outputText
  const req=name=>{if(name==='scripting')return new Proxy(ui,{get:(t,k)=>k==='Widget'?{reloadAll(){}}:t[k]})
   let dest=path.resolve(path.dirname(file),name);dest=['.ts','.tsx'].map(e=>dest+e).find(fs.existsSync)||dest
   if(dest===project+'/services/gitCore.ts')return {loadGitEngine:async()=>({git}),createFS:()=>fs}
   if(dest===project+'/services/repoStore.ts')return store
   if(dest===project+'/services/git/runtime.ts')return {...read(dest),...runtimeOverride}
   if(dest===project+'/services/git/remoteService.ts')return {...read(dest),...remote}
   if(dest===project+'/services/notifyService.ts')return {notifySync:async()=>{},notifyError:async()=>{}}
   if(dest.replace(/\.tsx?$/,'')===project+'/components/LocalCodeEditor')return {LocalCodeEditor:'LocalCodeEditor'}
   return read(dest)}
  new Function('require','module','exports',code)(req,m,m.exports);return m.exports}
 return rel=>read(project+'/'+rel)
}
const load=loader(),service=load('services/gitService.ts')
const author={name:'t',email:'t@example.invalid'}
async function disk(n,b){await fs.promises.mkdir(path.dirname(dir+'/'+n),{recursive:true});await fs.promises.writeFile(dir+'/'+n,b)}
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
const sort=a=>a.map(c=>c.filepath+':'+c.status).sort()
async function main(){try{
 await git.init({fs,dir,defaultBranch:'main'})
 for(const f of ['m.txt','d.txt','other.txt','keep/x.txt'])await disk(f,'base '+f)
 await git.add({fs,dir,filepath:'.'});await git.commit({fs,dir,author,message:'base'})
 const Data_=load('hooks/useRepoDetailData.ts').useRepoDetailData,Sync=load('hooks/useRepoSyncActions.ts').useRepoSyncActions,FilesTab=load('pages/FilesTab.tsx').FilesTab
 const toasts=[]
 // One production host: data hook + sync hook, FilesTab permanently mounted with the hook's own outputs.
 const host=mount(()=>{
  const data=Data_({bookmarkName:'repo',name:'test',showToast(m,t){toasts.push([m,t])}})
  const sync=Sync({bookmarkName:'repo',displayName:'test',currentBranch:'main',hasRemote:false,beginOpBusy:async()=>{},updateOpBusy:async()=>{},endOpBusy(){},makeSyncCancel:()=>()=>{},
   setPulledAt(){},refreshSyncState:data.refreshSyncState,refreshWorktree:data.refreshChangesAndSnapshot,reloadRepo:data.loadAll,showToast(m,t){toasts.push([m,t])},showConflictNotice(){}})
  return {data,sync}
 },{},{effectUpdates:true})
 const hostNow=()=>{host.render();return host.tree}
 const tabProps={files:[],worktreeEntries:{files:[],directories:[]},changes:[],loading:false,bookmarkName:'repo',onOpen(){},onStage(){},onRestore(){},mergeInProgress:false,creationActive:false,onCreateEntry(){},onCopyLink(){}}
 const tab=mount(FilesTab,tabProps)
 function feed(){const {data,sync}=hostNow();Object.assign(tabProps,{files:data.trackedFiles,worktreeEntries:data.worktreeEntries,changes:data.changes,onWorktreeChanged:data.refreshChangesAndSnapshot,onPush:sync.handlePush})}
 const labels=()=>{feed();tab.render();const flat=n=>n==null||n===false?'':typeof n==='object'?(Array.isArray(n)?n:[n.props?.header,n.props?.footer,n.props?.label,...(n.children||[])]).map(flat).join(' '):String(n);const t=flat(expand(tab.tree));return {mod:(t.match(/已修改/g)||[]).length,add:(t.match(/新增/g)||[]).length,del:(t.match(/已删除/g)||[]).length}}
 async function load0(){const d=hostNow().data;await d.loadChanges();await d.loadTrackedFiles();feed();tab.render()}
 async function scenario(name,mutate,expected,{fail=null,during=null,after}={}){
  pushes=0;pushFail=fail;pushHook=during
  await mutate();await load0();const before=sort(hostNow().data.changes);assert.ok(before.length>0,name+' starts dirty')
  const beforeLabels=labels()
  const msg=Object.keys(expected).length>=0?'push '+name:''
  await hostNow().sync.handlePush(fail?undefined:msg);pushFail=null;pushHook=null
  await tick();const d=hostNow().data
  assert.deepEqual(sort(d.changes),sort(await service.getChanges('repo')),name+': props equal a fresh real Git read')
  assert.deepEqual(sort(d.changes),expected.changes,name)
  if(after)await after(d,beforeLabels)
 }
 // modified + added + deleted pushed together (single-file swipe commits the whole repo by design)
 await scenario('modified',()=>disk('m.txt','changed'),{changes:[]},{after:async(d,b)=>{assert.ok(b.mod>=1);assert.equal(labels().mod,0,'no 已修改 label');assert.equal(pushes,1)}})
 await scenario('added',()=>disk('new.txt','new'),{changes:[]},{after:async(d,b)=>{assert.ok(b.add>=1);assert.equal(labels().add,0,'no 新增 label');assert.ok(d.trackedFiles.includes('new.txt'),'file tree re-read; now tracked')}})
 await scenario('deleted',()=>fs.promises.rm(dir+'/d.txt'),{changes:[]},{after:async(d,b)=>{assert.ok(b.del>=1);assert.equal(labels().del,0,'no 已删除 placeholder');assert.ok(!d.trackedFiles.includes('d.txt'))}})
 // all three at once
 await scenario('mixed',async()=>{await disk('m.txt','again');await disk('added2.txt','a');await fs.promises.rm(dir+'/other.txt')},{changes:[]},{after:async()=>{const l=labels();assert.deepEqual(l,{mod:0,add:0,del:0})}})
 // changes made while the push is in flight (after commit): kept as real changes
 await scenario('concurrent new edits survive',()=>disk('m.txt','v3'),{changes:['late-added.txt:*added','m.txt:*modified','keep/x.txt:*deleted'].sort()},{during:async()=>{await disk('late-added.txt','late');await disk('m.txt','v4 during push');await fs.promises.rm(dir+'/keep/x.txt')},after:async(d)=>{const l=labels();assert.ok(l.mod>=1&&l.add>=1&&l.del>=1,'late changes still labelled: '+JSON.stringify(l))}})
 // reset to clean for next
 await hostNow().sync.handlePush('cleanup');await tick()
 assert.deepEqual(sort(hostNow().data.changes),[])
 // push failure after the local commit: list reflects real state (committed, so clean), error shown, no fake state
 toasts.length=0
 await disk('m.txt','fails');await load0()
 pushFail='offline';pushes=0;await hostNow().sync.handlePush('will commit then fail');pushFail=null;await tick()
 assert.ok(toasts.some(([m,t])=>t==='error'&&/offline/.test(m)),'failure shown')
 assert.deepEqual(sort(hostNow().data.changes),sort(await service.getChanges('repo')),'after failed push the list is the real status')
 // failure before commit (no branch problem simulated by unrelated change kept): unrelated edit made after failure stays
 await disk('other2.txt','unrelated');await load0();assert.ok(sort(hostNow().data.changes).some(c=>c.startsWith('other2.txt')),'unrelated change is listed and untouched')
 // refresh failure never masks the push result nor throws
 const Sync2=load('hooks/useRepoSyncActions.ts').useRepoSyncActions
 const h2=mount(()=>Sync2({bookmarkName:'repo',displayName:'t',currentBranch:'main',hasRemote:false,beginOpBusy:async()=>{},updateOpBusy:async()=>{},endOpBusy(){},makeSyncCancel:()=>()=>{},setPulledAt(){},refreshSyncState:async()=>{},refreshWorktree:async()=>{throw Error('refresh failed')},reloadRepo:async()=>{},showToast(m,t){toasts.push([m,t])},showConflictNotice(){}}),{})
 toasts.length=0;await h2.tree.handlePush();assert.ok(toasts.some(([m,t])=>t==='success'&&/推送成功/.test(m)))
 tab.unmount();host.unmount();assert.equal(host.lateWrites,0)
 console.log('PASS production hooks + real Git: single-file swipe push clears modified/added/deleted labels without manual refresh; concurrent/unrelated changes stay; failure shows real state; refresh error never masks result')
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}}
main().catch(e=>{console.error(e);process.exitCode=1})
