/* Production directory importer + real disposable FS/Git; injected provider listing shapes. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process')
const {load}=require('./remoteFiles.test.cjs')
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-import-conflict-')),work=tmp+'/work',sources=tmp+'/sources'
fs.mkdirSync(work);fs.mkdirSync(sources)
const cmd=(...args)=>cp.execFileSync('git',['-C',work,...args],{encoding:'utf8'})
cmd('init','-qb','master');cmd('config','user.name','Test');cmd('config','user.email','test@example.invalid');fs.writeFileSync(work+'/baseline','base');cmd('add','.');cmd('commit','-qm','base')
const exists=p=>{try{fs.lstatSync(p);return true}catch{return false}}
let listing=(p,names)=>names,trace=[],copyFail=false
const fm={
 isLink:async p=>exists(p)&&fs.lstatSync(p).isSymbolicLink(),exists:async p=>exists(p),isFile:async p=>exists(p)&&fs.statSync(p).isFile(),isDirectory:async p=>exists(p)&&fs.statSync(p).isDirectory(),
 stat:async p=>{const s=fs.statSync(p);return {size:s.size,creationDate:s.birthtimeMs,modificationDate:s.mtimeMs}},
 readDirectory:async p=>{trace.push(['list',p]);return listing(p,fs.readdirSync(p))},
 createDirectory:async p=>{trace.push(['mkdir',p]);fs.mkdirSync(p)},copyFile:async(s,d)=>{trace.push(['copy',d]);if(copyFail)throw Error('injected copy failure');fs.copyFileSync(s,d,fs.constants.COPYFILE_EXCL)},
}
global.FileManager=fm
const service=load('services/git/localFileService.ts',{'../repoStore':{resolveWorkdir:()=>work},'../localImportExecution':{},})
const importer=source=>service.importLocalDirectoryInternal('repo',source,work)
function snapshot(root){const out={};function walk(p){for(const n of fs.readdirSync(p)){const c=p+'/'+n,s=fs.lstatSync(c);out[c]=s.isDirectory()?['dir']:s.isSymbolicLink()?['link',fs.readlinkSync(c)]:['file',fs.readFileSync(c).toString('base64')];if(s.isDirectory())walk(c)}}walk(root);return out}
function source(name){const p=sources+'/'+name;fs.mkdirSync(p);return p}
async function refused(src,pattern){const before=snapshot(tmp);trace=[];let error;try{await importer(src)}catch(e){error=e}assert.ok(error,'must reject');assert.match(error.message,pattern);assert.ok(!error.message.includes(tmp),'no system path');assert.deepEqual(snapshot(tmp),before,'conflict must not write/delete anything');assert.ok(!trace.some(([name])=>name==='mkdir'||name==='copy'));return error.message}
let groups=0;async function test(name,fn){await fn();groups++;console.log('PASS '+name)}
async function main(){
 const head=fs.readFileSync(work+'/.git/HEAD'),index=fs.readFileSync(work+'/.git/index')
 await test('empty first import succeeds with relative/absolute destination listings; two prechecks happen before exactly one mkdir, never self-conflict',async()=>{
  for(const absolute of [false,true]){listing=(p,names)=>p===work&&absolute?names.map(n=>p+'/'+n):names;const name=absolute?'Empty Absolute':'Empty Relative',src=source(name);trace=[];const result=await importer(src);assert.deepEqual(result,{path:name,files:[],directories:[name]});assert.deepEqual(fs.readdirSync(work+'/'+name),[]);const mkdir=trace.findIndex(([op])=>op==='mkdir');assert.ok(trace.slice(0,mkdir).filter(([op,p])=>op==='list'&&p===work).length>=2);assert.equal(trace.filter(([op])=>op==='mkdir').length,1);assert.equal(trace.filter(([op])=>op==='copy').length,0);assert.ok(!cmd('status','--porcelain').includes(name));}
 })
 await test('real directory/file/case/Unicode/broken-link collisions give exact name and type without overwrite; relative and absolute listing outcomes match',async()=>{
  for(const absolute of [false,true]){
   listing=(p,names)=>p===work&&absolute?names.map(n=>p+'/'+n):names
   for(const [requested,existing,kind,reason]of [
    ['Exact'+absolute,'Exact'+absolute,'directory','完全同名'],['Case'+absolute,'CASE'+String(absolute).toUpperCase(),'file','大小写/Unicode 等价'],['é'+absolute,'e\u0301'+absolute,'directory','Unicode 等价'],['Link'+absolute,'Link'+absolute,'link','完全同名'],
   ]){const src=source(requested),target=work+'/'+existing;if(kind==='directory')fs.mkdirSync(target);else if(kind==='link')fs.symlinkSync('absent',target);else fs.writeFileSync(target,'do not overwrite');const msg=await refused(src,/根目录已有同名目标/);assert.ok(msg.includes(JSON.stringify(requested)));assert.ok(msg.includes(JSON.stringify(existing)));assert.ok(msg.includes(reason));assert.ok(msg.includes(kind==='directory'?'目录':kind==='file'?'文件':'符号链接'));assert.ok(msg.includes('命中=目录枚举'));}
  }
 })
 await test('exists-only/provider-inconsistent listing names the hit, still refuses; selected source already in worktree is identified, not copied onto itself',async()=>{
  listing=(p,names)=>p===work?[]:names;const src=source('Exists Only');fs.mkdirSync(work+'/Exists Only');assert.match(await refused(src,/仅 exists/),/目录枚举未匹配/)
  listing=(p,names)=>p===work?[...names,'Ghost']:names;assert.match(await refused(source('Ghost'),/根目录已有同名目标/),/枚举后已不存在或提供方状态不一致/)
  listing=(p,names)=>names;fs.mkdirSync(work+'/Already Here');assert.match(await refused(work+'/Already Here',/根目录已有同名目标/),/所选源目录就是目标目录/)
 })
 await test('partial failed import leaves a real target directory invisible to Git; repeat is a genuine collision, source and target stay intact',async()=>{
  const src=source('Prior Failure');fs.writeFileSync(src+'/file','source');copyFail=true;await assert.rejects(importer(src),/部分导入/);copyFail=false;assert.ok(fs.statSync(work+'/Prior Failure').isDirectory());assert.deepEqual(fs.readdirSync(work+'/Prior Failure'),[]);assert.ok(!cmd('status','--porcelain').includes('Prior Failure'));assert.match(await refused(src,/根目录已有同名目标/),/Prior Failure.*目录/)
 })
 await test('nested binary/empty directories remain intact; absolute source-child listings are conservatively rejected (official docs do not specify entry shape)',async()=>{
  const src=source('Nested');fs.mkdirSync(src+'/empty');fs.writeFileSync(src+'/bytes',Buffer.from([0,255,128]));const result=await importer(src);assert.ok(result.directories.includes('Nested/empty'));assert.deepEqual(fs.readFileSync(work+'/Nested/bytes'),Buffer.from([0,255,128]));assert.deepEqual(fs.readdirSync(work+'/Nested/empty'),[])
  const abs=source('Absolute Source');fs.mkdirSync(abs+'/child');listing=(p,names)=>p===abs?names.map(n=>p+'/'+n):names;await refused(abs,/名称|路径|合法/);listing=(p,names)=>names
 })
 await test('diagnostic names escape invisible characters and redact credential-looking strings; type-read error does not leak native paths',async()=>{
  const src=source('Invisible\u200b');fs.mkdirSync(work+'/Invisible\u200b');assert.match(await refused(src,/根目录已有同名目标/),/\\u200b/)
  const secret='ghp_PRIVATE_TOKEN_123456',secretSrc=source(secret);fs.mkdirSync(work+'/'+secret);assert.ok(!(await refused(secretSrc,/根目录已有同名目标/)).includes(secret))
  const typeSrc=source('Type Failed');fs.mkdirSync(work+'/Type Failed');const saved=fm.isDirectory;fm.isDirectory=async p=>{if(p===work+'/Type Failed')throw Error('/private/provider/secret');return saved(p)};try{assert.match(await refused(typeSrc,/根目录已有同名目标/),/类型读取失败/)}finally{fm.isDirectory=saved}
 })
 assert.deepEqual(fs.readFileSync(work+'/.git/HEAD'),head);assert.deepEqual(fs.readFileSync(work+'/.git/index'),index)
 console.log(groups+' production directory-import collision groups passed; phone-specific cause remains unknown; only disposable FS touched.')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}))
