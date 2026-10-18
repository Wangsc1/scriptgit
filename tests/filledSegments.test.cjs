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
 const reader=Control(control.props);assert.equal(reader.type,'GeometryReader');assert.deepEqual(reader.props.frame,{height:44});assert.equal(reader.props.listRowInsets,0);assert.equal(reader.props.listRowSeparator,'hidden');assert.equal(reader.props.listRowBackground,undefined,'native List card background retained');assert.equal(reader.props.clipShape,undefined,'no outer radius override')
 for(const width of [320,343,768]){
 const row=reader.children[0]({size:{width,height:44}});assert.equal(row.type,'HStack');assert.equal(row.props.spacing,0);assert.deepEqual(row.props.frame,{width,height:44});assert.equal(row.children.length,3)
 for(let i=0;i<3;i++){
  const b=row.children[i],box=b.children[0],shape=box.children.find(n=>n.type==='RoundedRectangle'),label=box.children.find(n=>n.type==='Text')
  assert.equal(b.type,'Button');assert.equal(b.props.buttonStyle,'plain');assert.deepEqual(b.props.frame,{width:width/3,height:44});assert.equal(box.type,'ZStack');assert.deepEqual(box.props.frame,b.props.frame)
  assert.equal(label.props.background,undefined,'do not color intrinsic Text bounds');assert.equal(label.props.frame,undefined);assert.equal(label.props.foregroundStyle,'label')
  if(i===tab){assert.deepEqual(shape.props.frame,{width:width/3,height:44});assert.equal(shape.props.fill,'systemGray4');assert.equal(shape.props.cornerRadius,8)}else assert.equal(shape,undefined)
  const before=transitions.length;b.props.action();assert.equal(transitions.length,before+(i===tab?0:1));if(i!==tab)assert.equal(value,i)
 }
 }
 h.unmount()
}
let changed=0;const disabled=Control({value:'changes',options:[{value:'changes',title:'更改'},{value:'files',title:'文件'}],onChanged:()=>changed++,disabled:true})
for(const button of disabled.children[0]({size:{width:350,height:44}}).children){assert.equal(button.props.disabled,true);button.props.action()};assert.equal(changed,0)
console.log('PASS real RepoDetailContent Section: values/order/selected/click/unchanged branches; fixed-height GeometryReader explicit width/3 at 320/343/768, independent rounded selection shape (not Text background), native card background/clipping retained, disabled guards')
console.log('LIMIT native equal sizing, List hit-testing and light/dark appearance need device verification')
