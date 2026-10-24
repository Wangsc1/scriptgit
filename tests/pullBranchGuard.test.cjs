/* Reproduced old behavior: detached HEAD -> config write + fetch(main) -> Could not find main.
   Production pull + strict HEAD resolver now reject before config/network; temporary repository only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process')
const {load,ui}=require('./remoteFiles.test.cjs');global.self=globalThis
const git=require('../vendor/index.umd.min.js'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-pull-guard-')),dir=tmp+'/work',gitdir=dir+'/.git'
cp.execFileSync('git',['init','-q','-b','master',dir]);const cmd=(...args)=>cp.execFileSync('git',['-C',dir,...args],{encoding:'utf8'})
cmd('config','user.name','Test');cmd('config','user.email','test@example.invalid');fs.writeFileSync(dir+'/a','base');cmd('add','.');cmd('commit','-qm','base')
const oid=cmd('rev-parse','HEAD').trim();cmd('update-ref','refs/remotes/origin/master',oid);cmd('update-ref','refs/remotes/origin/trunk',oid);cmd('config','branch.master.remote','origin');cmd('config','branch.master.merge','refs/heads/trunk')
let configWrites=0,fetches=[],headReads=0,ctx
const engine={...git,fetch:async options=>{fetches.push({remote:options.remote,ref:options.ref});return {}}}
function reset(){configWrites=0;fetches=[];headReads=0;ctx={git:engine,fs:{...fs,promises:{...fs.promises,readFile:async(p,...args)=>{if(p===gitdir+'/HEAD')headReads++;return fs.promises.readFile(p,...args)}}},dir,gitdir}}
global.FileManager={appGroupDocumentsDirectory:tmp}
const remote=load('utils/remote.ts'),branch=load('utils/branch.ts')
const runtime=load('services/git/runtime.ts',{scripting:ui,'../gitCore':{},'../repoStore':{},'../../utils/branch':branch,'../../utils/stash':{},'./matrixScanService':{}})
const service=load('services/git/mergeService.ts',{'./remoteService':{cleanupOriginAfterMissingTarget:async()=>{}},
 '../gitCore':{createHttpTransport:()=>({})},'../authStore':{getAuth:()=>null,resolveAuthor:async()=>({name:'Test',email:'test@example.invalid'})},
 '../../utils/mergeConflict':{},'../../utils/branchMerge':load('utils/branchMerge.ts',{'./remote':remote}),'../../utils/remote':remote,
 '../../utils/remoteProgress':{checkRemoteCancelled(){},emitRemoteProgress:async()=>{},createGitOnProgress(){}},
 './runtime':{...runtime,getCtx:async()=>ctx,ensureGitConfigAuthor:async()=>{configWrites++},ensureWorktreeMaterialized:async()=>{}},
 './mergeConflictService':{assertNoMergeInProgress:async()=>{}},'./commitService':{},
})
async function main(){try{
 for(const head of [oid+'\n','ref: refs/remotes/origin/master\n',null]){
  reset();if(head===null)fs.unlinkSync(gitdir+'/HEAD');else fs.writeFileSync(gitdir+'/HEAD',head)
  await assert.rejects(service.pullInternal('temp'),/仓库诊断.*未自动选择 main\/master/);assert.equal(configWrites,0);assert.deepEqual(fetches,[])
 }
 reset();fs.writeFileSync(gitdir+'/HEAD','ref: ref: refs/heads/master\n');await assert.rejects(service.pullInternal('temp'),/HEAD 内容无效/);assert.equal(configWrites,0);assert.deepEqual(fetches,[])
 reset();const denied=Object.assign(Error('cannot read HEAD'),{code:'EACCES'});ctx.fs.promises.readFile=async()=>{throw denied};await assert.rejects(service.pullInternal('temp'),e=>e===denied);assert.equal(configWrites,0);assert.deepEqual(fetches,[])
 console.log('PASS missing/detached/nonlocal/malformed/unreadable HEAD never guesses main or writes config/fetches')
 reset();fs.writeFileSync(gitdir+'/HEAD','ref: refs/heads/master\n');let result=await service.pullInternal('temp');assert.equal(result.status,'upToDate');assert.equal(result.branch,'master');assert.equal(result.remoteBranch,'trunk');assert.equal(result.usedUpstream,true);assert.deepEqual(fetches,[{remote:'origin',ref:'trunk'}]);assert.equal(configWrites,1)
 console.log('PASS real named master HEAD still follows configured upstream origin/trunk')
 reset();fs.writeFileSync(gitdir+'/HEAD',oid+'\n');result=await service.pullInternal('temp','origin','master');assert.equal(result.status,'upToDate');assert.equal(result.remoteBranch,'master');assert.equal(result.usedUpstream,false);assert.equal(headReads,0);assert.deepEqual(fetches,[{remote:'origin',ref:'master'}])
 console.log('PASS explicit branch (including push pre-pull) unchanged; no forced HEAD or branch edits')
 reset();fs.writeFileSync(gitdir+'/HEAD','ref: refs/heads/unborn\n');const stop=Error('stop at fetch');ctx.git={...engine,fetch:async options=>{fetches.push(options.ref);throw stop}};await assert.rejects(service.pullInternal('temp'),e=>e===stop);assert.deepEqual(fetches,['unborn']);assert.equal(fs.readFileSync(gitdir+'/HEAD','utf8'),'ref: refs/heads/unborn\n')
 console.log('PASS unborn named HEAD is retained, never replaced by a default branch')
}finally{fs.rmSync(tmp,{recursive:true,force:true})}}
main().catch(e=>{console.error(e);process.exitCode=1})
