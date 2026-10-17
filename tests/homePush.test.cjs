const assert=require('node:assert/strict')
const {load,mount,ui,all,tick,deferred}=require('./remoteFiles.test.cjs')
const {page}=require('./homePullAll.test.cjs')
async function main(){
 const rows=['dirty','ahead','clean','cached'].map(name=>({name,bookmarkName:name}))
 const calls=[],times=[],effects=[],gate=deferred();let refreshed=0,fail=false
 const service={
  getRepoListStatus:async key=>{calls.push('status:'+key);return {branch:'feature',hasRemote:true,workdirOk:true}},
  hasRemoteBranch:async()=>true,
  pull:async(key,remote,branch)=>{calls.push('pull:'+key+':'+branch);if(fail)throw Error('network failed');await gate.promise},
  push:async(key,remote,branch,force)=>{assert.equal(force,false);calls.push('push:'+key+':'+branch)},
  RemoteCancelToken:class{cancel(){}},isRemoteOperationCancelled:()=>false,
 }
 const actions=load('hooks/useRepoSyncActions.ts',{'../services/gitService':service,'../services/notifyService':{notifySync:async()=>{},notifyError:async()=>{}},'../utils/branchMerge':{}})
 const scripting=new Proxy(ui,{get(target,key){
  if(key==='Navigation')return {useDismiss:()=>()=>{}}
  if(key==='useEffect')return (effect,deps)=>target.useMemo(()=>{effects.push(effect);return 0},deps)
  return target[key]
 }})
 const h=mount(page(rows,()=>{},async()=>{},()=>{}, {
  scripting,'../services/gitService':service,
  '../services/repoStore':{listRepos:()=>rows,sourceLabel:()=>'',updateBranchLastPulledAt:(...args)=>times.push(args)},
  '../hooks/useRepoSyncActions':actions,
  '../hooks/useRepoListStatus':{useRepoListStatus:()=>({statusMap:{dirty:{uncommitted:1},ahead:{uncommitted:0,ahead:2},clean:{uncommitted:0,ahead:0}},snapshotMap:{cached:{uncommitted:1}},repoRefreshMap:{},githubUpdatedProgress:{},refreshRepo:()=>refreshed++})},
 }),{})
 const render=()=>{h.render();effects.splice(0).forEach(effect=>effect());return all(h.tree).filter(n=>n.props.trailingSwipeActions)}
 let swipes=render()
 assert.deepEqual(swipes.map(n=>n.props.trailingSwipeActions.actions.map(a=>a.props.title)),[['拉取','提交','删除'],['拉取','提交','删除'],['拉取','删除'],['拉取','提交','删除']])
 const push=swipes[0].props.trailingSwipeActions.actions[1]
 assert.equal(push.props.tint,'systemGreen');assert.equal(push.props.systemImage,undefined)
 push.props.action();push.props.action();render();await tick()
 assert.deepEqual(calls,['status:dirty','pull:dirty:feature']);assert.equal(render()[0].props.trailingSwipeActions.actions[1].props.disabled,true)
 gate.resolve();await tick();render();assert.deepEqual(calls,['status:dirty','pull:dirty:feature','push:dirty:feature'])
 assert.equal(times[0][0],'dirty');assert.equal(times[0][1],'feature');assert.equal(refreshed,1)
 assert.equal(render()[0].props.trailingSwipeActions.actions[1].props.disabled,false)
 fail=true;render()[0].props.trailingSwipeActions.actions[1].props.action();render();await tick();render()
 assert.equal(calls.filter(value=>value.startsWith('push:')).length,1)
 assert.match(JSON.stringify(h.tree.props.alert.message),/先拉取最新失败/)
 console.log('PASS 条件绿色提交按钮、缓存回退、实时分支核验、先拉后推、重复点击保护、失败不推送及分支时间记录')
 h.unmount()
}
main().catch(error=>{console.error(error);process.exitCode=1})
