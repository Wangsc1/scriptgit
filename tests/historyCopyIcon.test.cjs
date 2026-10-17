const assert=require('node:assert/strict')
const {load,mount,ui,all}=require('./remoteFiles.test.cjs')
global.Data={fromString:s=>String(s)};global.Crypto={md5:s=>({toHexString:()=>'0'.repeat(32)})}
const colors=load('constants/colors.ts'),format=load('utils/format.ts'),github=load('utils/github.ts')
const selected=[]
const Tab=load('pages/HistoryTab.tsx',{
 scripting:ui,'../constants/colors':colors,'../utils/format':format,'../utils/github':github,
 '../api/githubApi':{getCommitAvatarUrls:async()=>({}),getCommitCheckStates:async()=>({})},
 '../components/AvatarView':{AvatarView:'AvatarView'},'../components/HistorySearchBar':{HistorySearchBar:'HistorySearchBar'},
 '../components/CommitCheckBadge':{CommitCheckBadge:'CommitCheckBadge'}
}).HistoryTab
const log=['a','b','c'].map((x,i)=>({oid:x.repeat(40),message:'subject '+x,date:Date.now()-i*1000,author:{name:'A',email:'a@example.invalid'},isHead:i===0,syncStatus:'pushed'}))
const h=mount(Tab,{log,loading:false,mergeInProgress:false,onCopy(){throw Error('copy must not be reachable from the removed icon')},onSelect:e=>selected.push(e.oid),onRevert(){},onSoftReset(){},onAmend(){},onSearch(){},onLoadMore(){},hasMore:false,searchBusy:false,totalMatches:null,limited:false,githubFullName:null})
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
h.render();const tree=expand(h.tree)
assert.equal(all(tree).filter(n=>n.type==='Image'&&n.props.systemName==='doc.on.doc').length,0)
const detailButtons=all(tree).filter(n=>n.type==='Button'&&all(n).some(x=>x.type==='AvatarView'))
assert.equal(detailButtons.length,3)
detailButtons[0].props.action();detailButtons[1].props.action()
assert.deepEqual(selected,[log[0].oid,log[1].oid])
console.log('PASS history rows have no copy icon; commit detail buttons and swipe rows remain available')
