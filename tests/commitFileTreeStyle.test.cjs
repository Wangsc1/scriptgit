const assert=require('node:assert/strict'),fs=require('node:fs')
const {load,ui,all}=require('./remoteFiles.test.cjs')
const colors=load('constants/colors.ts')
const {CommitFileTreeNode:Tree}=load('components/CommitFileTree.tsx',{scripting:ui,'../constants/colors':colors,'../pages/CommitDiffPage':{CommitDiffPage:'CommitDiffPage'}})
const base={bookmarkName:'repo',oid:'new',parentOid:'old',statusByPath:new Map([['a.txt','modified'],['b.txt','added'],['c.txt','deleted']])}
const file=name=>({type:'file',name,path:name})
for(const commitDetailStyle of [true,false]){
 const folder=Tree({...base,commitDetailStyle,node:{type:'directory',name:'src',path:'src',children:[file('a.txt')]}})
 assert.equal(all(folder.props.label).find(n=>n.type==='Image').props.foregroundStyle,commitDetailStyle?colors.COLOR_SECONDARY_LABEL:colors.COLOR_ACCENT)
 assert.equal(all(folder).find(n=>n.type===Tree).props.commitDetailStyle,commitDetailStyle)
 for(const [name,label] of [['a.txt','M'],['b.txt','A'],['c.txt','D']]){
  const row=Tree({...base,commitDetailStyle,node:file(name)})
  const badges=all(row).filter(n=>n.type==='Text'&&n.props.font==='headline')
  assert.equal(badges.length,commitDetailStyle?0:1)
  if(badges.length)assert.ok(JSON.stringify(badges[0].children).includes(label))
  assert.equal(row.props.destination.props.filepath,name)
  assert.equal(row.props.destination.props.oid,'new');assert.equal(row.props.destination.props.parentOid,'old')
 }
}
assert.equal(all(Tree({...base,node:file('a.txt')})).filter(n=>n.type==='Text'&&n.props.font==='headline').length,1)
assert.match(fs.readFileSync(__dirname+'/../pages/CommitDetailPage.tsx','utf8'),/statusByPath=\{statusByPath\}\s+commitDetailStyle/)
for(const name of ['a.txt','pic.JPG','nested/a.webp','icon.ico','unsupported.svg']){
 const row=Tree({...base,commitDetailStyle:true,node:file(name)})
 const icon=all(row).find(n=>n.type==='Image')
 assert.equal(icon.props.systemName,/\.(jpg|webp|ico)$/i.test(name)?'photo':'doc.text')
 assert.equal(icon.props.foregroundStyle,colors.COLOR_SECONDARY_LABEL)
 assert.equal(all(row).filter(n=>n.type==='Text'&&n.props.font==='headline').length,0)
}
console.log('PASS commit detail uses gray photo/doc.text/folder icons and no A/M/D; diff destinations and comparison defaults unchanged')
