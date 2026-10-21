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
const h=mount(Tab,{log,total:120,loading:false,mergeInProgress:false,onCopy(){throw Error('copy must not be reachable from the removed icon')},onSelect:e=>selected.push(e.oid),onRevert(){},onSoftReset(){},onAmend(){},onSearch(){},onLoadMore(){},hasMore:false,searchBusy:false,totalMatches:null,limited:false,githubFullName:null})
function expand(n){if(!n||typeof n!=='object')return n;if(Array.isArray(n))return n.map(expand);if(typeof n.type==='function')return expand(n.type(n.props));return {...n,children:(n.children||[]).map(expand)}}
h.render();assert.equal(h.tree.props.header.props.title,'提交历史（120）');const tree=expand(h.tree)
assert.equal(all(tree).filter(n=>n.type==='Image'&&n.props.systemName==='doc.on.doc').length,0)
const detailButtons=all(tree).filter(n=>n.type==='Button'&&all(n).some(x=>x.type==='AvatarView'))
assert.equal(detailButtons.length,3)
detailButtons[0].props.action();detailButtons[1].props.action()
assert.deepEqual(selected,[log[0].oid,log[1].oid])
h.unmount();
const base={log:[],loading:false,mergeInProgress:false,onSearch(){},onLoadMore(){},hasMore:false,searchBusy:false,totalMatches:null,limited:false,githubFullName:null};
const countHost=mount(Tab,base);countHost.render();assert.equal(countHost.tree.props.header.props.title,'提交历史');
base.log=log.slice(0,1);base.total=120;base.hasMore=true;countHost.render();assert.equal(countHost.tree.props.header.props.title,'提交历史（120）');
base.log=log;countHost.render();assert.equal(countHost.tree.props.header.props.title,'提交历史（120）');
base.log=log.slice(0,2);base.totalMatches=8;countHost.render();assert.equal(countHost.tree.props.header.props.title,'提交历史（120）');base.total=null;countHost.render();assert.equal(countHost.tree.props.header.props.title,'提交历史');base.total=0;countHost.render();assert.equal(countHost.tree.props.header.props.title,'提交历史（0）');countHost.unmount();
console.log('PASS history title uses separate full total, independent of pagination/search, unknown is unnumbered and empty is zero; detail actions unchanged')
