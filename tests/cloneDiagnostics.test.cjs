/* Read-only diagnostics, skip reasons, relative display and cloned-marker behavior; in-memory FS only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,node,all,text,ui,tick}=require('./remoteFiles.test.cjs')
const {env,repo,req}=require('./cloneQueue.test.cjs')
const progress=load('utils/remoteProgress.ts'),display=load('utils/displayPaths.ts'),marker=load('utils/clonedGithubRepos.ts',{'./github':load('utils/github.ts')})
const root=path.resolve(__dirname,'..');let groups=0
async function test(name,fn){await fn();groups++;console.log('PASS '+name)}
function guarded(e,{icloud=true}={}){
  const calls=[],fm=global.FileManager
  for(const name of ['createDirectory','rename','remove','copyFile','writeAsString','writeAsData','writeAsBytes','appendText','appendData','downloadFileFromiCloud','createLink']){
    fm[name]=async()=>{calls.push('WRITE:'+name);throw Error('unexpected write API')}
  }
  fm.isiCloudEnabled=icloud
  for(const name of ['exists','isDirectory','isLink','readDirectory']){const original=fm[name];fm[name]=async(...a)=>{calls.push(name);return original(...a)}}
  fm.isFileStoredIniCloud=p=>{calls.push('isFileStoredIniCloud');return p.endsWith('/exchange')}
  fm.isiCloudFileDownloaded=p=>{calls.push('isiCloudFileDownloaded');return false}
  return calls
}
function diagnostics(){return load('services/cloneDiagnostics.ts',{'./cloneWorkspace':global.__workspace,'../utils/displayPaths':display})}
function page(e,{token=true,myRepos=[],owned=[]}={}){
  const shown=[]
  const Page=load('pages/ClonePage.tsx',{
    scripting:ui,'../components/AvatarView':{AvatarView:'AvatarView'},'../hooks/useGitHubUserSearch':{useGitHubUserSearch:()=>({candidates:[],total:null,changeQuery(){},selectUser(){}})},'../components/FormRow':{FormRow:'FormRow'},'../components/BusyOverlay':{BusyOverlay:'BusyOverlay'},'../components/Toast':{toastContent:()=>null},
    '../hooks/useToast':{useToast:()=>({showToast:(message,type)=>shown.push([message,type])})},'../types/git':{},'../utils/clonedGithubRepos':marker,'../utils/displayPaths':display,'../services/cloneDiagnostics':diagnostics(),
    '../services/repoStore':{listRepos:()=>e.store.listRepos(),pickDirectory:async()=>null},'../services/gitService':{RemoteCancelToken:progress.RemoteCancelToken},'../services/cloneWorkspace':e.workspace,'../services/cloneQueue':e.queue,
    '../services/authStore':{hasToken:()=>token},'../services/notifyService':{notifySync:async()=>{},notifyError:async()=>{}},'../api/githubApi':{listMyRepos:async()=>myRepos,listOwnedRepos:async()=>owned},
    '../utils/format':{repoNameFromUrl:url=>url.split('/').pop().replace(/\.git$/,'')},'../utils/remoteProgress':{yieldForUi:async()=>{}},
  }).ClonePage
  return {Page,shown}
}
async function main(){
  await test('directory check is read-only and independent: exists/isDirectory/isLink/readDirectory/iCloud status; control chars, count and paths sanitized',async()=>{
    const e=env();global.__workspace=e.workspace;await e.workspace.prepareCloneRoot({kind:'icloud'})
    await e.fm.createDirectory('/cloud/Scripting/git/exchange',true);e.fm.files.set('/cloud/Scripting/git/bad\nname','file');e.fm.files.set('/cloud/Scripting/git/link','link')
    for(let i=0;i<205;i++)e.fm.files.set('/cloud/Scripting/git/file-'+i,'file')
    const calls=guarded(e),createdBefore=e.fm.created.length,filesBefore=[...e.fm.files.keys()].sort().join('|');const out=await diagnostics().runDirectoryCheck({kind:'icloud'},['exchange','missing','bad/name'],'')
    assert.match(out,/目标解析=成功（git）/);assert.match(out,/iCloud 已启用=true/);assert.match(out,/git 目录项=\d+（仅显示前 200 项）/);assert.equal(out.split('\n').filter(x=>x.startsWith('- ')).length,200);assert.doesNotMatch(out,/\n- bad\nname|\/cloud|Scripting\/git|token/i)
    assert.match(out,/exchange：exists=true；isDirectory=true；isLink=false；iCloud存储=true；iCloud已下载=false/);assert.match(out,/missing：exists=false/);assert.match(out,/bad\/name：名称无效/)
    assert.equal(calls.some(x=>x.startsWith('WRITE:')),false);assert.equal(e.fm.created.length,createdBefore);assert.equal([...e.fm.files.keys()].sort().join('|'),filesBefore);assert.deepEqual(e.fm.removed,[]);assert.deepEqual(e.fm.renamed,[])
  })
  await test('each API result is independent; thrown errors show type but no path/token; unavailable iCloud APIs are not called; target failure is explicit',async()=>{
    const e=env();global.__workspace=e.workspace;await e.workspace.prepareCloneRoot({kind:'icloud'});const calls=guarded(e)
    const fm=global.FileManager;fm.isDirectory=async()=>{const x=new TypeError('/cloud/Scripting/git/exchange token=abc ghp_secret123456');throw x};fm.isLink=async()=>{throw Error('link failed')}
    let out=await diagnostics().runDirectoryCheck({kind:'icloud'},[], 'exchange');assert.match(out,/isDirectory=抛错 TypeError：/);assert.match(out,/isLink=抛错 Error：link failed/);assert.match(out,/exists=false/);assert.doesNotMatch(out,/\/cloud|ghp_|abc/)
    fm.readDirectory=async()=>{throw Error('permission denied /cloud/Scripting/git')};out=await diagnostics().runDirectoryCheck({kind:'icloud'},[], 'exchange');assert.match(out,/git 目录读取=抛错 Error：permission denied/);assert.match(out,/exchange：/);assert.doesNotMatch(out,/\/cloud/)
    delete fm.isFileStoredIniCloud;delete fm.isiCloudFileDownloaded;calls.length=0;out=await diagnostics().runDirectoryCheck({kind:'icloud'},[], 'exchange');assert.match(out,/存储=不可用，下载=不可用/);assert.match(out,/iCloud存储=接口不可用；iCloud已下载=接口不可用/);assert.ok(!calls.includes('isFileStoredIniCloud'))
    fm.isiCloudEnabled=false;out=await diagnostics().runDirectoryCheck({kind:'icloud'},[], 'exchange');assert.match(out,/iCloud 已启用=false/);assert.match(out,/目标解析=失败：抛错 Error/);assert.doesNotMatch(out,/\/cloud|\/local/)
  })
  await test('page button is in 目标目录 section, user-triggered only, defaults to loaded names/manual override, copyable text, no first-render calls',async()=>{
    const e=env();global.__workspace=e.workspace;await e.workspace.prepareCloneRoot({kind:'icloud'});const calls=guarded(e);const copied=[];global.Pasteboard={setString:async x=>copied.push(x)}
    const {Page}=page(e,{myRepos:[repo('bob','exchange'),repo('bob','other')]});const h=mount(Page,{onCloned(){}});await tick();await tick()
    assert.equal(calls.includes('isFileStoredIniCloud'),false);assert.equal(calls.includes('isiCloudFileDownloaded'),false)
    const section=all(h.tree).find(n=>n.type==='Section'&&JSON.stringify(n.props.header).includes('目标目录'));assert.ok(all(section).some(n=>n.type==='Button'&&n.props.title==='目录检查'))
    await node(h,'Button','目录检查').props.action();assert.match(text(h),/exchange：exists=false/);assert.match(text(h),/other：exists=false/)
    all(h.tree).find(n=>n.type==='FormRow'&&n.props.label==='检查名称').props.onChanged('only-manual');await node(h,'Button','目录检查').props.action();assert.match(text(h),/only-manual：/);assert.doesNotMatch(text(h),/other：/)
    await node(h,'Button','复制检查结果').props.action();assert.match(copied[0],/only-manual/);assert.equal(calls.some(x=>x.startsWith('WRITE:')),false);h.unmount()
  })
  await test('skip reasons: registered, batch duplicate, disk directory/file unregistered, case-only; never overwrite/import/delete; display uses git/<repo> only',async()=>{
    const e=env();await e.workspace.prepareCloneRoot({kind:'icloud'});global.FileManager.isFileStoredIniCloud=undefined
    await e.fm.createDirectory('/cloud/Scripting/git/registered',true);await e.store.registerRepoByPath('/cloud/Scripting/git/registered','registered','https://github.com/bob/registered.git','registered')
    await e.fm.createDirectory('/cloud/Scripting/git/diskdir',true);e.fm.files.set('/cloud/Scripting/git/diskfile','file');await e.fm.createDirectory('/cloud/Scripting/git/CaseOnly',true)
    const results=await e.queue.runCloneQueue(['registered','diskdir','diskfile','CASEONLY','dup','dup'].map(n=>req('bob',n)),{kind:'icloud'},{cancelToken:new progress.RemoteCancelToken()})
    assert.deepEqual(results.map(r=>r.status),['skipped','skipped','skipped','skipped','cloned','skipped'])
    assert.match(results[0].message,/已注册同名仓库/);assert.match(results[1].message,/磁盘上已有同名项，但没有对应的已注册仓库，未覆盖（目录）/);assert.match(results[2].message,/磁盘上已有同名项，但没有对应的已注册仓库，未覆盖（文件）/);assert.match(results[3].message,/仅大小写不同/);assert.match(results[5].message,/已注册同名仓库/)
    const failing=env({clone:async()=>{throw Error('mock failure')}});await failing.workspace.prepareCloneRoot({kind:'icloud'})
    const dup=await failing.queue.runCloneQueue([req('bob','again'),req('bob','again')],{kind:'icloud'},{cancelToken:new progress.RemoteCancelToken()});assert.deepEqual(dup.map(r=>r.status),['failed','skipped']);assert.match(dup[1].message,/本批次重复/)
    assert.deepEqual(results.map(r=>r.displayPath),['git/registered','git/diskdir','git/diskfile','git/CASEONLY','git/dup','git/dup']);assert.ok(results.every(r=>!r.displayPath.includes('/cloud')));assert.ok(e.fm.files.has('/cloud/Scripting/git/diskdir'));assert.deepEqual(e.fm.removed.filter(p=>p.includes('diskdir')||p.includes('diskfile')||p.includes('registered')),[])
    assert.equal(e.clones.length,1)
  })
  await test('clone page result/confirmation hides full system paths; single skip shows visible toast',async()=>{
    const e=env();await e.workspace.prepareCloneRoot({kind:'icloud'});await e.fm.createDirectory('/cloud/Scripting/git/exchange',true)
    const {Page,shown}=page(e,{myRepos:[repo('Wangsc1','exchange')],owned:[repo('Wangsc1','exchange'),repo('Wangsc1','new')]});const h=mount(Page,{onCloned(){}});await tick();await tick()
    await node(h,'Button','Wangsc1/exchange').props.action();for(let i=0;i<20&&!shown.length;i++)await tick();assert.match(shown.at(-1)[0],/已跳过：磁盘上已有同名项，但没有对应的已注册仓库，未覆盖（目录）/);assert.equal(shown.at(-1)[1],'warning');h.render();assert.match(text(h),/跳过 · Wangsc1\/exchange\s*git\/exchange/);assert.doesNotMatch(text(h),/\/cloud|iCloud~|Documents/)
    global.Dialog={confirm:async x=>{global.__confirm=x;return false}};all(h.tree).find(n=>n.type==='FormRow'&&n.props.label==='用户名').props.onChanged('Wangsc1');await new Promise(r=>setTimeout(r,700));await tick();await node(h,'Button','克隆所选仓库').props.action();assert.match(global.__confirm.message,/目标：git\/<repo>/);assert.doesNotMatch(global.__confirm.message,/\/cloud|Documents/);h.unmount()
  })
  await test('my repositories list marks canonical registered origin, reads registry once after load, click does not queue; unmarked item still clones',async()=>{
    const e=env();await e.workspace.prepareCloneRoot({kind:'icloud'});await e.store.registerRepoByPath('/cloud/Scripting/git/exchange','alias','git@github.com:wangsc1/EXCHANGE.git','exchange')
    let reads=0;const base=e.store.listRepos;e.store.listRepos=()=>{reads++;return base()}
    const {Page,shown}=page(e,{myRepos:[repo('Wangsc1','exchange'),repo('Wangsc1','fresh')]});const h=mount(Page,{onCloned(){}});await tick();await tick();h.render();h.render()
    assert.ok(node(h,'Button','Wangsc1/exchange（已克隆）'));assert.ok(node(h,'Button','Wangsc1/fresh'));const readsAfterLoad=reads;h.render();assert.equal(reads,readsAfterLoad)
    await node(h,'Button','Wangsc1/exchange（已克隆）').props.action();assert.equal(e.clones.length,0);assert.match(shown.at(-1)[0],/已克隆/);assert.equal(shown.at(-1)[1],'info')
    await node(h,'Button','Wangsc1/fresh').props.action();for(let i=0;i<30&&e.clones.length<1;i++)await tick();assert.equal(e.clones.length,1);h.unmount()
    const api=load('api/githubApi.ts',{'../services/authStore':{getToken:()=>'mock-token'},'../utils/lru':{setLruEntry(){}}});global.fetch=async()=>({ok:true,status:200,json:async()=>[{name:'hidden',full_name:'a/hidden',owner:{login:'a'},clone_url:'x',disabled:true},{name:'ok',full_name:'a/ok',owner:{login:'a'},clone_url:'y'}]})
    assert.deepEqual((await api.listMyRepos(20)).map(r=>r.fullName),['a/ok'])
  })
  await test('metadata/readme minimal and old decision predicates unchanged',async()=>{
    const meta=JSON.parse(fs.readFileSync(path.join(root,'script.json'),'utf8'));assert.equal(meta.version,'1.4.6');const readme=fs.readFileSync(path.join(root,'README.md'),'utf8');assert.match(readme,/当前版本 \*\*1\.4\.6\*\*/);assert.match(readme,/「目录检查」是只读诊断/);assert.doesNotMatch(readme,/Octicons|primer|THIRD_PARTY/)
    const queue=fs.readFileSync(path.join(root,'services/cloneQueue.ts'),'utf8');assert.match(queue,/key\(name\) === key\(request\.name\)/);assert.match(queue,/FileManager\.exists\(path\)/);assert.doesNotMatch(fs.readFileSync(path.join(root,'services/cloneDiagnostics.ts'),'utf8'),/createDirectory\(|rename\(|remove\(|downloadFileFromiCloud\(|write/)
  })
  console.log(`\n${groups} clone diagnostics groups passed; in-memory FileManager only, no real clone/write.`)
}
main().catch(e=>{console.error(e);process.exitCode=1})
