/* Real isomorphic-git objects/refs on a disposable repo. No network or user data. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {load,mount,ui,tick,deferred}=require('./remoteFiles.test.cjs')
global.self=globalThis
const git=require('../vendor/index.umd.min.js'),root=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-history-total-')),dir=root+'/work',gitdir=dir+'/.git'
fs.mkdirSync(dir)
const author={name:'Fixture',email:'fixture@example.invalid',timestamp:1000,timezoneOffset:0}
let fail=false,reads=0,gate=null
const engine=new Proxy(git,{get:(t,k)=>k==='readCommit'?async opts=>{reads++;if(gate)await gate.promise;if(fail)throw Error('object read denied');return t.readCommit(opts)}:t[k]})
const query=load('services/git/statusQueryService.ts',{
 './localRenameHistory':{},'../../utils/history':load('utils/history.ts'),'../../utils/lru':load('utils/lru.ts'),
 '../../utils/performance':{measureOperation:(_,fn)=>fn()},'./runtime':{getCtx:async()=>({git:engine,fs,dir,gitdir})},'./statusScanService':{},
})
async function commit(message,parent){const tree=await git.writeTree({fs,dir,tree:[]});const oid=await git.writeCommit({fs,dir,commit:{tree,parent,author:{...author,timestamp:++author.timestamp},committer:author,message}});await git.writeRef({fs,dir,ref:'refs/heads/main',value:oid,force:true});return oid}
async function main(){try{
 await git.init({fs,dir,defaultBranch:'main'})
 assert.equal(await query.getHistoryTotal('r'),0)
 const oids=[];for(let i=0;i<90;i++)oids.push(await commit('commit '+i,oids.length?[oids.at(-1)]:[]))
 const page=await query.getLogPage('r',0,20);assert.equal(page.entries.length,20);assert.equal(page.hasMore,true)
 assert.equal(await query.getHistoryTotal('r'),90);assert.equal(query.getHistoryCacheStats().entryCount,64,'counter does not fill paginated detail cache')
 const search=await query.getLogPage('r',0,20,'commit 89');assert.equal(search.entries.length,1);assert.equal(search.totalMatches,1);assert.equal(await query.getHistoryTotal('r'),90)
 const n=reads;assert.equal(await query.getHistoryTotal('r'),90);assert.equal(reads,n,'HEAD cache avoids repeat object traversal')
 const side=await commit('side',[oids[20]]),merge=await commit('merge',[oids.at(-1),side])
 assert.equal(await query.getHistoryTotal('r'),92,'merge shared ancestors counted once');assert.equal((await git.log({fs,dir})).length,92)
 const changed=await commit('changed',[merge]);assert.equal(await query.getHistoryTotal('r'),93)
 await git.writeRef({fs,dir,ref:'HEAD',value:oids[5],force:true});assert.equal(await query.getHistoryTotal('r'),6,'detached HEAD has its own total')
 await git.writeRef({fs,dir,ref:'HEAD',value:'refs/heads/main',symbolic:true,force:true})
 fs.writeFileSync(gitdir+'/shallow',changed+'\n');assert.equal(await query.getHistoryTotal('r'),1,'declared shallow root is counted but parents not traversed')
 fs.unlinkSync(gitdir+'/shallow');await assert.rejects(query.getHistoryTotal('r',oids[0]),/HEAD 已变化/);assert.equal(await query.getHistoryTotal('r'),93,'deepen with same HEAD invalidates shallow-keyed cache')
 const missing='f'.repeat(40),broken=await commit('broken parent',[missing]);await assert.rejects(query.getHistoryTotal('r'),/object|Could not|found/i)
 fs.writeFileSync(gitdir+'/shallow',broken+'\n');assert.equal(await query.getHistoryTotal('r'),1,'missing parent is safe only at declared shallow boundary');fs.unlinkSync(gitdir+'/shallow')
 const denied=await commit('denied',[changed]);fail=true;await assert.rejects(query.getHistoryTotal('r'),/denied/);fail=false;assert.equal(await query.getHistoryTotal('r'),94,'error was not cached as zero')
 fs.writeFileSync(gitdir+'/shallow','malformed\n');await assert.rejects(query.getHistoryTotal('r'),/边界无效/);fs.unlinkSync(gitdir+'/shallow')
 await commit('race',[denied]);gate=deferred();const pending=query.getHistoryTotal('r');await tick();await commit('new HEAD',[denied]);gate.resolve();gate=null;await assert.rejects(pending,/HEAD 已变化/)
 const fsDenied={promises:{readFile:async()=>{throw Object.assign(Error('permission'),{code:'EACCES'})}}}
 // HEAD/ref failures are not confused with an empty repository.
 const bad=load('services/git/statusQueryService.ts',{'./localRenameHistory':{},'../../utils/history':load('utils/history.ts'),'../../utils/lru':load('utils/lru.ts'),'../../utils/performance':{},'./runtime':{getCtx:async()=>({git:{resolveRef:async()=>{throw Object.assign(Error('permission'),{code:'EACCES'})}},fs:fsDenied,dir,gitdir})},'./statusScanService':{}})
 await assert.rejects(bad.getHistoryTotal('r'),/permission/)
 const plain=load('services/git/statusQueryService.ts',{'./localRenameHistory':{},'../../utils/history':load('utils/history.ts'),'../../utils/lru':load('utils/lru.ts'),'../../utils/performance':{},'./runtime':{getCtx:async()=>({git,fs:new Proxy(fs.promises,{get:(t,k)=>k==='promises'?undefined:t[k]}),dir,gitdir})},'./statusScanService':{}})
 assert.equal(await plain.getHistoryTotal('r'),95,'production promise-style FS without .promises is supported')
 fs.writeFileSync(gitdir+'/HEAD','malformed HEAD\n');await assert.rejects(plain.getHistoryTotal('r'))

 console.log('PASS real Git total: partial pages/full total, search independent, merge dedup, empty, HEAD update/detach, shallow/deepen/missing-object/error and concurrent HEAD change')
 await hookRaces()
 }finally{fs.rmSync(root,{recursive:true,force:true})}}
async function hookRaces(){
 const source=fs.readFileSync(path.join(__dirname,'../hooks/useRepoDetailData.ts'),'utf8'),mocks={scripting:ui}
 for(const [,names,module]of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){if(module==='scripting')continue;mocks[module]={};for(const token of names.split(',')){const name=token.trim();if(name&&!name.startsWith('type '))mocks[module][name]=()=>{}}}
 const totals=[],pages=[],offsets=[]
 mocks['../services/gitService']={getHistoryTotal:()=>{const g=deferred();totals.push(g);return g.promise},getLogPage:(_repo,offset)=>{offsets.push(offset);const g=deferred();pages.push(g);return g.promise},hasHeadCommit:async()=>true}
 mocks['../services/repoStore']={findRepo:()=>({}),getRepoLastPulledAt:()=>null}
 const Hook=load('hooks/useRepoDetailData.ts',mocks).useRepoDetailData
 const h=mount(()=>Hook({bookmarkName:'r',name:'r',showToast(){}}),{})
 const a=h.tree.loadLog(true,'old')
 pages[0].resolve({entries:[{oid:'old'}],headOid:'old',hasMore:false,totalMatches:1});await a
 const b=h.tree.loadLog(true,'new')
 pages[1].resolve({entries:[{oid:'new'}],headOid:'new',hasMore:false,totalMatches:1});await b
 totals[1].resolve(120);await tick();h.render();assert.equal(h.tree.historyTotal,120);assert.equal(h.tree.log[0].oid,'new')
 totals[0].resolve(3);await tick();h.render();assert.equal(h.tree.historyTotal,120);assert.equal(h.tree.log[0].oid,'new')
 const c=h.tree.loadLog(true,'error');pages[2].resolve({entries:[],hasMore:false,totalMatches:0});await c;totals[2].reject(Error('count failed'));await tick();h.render();assert.equal(h.tree.historyTotal,null,'unknown error not zero')
 const older=h.tree.loadLog(true,'older'),newer=h.tree.loadLog(true,'newer')
 pages[4].resolve({entries:[{oid:'latest'}],hasMore:false,totalMatches:1});await newer
 pages[3].resolve({entries:[{oid:'stale'}],hasMore:false,totalMatches:1});await older
 totals[3].resolve(140);await tick();h.render();assert.equal(h.tree.log[0].oid,'latest');assert.equal(h.tree.historyTotal,140)
 const switched=h.tree.loadLog(false);pages[5].resolve({headOid:'switched',entries:[{oid:'wrong-offset'}],hasMore:false,totalMatches:null});await tick();assert.equal(offsets[6],0,'HEAD change during load-more restarts at first page')
 pages[6].resolve({headOid:'switched',entries:[{oid:'branch-first'}],hasMore:false,totalMatches:null});await switched;totals[4].resolve(7);await tick();h.render();assert.deepEqual(h.tree.log.map(e=>e.oid),['branch-first']);assert.equal(h.tree.historyTotal,7)
 const d=h.tree.loadLog(true,'detached');pages[7].resolve({entries:[],hasMore:false,totalMatches:0});await d;h.unmount();totals[5].resolve(999);await tick();assert.equal(h.lateWrites,0)
 console.log('PASS real data hook: page renders without awaiting count; latest search/refresh wins, errors remain unknown, unmount ignores stale total and page')
}
main().catch(e=>{console.error(e);process.exitCode=1})
