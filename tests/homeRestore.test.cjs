const assert=require('node:assert/strict')
const {mount,all,tick,deferred}=require('./remoteFiles.test.cjs')
const {page}=require('./homePullAll.test.cjs')
async function main(){
 const rows=['dirty','ahead','clean'].map(name=>({name,bookmarkName:name})),calls=[],gate=deferred();let merged=false,refreshes=0
 const h=mount(page(rows,async()=>{},async()=>{},()=>{}, {
  '../services/gitService':{
   getRepoListStatus:async key=>({workdirOk:true,mergeInProgress:merged}),
   prepareRestoreScope:async key=>{if(merged)throw Error('仓库存在未完成合并');return {scope:'',root:'/authorized',gitdir:'/metadata',filepaths:['a.txt','sub/b.txt'],empty:null}},
   restoreWorktreeScope:async(key,plan)=>{calls.push([key,plan.filepaths]);await gate.promise;return '已还原 2 个文件，删除 0 个新增空目录。'},
  },
  '../hooks/useRepoListStatus':{useRepoListStatus:()=>({statusMap:{dirty:{uncommitted:2},ahead:{ahead:1,uncommitted:0},clean:{uncommitted:0}},snapshotMap:{},repoRefreshMap:{},githubUpdatedProgress:{},refreshRepo:()=>refreshes++})},
 }),{})
 function swipes(){h.render();return all(h.tree).filter(n=>n.props.trailingSwipeActions).map(n=>n.props.trailingSwipeActions)}
 const restore=swipes()[0].actions.find(n=>n.props.title==='还原')
 assert.equal(restore.props.tint,'systemOrange');assert.equal(restore.props.systemImage,undefined)
 assert.ok(swipes().slice(1).every(s=>!s.actions.some(n=>n.props.title==='还原')))
 restore.props.action();await tick();h.render();assert.equal(h.tree.props.alert.title,'还原文件并删除新增空目录？')
 assert.match(JSON.stringify(h.tree.props.alert.message),/还原 2 个文件到 HEAD/)
 let actions=all(h.tree.props.alert.actions).filter(n=>n.type==='Button')
 assert.equal(actions[1].props.title,'还原');assert.equal(actions[1].props.role,'destructive')
 assert.deepEqual(calls,[]);actions[0].props.action();h.render();assert.equal(h.tree.props.alert.isPresented,false);assert.deepEqual(calls,[])
 restore.props.action();await tick();h.render();actions=all(h.tree.props.alert.actions).filter(n=>n.type==='Button')
 const pending=actions[1].props.action();await tick();assert.deepEqual(calls,[['dirty',['a.txt','sub/b.txt']]])
 assert.ok(swipes().every(s=>s.actions.every(n=>n.props.disabled)))
 gate.resolve();await pending;h.render();assert.equal(h.tree.props.alert.isPresented,false);assert.equal(refreshes,1)
 merged=true;restore.props.action();await tick();h.render()
 assert.equal(h.tree.props.alert.title,'还原检查失败');assert.equal(calls.length,1)
 h.unmount();console.log('PASS 橙色还原仅对未提交改动显示、统一红色确认、取消零写入、仅操作目标仓库、合并保护和刷新')
}
main().catch(error=>{console.error(error);process.exitCode=1})
