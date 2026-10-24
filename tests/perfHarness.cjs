/* Shared helper for large-repo performance tests: production services/hooks over a REAL temp Git repo,
 * counting filesystem / FileManager / Git-engine operations. No network. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),ts=require('typescript')
const {ui,mount,tick,deferred}=require('./remoteFiles.test.cjs')
global.self=globalThis
const project=path.resolve(__dirname,'..'),git=require('../vendor/index.umd.min.js')
const counts={}
const bump=(k)=>{counts[k]=(counts[k]||0)+1}
const reset=()=>{for(const k of Object.keys(counts))delete counts[k]}
const snap=()=>({...counts})
function countingFs(real){
 const wrap=(obj,prefix)=>new Proxy(obj,{get(t,k){const v=t[k];if(typeof v==='function'&&typeof k==='string')return (...a)=>{bump(prefix+k);return v.apply(t,a)};if(k==='promises'&&v)return wrap(v,'fs.');return v}})
 return wrap(real,'fs.')
}
const sh=(cwd,...a)=>cp.execFileSync('git',['-c','user.name=t','-c','user.email=t@example.invalid',...a],{cwd,encoding:'utf8',maxBuffer:1<<26}).trim()
function build(root,{files=1450,dirs=60,branches=3}={}){
 const dir=root+'/work';fs.mkdirSync(dir,{recursive:true});sh(root,'init','-q','-b','main',dir)
 for(let i=0;i<files;i++){const p=`d${i%dirs}/s${i%7}/f${i}.txt`;fs.mkdirSync(path.dirname(dir+'/'+p),{recursive:true});fs.writeFileSync(dir+'/'+p,'content '+i+'\n'.repeat(i%5))}
 fs.writeFileSync(dir+'/.gitignore','node_modules/\n*.log\n');fs.mkdirSync(dir+'/node_modules/x',{recursive:true});fs.writeFileSync(dir+'/node_modules/x/i.js','x')
 sh(dir,'add','-A');sh(dir,'commit','-qm','base')
 for(let b=1;b<=branches;b++){sh(dir,'checkout','-q','-b','br'+b);for(let k=0;k<5;k++)fs.writeFileSync(dir+`/d${k}/s${k%7}/f${k}.txt`,`branch ${b} change ${k}`);fs.writeFileSync(dir+`/d0/new-${b}.txt`,'n');sh(dir,'add','-A');sh(dir,'commit','-qm','b'+b);sh(dir,'checkout','-q','main')}
 return dir
}
function setup(opts={}){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-perf-'));const dir=build(tmp,opts)
 const gitdir=dir+'/.git',cfs=countingFs(fs)
 const engine=new Proxy(git,{get:(t,k)=>typeof t[k]==='function'&&['statusMatrix','isIgnored','listFiles','readCommit','readBlob','checkout','log','walk','resolveRef','listBranches','readTree','add','currentBranch'].includes(k)?(...a)=>{bump('git.'+k);return t[k](...a)}:t[k]})
 const ctx={git:engine,fs:cfs,dir,gitdir}
 const fm={temporaryDirectory:tmp,scriptsDirectory:tmp,appGroupDocumentsDirectory:tmp,documentsDirectory:tmp}
 const wrapFm={exists:async p=>fs.existsSync(p),readDirectory:async p=>fs.promises.readdir(p),createDirectory:async p=>fs.promises.mkdir(p,{recursive:true}),isDirectory:async p=>{try{return (await fs.promises.stat(p)).isDirectory()}catch{return false}},isFile:async p=>{try{return (await fs.promises.stat(p)).isFile()}catch{return false}},isLink:async p=>{try{return (await fs.promises.lstat(p)).isSymbolicLink()}catch(e){if(e.code==='ENOENT')return false;throw e}},stat:async p=>{const s=await fs.promises.stat(p);return {size:s.size,modificationDate:s.mtimeMs,creationDate:s.birthtimeMs,type:s.isDirectory()?'directory':'file'}},readAsString:async p=>fs.readFileSync(p,'utf8'),remove:async p=>fs.promises.rm(p,{recursive:true,force:true}),rename:async(a,b)=>fs.promises.rename(a,b),copyFile:async(a,b)=>fs.promises.copyFile(a,b)}
 const control={latency:0,inFlight:0,maxInFlight:0}
 global.FileManager={...fm,...Object.fromEntries(Object.entries(wrapFm).map(([k,f])=>[k,async(...a)=>{bump('FM.'+k);control.inFlight++;control.maxInFlight=Math.max(control.maxInFlight,control.inFlight);try{if(control.latency)await new Promise(r=>setTimeout(r,control.latency));return await f(...a)}finally{control.inFlight--}}]))}
 global.Keychain={contains:()=>true,get:()=>'t',set:()=>true,remove:()=>true};global.Storage={get:()=>({login:'octo',id:7,avatarUrl:''}),set:()=>true,remove:()=>true};global.Dialog={confirm:async()=>true}
 const store={writeSnapshot(){bump('snapshot.write')},resolveWorkdir:()=>dir,findRepo:()=>({bookmarkName:'repo',name:'big',repoId:'repo',source:'clone',createdAt:1}),listRepos:()=>[],getGitdirPath:()=>gitdir,getRepoLastPulledAt:()=>null,updateBranchLastPulledAt(){},readSnapshots:async()=>({}),resolveRepoPathsReadOnly:()=>({workdir:dir,storedWorkdir:dir,gitdir,source:'t',bookmarkChecks:[]})}
 const cache=new Map()
 function read(file){file=path.resolve(file);if(cache.has(file))return cache.get(file).exports
  const m={exports:{}};cache.set(file,m)
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'__jsx',jsxFragmentFactory:'__fragment'},fileName:file}).outputText
  const req=name=>{if(name==='scripting')return new Proxy(ui,{get:(t,k)=>k==='Widget'?{reloadAll(){}}:t[k]})
   let dest=path.resolve(path.dirname(file),name);dest=['.ts','.tsx'].map(e=>dest+e).find(fs.existsSync)||dest
   if(dest===project+'/services/gitCore.ts')return {loadGitEngine:async()=>({git:engine}),createFS:()=>cfs,createHttpTransport:()=>{throw Error('network forbidden')}}
   if(dest===project+'/services/repoStore.ts')return store
   if(dest===project+'/services/notifyService.ts')return {notifySync:async()=>{},notifyError:async()=>{}}
   if(dest===project+'/services/git/runtime.ts')return {...read(dest),runWithBackgroundKeepAlive:fn=>fn(),resolveGitdir:()=>gitdir,getCtx:async()=>ctx}
   return read(dest)}
  new Function('require','module','exports',code)(req,m,m.exports);return m.exports}
 const load=rel=>read(project+'/'+rel)
 return {tmp,dir,gitdir,ctx,load,counts,reset,snap,control,cleanup:()=>fs.rmSync(tmp,{recursive:true,force:true}),sh:(...a)=>sh(dir,...a),mount,tick,deferred,ui}
}
module.exports={setup}
