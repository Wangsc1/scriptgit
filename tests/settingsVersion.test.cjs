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
assert.ok(rows.every(n=>ts.isJsxElement(n)&&n.openingElement.tagName.getText(ast)==='Section'),'no title-only row/implicit section')
const header=attr(rows[0].openingElement,'header').initializer.expression
assert.equal(header.openingElement.tagName.getText(ast),'VStack','title/version and Token share one section header')
assert.match(header.getText(ast),/GitHub Token/)
assert.equal(attr(header.openingElement,'spacing').initializer.expression.getText(ast),'12','explicit normal title-to-Token gap, not a grouped section gap')
assert.equal(attr(header.openingElement,'alignment').initializer.text,'leading')
const jsx=(type,props,...children)=>({type,props:props||{},children})
const margins=attr(list.openingElement,'contentMargins').initializer.expression.getText(ast)
const snippet=`const HStack='HStack',VStack='VStack',Text='Text',Spacer='Spacer';const COLOR_LABEL='label',COLOR_SECONDARY_LABEL='secondaryLabel';export const margins=${margins};export function title(Script){const scriptVersion=${versionExpression};return (${header.getText(ast)})}`
const output=ts.transpileModule(snippet,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'jsx'}}).outputText
const mod={exports:{}};new Function('module','exports','jsx',output)(mod,mod.exports,jsx)
const metadata=JSON.parse(fs.readFileSync(path.join(root,'script.json'),'utf8'))
for(const version of [metadata.version,'9.8.7-test']){
 const head=mod.exports.title({metadata:{version},version:'HOST-MUST-NOT-BE-SHOWN'}),[row,token]=head.children
 assert.deepEqual(head.props,{alignment:'leading',spacing:12});assert.equal(token.type,'Text');assert.deepEqual(token.children,['GitHub Token']);assert.equal(row.props.alignment,'firstTextBaseline')
 const [title,spacer,label]=row.children
 assert.deepEqual(title.props,{font:'largeTitle',fontWeight:'bold',foregroundStyle:'label',textCase:null});assert.deepEqual(title.children,['设置'])
 assert.equal(spacer.type,'Spacer');assert.deepEqual(label.props,{font:'footnote',foregroundStyle:'secondaryLabel',textCase:null});assert.deepEqual(label.children,['v'+version])
}
assert.deepEqual(mod.exports.margins,{edges:'top',insets:0,placement:'scrollContent'},'clear only auto top content margins; leave sides/bottom and other sections alone')
assert.ok(!attr(list.openingElement,'listSectionSpacing'),'do not change spacing of unrelated sections')
assert.doesNotMatch(source,/padding=\{-|insets:\s*-\d|offset=|listSectionMargins/,'no negative padding/offset or iOS26-only section margin workaround')
// Keep the actual close toolbar and original onAppear hook independent of title metadata.
assert.match(source,/const dismiss = Navigation\.useDismiss\(\)/)
assert.match(source,/<ToolbarItem placement="topBarLeading">\s*<Button action=\{dismiss\}>\s*<Image systemName="xmark" fontWeight="semibold" foregroundStyle=\{COLOR_LABEL\}/)
assert.match(source,/onAppear=\{\(\) => setDiagnosticCount\(getSlowOperations\(\)\.length\)\}/)
console.log('PASS actual Settings title row: current script metadata v'+metadata.version+', alternate metadata updates, large left title / small secondary right version in Token section header, explicit 12-point header spacing/zero top content margin, no implicit title section, close wiring retained')
console.log('LIMIT header layout/spacing constraints verified in source, NOT native pixels; header scroll/pinning and final spacing need device verification')
