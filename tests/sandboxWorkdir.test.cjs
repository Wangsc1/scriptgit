/* Sandbox UUID recovery: real repoStore, in-memory native/storage boundaries only. */
const assert=require('node:assert/strict')
const {env}=require('./cloneQueue.test.cjs')
const {load,ui}=require('./remoteFiles.test.cjs')
const oldRoot='/var/mobile/Containers/Data/Application/11111111-1111-1111-1111-111111111111/Documents'
const newRoot='/var/mobile/Containers/Data/Application/22222222-2222-2222-2222-222222222222/Documents'
function fixture(){const e=env();e.fm.documentsDirectory=newRoot;e.fm.files.set(newRoot,'dir');return e}
function row(name,extra={}){return {bookmarkName:name,repoId:name,name,source:'clone',workdir:oldRoot+'/git/'+name,remoteUrl:'https://github.com/o/'+name+'.git',...extra}}
async function main(){
 const e=fixture(),repo=row('draft',{lastPulledAt:123,customSetting:'retain'})
 e.rows.push(repo);e.fm.files.set(newRoot+'/git/draft','dir');e.fm.files.set(newRoot+'/git/draft/draft.txt','uncommitted bytes')
 const before=JSON.stringify(e.rows),readonly=e.store.resolveRepoPathsReadOnly('draft')
 assert.equal(readonly.workdir,newRoot+'/git/draft');assert.equal(readonly.source,'appDocuments');assert.equal(JSON.stringify(e.rows),before)
 assert.equal(e.store.resolveWorkdir('draft'),newRoot+'/git/draft');assert.equal(e.rows[0].workdirDocumentsRelative,'git/draft');assert.equal(e.rows[0].customSetting,'retain');assert.equal(e.rows[0].lastPulledAt,123)
 e.fm.files.set('/group/git-repos/draft','dir')
 const runtime=load('services/git/runtime.ts',{scripting:ui,'../repoStore':e.store,'../gitCore':{loadGitEngine:async()=>({git:{}}),createFS:(_gitdir,dir)=>({dir})},'./matrixScanService':{},'../../utils/branch':{},'../../utils/stash':{}})
 const ctx=await runtime.getCtx('draft');assert.equal(ctx.dir,newRoot+'/git/draft');assert.equal(ctx.gitdir,'/group/git-repos/draft');assert.equal(ctx.fs.dir,newRoot+'/git/draft')
 assert.equal(e.store.getGitdirPath(e.rows[0]),'/group/git-repos/draft');assert.equal(e.fm.files.get(newRoot+'/git/draft/draft.txt'),'uncommitted bytes')
 assert.equal(e.fm.bookmarkAttempts,0);assert.deepEqual(e.fm.removed,[]);assert.deepEqual(e.fm.renamed,[]);assert.deepEqual(e.fm.created,[])
 // A second sandbox change must follow the saved relative location again.
 const nextRoot='/var/mobile/Containers/Data/Application/33333333-3333-3333-3333-333333333333/Documents'
 e.fm.documentsDirectory=nextRoot;assert.equal(e.store.resolveRepoPathsReadOnly('draft').workdir,nextRoot+'/git/draft');assert.equal(e.store.resolveWorkdir('draft'),nextRoot+'/git/draft')
 console.log('PASS stale UUID recovered read-only and normally; relative anchor persists; gitdir/metadata/draft preserved; zero filesystem writes/bookmarks')
 for(const extra of [{source:'local'},{source:undefined},{accessBookmarkName:'missing'},{workdir:'/external/git/draft'},{workdir:oldRoot+'/other/draft'},{workdir:oldRoot+'/git/../draft'},{workdir:oldRoot+'/git/draft/child'}]){
  const f=fixture(),r=row('draft',extra);f.rows.push(r);assert.equal(f.store.resolveRepoPathsReadOnly('draft').workdir,r.workdir)
 }
 const f=fixture();f.rows.push(row('external',{accessBookmarkName:'parent',workdirRelative:'git/external'}));f.fm.bookmarks.set('parent','/external');assert.equal(f.store.resolveWorkdir('external'),'/external/git/external')
 const cloud=fixture();cloud.rows.push(row('cloud',{workdir:'/cloud/Scripting/git/cloud'}));assert.equal(cloud.store.resolveWorkdir('cloud'),'/cloud/Scripting/git/cloud')
 console.log('PASS external/bookmarked/local-added/iCloud/unrecognized legacy paths are not rebound')
 const fresh=fixture(),path=newRoot+'/git/new';await fresh.store.registerRepoByPath(path,'new','https://github.com/o/new.git','new')
 assert.equal(fresh.rows[0].workdirDocumentsRelative,'git/new');assert.equal(fresh.fm.bookmarkAttempts,0)
 // Malformed saved relative paths must never escape the current Documents root.
 for(const relative of ['../outside','/absolute','git/../outside','git//bad','git/./bad','git\\bad']){
  const bad=fixture();bad.rows.push(row('bad',{workdirDocumentsRelative:relative}));assert.throws(()=>bad.store.resolveWorkdir('bad'),/路径/)
 }
 console.log('PASS new local clone registers stable anchor; unsafe relative paths rejected')
}
main().catch(e=>{console.error(e);process.exitCode=1})
