/* Real API/queue/cloneInternal/HTTP auth code; no real network or filesystem writes. */
const assert=require('node:assert/strict')
const {load,mount,node,text,all,ui,tick,http}=require('./remoteFiles.test.cjs')
const {env,rawRepo,req}=require('./cloneQueue.test.cjs')
const progress=load('utils/remoteProgress.ts')
let credential=null,groups=0
const keys=load('constants/auth.ts')
global.Keychain={contains:key=>key===keys.KC_TOKEN_KEY&&credential!==null,get:key=>key===keys.KC_TOKEN_KEY?credential:null}
const auth=load('services/authStore.ts',{'../constants/auth':keys,'./storage':{}})
const api=load('api/githubApi.ts',{'../services/authStore':auth,'../utils/lru':{setLruEntry(){}}})
async function test(name,fn){credential=null;await fn();groups++;console.log('PASS '+name)}
function integration(){
  let remote
  const e=env({api,cloneImplementation:(...args)=>remote.cloneInternal(...args)})
  const transport=load('services/gitCore.ts',{'../polyfills':{}}).createHttpTransport
  const engineCalls=[],upstreams=[]
  const git={clone:async options=>{
    engineCalls.push(options)
    const response=await options.http.request({url:options.url+'/info/refs?service=git-upload-pack',method:'GET',headers:{Accept:'application/x-git-upload-pack-advertisement'}})
    if(response.statusCode!==200)throw new Error('Git HTTP '+response.statusCode+': authentication failed')
    e.fm.files.set(options.dir+'/README.md','downloaded')
  },addRemote:async options=>upstreams.push(options),push:async()=>{throw new Error('must not push without Token')}}
  remote=load('services/git/remoteService.ts',{
    '../gitCore':{createHttpTransport:transport,createFS:()=>({}),loadGitEngine:async()=>({git})},
    '../authStore':auth,'../../constants/git':{DEFAULT_BRANCH:'main'},'../../utils/gitSync':{},'../../utils/remoteProgress':progress,
    './runtime':{resolveGitdir:id=>'/group/git-repos/'+id,ensureWorktreeMaterialized:async()=>{},getCtx:async()=>({git,fs:{},dir:'/fake',gitdir:'/group/git-repos/fake'})},
  })
  return {...e,remote,engineCalls,upstreams}
}
function network(handler){
  const calls=[]
  global.fetch=async(url,options)=>{
    calls.push({url,options});const response=await handler(url,options);const status=response.status??200
    return {ok:status>=200&&status<300,status,json:async()=>response.data,headers:new Map(),expectedContentLength:0,dataStream:(async function*(){})(),url}
  }
  return calls
}
function page(e){
  const useToast=load('hooks/useToast.ts',{scripting:ui}).useToast
  return load('pages/ClonePage.tsx',{'../utils/displayPaths':load('utils/displayPaths.ts'),'../services/cloneDiagnostics':{runDirectoryCheck:async()=>''},
    scripting:ui,'../components/AvatarView':{AvatarView:'AvatarView'},'../hooks/useGitHubUserSearch':load('hooks/useGitHubUserSearch.ts',{scripting:ui,'../api/githubApi':api}),'../components/FormRow':{FormRow:'FormRow'},'../components/BusyOverlay':{BusyOverlay:'BusyOverlay'},'../components/Toast':{toastContent:message=>global.__jsx('Text',{},message)},'../hooks/useToast':{useToast},
    '../utils/clonedGithubRepos':load('utils/clonedGithubRepos.ts',{'./github':load('utils/github.ts')}),'../services/repoStore':{listRepos:e.store.listRepos,pickDirectory:async()=>null},'../services/gitService':{RemoteCancelToken:progress.RemoteCancelToken},'../services/cloneWorkspace':e.workspace,'../services/cloneQueue':e.queue,
    '../services/authStore':auth,'../services/notifyService':{notifySync:async()=>{},notifyError:async()=>{}},'../api/githubApi':api,
    '../utils/format':{repoNameFromUrl:url=>url.split('/').pop().replace(/\.git$/,'')},'../utils/remoteProgress':{yieldForUi:async()=>{}},
  }).ClonePage
}
function setForm(h,label,value){h.render();const form=all(h.tree).find(n=>n.type==='FormRow'&&n.props.label===label);assert.ok(form);form.props.onChanged(value)}
async function main(){
  await test('no Token public pagination and details GET have no /user or Authorization',async()=>{
    const calls=http(url=>{
      if(url.includes('/users/Wangsc1/repos'))return {data:url.endsWith('page=1')?Array.from({length:100},(_,i)=>rawRepo('Wangsc1','r'+i)):[rawRepo('Wangsc1','last')]}
      if(url.endsWith('/repos/Wangsc1/last'))return {data:rawRepo('Wangsc1','last')}
      throw new Error('Unexpected authenticated endpoint '+url)
    })
    assert.equal((await api.listOwnedRepos('Wangsc1')).length,101);assert.equal(calls.length,2)
    assert.equal((await api.getRepo('Wangsc1/last')).fullName,'Wangsc1/last')
    assert.ok(calls.every(c=>!('Authorization' in c.options.headers)));assert.ok(calls.every(c=>!c.url.endsWith('/user')&&!c.url.includes('/user/repos')))
  })
  await test('anonymous later-page limit rejects partial list with actionable hint',async()=>{
    const calls=http(url=>url.endsWith('page=1')?{data:Array.from({length:100},(_,i)=>rawRepo('Wangsc1','r'+i))}:{status:403,data:{message:'API rate limit exceeded'}})
    await assert.rejects(api.listOwnedRepos('Wangsc1'),/匿名 GitHub API 限流.*稍后重试或配置 Token/);assert.equal(calls.length,2)
    http(()=>({status:429,data:{message:'Too many requests'}}));await assert.rejects(api.listOwnedRepos('Wangsc1'),/限流/)
    http(()=>({status:404,data:{message:'Not Found'}}));await assert.rejects(api.listOwnedRepos('nobody'),/用户名\/仓库不存在/)
  })
  await test('invalid Token never retries anonymously or returns public-only success',async()=>{
    credential='mock-invalid-token'
    for(const status of [401,403]){
      const calls=http(()=>({status,data:{message:'Bad credentials'}}))
      await assert.rejects(api.listOwnedRepos('Wangsc1'),/未降级为匿名访问/)
      assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/user'));assert.equal(calls[0].options.headers.Authorization,'Bearer '+credential);assert.equal(auth.getToken(),credential)
    }
  })
  await test('authenticated later private-list failure cannot return earlier public-only results',async()=>{
    credential='mock-valid-token'
    const calls=http(url=>url.endsWith('/user')?{data:{login:'alice'}}:url.includes('/users/Wangsc1/repos')?{data:[rawRepo('Wangsc1','public')]}:{status:403,data:{message:'Resource not accessible by personal access token'}})
    await assert.rejects(api.listOwnedRepos('Wangsc1'),/未降级为匿名访问/);assert.equal(calls.length,3);assert.ok(calls.every(c=>c.options.headers.Authorization==='Bearer '+credential))
  })
  await test('own/private and accessible other-owner/private lists retain authentication',async()=>{
    credential='mock-valid-token';let target='alice'
    const calls=http(url=>url.endsWith('/user')?{data:{login:'alice'}}:url.includes('/users/Wangsc1/repos')?{data:[rawRepo('Wangsc1','public')]}:target==='alice'?{data:[rawRepo('alice','secret',true)]}:{data:[rawRepo('Wangsc1','secret',true),rawRepo('unrelated','secret',true)]})
    assert.ok((await api.listOwnedRepos('alice'))[0].private)
    target='Wangsc1';const repos=await api.listOwnedRepos('Wangsc1');assert.equal(repos.length,2);assert.ok(repos.some(r=>r.private));assert.ok(calls.every(c=>c.options.headers.Authorization==='Bearer '+credential))
  })
  await test('without Token, Contents PUT/repo creation/issue/workflow writes still fail before HTTP',async()=>{
    const calls=http(()=>{throw new Error('No HTTP write permitted')})
    const writes=[()=>api.saveRepoTextFile('Wangsc1/r',{path:'a',branch:'main',sha:'s',text:'changed',message:'m'}),()=>api.createRepo({name:'new'}),()=>api.createIssue('Wangsc1/r',{title:'test'}),()=>api.dispatchWorkflow('Wangsc1/r',1,{ref:'main'})]
    for(const write of writes)await assert.rejects(write(),/未配置 GitHub Token/)
    assert.equal(calls.length,0)
  })
  await test('anonymous UI -> API -> queue -> cloneInternal -> HTTP transport succeeds',async()=>{
    const e=integration(),registered=[]
    const calls=network(url=>url.includes('/search/users?')?{data:{items:[],total_count:0,incomplete_results:false}}:url.includes('/users/Wangsc1/repos')?{data:[rawRepo('Wangsc1','public')]}:url.endsWith('/repos/Wangsc1/public')?{data:rawRepo('Wangsc1','public')}:url.includes('/info/refs')?{data:null}:(()=>{throw new Error('Unexpected '+url)})())
    const h=mount(page(e),{onCloned:(r,keep)=>registered.push([r,keep])});await tick();assert.match(text(h),/未配置 Token：仅公开仓库/)
    setForm(h,'用户名','Wangsc1');await new Promise(resolve=>setTimeout(resolve,700));await tick();assert.match(text(h),/本次列表仅包含公开仓库/)
    let confirm;global.Dialog={confirm:async input=>{confirm=input;return true}}
    await node(h,'Button','克隆所选仓库').props.action()
    assert.match(confirm.message,/仅公开仓库/);assert.match(text(h),/成功 1/);assert.equal(e.engineCalls.length,1)
    assert.deepEqual(e.engineCalls[0].onAuth(),{username:'anonymous',password:''});assert.equal(registered.length,1);assert.equal(registered[0][1],true)
    assert.ok(e.fm.files.has('/cloud/Scripting/git/public/README.md'));assert.equal(calls.length,4);assert.equal(calls.filter(c=>c.url.includes('/search/users?')).length,1);assert.ok(calls.every(c=>!c.options.headers.Authorization));h.unmount()
  })
  await test('single public URL clone has no credential gate or Authorization header',async()=>{
    const e=integration(),registered=[];const calls=network(url=>{assert.ok(url.includes('/info/refs'));return {data:null}})
    const h=mount(page(e),{onCloned:r=>registered.push(r)});await tick()
    setForm(h,'Git URL','https://github.com/Wangsc1/public.git');await node(h,'Button','克隆').props.action()
    assert.equal(registered.length,1);assert.equal(e.engineCalls.length,1);assert.equal(calls.length,1);assert.equal(calls[0].options.headers.Authorization,undefined);h.unmount()
  })
  await test('anonymous fork details retain upstream behavior',async()=>{
    const e=integration();network(url=>url.endsWith('/repos/Wangsc1/fork')?{data:{...rawRepo('Wangsc1','fork'),fork:true,parent:rawRepo('source','original')}}:{data:null})
    const results=await e.queue.runCloneQueue([req('Wangsc1','fork')],{kind:'icloud'},{cancelToken:new progress.RemoteCancelToken()})
    assert.equal(results[0].status,'cloned');assert.equal(e.upstreams[0].url,'https://github.com/source/original.git')
  })
  await test('authenticated clone keeps Basic auth; invalid clone does not fallback; push still needs Token',async()=>{
    credential='mock-valid-token';const e=integration();let status=200;const calls=network(()=>({status,data:null}))
    await e.remote.cloneInternal('https://github.com/Wangsc1/secret.git','/clone-one','first')
    assert.equal(calls[0].options.headers.Authorization,'Basic '+Buffer.from('x-access-token:'+credential).toString('base64'));assert.deepEqual(e.engineCalls[0].onAuth(),{username:'x-access-token',password:credential})
    status=401;credential='mock-invalid-token';await assert.rejects(e.remote.cloneInternal('https://github.com/Wangsc1/secret.git','/clone-two','second'),/401/)
    assert.equal(calls.length,2);assert.equal(calls[1].options.headers.Authorization,'Basic '+Buffer.from('x-access-token:'+credential).toString('base64'));assert.equal(auth.getToken(),credential)
    credential=null;await assert.rejects(e.remote.pushInternal('a'),/未配置 GitHub Token/);assert.equal(calls.length,2)
  })
  console.log(`\n${groups} anonymous/auth regression groups passed; all network/filesystem I/O mocked.`)
}
main().catch(e=>{console.error(e);process.exitCode=1})
