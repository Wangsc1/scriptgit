const assert=require('node:assert/strict')
const fs=require('node:fs')
const {load}=require('./remoteFiles.test.cjs')
const keys=load('constants/auth.ts')
let token='token-a',user=null,requests=0
const keychain=new Map([[keys.KC_TOKEN_KEY,token]])
global.Keychain={get:k=>keychain.get(k)||null,contains:k=>keychain.has(k),set:(k,v)=>{keychain.set(k,v);return true},remove:k=>keychain.delete(k)}
const store={readGithubUser:()=>user,writeGithubUser:v=>{user=v},readIdentity:()=>{throw Error('旧手工身份不应读取')}}
const auth=load('services/authStore.ts',{'../constants/auth':keys,'./storage':store})
const response=(data,status=200)=>({ok:status===200,status,json:async()=>data})
async function main(){
 global.fetch=async()=>{requests++;return response({id:123,login:'github-user',name:'Display Name',email:'private@example.com',avatar_url:'avatar'})}
 assert.deepEqual(await auth.resolveAuthor(),{name:'github-user',email:'123+github-user@users.noreply.github.com'})
 assert.equal(requests,1);await auth.resolveAuthor();assert.equal(requests,1)
 user={login:'legacy',avatarUrl:''};await auth.resolveAuthor();assert.equal(requests,2)
 auth.setToken('token-b');assert.equal(user,null)
 global.fetch=async()=>response({id:456,login:'next-user'})
 assert.deepEqual(await auth.resolveAuthor(),{name:'next-user',email:'456+next-user@users.noreply.github.com'})
 auth.clearToken();assert.equal(user,null);await assert.rejects(auth.resolveAuthor(),/配置并验证/)
 auth.setToken('invalid');global.fetch=async()=>response({},401);await assert.rejects(auth.resolveAuthor(),/HTTP 401/);assert.equal(user,null)
 global.fetch=async()=>{throw Error('offline')};await assert.rejects(auth.resolveAuthor(),/offline/)
 global.fetch=async()=>response({id:0,login:'unknown'});await assert.rejects(auth.resolveAuthor(),/有效账号/)
 global.fetch=async()=>{auth.setToken('switched');return response({id:123,login:'old-user'})};await assert.rejects(auth.resolveAuthor(),/已更换/);assert.equal(user,null)
 assert.deepEqual(await auth.resolveAuthor({name:'preserved-author',email:'preserved@example.com'}),{name:'preserved-author',email:'preserved@example.com'})
 const settings=fs.readFileSync(require('node:path').join(__dirname,'../pages/SettingsPage.tsx'),'utf8')
 assert.doesNotMatch(settings,/handleSaveIdentity|保存身份|header=\{<Text>Git 身份/)
 assert.match(settings,/id: result.user.id/)
 const stored=new Map();global.Storage={get:k=>stored.get(k),set:(k,v)=>{stored.set(k,v);return true},remove:k=>stored.delete(k)}
 const storage=load('services/storage.ts')
 storage.writeGithubUser({login:'test',id:789,avatarUrl:'a'})
 assert.deepEqual(storage.readGithubUser(),{login:'test',id:789,avatarUrl:'a'})
 console.log('PASS 自动GitHub用户名与noreply、旧缓存升级、不读取私人邮箱/旧身份、换Token失效、无Token/无效认证/断网/账号异常/中途换Token拒绝、保留内部作者override、身份设置移除、账号ID持久化')
}
main().catch(e=>{console.error(e);process.exitCode=1})
