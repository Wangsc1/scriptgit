/* Capability semantics only, not a native gesture or crypto implementation test. */
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {load}=require('./remoteFiles.test.cjs')
const {LocalFileDragSession}=load('utils/localFileDrag.ts')
global.UUID={string:randomUUID}
const a=new LocalFileDragSession(),b=new LocalFileDragSession()
let token=a.begin('repo','/root','source.txt')
assert.equal(a.eligible('repo','folder'),true)
assert.equal(a.consume('source.txt','repo','/root','folder'),null)
assert.equal(a.consume(token,'repo','/root','folder'),null,'an invalid payload attempt burns the capability')
token=a.begin('repo','/root','source.txt');assert.equal(b.consume(token,'repo','/root','folder'),null,'different mounted FilesTab has no authority')
assert.equal(a.consume(token,'other-repo','/root','folder'),null)
token=a.begin('repo','/root','source.txt');assert.equal(a.consume(token,'repo','/other-root','folder'),null)
token=a.begin('repo','/root','folder/source.txt');assert.equal(a.eligible('repo','folder'),false);assert.equal(a.consume(token,'repo','/root','folder'),null)
token=a.begin('repo','/root','source.txt');a.begin('repo','/root','other.txt');assert.equal(a.consume(token,'repo','/root','folder'),null,'new drag replaces cancelled drag')
token=a.begin('repo','/root','source.txt');const now=Date.now;Date.now=()=>now()+120001
try{assert.equal(a.consume(token,'repo','/root','folder'),null)}finally{Date.now=now}
token=a.begin('repo','/root','source.txt');assert.equal(a.consume(token,'repo','/root','folder').path,'source.txt');assert.equal(a.consume(token,'repo','/root','folder'),null,'single use')
token=a.begin('repo','/root','source.txt');a.clear();assert.equal(a.consume(token,'repo','/root','folder'),null)
delete global.UUID
console.log('PASS drag capabilities: no path authorization, per-page/repo/root binding, same-parent rejection, expiry, cancellation replacement and one-shot consumption')
