/* Local clone default, external selection and directory labels; no user repo access. */
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const ts=require('typescript')
const {load,mount,node,text,all,ui,tick}=require('./remoteFiles.test.cjs')
const {env,repo}=require('./cloneQueue.test.cjs')
const progress=load('utils/remoteProgress.ts')
async function main(){
  const e=env();e.fm.isiCloudEnabled=false;e.fm.setUnavailable(true)
  const page=load('pages/ClonePage.tsx',{'../utils/displayPaths':load('utils/displayPaths.ts'),'../services/cloneDiagnostics':{runDirectoryCheck:async()=>''},
    scripting:ui,'../components/AvatarView':{AvatarView:'AvatarView'},'../hooks/useGitHubUserSearch':{useGitHubUserSearch:()=>({candidates:[],total:null,changeQuery(){},selectUser(){}})},
    '../components/FormRow':{FormRow:'FormRow'},'../components/BusyOverlay':{BusyOverlay:'BusyOverlay'},'../components/Toast':{toastContent:()=>null},'../hooks/useToast':{useToast:()=>({showToast(){}})},
    '../utils/clonedGithubRepos':load('utils/clonedGithubRepos.ts',{'./github':load('utils/github.ts')}),'../services/repoStore':{listRepos:e.store.listRepos,pickDirectory:async()=>({path:'/external',accessBookmarkName:null})},'../services/gitService':{RemoteCancelToken:progress.RemoteCancelToken},'../services/cloneWorkspace':e.workspace,'../services/cloneQueue':e.queue,
    '../services/authStore':{hasToken:()=>false},'../services/notifyService':{},'../api/githubApi':{listOwnedRepos:async()=>[repo('bob','one')]},'../utils/format':{},'../utils/remoteProgress':{yieldForUi:async()=>{}},
  }).ClonePage
  const h=mount(page,{onCloned(){}})
  await tick()
  const sections=all(h.tree).filter(n=>n.type==='Section')
  for(const title of ['目标目录','按 GitHub 用户名添加']){
    const section=sections.find(n=>n.props.header.children.includes(title))
    assert.ok(section);if(title!=='目标目录')assert.equal(Object.hasOwn(section.props,'footer'),false)
  }
  assert.ok(!text(h).includes('搜索Github用户名'))
  assert.ok(!text(h).includes('每个仓库保存到'))
  assert.ok(!text(h).includes('无 Token 时加载该用户全部公开仓库'))
  const buttons=all(h.tree).filter(n=>n.type==='Button').map(n=>n.props.title)
  assert.ok(buttons.indexOf('使用默认本地目录')<buttons.indexOf('更改目录'))
  assert.ok(!text(h).includes('/cloud/Scripting/git'))
  assert.ok(!buttons.includes('使用默认 iCloud/Scripting/git / 重试'))
  await node(h,'Button','更改目录').props.action()
  assert.ok(e.fm.files.has('/external/git'));assert.ok(!text(h).includes('/external/git'))
  e.fm.isiCloudEnabled=false
  await node(h,'Button','使用默认本地目录').props.action()
  assert.ok(!text(h).includes('iCloud 未启用'));assert.ok(e.fm.files.has('/local/git'));assert.ok(text(h).includes('在我的 iPhone / Scripting / git'))
  e.fm.isiCloudEnabled=true
  await node(h,'Button','使用默认本地目录').props.action()
  assert.ok(!text(h).includes('iCloud 未启用'));assert.ok(!e.fm.files.has('/cloud/Scripting/git'))
  h.render()
  all(h.tree).find(n=>n.type==='FormRow'&&n.props.label==='用户名').props.onChanged('bob')
  await new Promise(resolve=>setTimeout(resolve,700));await tick()
  let confirmation
  global.Dialog={confirm:async input=>{confirmation=input;return false}}
  await node(h,'Button','克隆所选仓库').props.action()
  assert.match(confirmation.message,/目标：git\/<repo>/);assert.doesNotMatch(confirmation.message,/\/cloud/)
  assert.equal(e.clones.length,0)
  h.unmount()
  const root=path.join(__dirname,'..')
  const source=ts.createSourceFile('ClonePage.tsx',fs.readFileSync(path.join(root,'pages/ClonePage.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  assert.equal(source.parseDiagnostics.length,0)
  console.log('PASS local default with iCloud disabled/offline; visible Chinese directory label; external/default switching; batch confirmation and TSX syntax.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
