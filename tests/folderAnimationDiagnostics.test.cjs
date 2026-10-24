/* Fixed-data phone diagnostic contracts; native animation and system back gesture are NOT emulated. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,mount,ui,all}=require('./remoteFiles.test.cjs')
const root=path.join(__dirname,'..'),file='pages/FolderAnimationDiagnosticsPage.tsx',source=fs.readFileSync(path.join(root,file),'utf8')
assert.deepEqual([...source.matchAll(/from "([^"]+)"/g)].map(m=>m[1]),['scripting'])
assert.doesNotMatch(source.replace(/\/\/.*$/gm, ""),/\b(FileManager|Storage|fetch|gitService|repoStore|transition|withAnimation|navigationBarBackButtonHidden)\b/)
let writes=0
const observed=new Proxy(ui,{get(t,k){if(k!=='useState')return t[k];return initial=>{const [v,set]=t.useState(initial);return [v,next=>{writes++;set(next)}]}}})
const diagnostic=load(file,{scripting:observed})
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
const text=n=>typeof n==='object'&&n!==null?(n.children||[]).map(text).join(' '):String(n)
const tree=h=>{h.render();return expand(h.tree)}
const app=h=>all(tree(h)).find(n=>n.type==='DisclosureGroup'&&(n.props.title==='app'||text(n.props.label)==='app'||text(n.props.label).trim()==='app'))
const count=h=>text(tree(h))
const realSet=global.setTimeout,realClear=global.clearTimeout;let id=0;const timers=new Map()
global.setTimeout=fn=>{const key=++id;timers.set(key,fn);return key}
global.clearTimeout=key=>timers.delete(key)
function flush(){const batch=[...timers.values()];timers.clear();batch.forEach(fn=>fn())}
try{
 const groups=[0,1,2,3].map(mode=>mount(diagnostic.FolderAnimationDiagnosticGroup,{mode}))
 // 1: truly uncontrolled, including nested nodes: no feedback, counters or fake controlled props.
 for(const n of all(tree(groups[0])).filter(n=>n.type==='DisclosureGroup')){assert.equal(n.props.onChanged,undefined);assert.equal(n.props.isExpanded,undefined)}
 assert.match(count(groups[0]),/原生自管/)
 // 2: official fixed app control, nested children remain native-managed.
 writes=0;app(groups[1]).props.onChanged(true);assert.equal(writes,1);assert.equal(timers.size,0)
 assert.equal(app(groups[1]).props.isExpanded,true);assert.match(count(groups[1]),/app 展开：1 次/)
 assert.equal(all(tree(groups[1])).find(n=>n.type==='DisclosureGroup'&&n.props.title==='admin').props.onChanged,undefined)
 // 3: component/key structure and controlled nested intent survive parent collapse.
 const raw=()=>{groups[2].render();return all(groups[2].tree).filter(n=>n.props.node)}
 assert.deepEqual(raw().map(n=>n.props.key),['app','docs'])
 const before=all(tree(groups[2])).filter(n=>n.type==='DisclosureGroup').length
 app(groups[2]).props.onChanged(true)
 let admin=all(tree(groups[2])).find(n=>n.type==='DisclosureGroup'&&text(n.props.label).trim()==='admin');admin.props.onChanged(true)
 app(groups[2]).props.onChanged(false)
 assert.equal(all(tree(groups[2])).filter(n=>n.type==='DisclosureGroup').length,before)
 assert.equal(all(tree(groups[2])).find(n=>n.type==='DisclosureGroup'&&text(n.props.label).trim()==='admin').props.isExpanded,true)
 assert.equal(timers.size,0);assert.match(count(groups[2]),/app 展开：1 次/)
 // 4: exactly one synchronous update plus one async EMPTY Map update per toggle.
 writes=0;app(groups[3]).props.onChanged(true);assert.equal(writes,1);assert.equal(timers.size,1)
 assert.match(count(groups[3]),/额外更新：\s*0\s*次/);flush();assert.equal(writes,2)
 assert.match(count(groups[3]),/额外更新：\s*1\s*次/)
 assert.equal(groups[3].slots[0].extra.size,0)
 // Independent groups do not touch parent selection or each other's expansion/counters.
 assert.equal(app(groups[2]).props.isExpanded,false);assert.equal(app(groups[1]).props.isExpanded,true)
 assert.match(count(groups[1]),/额外更新：\s*0\s*次/)
 app(groups[3]).props.onChanged(false);assert.equal(timers.size,1)
 const queued=[...timers.values()];groups[3].unmount();assert.equal(timers.size,0)
 queued.forEach(fn=>fn());assert.equal(groups[3].lateWrites,0)
 groups.slice(0,3).forEach(h=>h.unmount())
 const page=mount(diagnostic.FolderAnimationDiagnosticsPage,{})
 assert.equal(page.tree.type,'List');assert.equal(page.tree.props.navigationTitle,'文件夹动画诊断')
 assert.equal(page.tree.props.toolbar,undefined);assert.equal(page.tree.props.navigationBarBackButtonHidden,undefined)
 const selected=()=>{page.render();return all(page.tree).find(n=>n.type===diagnostic.FolderAnimationDiagnosticGroup)}
 assert.equal(selected().props.key,0)
 const buttons=()=>all(page.tree).filter(n=>n.type==='Button')
 assert.equal(buttons().length,4);buttons()[3].props.action();assert.equal(selected().props.mode,3);assert.equal(selected().props.key,3)
 buttons()[1].props.action();assert.equal(selected().props.key,1)
 const fresh=mount(diagnostic.FolderAnimationDiagnosticGroup,{mode:1});assert.equal(app(fresh).props.isExpanded,false);assert.match(count(fresh),/app 展开：0 次/);fresh.unmount();page.unmount()
}finally{global.setTimeout=realSet;global.clearTimeout=realClear}
// Actual detail menu -> actual nav hook -> destination. Repository operations are spies, never run.
const pageSource=fs.readFileSync(path.join(root,'pages/RepoDetailPage.tsx'),'utf8'),mocks={scripting:ui},noop=()=>{}
for(const [,names,module] of pageSource.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
 if(module==='scripting')continue;mocks[module]={};for(const token of names.split(',')){const name=token.trim();if(name)mocks[module][name]=name}
}
let loads=0,mergeReads=0
const data={githubFullName:null,displayName:'test',changes:[],branchInfo:{current:'main'},tab:0,mergeInProgress:false,loadAll:()=>loads++,loadMergeState:()=>mergeReads++}
const hook=(module,name,value)=>mocks[module]={[name]:()=>value}
hook('../hooks/useToast','useToast',{showToast:noop})
hook('../hooks/useRepoDetailData','useRepoDetailData',data)
hook('../hooks/useOpBusy','useOpBusy',{})
mocks['../hooks/useRepoDetailNavigation']=load('hooks/useRepoDetailNavigation.ts',{scripting:ui})
hook('../hooks/useRepoWorktreeActions','useRepoWorktreeActions',{commitSheetMode:null})
hook('../hooks/useRepoPendingActions','useRepoPendingActions',{clearPending:noop})
hook('../hooks/useRepoBranchActions','useRepoBranchActions',{})
hook('../hooks/useRepoSyncActions','useRepoSyncActions',{})
hook('../hooks/useLocalEntryCreation','useLocalEntryCreation',{busy:false,open:noop})
mocks['../utils/format']={suggestCommitTitle:()=>'',shortOid:noop}
const Page=load('pages/RepoDetailPage.tsx',mocks).RepoDetailPage,h=mount(Page,{bookmarkName:'unused',name:'test'})
const menu=()=>{h.render();return all(h.tree.props.toolbar.topBarTrailing)}
assert.deepEqual(menu().filter(n=>n.type==='Button').map(n=>n.props.title),['文件夹动画诊断'])
menu().find(n=>n.type==='Button').props.action();h.render()
assert.equal(h.tree.props.navigationDestination.isPresented,true)
const destination=all(h.tree.props.navigationDestination.content).find(n=>n.type==='RepoDetailDestination')
assert.equal(destination.props.showAnimationDiagnostics,true)
const destinationSource=fs.readFileSync(path.join(root,'components/RepoDetailDestination.tsx'),'utf8'),destMocks={scripting:ui}
for(const [,names,module] of destinationSource.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)){
 if(module==='scripting')continue;destMocks[module]={};for(const token of names.split(',')){const name=token.trim();if(name)destMocks[module][name]=name}
}
destMocks['../pages/FolderAnimationDiagnosticsPage']=diagnostic
const Dest=load('components/RepoDetailDestination.tsx',destMocks).RepoDetailDestination
assert.equal(Dest(destination.props).type,diagnostic.FolderAnimationDiagnosticsPage)
h.tree.props.navigationDestination.onChanged(false);h.render();assert.equal(h.tree.props.navigationDestination.isPresented,false)
h.tree.props.onAppear();assert.equal(loads,0);assert.equal(mergeReads,0)
data.githubFullName='owner/repo';assert.deepEqual(menu().filter(n=>n.type==='Button').map(n=>n.props.title),['文件夹动画诊断','Edit Remote Files','Issues','Pull Requests','Actions'])
h.unmount()
console.log('PASS four fixed-data isolated diagnostic groups, native uncontrolled, keyed recursive structure, exact extra empty Map update, timer cleanup, reset, real detail menu/navigation/native back contract; no device frames asserted')
