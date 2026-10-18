const assert=require('node:assert/strict')
const {load,mount,ui,all,tick,deferred}=require('./remoteFiles.test.cjs')
const {page}=require('./homePullAll.test.cjs')
async function main(){
 const rows=['dirty','ahead','clean','cached'].map(name=>({name,bookmarkName:name}))
 const calls=[],times=[],effects=[],gate=deferred();let refreshed=0,fail=false
 const service={
  getRepoListStatus:async key=>{calls.push('status:'+key);return {branch:'feature',hasRemote:true,workdirOk:true}},
  stageAll:async key=>{calls.push('stageAll:'+key)},commit:async(key,message)=>{calls.push('commit:'+key+':'+message)},getChanges:async()=>[],restoreFiles:async()=>{},
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
 assert.deepEqual(swipes.map(n=>n.props.trailingSwipeActions.actions.map(a=>a.props.title)),[['还原','暂存','拉取','推送','删除'],['拉取','推送','删除'],['拉取','删除'],['还原','暂存','拉取','推送','删除']])
 const stage=swipes[0].props.trailingSwipeActions.actions.find(n=>n.props.title==='暂存');assert.equal(stage.props.tint,'systemPurple','暂存 uses purple');assert.ok(!swipes[1].props.trailingSwipeActions.actions.some(n=>n.props.title==='暂存'),'no 暂存 when there is nothing uncommitted')
 const push=swipes[0].props.trailingSwipeActions.actions.find(n=>n.props.title==='推送')
 assert.equal(push.props.tint,'systemGreen');assert.equal(push.props.systemImage,undefined)
 const sheet=()=>{h.render();const p=h.tree.props.sheet;return p}
 const btn=i=>render()[i].props.trailingSwipeActions.actions.find(n=>n.props.title==='推送')
 // 有未提交改动：点「推送」只弹出提交说明，不立刻做任何事；重复点击不叠加。
 push.props.action();push.props.action();render();await tick()
 assert.deepEqual(calls,[],'nothing runs before the commit message is confirmed')
 assert.equal(sheet().isPresented,true);let form=sheet().content;assert.equal(form.type,'CommitMessageSheet');assert.equal(form.props.confirmTitle,'推送');assert.equal(form.props.initialTitle,'更新 1 个文件')
 // 标题为空：不执行，表单内报错。
 form.props.onConfirm('   ','');render();assert.deepEqual(calls,[]);assert.match(String(sheet().content.props.error),/请填写提交信息/)
 // 取消：不执行。
 sheet().content.props.onCancel();render();assert.equal(sheet().isPresented,false);assert.deepEqual(calls,[])
 // 确认：全部暂存 → 提交 → 先拉后推，全程一次。
 btn(0).props.action();render();sheet().content.props.onConfirm('修复 bug','详细说明');render();await tick()
 assert.equal(sheet().isPresented,false)
 assert.deepEqual(calls,['status:dirty','stageAll:dirty','commit:dirty:修复 bug\n\n详细说明','pull:dirty:feature'],'stages and commits BEFORE pulling');assert.equal(btn(0).props.disabled,true)
 gate.resolve();await tick();render();assert.deepEqual(calls,['status:dirty','stageAll:dirty','commit:dirty:修复 bug\n\n详细说明','pull:dirty:feature','push:dirty:feature'])
 assert.equal(times[0][0],'dirty');assert.equal(times[0][1],'feature');assert.equal(refreshed,1)
 assert.equal(btn(0).props.disabled,false)
 // 只有未推送的提交（无未提交改动）：不弹窗，直接先拉后推，不再提交。
 calls.length=0;btn(1).props.action();render();await tick()
 assert.equal(sheet().isPresented,false);assert.deepEqual(calls,['status:ahead','pull:ahead:feature','push:ahead:feature'],'ahead-only repo pushes directly, no stage/commit')
 // 提交后拉取失败：已提交的结果保留，不推送，提示失败。
 calls.length=0;fail=true;btn(0).props.action();render();sheet().content.props.onConfirm('再来一次','');render();await tick();render()
 assert.deepEqual(calls.filter(v=>v.startsWith('push:')),[],'failed pull must not push');assert.ok(calls.some(v=>v.startsWith('commit:')),'commit already happened')
 assert.match(JSON.stringify(h.tree.props.alert.message),/先拉取最新失败/)
 fail=false
 // 主页暂存：只调用 stageAll，不拉取/推送，完成后给出结果提示。
 {const before=calls.length;const stageBtn=render()[0].props.trailingSwipeActions.actions.find(n=>n.props.title==='暂存');stageBtn.props.action();await tick();await tick();render()
  const added=calls.slice(before);assert.deepEqual(added.filter(v=>!v.startsWith('status:')),['stageAll:dirty'],'暂存 only stages; no pull/push: '+JSON.stringify(added));assert.match(JSON.stringify(h.tree.props.alert.title),/暂存完成/)}
 console.log('PASS 主页推送：有改动先弹提交说明（空标题/取消不执行）、确认后暂存→提交→先拉后推、仅未推送提交直接推送、拉取失败不推送、紫色暂存只暂存')
 h.unmount()
}
main().catch(error=>{console.error(error);process.exitCode=1})
