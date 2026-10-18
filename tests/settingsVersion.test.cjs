/* Source-bound test of the actual settings title row and runtime metadata
 * expression. Native font sizing/scrolling is not simulated. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript')
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'pages/SettingsPage.tsx'),'utf8')
const ast=ts.createSourceFile('SettingsPage.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const attr=(node,name)=>node.attributes.properties.find(p=>ts.isJsxAttribute(p)&&p.name.text===name)
function walk(node,visit){visit(node);ts.forEachChild(node,n=>walk(n,visit))}
let list,versionExpression
walk(ast,n=>{
 if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='scriptVersion')versionExpression=n.initializer.getText(ast)
 if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(ast)==='List')list=n
})
assert.equal(versionExpression,'Script.metadata.version','must be current script metadata, not host Device/App version or a literal')
assert.equal(attr(list.openingElement,'navigationTitle').initializer.text,'','no duplicate native large title')
assert.equal(attr(list.openingElement,'navigationBarTitleDisplayMode').initializer.text,'inline')
const rows=list.children.filter(n=>ts.isJsxElement(n)||ts.isJsxSelfClosingElement(n))
assert.equal(rows[0].openingElement.tagName.getText(ast),'HStack','title is first scrollable row, not a top toolbar item')
assert.equal(rows[1].openingElement.tagName.getText(ast),'Section','original form section follows title row')
assert.match(rows[1].openingElement.getText(ast),/GitHub Token/)
const jsx=(type,props,...children)=>({type,props:props||{},children})
const snippet=`const HStack='HStack',Text='Text',Spacer='Spacer',Rectangle='Rectangle';const COLOR_LABEL='label',COLOR_SECONDARY_LABEL='secondaryLabel';export function title(Script){const scriptVersion=${versionExpression};return (${rows[0].getText(ast)})}`
const output=ts.transpileModule(snippet,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'jsx'}}).outputText
const mod={exports:{}};new Function('module','exports','jsx',output)(mod,mod.exports,jsx)
const metadata=JSON.parse(fs.readFileSync(path.join(root,'script.json'),'utf8'))
for(const version of [metadata.version,'9.8.7-test']){
 const row=mod.exports.title({metadata:{version},version:'HOST-MUST-NOT-BE-SHOWN'})
 assert.equal(row.props.alignment,'firstTextBaseline');assert.equal(row.props.listRowSeparator,'hidden');assert.deepEqual(row.props.listRowBackground,{type:'Rectangle',props:{fill:'clear'},children:[]})
 const [title,spacer,label]=row.children
 assert.deepEqual(title.props,{font:'largeTitle',fontWeight:'bold',foregroundStyle:'label'});assert.deepEqual(title.children,['设置'])
 assert.equal(spacer.type,'Spacer');assert.deepEqual(label.props,{font:'footnote',foregroundStyle:'secondaryLabel'});assert.deepEqual(label.children,['v'+version])
}
// Keep the actual close toolbar and original onAppear hook independent of title metadata.
assert.match(source,/const dismiss = Navigation\.useDismiss\(\)/)
assert.match(source,/<ToolbarItem placement="topBarLeading">\s*<Button action=\{dismiss\}>\s*<Image systemName="xmark" fontWeight="semibold" foregroundStyle=\{COLOR_LABEL\}/)
assert.match(source,/onAppear=\{\(\) => setDiagnosticCount\(getSlowOperations\(\)\.length\)\}/)
console.log('PASS actual Settings title row: current script metadata v'+metadata.version+', alternate metadata updates, large left title / small secondary right version below toolbar, existing sections and close wiring retained')
console.log('LIMIT custom title scrolls with the List (no native large-title collapsing); native layout needs device verification')
