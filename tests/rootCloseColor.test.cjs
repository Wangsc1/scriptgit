/* Source-bound toolbar wiring test. Native semantic color resolution/contrast
 * is provided by iOS; this does not simulate dark/light UIKit rendering. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript')
const root=path.resolve(__dirname,'..')
const options={target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'jsx'}
function compile(source){const mod={exports:{}};new Function('module','exports','jsx',ts.transpileModule(source,{compilerOptions:options}).outputText)(mod,mod.exports,(type,props,...children)=>({type,props:props||{},children}));return mod.exports}
const colors=compile(fs.readFileSync(path.join(root,'constants/colors.ts'),'utf8'))
assert.equal(colors.COLOR_LABEL,'label','official native adaptive label keyword, not static white/black')
function walk(node,visit){visit(node);ts.forEachChild(node,n=>walk(n,visit))}
function prop(node,name){return node.attributes.properties.find(p=>ts.isJsxAttribute(p)&&p.name.text===name)}
for(const page of ['RepoListPage','SettingsPage']){
 const source=fs.readFileSync(path.join(root,'pages/'+page+'.tsx'),'utf8'),ast=ts.createSourceFile(page+'.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 assert.ok(ast.statements.some(n=>ts.isImportDeclaration(n)&&n.moduleSpecifier.text==='../constants/colors'&&n.importClause?.namedBindings?.elements?.some(e=>e.name.text==='COLOR_LABEL')))
 let toolbar,closeCount=0
 walk(ast,node=>{
  if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='dismiss')assert.equal(node.initializer.getText(ast),'Navigation.useDismiss()','keep root modal dismiss hook')
  if(ts.isJsxAttribute(node)&&node.name.text==='toolbar')toolbar=node.initializer.expression
  if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(ast)==='Image'&&prop(node,'systemName')?.initializer?.text==='xmark'){
   closeCount++;assert.equal(prop(node,'foregroundStyle').initializer.expression.getText(ast),'COLOR_LABEL');assert.equal(prop(node,'fontWeight').initializer.text,'semibold')
  }
 })
 assert.equal(closeCount,1);assert.ok(toolbar)
 // Evaluate the actual source toolbar subtree, retaining Button action identity.
 const render=compile(`const COLOR_LABEL=${JSON.stringify(colors.COLOR_LABEL)};const Toolbar='Toolbar',ToolbarItem='ToolbarItem',Button='Button',Image='Image',Menu='Menu';export function render(dismiss){const handleAddLocal=()=>{},setShowClone=()=>{};return (${toolbar.getText(ast)})}`).render
 let calls=0;const dismiss=()=>{calls++},tree=render(dismiss)
 const leading=tree.children.find(n=>n.type==='ToolbarItem'&&n.props.placement==='topBarLeading')
 assert.ok(leading);const button=leading.children[0],icon=button.children[0]
 assert.equal(button.type,'Button');assert.equal(button.props.action,dismiss);assert.equal(button.props.tint,undefined,'do not recolor other toolbar buttons or inherited tint')
 assert.deepEqual(icon.props,{systemName:'xmark',fontWeight:'semibold',foregroundStyle:'label'});button.props.action();assert.equal(calls,1)
 console.log('PASS '+page+': actual leading toolbar xmark uses native label; icon/weight/placement and dismiss action unchanged')
}
console.log('LIMIT native light/dark label contrast and toolbar presentation still require device verification')
