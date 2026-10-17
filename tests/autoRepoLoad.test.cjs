/* Fake timers and real page/API pagination; no external I/O. */
const assert=require('node:assert/strict')
const {load,mount,node,all,text,tick,deferred,http}=require('./remoteFiles.test.cjs')
const {env,repo,rawRepo}=require('./cloneQueue.test.cjs')
const {page}=require('./clonedSelection.test.cjs')
let count=0
function clock(){const original=setTimeout,clear=clearTimeout;let now=0,id=0;const jobs=new Map();global.setTimeout=(fn,ms=0)=>{jobs.set(++id,{fn,at:now+ms});return id};global.clearTimeout=id=>jobs.delete(id);return {advance:async ms=>{const end=now+ms;while(true){const next=[...jobs].filter(([,x])=>x.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;jobs.delete(next[0]);next[1].fn();await tick()}now=end;await tick()},restore(){global.setTimeout=original;global.clearTimeout=clear},jobs}}
function input(h,value){h.render();all(h.tree).find(n=>n.type==='FormRow'&&n.props.label==='用户名').props.onChanged(value)}
function candidate(h,login){h.render();return all(h.tree).find(n=>n.type==='Button'&&n.props.key===login)}
const search=()=>({candidates:['bob','alice','carol'].map(login=>({login})),total:null,selectUser(){},changeQuery(){}})
async function test(name,fn){const time=clock();try{await fn(time);count++;console.log('PASS '+name)}finally{time.restore()}}
async function main(){
 await test('typed username debounces 650ms; invalid/empty never load; no deleted load button; fixed execute text',async time=>{
  const calls=[],e=env(),h=mount(page(e,async name=>{calls.push(name);return [repo(name,'new')]}),{onCloned(){}})
  assert.equal(all(h.tree).some(n=>n.type==='Button'&&n.props.title==='加载全部仓库'),false)
  input(h,'b');await time.advance(300);input(h,'bo');await time.advance(300);input(h,'bob');await time.advance(649);assert.equal(calls.length,0);await time.advance(1);assert.deepEqual(calls,['bob']);assert.equal(node(h,'Button','克隆所选仓库').props.disabled,false)
  for(const name of ['','-bad','bad-','bad/name','a'.repeat(40)]){input(h,name);await time.advance(700)}assert.equal(calls.length,1);h.unmount()
 })
 await test('valid initial username loads all API pages before publishing; un-cloned default only; no origin extra network',async time=>{
  const api=load('api/githubApi.ts',{'../services/authStore':{getToken:()=>null},'../utils/lru':{setLruEntry(){}}}),last=deferred(),e=env()
  e.rows.push({bookmarkName:'old',remoteUrl:'git@github.com:BOB/r0.git',createdAt:0})
  const calls=http(url=>url.endsWith('page=1')?{data:Array.from({length:100},(_,i)=>rawRepo('bob','r'+i))}:last.promise)
  const h=mount(page(e,api.listOwnedRepos),{initialUsername:'bob',onCloned(){}});await time.advance(650);assert.equal(calls.length,2);assert.equal(all(h.tree).some(n=>n.props?.title==='克隆所选仓库'),false)
  last.resolve({data:[rawRepo('bob','end')]});await tick();assert.match(text(h),/共\s+101\s+个 · 已选\s+100\s+个/);assert.ok(node(h,'Button','☐ bob/r0（已克隆）'));assert.equal(calls.length,2);h.unmount()
 })
 await test('candidates load immediately; repeated same clicks do not stack; old request and latest queued user never mix',async time=>{
  const gates={bob:deferred(),carol:deferred()},calls=[],e=env();let active=0,peak=0
  const h=mount(page(e,async name=>{calls.push(name);peak=Math.max(peak,++active);try{return await gates[name].promise}finally{active--}},()=>{},search),{onCloned(){}})
  candidate(h,'bob').props.action();candidate(h,'bob').props.action();assert.deepEqual(calls,['bob'])
  input(h,'alice');await time.advance(650);input(h,'carol');candidate(h,'carol').props.action();candidate(h,'carol').props.action();assert.deepEqual(calls,['bob'])
  gates.bob.resolve([repo('bob','old')]);await tick();assert.deepEqual(calls,['bob','carol']);assert.ok(!text(h).includes('bob/old'));assert.equal(peak,1)
  gates.carol.resolve([repo('carol','new')]);await tick();assert.ok(node(h,'Button','☑ carol/new'));candidate(h,'carol').props.action();assert.equal(calls.length,2);h.unmount()
 })
 await test('input change immediately invalidates selection and stale execute; clearing/unmount suppress queued requests and late writes',async time=>{
  const gate=deferred(),calls=[],e=env(),h=mount(page(e,async name=>{calls.push(name);return name==='bob'?[repo(name,'one')]:gate.promise}),{onCloned(){}})
  input(h,'bob');await time.advance(650);const old=node(h,'Button','克隆所选仓库').props.action
  input(h,'alice');assert.equal(all(h.render()).some(n=>n.props?.title==='克隆所选仓库'),false);await old();assert.equal(e.clones.length,0)
  await time.advance(650);input(h,'carol');await time.advance(650);input(h,'');gate.resolve([repo('alice','late')]);await tick();assert.deepEqual(calls,['bob','alice']);assert.ok(!text(h).includes('late'))
  input(h,'bob');h.unmount();await time.advance(1000);assert.equal(calls.length,2);assert.equal(h.lateWrites,0)
 })
 await test('load failure has retry, no partial list; retry double-click single-flight and confirmation retains count',async time=>{
  const e=env(),gate=deferred();let calls=0,confirmation
  const h=mount(page(e,async()=>{if(++calls===1)throw Error('page 2 failed');return gate.promise}),{onCloned(){}})
  input(h,'bob');await time.advance(650);assert.match(text(h),/page 2 failed/);assert.equal(all(h.tree).some(n=>n.props?.title==='克隆所选仓库'),false)
  const retry=node(h,'Button','重试仓库加载').props.action;retry();retry();assert.equal(calls,2);gate.resolve([repo('bob','one')]);await tick();global.Dialog={confirm:async c=>{confirmation=c;return false}};await node(h,'Button','克隆所选仓库').props.action();assert.match(confirmation.title,/1 个仓库/);assert.match(confirmation.message,/目标：/);h.unmount()
 })
 await test('disabled:true filtered across full raw pages, own/private merge and my clone list; names never hardcoded',async time=>{
  let token=null;const api=load('api/githubApi.ts',{'../services/authStore':{getToken:()=>token},'../utils/lru':{setLruEntry(){}}})
  const calls=http(url=>url.endsWith('page=1')?{data:Array.from({length:100},(_,i)=>({...rawRepo('bob','blocked'+i),disabled:true}))}:{data:[rawRepo('bob','scripts'),{...rawRepo('bob','disabled-end'),disabled:true}]})
  const e=env(),h=mount(page(e,api.listOwnedRepos),{initialUsername:'bob',onCloned(){}})
  await time.advance(650);assert.ok(node(h,'Button','☑ bob/scripts'));assert.equal(all(h.tree).some(n=>String(n.props?.title||'').includes('blocked')),false);assert.equal(calls.length,2)
  let confirmation;global.Dialog={confirm:async c=>{confirmation=c;return false}};await node(h,'Button','克隆所选仓库').props.action();assert.match(confirmation.title,/1 个仓库/);assert.equal(e.clones.length,0);h.unmount()
  token='mock-token';http(url=>url.endsWith('/user')?{data:{login:'alice'}}:url.includes('/users/bob/')?{data:[{...rawRepo('bob','blocked-public'),disabled:true},rawRepo('bob','public')]}:{data:[{...rawRepo('bob','blocked-private',true),disabled:true},rawRepo('bob','private',true),rawRepo('other','unrelated',true)]})
  assert.deepEqual((await api.listOwnedRepos('bob')).map(r=>r.name).sort(),['private','public'])
  http(()=>({data:[{...rawRepo('alice','blocked'),disabled:true},rawRepo('alice','scripts')]}));assert.deepEqual((await api.listMyRepos()).map(r=>r.name),['scripts'])
  http(url=>url.endsWith('/user')?{data:{login:'alice'}}:{data:[{...rawRepo('alice','blocked'),disabled:true},rawRepo('alice','ok')]});assert.deepEqual((await api.listOwnedRepos('alice')).map(r=>r.name),['ok'])
 })
 await test('blocked 403 maps safe reason independently of token; no fake rate-limit remedy; actual limits keep original hints',async()=>{
  let token=null;const api=load('api/githubApi.ts',{'../services/authStore':{getToken:()=>token},'../utils/lru':{setLruEntry(){}}})
  for(const credential of [null,'mock-token'])for(const reason of ['tos','dmca','legal','unknown','__proto__']){
   token=credential;http(()=>({status:403,data:{message:'Repository access blocked',block:{reason,html_url:'https://untrusted.example'}}}))
   await assert.rejects(api.getRepo('Wangsc1/scripts'),e=>{assert.equal(e.status,403);assert.match(e.message,/GitHub 已阻止访问/);assert.ok(e.message.includes(({tos:'服务条款限制',dmca:'版权投诉限制',legal:'法律限制'})[reason] && ['tos','dmca','legal'].includes(reason) ? ({tos:'服务条款限制',dmca:'版权投诉限制',legal:'法律限制'})[reason] : '原因未明确'));assert.match(e.message,/Token 不保证解除限制/);assert.ok(!e.message.includes('匿名访问受限或触发限流'));assert.ok(!e.message.includes('untrusted.example'));assert.ok(!e.message.includes('[object Object]'));return true})
  }
  token=null;http(()=>({status:403,data:{message:'API rate limit exceeded'}}));await assert.rejects(api.getRepo('bob/a'),/匿名 GitHub API 限流/)
 })
 console.log(`\n${count} automatic loading/blocked-error groups passed; all native/network I/O mocked.`)
}
main().catch(e=>{console.error(e);process.exitCode=1})
