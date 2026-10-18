/* Real bundled isomorphic-git + native temporary Git repository; never user repositories. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process')
const {load,mount,ui}=require('./remoteFiles.test.cjs')
const git=new Function('var self=globalThis; var module={exports:{}}; var exports=module.exports;'+fs.readFileSync(path.join(__dirname,'../vendor/index.umd.min.js'),'utf8')+'\n;return module.exports')()
const scan={scanMutationMatrix:ctx=>git.statusMatrix(ctx)}
const pathsModule=load('services/git/pathStashService.ts',{'./matrixScanService':scan})
const {createPathStash}=pathsModule
const author={name:'Test',email:'test@example.invalid'}
async function fixture(run){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-path-stash-')),gitdir=dir+'/.git'
 const abs=p=>path.isAbsolute(p)?p:gitdir+'/'+p
 const adapter={...fs.promises,readFile:async(p,...args)=>fs.promises.readFile(abs(p),...args),unlink:async p=>fs.promises.unlink(abs(p)),exists:async p=>{try{await fs.promises.lstat(abs(p));return true}catch(e){if(e.code==='ENOENT')return false;throw e}},writeFile:async(p,data,...args)=>{p=abs(p);await fs.promises.mkdir(path.dirname(p),{recursive:true});return fs.promises.writeFile(p,data,...args)}}
 const ctx={git,fs:adapter,dir,gitdir}
 const cmd=(...args)=>cp.execFileSync('git',['-C',dir,...args],{encoding:'utf8'})
 const write=(p,v)=>{fs.mkdirSync(path.dirname(dir+'/'+p),{recursive:true});fs.writeFileSync(dir+'/'+p,v)}
 try{cmd('init','-q');cmd('config','user.name',author.name);cmd('config','user.email',author.email)
 for(const p of ['folder/a','folder/b','folder2/c','other','gone'])write(p,'base '+p+'\n')
 cmd('add','.');cmd('commit','-qm','base');await run({ctx,cmd,write,dir,adapter})
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
}
async function main(){
 for(const selection of [['folder/a'],['folder'],undefined])await fixture(async({ctx,cmd,write,dir})=>{
  write('folder/a','staged a\n');cmd('add','folder/a');write('folder/a','working a\n')
  write('folder/b','changed b\n');write('folder/new','new file\n');write('folder2/c','different prefix\n')
  write('other','staged other\n');cmd('add','other');write('other','working other\n');fs.unlinkSync(dir+'/gone')
  const originalHead=fs.readFileSync(ctx.gitdir+'/HEAD'),originalOid=cmd('rev-parse','HEAD')
  const oldOther=cmd('show',':other'),oldWork=fs.readFileSync(dir+'/other','utf8'),oldStatus=cmd('status','--porcelain')
  await createPathStash(ctx,'selected scope',author,selection)
  assert.deepEqual(fs.readFileSync(ctx.gitdir+'/HEAD'),originalHead,'Stash create preserves symbolic HEAD bytes');assert.equal(cmd('rev-parse','HEAD'),originalOid)
  assert.equal(cmd('stash','list').trim().split('\n').length,1)
  const changed=cmd('diff','--name-only','stash@{0}^1','stash@{0}').trim().split('\n').sort()
  const expected=selection?.[0]==='folder/a'?['folder/a']:selection?['folder/a','folder/b','folder/new']:['folder/a','folder/b','folder/new','folder2/c','gone','other']
  assert.deepEqual(changed,expected.sort(),'stash contains only requested scope')
  assert.equal(fs.readFileSync(dir+'/folder/a','utf8'),'base folder/a\n')
  if(selection){assert.equal(cmd('show',':other'),oldOther);assert.equal(fs.readFileSync(dir+'/other','utf8'),oldWork);assert.match(cmd('status','--porcelain'),/MM other/);assert.equal(fs.readFileSync(dir+'/folder2/c','utf8'),'different prefix\n')}
  if(selection?.[0]==='folder/a'){assert.equal(fs.readFileSync(dir+'/folder/b','utf8'),'changed b\n');assert.equal(fs.readFileSync(dir+'/folder/new','utf8'),'new file\n')}
  // Native Git can recover both worktree and index snapshots from our standard stash.
  cmd('reset','--hard','-q','HEAD');cmd('clean','-fdq');cmd('stash','apply','--index')
  assert.equal(fs.readFileSync(dir+'/folder/a','utf8'),'working a\n');assert.equal(cmd('show',':folder/a'),'staged a\n')
  // App application on the original base restores the same staged/unstaged split.
  cmd('reset','--hard','-q','HEAD');cmd('clean','-fdq')
  const service=load('services/git/stashService.ts',{'./matrixScanService':scan,'../../utils/stash':load('utils/stash.ts'),'./runtime':{getCtx:async()=>ctx},'./pathStashService':pathsModule})
  if(selection?.[0]!=='folder/a'){
   write('.git/info/exclude','folder/new\n');write('folder/new','do not overwrite ignored file\n')
   await assert.rejects(service.applyStashInternal('temp',0),/覆盖未跟踪或忽略/)
   assert.equal(fs.readFileSync(dir+'/folder/new','utf8'),'do not overwrite ignored file\n');fs.unlinkSync(dir+'/folder/new');write('.git/info/exclude','')
  }
  const beforeApplyHead=fs.readFileSync(ctx.gitdir+'/HEAD')
  await service.applyStashInternal('temp',0)
  assert.deepEqual(fs.readFileSync(ctx.gitdir+'/HEAD'),beforeApplyHead,'Stash apply preserves HEAD bytes');assert.equal(cmd('rev-parse','HEAD'),originalOid)
  assert.equal(fs.readFileSync(dir+'/folder/a','utf8'),'working a\n');assert.equal(cmd('show',':folder/a'),'staged a\n')
  cmd('reset','--hard','-q','HEAD');cmd('clean','-fdq');write('new-head','new commit');cmd('add','.');cmd('commit','-qm','advance')
  await assert.rejects(service.applyStashInternal('temp',0),/基线已改变/)
  assert.equal(cmd('status','--porcelain'),'')
  console.log('PASS real stash scope:',selection||'all', 'native + app recovery; unrelated index/worktree preserved')
 })
 await fixture(async({ctx,cmd,write,dir,adapter})=>{
  write('folder/a','recover me\n');write('folder/b','recover b\n');write('other','unrelated\n');cmd('add','other')
  const index=fs.readFileSync(ctx.gitdir+'/index'),status=cmd('status','--porcelain')
  let checkouts=0;const failing={...ctx,git:{...git,checkout:async options=>{if(++checkouts===2)throw Error('injected checkout failure');return git.checkout(options)}}}
  await assert.rejects(createPathStash(failing,'failure',author,['folder']),/injected/);assert.equal(checkouts,2,'failure follows one successful selected-path reset')
  assert.deepEqual(fs.readFileSync(ctx.gitdir+'/index'),index);assert.equal(cmd('status','--porcelain'),status);assert.equal(fs.readFileSync(dir+'/folder/a','utf8'),'recover me\n');assert.equal(cmd('stash','list'),'')
  await assert.rejects(createPathStash(ctx,'invalid',author,['../other']),/无效/)
  await assert.rejects(createPathStash(ctx,'empty',author,[]),/没有可保存/)
  console.log('PASS rollback after partial checkout failure; invalid/empty selections do not stash all')
 })
 await fixture(async({ctx,cmd,write,dir})=>{
  write('folder/a','edited');fs.chmodSync(dir+'/folder/a',0o755)
  await assert.rejects(createPathStash(ctx,'unsafe',author,['folder/a']),/可执行文件/)
  assert.equal(fs.readFileSync(dir+'/folder/a','utf8'),'edited');assert.equal(cmd('stash','list'),'')
  fs.chmodSync(dir+'/folder/a',0o644);fs.symlinkSync('folder/a',dir+'/link')
  await assert.rejects(createPathStash(ctx,'unsafe',author,['link']),/符号链接/)
  assert.equal(cmd('stash','list'),'');assert.ok(fs.lstatSync(dir+'/link').isSymbolicLink())
  console.log('PASS executable/symlink safety rejects before resetting anything')
 })
 const calls=[]
 const hook=load('hooks/useRepoWorktreeActions.ts',{
  scripting:ui,'../services/gitService':{
   createStash:async(...args)=>calls.push(['stash',...args]),addFiles:async(...args)=>calls.push(['stage',...args]),
   stageAll:async(...args)=>calls.push(['stageAll',...args]),unstageFiles:async(...args)=>calls.push(['unstage',...args]),unstageAll:async(...args)=>calls.push(['unstageAll',...args]),
  },'../services/notifyService':{},'../utils/format':{},
 }).useRepoWorktreeActions
 const h=mount(()=>hook({bookmarkName:'repo',changes:[{filepath:'folder/a'}],mergeInProgress:false,refreshChangesAndSnapshot:async()=>{},loadStashes:async()=>{},showToast(){}}),{})
 await h.tree.handleStagePaths(['folder/a']);h.render();assert.deepEqual(calls,[['stash','repo','',['folder/a']]])
 await h.tree.handleStage('folder/a');h.render();await h.tree.handleUnstage('folder/a');h.render();await h.tree.handleStageAll();h.render();await h.tree.handleUnstageAll()
 assert.deepEqual(calls.slice(1),[['stage','repo','folder/a'],['unstage','repo','folder/a'],['stageAll','repo'],['unstageAll','repo']]);h.unmount()
 console.log('PASS file-tree Stash dispatch is separate from Changes Stage/unstage/all')

}
const watchdog=setTimeout(()=>{console.error('FAIL path stash test did not finish');process.exitCode=1},15000)
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>clearTimeout(watchdog))
