/* Structure only: native layout/appearance needs device verification. */
const assert=require('node:assert/strict')
const {load,mount,ui,all}=require('./remoteFiles.test.cjs')
const Control=load('components/FilledSegmentedControl.tsx',{scripting:ui,'../constants/colors':{COLOR_ACCENT:'systemBlue'}}).FilledSegmentedControl
const fs=require('node:fs'),path=require('node:path')
const source=fs.readFileSync(path.join(__dirname,'../components/FilledSegmentedControl.tsx'),'utf8')
assert.doesNotMatch(source,/GeometryReader|listRowBackground|modifiers\(/,'no measured geometry / ordered modifiers; row height from documented listRowInsets only')
let value=0;const seen=[]
const options=[{value:0,title:'文件'},{value:1,title:'Stash'},{value:2,title:'状态'}]
for(let sel=0;sel<3;sel++){
 const h=mount(Control,{value:sel,options,onChanged:v=>{value=v;seen.push(v)}})
 const row=h.tree;assert.equal(row.type,'HStack');assert.equal(row.children.length,3);assert.deepEqual(row.props.listRowInsets,{top:8,bottom:8,leading:8,trailing:8},'row 8+36+8=52pt, same as the branch row')
 row.children.forEach((b,i)=>{
  const text=b.children[0]
  assert.equal(b.type,'Button');assert.deepEqual(b.props.frame,{maxWidth:'infinity'});assert.equal(text.type,'Text');assert.deepEqual(text.children,[options[i].title])
  assert.equal(text.props.frame.maxWidth,'infinity');assert.equal(text.props.frame.alignment,'center')
  if(i===sel){assert.deepEqual(text.props.background,{style:{light:'#E2E3E5',dark:'#48484A'},shape:{type:'rect',cornerRadius:18}},'full capsule like the home floating bar');assert.equal(text.props.foregroundStyle,'systemBlue','selected text is accent blue like the home floating bar');assert.equal(text.props.frame.minHeight,36)}
  else{assert.equal(text.props.background,undefined,'only the selected segment has a block');assert.equal(text.props.foregroundStyle,'label')}
  const before=seen.length;b.props.action();assert.equal(seen.length,before+(i===sel?0:1))
 })
 h.unmount()
}
let changed=0;const off=mount(Control,{value:0,options,onChanged:()=>changed++,disabled:true})
off.tree.children.forEach(b=>{assert.equal(b.props.disabled,true);b.props.action()});assert.equal(changed,0)
console.log('PASS segmented control: equal-width buttons, only selected segment has a rounded gray block, no inner track/capsule, no custom row geometry, disabled guard')
console.log('LIMIT native appearance, corner match and vertical centering need device verification')
