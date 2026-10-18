/* Retirement regression: production traversal/pages with deterministic Git/UI boundaries. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,all,node,tick}=require('./remoteFiles.test.cjs')
const progress=load('utils/remoteProgress.ts')
const traversal=load('services/git/commitTraversal.ts',{'../../utils/remoteProgress':progress})
function page(name,service){
 const source=fs.readFileSync(path.join(__dirname,'../pages/'+name+'.tsx'),'utf8'),mocks={scripting:ui}
 for(const [,names,module] of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
  if(module==='scripting')continue
  mocks[module]={};for(const token of names.split(',')){const key=token.trim();if(key&&!key.startsWith('type '))mocks[module][key]=key}
 }
 mocks['../services/gitService']=service
 mocks['../services/repoStore']={findRepo:()=>({name:'test'}),resolveWorkdir:()=>'/test'}
 mocks['../hooks/useToast']={useToast:()=>({showToast(){},toastState:null})}
 return load('pages/'+name+'.tsx',mocks)[name]
}
async function main(){
 let reads=[]
 const git={readCommit:async({oid})=>{reads.push(oid);return {commit:{parent:{a:['b'],b:['c'],c:[]}[oid]||[]}}}}
 assert.equal(await traversal.countCommitsUntil(git,{},'/w','/g','a','c'),2)
 assert.deepEqual(reads,['a','b']);reads=[]
 assert.equal(await traversal.countCommitsUntil(git,{},'/w','/g','a',null,1),1)
 assert.deepEqual(reads,['a']);reads=[]
 assert.equal(await traversal.countCommitsUntil(git,{},'/w','/g','a','a'),0)
 const cycle={readCommit:async()=>({commit:{parent:['a']}})}
 assert.equal(await traversal.countCommitsUntil(cycle,{},'/w','/g','a',null),1)
 const token=new progress.RemoteCancelToken();token.cancel()
 await assert.rejects(traversal.countCommitsUntil(git,{},'/w','/g','a',null,99,{cancelToken:token}),/取消/)
 await assert.rejects(traversal.countCommitsUntil({readCommit:async()=>{throw Error('bad object')}},{},'/w','/g','a',null),/bad object/)
 global.FileManager={appGroupDocumentsDirectory:'/test'}
 const runtime=load('services/git/runtime.ts',{scripting:ui,'../gitCore':{},'../repoStore':{},'./matrixScanService':{},'../../utils/branch':{},'../../utils/stash':{}})
 assert.equal(await runtime.readSymbolicHeadBranch({readFile:async()=> 'ref: refs/heads/topic\n'}),'topic')
 assert.equal(await runtime.readSymbolicHeadBranch({readFile:async()=> 'a'.repeat(40)}),null)
 assert.equal(await runtime.readSymbolicHeadBranch({readFile:async()=>{throw Error('denied')}}),null)
 console.log('PASS shared first-parent traversal: stop/limit/cycle/cancel/error; tolerant HEAD reader unchanged')
 let aborts=0
 const Conflicts=page('ConflictsPage',{getMergeConflictState:async()=>({conflicts:[]}),abortMerge:async()=>aborts++})
 const c=mount(Conflicts,{bookmarkName:'repo'});await tick();c.render()
 const abortButton=all(c.tree).find(n=>n.type==='Button'&&n.props.title==='中止合并'&&n.props.systemImage==='xmark.circle')
 assert.ok(abortButton);abortButton.props.action();c.render()
 assert.equal(c.tree.props.alert.isPresented,true);assert.equal(aborts,0)
 const ca=all(c.tree.props.alert.actions);ca.find(n=>n.props?.title==='取消').props.action();c.render();assert.equal(aborts,0)
 all(c.tree).find(n=>n.type==='Button'&&n.props.title==='中止合并'&&n.props.systemImage==='xmark.circle').props.action();c.render()
 await all(c.tree.props.alert.actions).find(n=>n.props?.title==='中止合并').props.action();assert.equal(aborts,1);c.unmount()
 let deletions=0,rows=[{remote:'origin',url:'https://example.invalid/repo.git'}]
 const Remotes=page('RemotesPage',{...progress,listRemotes:async()=>rows,getBranches:async()=>({current:'main'}),getBranchUpstream:async()=>({remote:'origin',merge:'refs/heads/main'}),fetchRemote:async()=>{},getRemoteBranches:async()=>['main'],deleteRemote:async()=>{deletions++;rows=[]}})
 const r=mount(Remotes,{bookmarkName:'repo'});await tick();await tick();r.render()
 const swipe=()=>all(r.tree).find(n=>n.props?.trailingSwipeActions)?.props.trailingSwipeActions.actions
 assert.ok(swipe());swipe().find(n=>n.props.title==='删除').props.action();r.render()
 assert.equal(r.tree.props.alert.isPresented,true);assert.equal(deletions,0)
 all(r.tree.props.alert.actions).find(n=>n.props?.title==='取消').props.action();r.render();assert.equal(deletions,0)
 swipe().find(n=>n.props.title==='删除').props.action();r.render()
 await all(r.tree.props.alert.actions).find(n=>n.props?.title==='删除').props.action();assert.equal(deletions,1);r.unmount()
 console.log('PASS retired ordinary alert branches removed, abort merge/delete remote still require confirmation; cancel writes nothing')
 const sort=load('utils/repoSort.ts',{'./repoUpdated':load('utils/repoUpdated.ts',{'./github':load('utils/github.ts')})})
 const entries=[{name:'app10'},{name:'app2'}];assert.deepEqual(sort.sortReposByGithubUpdated(entries).map(r=>r.name),['app2','app10']);assert.equal(entries[0].name,'app10')
 console.log('PASS current GitHub sorting and stable name fallback retained')
}
main().catch(e=>{console.error(e);process.exitCode=1})
