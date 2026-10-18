/* Real two caller components and filled row wiring; not native layout proof. */
const assert=require('node:assert/strict')
const {load,mount,ui,all}=require('./remoteFiles.test.cjs')
const Control=load('components/FilledSegmentedControl.tsx',{scripting:ui}).FilledSegmentedControl
const Content=load('components/RepoDetailContent.tsx',{scripting:ui,'./FilledSegmentedControl':{FilledSegmentedControl:Control},'../constants/colors':{},'../pages/FilesTab':{FilesTab:'FilesTab'},'../pages/HistoryTab':{HistoryTab:'HistoryTab'},'../pages/StashTab':{StashTab:'StashTab'}}).RepoDetailTabContent
let value=0;const transitions=[]
for(const [tab,branch]of [[0,'FilesTab'],[1,'StashTab'],[2,'HistoryTab']]){
 const h=mount(Content,{tab,onTabChange:v=>{value=v;transitions.push(v)},trackedFiles:['file'],changes:[]})
 const first=h.tree.children[0];assert.equal(first.type,'Section');assert.equal(first.children.length,1)
 const control=first.children[0];assert.equal(control.type,Control);assert.equal(control.props.value,tab)
 assert.deepEqual(control.props.options,[{value:0,title:'文件'},{value:1,title:'Stash'},{value:2,title:'状态'}])
 assert.ok(all(h.tree).some(n=>n.type===branch),'unchanged conditional tab branch')
 const row=Control(control.props);assert.equal(row.type,'HStack');assert.equal(row.props.spacing,0);assert.equal(row.props.listRowInsets,0);assert.equal(row.props.listRowSeparator,'hidden');assert.equal(row.props.listRowBackground.props.fill,'clear');assert.deepEqual(row.props.clipShape,{type:'rect',cornerRadius:10})
 assert.equal(row.children.length,3)
 for(let i=0;i<3;i++){
  const b=row.children[i],label=b.children[0]
  assert.equal(b.type,'Button');assert.equal(b.props.buttonStyle,'plain');assert.equal(b.props.frame.maxWidth,Infinity)
  assert.deepEqual(label.props.frame,{maxWidth:Infinity,height:44});assert.equal(label.props.foregroundStyle,'label');assert.equal(label.props.background,i===tab?'systemGray4':'secondarySystemGroupedBackground');assert.equal(label.props.clipShape,undefined,'no nested capsule')
  const before=transitions.length;b.props.action();assert.equal(transitions.length,before+(i===tab?0:1));if(i!==tab)assert.equal(value,i)
 }
 h.unmount()
}
let changed=0;const disabled=Control({value:'changes',options:[{value:'changes',title:'更改'},{value:'files',title:'文件'}],onChanged:()=>changed++,disabled:true})
for(const button of disabled.children){assert.equal(button.props.disabled,true);button.props.action()};assert.equal(changed,0)
console.log('PASS real RepoDetailContent Section: values/order/selected/click/unchanged branches; single equal-width filled row, semantic gray/label, zero row inset/no inner capsules, disabled guards')
console.log('LIMIT native equal sizing, List hit-testing and light/dark appearance need device verification')
