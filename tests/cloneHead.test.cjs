/* Production cloneInternal + bundled Git + production fs adapter against local git-http-backend. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),http=require('node:http')
const {load,ui}=require('./remoteFiles.test.cjs');global.self=globalThis
const git=require('../vendor/index.umd.min.js'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'scriptgit-clone-head-')),source=tmp+'/source',root=tmp+'/server',group=tmp+'/group',dir=tmp+'/git/work',gitdir=group+'/git-repos/clone'
const native=(...args)=>cp.execFileSync('git',args,{encoding:'utf8'})
fs.mkdirSync(root);native('init','-q','-b','master',source);native('-C',source,'config','user.name','Test');native('-C',source,'config','user.email','test@example.invalid');fs.writeFileSync(source+'/a','base');native('-C',source,'add','.');native('-C',source,'commit','-qm','base');native('clone','-q','--bare',source,root+'/remote.git')
const exists=p=>fs.existsSync(p)
global.FileManager={appGroupDocumentsDirectory:group,scriptsDirectory:tmp,documentsDirectory:tmp,
 isiCloudEnabled:false,get iCloudDocumentsDirectory(){throw Error('iCloud unavailable; local default must not access cloud root')},
 exists:async p=>exists(p),isLink:async p=>exists(p)&&fs.lstatSync(p).isSymbolicLink(),isDirectory:async p=>exists(p)&&fs.statSync(p).isDirectory(),
 readDirectory:async p=>fs.promises.readdir(p),stat:async p=>{const s=await fs.promises.stat(p);return {size:s.size,creationDate:s.birthtimeMs,modificationDate:s.mtimeMs,type:s.isDirectory()?'directory':'file'}},
 readAsString:async p=>fs.promises.readFile(p,'utf8'),readAsBytes:async p=>new Uint8Array(await fs.promises.readFile(p)),
 writeAsString:async(p,text)=>fs.promises.writeFile(p,text),writeAsBytes:async(p,bytes)=>fs.promises.writeFile(p,bytes),
 createDirectory:async p=>fs.promises.mkdir(p,{recursive:true}),remove:async p=>fs.promises.rm(p,{recursive:true,force:true}),rename:async(a,b)=>fs.promises.rename(a,b),createLink:async(p,target)=>fs.promises.symlink(target,p),
}
const core=load('services/gitCore.ts',{'../polyfills':{}}),progress=load('utils/remoteProgress.ts')
const runtime=load('services/git/runtime.ts',{scripting:ui,'../gitCore':{},'../repoStore':{},'../../utils/branch':load('utils/branch.ts'),'../../utils/stash':{},'./matrixScanService':{}})
const transport={request:async({url,method,headers,body})=>{
 const chunks=[];if(body)for await(const chunk of body)chunks.push(Buffer.from(chunk))
 const response=await fetch(url,{method,headers,body:chunks.length?Buffer.concat(chunks):undefined})
 return {url:response.url,method,statusCode:response.status,statusMessage:response.statusText,headers:Object.fromEntries(response.headers),body:[new Uint8Array(await response.arrayBuffer())]}
}}
const remote=load('services/git/remoteService.ts',{'../gitCore':{createFS:core.createFS,loadGitEngine:async()=>({git}),createHttpTransport:()=>transport},'../authStore':{getAuth:()=>null},'../../constants/git':{DEFAULT_BRANCH:'main'},'../../utils/gitSync':{},'../../utils/remoteProgress':progress,'./runtime':{resolveGitdir:()=>gitdir,ensureWorktreeMaterialized:runtime.ensureWorktreeMaterialized}})
const server=http.createServer(async(req,res)=>{try{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=Buffer.concat(chunks),url=new URL(req.url,'http://localhost')
 const result=cp.execFileSync('git',['http-backend'],{input,maxBuffer:10*1024*1024,env:{...process.env,GIT_PROJECT_ROOT:root,GIT_HTTP_EXPORT_ALL:'1',REQUEST_METHOD:req.method,PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),CONTENT_TYPE:req.headers['content-type']||'',CONTENT_LENGTH:String(input.length)}})
 const end=result.indexOf('\r\n\r\n');if(end<0)throw Error('invalid CGI response');const headers=result.subarray(0,end).toString().split('\r\n')
 for(const line of headers){const colon=line.indexOf(':');if(colon<0)continue;const key=line.slice(0,colon),value=line.slice(colon+1).trim();if(key.toLowerCase()==='status')res.statusCode=Number(value.slice(0,3));else res.setHeader(key,value)}
 res.end(result.subarray(end+4))
 }catch(error){res.statusCode=500;res.end(String(error))}})
async function main(){try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/remote.git`
 const workspace=load('services/cloneWorkspace.ts');const localRoot=await workspace.prepareCloneRoot({kind:'local'});assert.equal(dir,localRoot+'/work')
 await remote.cloneInternal(url,dir,'clone')
 assert.equal(fs.readFileSync(gitdir+'/HEAD','utf8'),'ref: refs/heads/master\n');assert.deepEqual(await git.listBranches({fs:core.createFS(gitdir,dir),dir,gitdir}),['master']);assert.equal(fs.readFileSync(dir+'/a','utf8'),'base')
 assert.equal(native('--git-dir='+gitdir,'rev-parse','HEAD'),native('-C',source,'rev-parse','HEAD'))
 console.log('PASS real cloneInternal follows advertised master default (not configured DEFAULT_BRANCH main), split gitdir and production adapter preserve symbolic HEAD; local default works with iCloud disabled/unavailable; local HTTP only')
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true})}}
const watchdog=setTimeout(()=>{console.error('FAIL clone HEAD test did not finish');process.exitCode=1},30000)
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>clearTimeout(watchdog))
