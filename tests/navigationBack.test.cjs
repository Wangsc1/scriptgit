/* Source-level navigation audit; native interactive-pop/sheet gestures are NOT emulated. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8')
const files=[];(function walk(d){for(const n of fs.readdirSync(path.join(root,d))){const r=d+'/'+n;if(fs.statSync(path.join(root,r)).isDirectory())walk(r);else if(r.endsWith('.tsx'))files.push(r)}})('pages');files.push(...fs.readdirSync(path.join(root,'components')).filter(n=>n.endsWith('.tsx')).map(n=>'components/'+n),'index.tsx')
// 1) Only the busy clone page suppresses the system back button; pushed pages have no custom gesture overrides.
const hidden=files.filter(f=>/navigationBarBackButtonHidden/.test(read(f)));assert.deepEqual(hidden,['pages/ClonePage.tsx']);assert.match(read('pages/ClonePage.tsx'),/navigationBarBackButtonHidden=\{cloning\}/)
for(const f of files){
 assert.doesNotMatch(read(f),/highPriorityGesture|interactiveDismissDisabled/,f)
 if(f!=='pages/LocalFileEditor.tsx')assert.doesNotMatch(read(f),/DragGesture|simultaneousGesture/,f)
}
// The full-screen local editor intentionally adds a simultaneous edge swipe only
// to its diff ScrollView. It uses the same save-first back path, not a direct close.
const ts=require('typescript'),ast=ts.createSourceFile('LocalFileEditor.tsx',read('pages/LocalFileEditor.tsx'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const gestures=[]
function visit(n){if(ts.isJsxAttribute(n)&&n.name.getText(ast)==='simultaneousGesture')gestures.push(n);ts.forEachChild(n,visit)}visit(ast)
assert.equal(gestures.length,1)
assert.equal(gestures[0].parent.parent.tagName.getText(ast),'ScrollView')
assert.match(gestures[0].getText(ast),/startLocation\.x <= 24[\s\S]*translation\.width >= 80[\s\S]*void back\(\)/)
assert.doesNotMatch(gestures[0].getText(ast),/onClose|dismiss|Script\.exit/)
// 2) Root list/detail/sub pages use native NavigationStack/NavigationLink/navigationDestination, so system edge-swipe is retained.
assert.match(read('index.tsx'),/<NavigationStack>\s*<RepoListPage \/>/);for(const f of ['pages/RepoListPage.tsx','pages/RepoDetailPage.tsx','pages/GitHubWorkPage.tsx','pages/ActionsPage.tsx'])assert.match(read(f),/navigationDestination/,f)
// 3) Editor/image are full-screen covers with explicit buttons; editor back is the only editor exit and always uses the save-first path.
const detail=read('pages/RepoDetailPage.tsx'),editor=read('pages/LocalFileEditor.tsx')
assert.match(detail,/fullScreenCover=\{\[?\{[\s\S]*?onChanged: \(\) => \{\}/);assert.match(editor,/topBarLeading: <Button title="返回" action=\{back\}/);assert.equal((editor.match(/onClose\(\)/g)||[]).length,1);assert.match(editor,/async function back\(\)[\s\S]*saveLocalWorktreeFile[\s\S]*onClose\(\)/)
assert.doesNotMatch(editor,/navigationBarBackButtonHidden|Script\.exit|Navigation\.present/)
console.log('PASS native push pages keep system back gesture; only busy clone page hides it; no pushed-page gesture overrides; editor diff edge swipe and toolbar both use save-first back; limits remain for covers/sheets (native swipe API unavailable, device test needed).')
