const assert=require('node:assert/strict')
const {load,mount,node,text,all,ui,tick,deferred,http}=require('./remoteFiles.test.cjs')
const {env,repo}=require('./cloneQueue.test.cjs')
const progress=load('utils/remoteProgress.ts')
let count=0
async function test(name,fn){await fn();count++;console.log('PASS '+name)}
const item=login=>({login,avatarUrl:'https://avatars.example/'+login})
const result=(items,more=false,extra={})=>({items,total:items.length,hasMore:more,limited:false,incomplete:false,...extra})
function fakeTimers(){
  const originalSet=global.setTimeout,originalClear=global.clearTimeout
  const pending=new Map();let id=0
  global.setTimeout=(fn,delay)=>{pending.set(++id,{fn,delay});return id}
  global.clearTimeout=id=>pending.delete(id)
  return {pending,flush:async()=>{const tasks=[...pending.values()];pending.clear();tasks.forEach(t=>t.fn());await tick()},restore:()=>{global.setTimeout=originalSet;global.clearTimeout=originalClear}}
}
function hook(searchGitHubUsers){return load('hooks/useGitHubUserSearch.ts',{scripting:ui,'../api/githubApi':{searchGitHubUsers}}).useGitHubUserSearch}
function harness(search){const use=hook(search);return mount(()=>global.__jsx('Harness',{search:use()}),{})}
function state(h){h.render();return h.tree.props.search}
function form(h){h.render();const n=all(h.tree).find(n=>n.type==='FormRow'&&n.props.label==='用户名');assert.ok(n);return n}
function page(e,api){
  const useToast=load('hooks/useToast.ts',{scripting:ui}).useToast
  return load('pages/ClonePage.tsx',{
    scripting:ui,'../components/AvatarView':{AvatarView:'AvatarView'},'../hooks/useGitHubUserSearch':{useGitHubUserSearch:hook(api.searchGitHubUsers)},
    '../components/FormRow':{FormRow:'FormRow'},'../components/BusyOverlay':{BusyOverlay:'BusyOverlay'},'../components/Toast':{toastContent:()=>null},'../hooks/useToast':{useToast},
    '../utils/clonedGithubRepos':load('utils/clonedGithubRepos.ts',{'./github':load('utils/github.ts')}),'../services/repoStore':{listRepos:e.store.listRepos,pickDirectory:async()=>null},'../services/gitService':{RemoteCancelToken:progress.RemoteCancelToken},'../services/cloneWorkspace':e.workspace,'../services/cloneQueue':e.queue,
    '../services/authStore':{hasToken:()=>false},'../services/notifyService':{notifySync:async()=>{},notifyError:async()=>{}},'../api/githubApi':{listMyRepos:async()=>[],...api},
    '../utils/format':{repoNameFromUrl:()=> 'repo'},'../utils/remoteProgress':{yieldForUi:async()=>{}},
  }).ClonePage
}
async function main(){
  await test('public user API uses encoded in:login/type:user, avatar mapping, pagination and 1000 limit',async()=>{
    let token=null
    const api=load('api/githubApi.ts',{'../services/authStore':{getToken:()=>token},'../utils/lru':{setLruEntry(){}}})
    const calls=http(()=>({data:{items:[{login:'Wangsc1',avatar_url:'avatar'}],total_count:1200,incomplete_results:true}}))
    const first=await api.searchGitHubUsers('wang');assert.deepEqual(first.items,[{login:'Wangsc1',avatarUrl:'avatar'}]);assert.ok(first.limited&&first.incomplete&&first.hasMore)
    assert.match(calls[0].url,/q=wang%20in%3Alogin%20type%3Auser&per_page=20&page=1$/);assert.equal(calls[0].options.headers.Authorization,undefined)
    const last=await api.searchGitHubUsers('wang',50);assert.equal(last.hasMore,false)
    await assert.rejects(api.searchGitHubUsers('wang',51),/1000/);await assert.rejects(api.searchGitHubUsers('w'),/至少 2/);await assert.rejects(api.searchGitHubUsers('wang type:org'),/至少 2/)
    token='mock-token';await api.searchGitHubUsers('wang',2);assert.equal(calls.at(-1).options.headers.Authorization,'Bearer mock-token')
    const failures=http(()=>({status:401,data:{message:'Bad credentials'}}));await assert.rejects(api.searchGitHubUsers('wang'),/未降级为匿名访问/);assert.equal(failures.length,1)
    token=null;http(()=>({status:403,data:{message:'API rate limit exceeded'}}));await assert.rejects(api.searchGitHubUsers('wang'),/匿名 GitHub API 限流/)
  })
  await test('350ms debounce/minimum length, pagination append and duplicate-login suppression',async()=>{
    const timer=fakeTimers();let h
    try{
      const calls=[];h=harness(async(q,page)=>{calls.push([q,page]);return page===1?result([item('Wangsc1')],true,{total:22}):result([item('wangsc1'),item('Wangsc2')])})
      state(h).changeQuery('w');assert.equal(timer.pending.size,0)
      state(h).changeQuery('wa');state(h).changeQuery('wang');assert.equal(timer.pending.size,1);assert.equal([...timer.pending.values()][0].delay,350);assert.equal(calls.length,0)
      await timer.flush();assert.deepEqual(calls,[['wang',1]]);assert.equal(state(h).candidates.length,1)
      await state(h).loadMore();assert.deepEqual(calls[1],['wang',2]);assert.deepEqual(state(h).candidates.map(x=>x.login),['Wangsc1','Wangsc2']);assert.equal(state(h).hasMore,false)
    }finally{h?.unmount();timer.restore()}
  })
  await test('old in-flight search and pagination responses cannot overwrite changed/cleared query',async()=>{
    const timer=fakeTimers();let h
    try{
      const old=deferred(),more=deferred()
      h=harness((q,p)=>q==='old'?old.promise:p===2?more.promise:Promise.resolve(result([item('new-user')],true)))
      state(h).changeQuery('old');await timer.flush();assert.equal(state(h).loading,true)
      state(h).changeQuery('new');await timer.flush();assert.equal(state(h).candidates[0].login,'new-user')
      old.resolve(result([item('obsolete')]));await tick();assert.equal(state(h).candidates[0].login,'new-user')
      const pending=state(h).loadMore();state(h).changeQuery('');more.resolve(result([item('late-page')]));await pending
      assert.deepEqual(state(h).candidates,[]);assert.equal(state(h).total,null);assert.equal(state(h).loading,false)
    }finally{h?.unmount();timer.restore()}
  })
  await test('selecting a user cancels pending timers/requests; failed page retries in place; unmount ignores response',async()=>{
    const timer=fakeTimers();let h
    try{
      let fail=true;const pending=deferred()
      h=harness((q,p)=>q==='waiting'?pending.promise:p===1?Promise.resolve(result([item('a-user')],true)):fail?Promise.reject(new Error('limit')):Promise.resolve(result([item('b-user')])))
      state(h).changeQuery('ab');await timer.flush();await state(h).loadMore();assert.match(state(h).error,/limit/);assert.equal(state(h).candidates.length,1)
      fail=false;await state(h).retry();assert.equal(state(h).candidates.length,2);assert.equal(state(h).error,'')
      state(h).changeQuery('waiting');await timer.flush();state(h).selectUser('selected-user');pending.resolve(result([item('obsolete')]));await tick();assert.equal(state(h).candidates.length,0)
      state(h).changeQuery('later');assert.equal(timer.pending.size,1);state(h).selectUser('selected-user');assert.equal(timer.pending.size,0)
      const wait=deferred();h.unmount();h=harness(()=>wait.promise);state(h).changeQuery('unmount');await timer.flush();h.unmount();wait.resolve(result([item('late')]));await tick();assert.equal(h.lateWrites,0)
    }finally{if(h&&!h.unmounted)h.unmount();timer.restore()}
  })
  await test('UI avatar/login selection fills login, loads selected owner, and editing input invalidates old batch action',async()=>{
    const timer=fakeTimers();let h
    try{
      const e=env(),owners=[]
      const api={searchGitHubUsers:async()=>result([item('Wangsc1')],true,{total:1500,limited:true,incomplete:true}),listOwnedRepos:async owner=>{owners.push(owner);return [repo(owner,'one')]}}
      h=mount(page(e,api),{onCloned:()=>{}});await tick();form(h).props.onChanged('wang');await timer.flush();h.render()
      const candidate=all(h.tree).find(n=>n.type==='Button'&&all(n).some(c=>c.type==='AvatarView'&&c.props.url==='https://avatars.example/Wangsc1'))
      assert.ok(candidate);assert.ok(all(candidate).some(c=>c.type==='Text'&&c.children.includes('Wangsc1')))
      assert.match(text(h),/1000/);assert.match(text(h),/不完整/);assert.ok(node(h,'Button','加载更多用户候选'))
      candidate.props.action();assert.equal(form(h).props.value,'Wangsc1');assert.equal(owners.length,0);assert.equal(all(h.tree).filter(n=>n.type==='AvatarView').length,0)
      await node(h,'Button','加载全部仓库').props.action();assert.deepEqual(owners,['Wangsc1']);assert.match(text(h),/仅包含公开仓库/)
      const oldAction=node(h,'Button','批量克隆所选 1 个仓库').props.action
      form(h).props.onChanged('someone');h.render();assert.ok(!all(h.tree).some(n=>n.type==='Button'&&String(n.props.title).startsWith('批量克隆所选')))
      global.Dialog={confirm:async()=>true};await oldAction();assert.equal(e.clones.length,0)
      form(h).props.onChanged('');assert.equal(form(h).props.value,'');assert.equal(timer.pending.size,0)
    }finally{h?.unmount();timer.restore()}
  })
  await test('in-flight repository results are discarded when username changes, rather than re-enabling stale selection',async()=>{
    const timer=fakeTimers();let h
    try{
      const e=env(),wait=deferred();h=mount(page(e,{searchGitHubUsers:async()=>result([]),listOwnedRepos:()=>wait.promise}),{onCloned:()=>{}});await tick()
      form(h).props.onChanged('olduser');const pending=node(h,'Button','加载全部仓库').props.action()
      form(h).props.onChanged('newuser');wait.resolve([repo('olduser','old-repo')]);await pending
      assert.equal(form(h).props.value,'newuser');h.render();assert.ok(!all(h.tree).some(n=>n.type==='Button'&&String(n.props.title).startsWith('批量克隆所选')));assert.ok(!text(h).includes('old-repo'))
    }finally{h?.unmount();timer.restore()}
  })
  console.log(`\n${count} user-search regression groups passed; timers, HTTP and filesystem mocked.`)
}
main().catch(e=>{console.error(e);process.exitCode=1})
