const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm');
const esbuild=require('../desktop-web/node_modules/esbuild');
const compiled=esbuild.build({stdin:{contents:"export {browseEntries,folderTarget} from './src/file-panel';export {Operations} from './src/operations';export {NativeTransfers} from './src/native-transfers';",resolveDir:path.join(__dirname,'../desktop-web')},bundle:true,platform:'node',format:'cjs',write:false});
const api=compiled.then(value=>{const scope={module:{exports:{}},exports:{},window:{setInterval:()=>0},clearInterval(){}};scope.exports=scope.module.exports;vm.runInNewContext(value.outputFiles[0].text,scope);return scope.module.exports;});
const entry=(name,size=0,modified=0,directory=false)=>({name,size,modified,directory});

test('favorite connection errors do not claim that file bytes or a partial transfer were saved',async()=>{
  const {NativeTransfers}=await api,queue=new NativeTransfers(async action=>{if(action==='list')return {jobs:[]};throw Object.assign(Error('old transfer message'),{code:'TRANSFER_IO'});},()=>{},true);
  try{await assert.rejects(queue.places('open',{path:'C:/资料'}),error=>/无法核对设备连接/.test(error.message)&&!error.message.includes('已传部分'));}finally{queue.dispose();}
});

test('native verification reaches the view separately from transfer progress',async()=>{
  const {NativeTransfers}=await api;let receive;
  const updated=new Promise(resolve=>receive=resolve);
  const queue=new NativeTransfers(async()=>({jobs:[{id:1,kind:'upload',name:'data.bin',status:'running',phase:'verifying',bytes:256,size:1024,verifyBytes:128,verifyTotal:512}]}),receive);
  try{const [task]=await updated;assert.equal(task.bytes,256);assert.equal(task.verifyBytes,128);assert.equal(task.verifyTotal,512);assert.equal(task.status,'running');}
  finally{queue.dispose();}
});

test('current-directory search is Unicode aware, sorts naturally, keeps folders first and never mutates its snapshot',async()=>{
  const {browseEntries}=await api,values=[entry('报告10.txt',20,200),entry('报告2.txt',10,300),entry('资料',0,100,true),entry('NOTES.TXT',0,0)];const before=JSON.stringify(values);
  assert.deepEqual([...browseEntries(values,'报告','name')].map(e=>e.name),['报告2.txt','报告10.txt']);
  assert.deepEqual([...browseEntries(values,'','size')].map(e=>e.name),['资料','报告10.txt','报告2.txt','NOTES.TXT']);
  assert.deepEqual([...browseEntries(values,'','modified')].map(e=>e.name),['资料','报告2.txt','报告10.txt','NOTES.TXT']);
  assert.equal(browseEntries(values,' notes ','name')[0].name,'NOTES.TXT');assert.equal(browseEntries(values,'not loaded','name').length,0);assert.equal(JSON.stringify(values),before);
});

test('new folder targets stay in the selected directory and reject traversal, reserved names and excessive length',async()=>{
  const {folderTarget}=await api;assert.equal(folderTarget('C:/资料','中文 新目录'),'C:/资料/中文 新目录');assert.equal(folderTarget('D:/','folder'),'D:/folder');
  for(const value of ['', '..', '../escape','sub/dir','a\\b','CON.txt','a.','a ','x\n','x'.repeat(256)])assert.throws(()=>folderTarget('C:/资料',value));
  assert.throws(()=>folderTarget('/','new'));assert.throws(()=>folderTarget('C:relative','new'));assert.throws(()=>folderTarget('C:/'+ 'a'.repeat(1018),'new-folder'));
});

test('folder creation distinguishes an existing directory and requires an acknowledgement of the exact target',async()=>{
  const {Operations}=await api,op=new Operations(()=>''),target='C:/资料/新目录';let sent;
  op.request=async(action,data)=>{sent={action,...data};return {path:target,created:true};};assert.equal((await op.mkdir(target)).created,true);assert.deepEqual(sent,{action:'mkdir',path:target});
  op.request=async()=>({path:target,created:false});assert.equal((await op.mkdir(target)).created,false);
  for(const reply of [{path:'C:/other',created:true},{path:target},{}]){op.request=async()=>reply;await assert.rejects(op.mkdir(target),/结果未确认/);}
});

test('directory replies validate path, entry metadata, duplicate names and bounds before replacing the browser view',async()=>{
  const {Operations}=await api,op=new Operations(()=>''),good={path:'C:/资料',entries:[entry('资料.txt')],truncated:false};
  for(const bad of [{...good,path:'not-an-absolute-path'},{...good,truncated:'false'},{...good,entries:[entry('../escape')]},{...good,entries:[entry('a'),entry('a')]},{...good,entries:[entry('a',-1)]},{...good,entries:[entry('a',1,-1)]},{...good,entries:[entry('a',1,NaN)]},{...good,entries:Array.from({length:2001},(_,i)=>entry(String(i)))}]){op.request=async()=>bad;await assert.rejects(op.list('C:/资料'),/目录响应无效/);}
  op.request=async()=>good;assert.equal((await op.list()).path,'C:/资料');op.request=async()=>({path:'/',entries:[entry('C:',0,0,true)],truncated:false});assert.equal((await op.list()).entries[0].name,'C:');
});
