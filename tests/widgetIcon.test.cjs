/* Widget brand icon: packaged transparent GitHub mark, black, no square background; falls back to the old symbol. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,ui,all}=require('./remoteFiles.test.cjs')
const root=path.join(__dirname,'..')
let iconExists=true
global.FileManager={existsSync:p=>{assert.equal(p,'/scripts/scriptgit/icon-white.png');return iconExists}}
const scripting=new Proxy(ui,{get:(t,k)=>k==='Path'?{join:(...a)=>a.join('/')}:k==='Script'?{directory:'/scripts/scriptgit'}:k==='Widget'?{family:'systemSmall',parameter:'',present(){},}:k==='AccessoryWidgetBackground'?'AccessoryWidgetBackground':t[k]})
const mod=load('widget.tsx',{scripting,'./constants/colors':load('constants/colors.ts'),'./services/repoStore':{readSnapshots:async()=>({})},'./utils/widget':{buildWidgetSummary:()=>({}),formatWidgetUpdatedAt:()=>''}})
const source=fs.readFileSync(path.join(root,'widget.tsx'),'utf8')
// the three places that used the old curve-path symbol now use the packaged brand icon
assert.equal((source.match(/point\.topleft\.down\.to\.point\.bottomright\.curvepath/g)||[]).length,1,'old symbol only remains as the fallback')
assert.equal((source.match(/<BrandIcon /g)||[]).length,3)
// pure render of the icon element
const BrandIcon=Object.values(mod).find(v=>typeof v==='function'&&v.name==='BrandIcon')||null
assert.ok(BrandIcon||/function BrandIcon/.test(source))
const icon=(props)=>{ // evaluate the component source directly when not exported
  const m=source.match(/function BrandIcon[\s\S]*?\n}\n/)[0]
  const ts=require('typescript');const js=ts.transpileModule(m+'\nmodule.exports=BrandIcon',{compilerOptions:{jsx:ts.JsxEmit.React,jsxFactory:'__jsx',module:ts.ModuleKind.CommonJS}}).outputText
  const mm={exports:{}};new Function('module','exports','__jsx','Image','COLOR_ACCENT','BRAND_ICON_PATH','FileManager',js)(mm,mm.exports,global.__jsx,ui.Image||'Image','systemBlue','/scripts/scriptgit/icon-white.png',global.FileManager)
  return mm.exports(props)
}
iconExists=true
let node=icon({size:18});assert.equal(node.type,'Image')
assert.equal(node.props.filePath,'/scripts/scriptgit/icon-white.png');assert.equal(node.props.foregroundStyle,'black');assert.equal(node.props.renderingMode,'template')
assert.deepEqual(node.props.frame,{width:18,height:18});assert.equal(node.props.background,undefined);assert.equal(node.props.clipShape,undefined);assert.equal(node.props.cornerRadius,undefined)
assert.equal(node.props.widgetAccentedRenderingMode,'fullColor')
node=icon({size:12,tinted:true});assert.equal(node.props.widgetAccentedRenderingMode,'accented');assert.equal(node.props.foregroundStyle,'black')
iconExists=false
node=icon({size:18});assert.equal(node.props.systemName,'point.topleft.down.to.point.bottomright.curvepath');assert.equal(node.props.filePath,undefined)
// the packaged file is a transparent-background mark, not a square tile
const {execFileSync}=require('node:child_process')
const info=execFileSync('python3',['-c',"from PIL import Image;im=Image.open(r'"+path.join(root,'icon-white.png')+"').convert('RGBA');print(im.getpixel((0,0))[3],im.getpixel((im.width//2,im.height//2))[3])"]).toString().trim()
assert.equal(info,'0 0','icon corner and centre are transparent: no square background')
console.log('PASS widget brand icon: transparent GitHub mark, black, no square background in header/circular/rectangular; fallback keeps old symbol')
