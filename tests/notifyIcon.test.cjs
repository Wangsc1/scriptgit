/* Notification payload/mock only; no real notification, network or user files. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load}=require('./remoteFiles.test.cjs')
const root=path.resolve(__dirname,'..'),calls=[];let enabled=true,exists=true,decoded='PNG-DATA',fromFileCalls=0
global.FileManager={scriptsDirectory:'/private/scripts',exists:async p=>{assert.equal(p,'/private/scripts/scriptgit/assets/notify-icon.png');return exists}}
global.Data={fromFile:p=>{fromFileCalls++;assert.equal(p,'/private/scripts/scriptgit/assets/notify-icon.png');return decoded}}
function service(){return load('services/notifyService.ts',{scripting:{Notification:{schedule:async x=>{calls.push(x)}}},'./storage':{readNotifyEnabled:()=>enabled,readErrorNotifyEnabled:()=>enabled}})}
async function main(){
 let n=service();await n.notifySync('push','https://token@example.invalid/a?token=abc','ghp_secret1234567890');n.notifyError;await n.notifyError('pull','repo','github_pat_secret failed https://u:p@example.invalid')
 assert.equal(calls.length,2);assert.equal(calls[0].iconImageData,'PNG-DATA');assert.equal(calls[1].iconImageData,'PNG-DATA');assert.deepEqual(calls.map(c=>c.threadIdentifier),['gitgit-sync','gitgit-error']);assert.deepEqual(calls[0].tapAction,{type:'runScript',scriptName:'scriptgit'});assert.equal(calls[0].silent,false);assert.equal(calls[0].interruptionLevel,'active')
 assert.doesNotMatch(JSON.stringify(calls.map(({iconImageData,...rest})=>rest)),/ghp_|github_pat|token@|abc|u:p@/)
 assert.equal(fromFileCalls,1)
 calls.length=0;exists=false;n=service();await n.notifySync('commit','repo','done');assert.equal(calls.length,1);assert.ok(!('iconImageData' in calls[0]));assert.doesNotMatch(JSON.stringify(calls),/private|scripts/)
 exists=true;decoded=null;n=service();await n.notifyError('push','repo','failed');assert.equal(calls.length,2);assert.ok(!('iconImageData' in calls[1]))
 enabled=false;calls.length=0;await n.notifySync('push','repo','x');await n.notifyError('push','repo','x');assert.equal(calls.length,0)
 const source=fs.readFileSync(root+'/services/notifyService.ts','utf8');assert.doesNotMatch(source,/systemImage|iconImageData:\s*.*\/.*png/i)
 console.log('PASS notification icon uses fixed packaged PNG Data; missing/decode failure still sends without path; tap/thread/silent/redaction/enable gates unchanged.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
