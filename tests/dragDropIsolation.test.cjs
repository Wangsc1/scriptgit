/* Native event bridge modeled, NOT proof of on-device drag/drop delivery. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {load,ui,mount,all,tick,deferred}=require('./remoteFiles.test.cjs')
const execution=load('services/localImportExecution.ts')
let main=false,pending=[],dispatches=0,repoCalls=0
function deliver(fn){const old=main;main=true;try{fn()}finally{main=old}}
function drain(){for(const fn of pending.splice(0))deliver(fn)}
async function flush(){for(let i=0;i<20;i++){await tick();drain()}}
global.Thread={get isMainThread(){return main},runInMain(fn){dispatches++;pending.push(fn)}}
let payload=''
global.ItemProvider={fromText:text=>{payload=text;return {registeredTypes:['public.utf8-plain-text','public.url'],loadText:async()=>text}}}
const Page=load('pages/DragDropTestPage.tsx',{scripting:ui,'../services/localImportExecution':execution}).DragDropTestPage
function parts(h){h.render();const nodes=all(h.tree);return {source:nodes.find(n=>n.props?.onDrag),target:nodes.find(n=>n.props?.onDrop),close:nodes.find(n=>n.type==='VStack'&&n.props.toolbar)?.props.toolbar.topBarLeading}}
function text(h){h.render();return JSON.stringify(h.tree)}
async function testPage(){
 let closed=0;const h=mount(Page,{onClose:()=>closed++});let {source,target}=parts(h)
 assert.equal(h.tree.type,'NavigationStack');assert.ok(!all(h.tree).some(n=>['List','DisclosureGroup','Menu','WebView'].includes(n.type)))
 assert.ok(target.props.frame.minHeight>=160);assert.match(text(h),/将测试块拖到接收区松手/)
 const provider=source.props.onDrag.data();assert.equal(provider instanceof Promise,false);assert.equal(typeof provider.loadText,'function');const first=payload;await flush();assert.match(text(h),/onDrag.data 入口/);assert.ok(!text(h).includes(payload))
 let loads=0,checks=0;const drop=target.props.onDrop
 assert.deepEqual(drop.types,['public.utf8-plain-text','public.plain-text'])
 const info={hasItemsConforming:types=>{checks++;assert.deepEqual(types,drop.types);drain();assert.match(text(h),/validateDrop 入口/);return true},itemProviders:types=>{assert.deepEqual(types,drop.types);return [{loadText(){loads++;return provider.loadText()}}]}}
 assert.equal(drop.validateDrop(info),true);assert.equal(checks,1)
 const normal={...info,hasItemsConforming:()=>true}
 drop.dropEntered(normal);assert.equal(drop.dropUpdated(normal),'copy');await flush()
 const before=dispatches,previous=text(h)
 for(let i=0;i<500;i++)assert.equal(drop.dropUpdated(normal),'copy')
 await flush();assert.equal(dispatches,before);assert.equal(text(h),previous)
 assert.equal(drop.performDrop(normal),true);assert.equal(loads,1,'load starts synchronously before callback returns');await flush()
 assert.match(text(h),/validateDrop 入口.*dropEntered 入口.*dropUpdated 入口.*performDrop 入口.*performDrop.loadText 已启动.*测试成功/)
 const trace=all(h.tree).find(n=>n.type==='Text'&&n.props.font==='caption2').children.join('');assert.ok(trace.split('\n').length<=12);assert.ok(!trace.includes(first))
 source=parts(h).source;source.props.onDrag.data();await flush();assert.notEqual(payload,first);assert.ok(!text(h).includes('测试成功'),'new drag clears old trace')
 const broken={hasItemsConforming(){throw Error('native capability')},itemProviders(){throw Error('must not run')}}
 assert.equal(drop.validateDrop(broken),false);await flush();assert.match(text(h),/validateDrop 入口.*validateDrop.hasItemsConforming 异常/)
 assert.equal(drop.performDrop({hasItemsConforming:()=>true,itemProviders(){throw Error('native providers')}}),false);await flush();assert.match(text(h),/performDrop.itemProviders 同步异常/)
 const prior=loads;assert.equal(drop.performDrop({hasItemsConforming:()=>false,itemProviders(){loads++;throw Error('must not run')}}),false);assert.equal(loads,prior)
 assert.equal(drop.performDrop({hasItemsConforming:()=>true,itemProviders:()=>[{loadText(){throw Error('native load')}}]}),false);await flush();assert.match(text(h),/performDrop.loadText 同步异常/)
 const gate=deferred();assert.equal(drop.performDrop({hasItemsConforming:()=>true,itemProviders:()=>[{loadText:()=>gate.promise}]}),true)
 parts(h).close.props.action();assert.equal(closed,0,'close dispatch can be deferred');await flush();assert.equal(closed,1);h.unmount();gate.resolve(payload);await flush();assert.equal(h.lateWrites,0)
 assert.equal(drop.validateDrop(normal),false,'closed page invalidates callbacks')
 const detached=mount(Page,{onClose(){}});parts(detached).source.props.onDrag.data();detached.unmount();await flush();assert.equal(detached.lateWrites,0)
 const src=fs.readFileSync(path.join(__dirname,'../pages/DragDropTestPage.tsx'),'utf8');assert.doesNotMatch(src,/gitService|repoStore|FileManager|loadData|loadFilePath|DocumentPicker|Photos|Timer|setTimeout/)
}
async function testEntry(){
 const forbidden=()=>{repoCalls++;throw Error('test entry must not access repository')}
 const FilesTab=load('pages/FilesTab.tsx',{
 '../services/localImportBatchSummary':load('services/localImportBatchSummary.ts'),
  scripting:ui,'./DragDropTestPage':{DragDropTestPage:'DragDropTestPage'},'../components/NameInputSheet':{NameInputSheet:'NameInputSheet'},'../constants/colors':{},
  '../services/localImportExecution':execution,'../services/gitService':new Proxy({},{get:()=>forbidden}),
  '../services/repoStore':{resolveWorkdir:()=>'/existing-list-metadata-context'},'../services/localFileImport':new Proxy({},{get:()=>forbidden}),
  '../utils/localFileDrag':load('utils/localFileDrag.ts'),'../utils/fileTree':load('utils/fileTree.ts'),'../utils/fileListPerformance':load('utils/fileListPerformance.ts'),'../utils/format':{formatBytes:String,formatDate:String},
 }).FilesTab
 const props={files:[],changes:[],bookmarkName:'repo',loading:false,mergeInProgress:false,onWorktreeChanged:forbidden,onOpen:forbidden,onPush:forbidden,onRestore:forbidden,onCreateEntry:forbidden}
 const h=mount(FilesTab,props,{effectUpdates:true});await flush();h.render();const buttons=all(h.tree.props.header).filter(n=>n.type==='Button')
 assert.equal(buttons.at(-1).props.title,'拖放测试');const groups=all(h.tree.props.header).filter(n=>n.type==='Section');assert.equal(groups.length,3);assert.match(JSON.stringify(groups.at(-1).props.header),/仅诊断，不改仓库/)
 buttons.at(-1).props.action();assert.equal(h.tree.props.fullScreenCover.isPresented,false,'menu only queues intent');h.render();assert.equal(h.tree.props.fullScreenCover.isPresented,false,'await real main callback, not sync Thread assumption');await flush();h.render()
 assert.equal(h.tree.props.fullScreenCover.isPresented,true);assert.equal(h.tree.props.fullScreenCover.content.type,'DragDropTestPage');assert.deepEqual(Object.keys(h.tree.props.fullScreenCover.content.props),['onClose'])
 h.tree.props.fullScreenCover.content.props.onClose();h.render();assert.equal(h.tree.props.fullScreenCover.isPresented,false);assert.equal(repoCalls,0);h.unmount()
 const detached=mount(FilesTab,props,{effectUpdates:true});await flush();detached.render();all(detached.tree.props.header).find(n=>n.type==='Button'&&n.props.title==='拖放测试').props.action();detached.render();detached.unmount();await flush();assert.equal(detached.lateWrites,0);assert.equal(repoCalls,0)
}
async function mainTest(){await testPage();await testEntry();console.log('PASS pure VStack source/target, sync provider/load and return, bounded/dedup event trace, errors, new-drag reset, close/unmount cleanup; menu post-commit deferred-main presentation and zero repository calls');console.log('LIMIT native gesture recognition, callback delivery and full-screen presentation still require device validation')}
mainTest().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{delete global.Thread;delete global.ItemProvider})
