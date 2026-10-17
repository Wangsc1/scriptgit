/* Targeted 1.2.2 UI-only regression; no full clone/editor suite required. */
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const ts=require('typescript')
const {load,mount,node,text,all,ui,tick}=require('./remoteFiles.test.cjs')
const {env,repo}=require('./cloneQueue.test.cjs')
const progress=load('utils/remoteProgress.ts')
async function main(){
  const e=env()
  const page=load('pages/ClonePage.tsx',{
    scripting:ui,'../components/AvatarView':{AvatarView:'AvatarView'},'../hooks/useGitHubUserSearch':{useGitHubUserSearch:()=>({candidates:[],total:null,changeQuery(){},selectUser(){}})},
    '../components/FormRow':{FormRow:'FormRow'},'../components/BusyOverlay':{BusyOverlay:'BusyOverlay'},'../components/Toast':{toastContent:()=>null},'../hooks/useToast':{useToast:()=>({showToast(){}})},
    '../utils/clonedGithubRepos':load('utils/clonedGithubRepos.ts',{'./github':load('utils/github.ts')}),'../services/repoStore':{listRepos:e.store.listRepos,pickDirectory:async()=>({path:'/external',accessBookmarkName:null})},'../services/gitService':{RemoteCancelToken:progress.RemoteCancelToken},'../services/cloneWorkspace':e.workspace,'../services/cloneQueue':e.queue,
    '../services/authStore':{hasToken:()=>false},'../services/notifyService':{},'../api/githubApi':{listOwnedRepos:async()=>[repo('bob','one')]},'../utils/format':{},'../utils/remoteProgress':{yieldForUi:async()=>{}},
  }).ClonePage
  const h=mount(page,{onCloned(){}})
  await tick()
  const sections=all(h.tree).filter(n=>n.type==='Section')
  for(const title of ['目标目录','按 GitHub 用户名批量添加']){
    const section=sections.find(n=>n.props.header.children.includes(title))
    assert.ok(section);assert.equal(Object.hasOwn(section.props,'footer'),false)
  }
  assert.ok(!text(h).includes('搜索Github用户名'))
  assert.ok(!text(h).includes('每个仓库保存到'))
  assert.ok(!text(h).includes('无 Token 时加载该用户全部公开仓库'))
  const buttons=all(h.tree).filter(n=>n.type==='Button').map(n=>n.props.title)
  assert.ok(buttons.indexOf('默认目录iCloud/Scripting/git')<buttons.indexOf('更改目录'))
  assert.ok(!text(h).includes('/cloud/Scripting/git'))
  assert.ok(!buttons.includes('使用默认 iCloud/Scripting/git / 重试'))
  await node(h,'Button','更改目录').props.action()
  assert.ok(e.fm.files.has('/external/git'));assert.ok(!text(h).includes('/external/git'))
  e.fm.isiCloudEnabled=false
  await node(h,'Button','默认目录iCloud/Scripting/git').props.action()
  assert.match(text(h),/iCloud 未启用/)
  e.fm.isiCloudEnabled=true
  await node(h,'Button','默认目录iCloud/Scripting/git').props.action()
  assert.ok(!text(h).includes('iCloud 未启用'));assert.ok(e.fm.files.has('/cloud/Scripting/git'))
  h.render()
  all(h.tree).find(n=>n.type==='FormRow'&&n.props.label==='用户名').props.onChanged('bob')
  await new Promise(resolve=>setTimeout(resolve,700));await tick()
  let confirmation
  global.Dialog={confirm:async input=>{confirmation=input;return false}}
  await node(h,'Button','克隆所选仓库').props.action()
  assert.match(confirmation.message,/目标：\/cloud\/Scripting\/git\/<repo>/)
  assert.equal(e.clones.length,0)
  h.unmount()
  const root=path.join(__dirname,'..')
  const source=ts.createSourceFile('ClonePage.tsx',fs.readFileSync(path.join(root,'pages/ClonePage.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  assert.equal(source.parseDiagnostics.length,0)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'script.json'),'utf8')).version,'1.3.1')
  assert.match(fs.readFileSync(path.join(root,'README.md'),'utf8'),/当前版本 \*\*1\.3\.1\*\*/)
  console.log('PASS directory row hidden; exact button label/order; external/default/retry behavior; batch directory confirmation retained; both specified footers absent; search caption absent; ClonePage TSX syntax; 1.3.1 versions.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
