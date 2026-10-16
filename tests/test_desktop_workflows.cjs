const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm');
const {File,Blob}=require('node:buffer');
const esbuild=require('../desktop-web/node_modules/esbuild');
function load(name,extra={}){
  const result=esbuild.buildSync({entryPoints:[path.join(__dirname,'../desktop-web/src/'+name+'.ts')],bundle:true,platform:'node',format:'cjs',write:false});
  const scope={module:{exports:{}},File,Blob,AbortController,TextEncoder,ArrayBuffer,URL,setTimeout,clearTimeout,window:{setTimeout},...extra};
  vm.runInNewContext(result.outputFiles[0].text,scope);return scope.module.exports;
}
const {TransferQueue,validateRelativePath,droppedUploads}=load('transfers');
const plain=value=>JSON.parse(JSON.stringify(value));
function queueFixture(){
  const files=new Map(),events=[],saved=[];let block;
  const worker={
    mkdir:async value=>events.push(['mkdir',value]),
    upload:async(file,directory,progress,cancelled,name)=>{
      const target=directory.replace(/\/$/,'')+'/'+name;events.push(['upload',target]);
      if(files.has(target))throw Error('同名文件已经存在，上传不会覆盖。');
      if(name==='blocked.txt')await new Promise((resolve,reject)=>{block={resolve,reject};});
      if(cancelled())throw Error('cancelled');files.set(target,await file.text());progress(file.size);
    },
    download:async(remote,options)=>{events.push(['download',remote,options.directory]);options.progress(3,3,'receiving');return {blob:new Blob(['zip']),name:options.directory?'folder.zip':'file.txt'};},
    close:error=>{if(block){block.reject(error||Error('closed'));block=undefined;}}
  };
  const queue=new TransferQueue(()=>worker,file=>saved.push(file.name),()=>{});
  return {queue,files,events,saved};
}
test('folder batches retain their destination, create nested/empty folders and download folders through ZIP',async()=>{
  const h=queueFixture();
  h.queue.addUploads([{directory:true,relative:'项目/空目录'},{relative:'项目/甲.txt',file:new File(['甲'],'甲.txt')},{relative:'项目/乙.txt',file:new File(['乙'],'乙.txt')}],'C:/目标');
  h.queue.addDownloads([{path:'C:/远端文件夹',name:'远端文件夹',directory:true,size:0}]);await h.queue.idle();
  assert.deepEqual(h.events.filter(value=>value[0]==='mkdir'),[['mkdir','C:/目标/项目'],['mkdir','C:/目标/项目/空目录']]);
  assert.equal(h.files.get('C:/目标/项目/甲.txt'),'甲');assert.equal(h.files.get('C:/目标/项目/乙.txt'),'乙');
  assert.deepEqual(h.saved,['folder.zip']);assert.ok(h.queue.items.every(item=>item.status==='done'));
  assert.ok(h.queue.items.every(item=>!item.file),'completed tasks release local File references');
});

test('a shared file workspace permit gates I/O and releases after both success and failure',async()=>{
  let grant,released=0,calls=0;
  const worker={mkdir:async()=>{},upload:async()=>{calls++;if(calls===1)throw Error('synthetic disconnect');},download:async()=>{},close:()=>{}};
  const queue=new TransferQueue(()=>worker,()=>{},()=>{},()=>new Promise(resolve=>{grant=()=>resolve(()=>released++);}));
  queue.addUploads([{file:new File(['first'],'first.txt'),relative:'first.txt'},{file:new File(['second'],'second.txt'),relative:'second.txt'}],'C:/target');
  assert.equal(calls,0);assert.equal(queue.items[0].phase,'waiting');grant();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(released,1);assert.equal(queue.items[0].status,'failed');assert.equal(calls,1);grant();await queue.idle();assert.equal(released,2);assert.equal(queue.items[1].status,'done');
});
test('cancelling while waiting for another device never opens a remote file or directory',async()=>{
  let calls=0;
  const queue=new TransferQueue(()=>({mkdir:async()=>calls++,upload:async()=>calls++,download:async()=>calls++,close:()=>{}}),()=>{},()=>{},signal=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true})));
  queue.addUploads([{file:new File(['data'],'child.txt'),relative:'folder/child.txt'}],'C:/target');queue.cancel(queue.items[0].id);await queue.idle();
  assert.equal(calls,0);assert.equal(queue.items[0].status,'cancelled');
});
test('a failed task does not block the queue, and conflict renaming never overwrites the original',async()=>{
  const h=queueFixture();h.files.set('C:/目标/同名.txt','original');
  h.queue.addUploads([{relative:'同名.txt',file:new File(['new'],'同名.txt')},{relative:'下一项.txt',file:new File(['next'],'下一项.txt')}],'C:/目标');await h.queue.idle();
  assert.equal(h.queue.items[0].status,'failed');assert.equal(h.queue.items[1].status,'done');
  h.queue.retry(h.queue.items[0].id,'更名.txt');await h.queue.idle();
  assert.equal(h.files.get('C:/目标/同名.txt'),'original');assert.equal(h.files.get('C:/目标/更名.txt'),'new');
  assert.ok(h.queue.items.every(item=>item.status==='done'));
});
test('cancelling the active transfer closes only its worker and still permits later queued items',async()=>{
  const h=queueFixture();h.queue.addUploads([{relative:'blocked.txt',file:new File(['blocked'],'blocked.txt')},{relative:'next.txt',file:new File(['next'],'next.txt')}],'C:/目标');
  await new Promise(resolve=>setImmediate(resolve));h.queue.cancel(h.queue.items[0].id);await h.queue.idle();
  assert.equal(h.queue.items[0].status,'cancelled');assert.equal(h.queue.items[1].status,'done');assert.equal(h.files.has('C:/目标/blocked.txt'),false);
});
test('upload batches reject traversal and invalid names before enqueueing and read dropped folders in batches',async()=>{
  for(const relative of ['../escape','/absolute','C:/escape','a\\b','CON.txt','folder/..','x/'.repeat(33)+'y'])assert.throws(()=>validateRelativePath(relative));
  const h=queueFixture();assert.throws(()=>h.queue.addUploads([{relative:'../escape',file:new File(['x'],'x')}],'C:/目标'));assert.equal(h.queue.items.length,0);
  const child={name:'中文.txt',isFile:true,isDirectory:false,file:resolve=>resolve(new File(['x'],'中文.txt'))};
  const empty={name:'空目录',isFile:false,isDirectory:true,createReader:()=>({readEntries:resolve=>resolve([])})};
  let reads=0;const folder={name:'课题',isFile:false,isDirectory:true,createReader:()=>({readEntries:resolve=>resolve(reads++===0?[child,empty]:[])})};
  const entries=await droppedUploads({items:[{kind:'file',webkitGetAsEntry:()=>folder}],files:[]});
  assert.deepEqual(plain(entries.map(({relative,directory})=>({relative,directory:!!directory}))),[{relative:'课题',directory:true},{relative:'课题/中文.txt',directory:false},{relative:'课题/空目录',directory:true}]);
  assert.equal(reads,2);
});
test('closing during dropped-folder enumeration stops before reading or enqueueing later files',async()=>{
  const controller=new AbortController();let finish,filesRead=0;
  const child={name:'later.txt',isFile:true,isDirectory:false,file:resolve=>{filesRead++;resolve(new File(['later'],'later.txt'));}};
  const folder={name:'folder',isFile:false,isDirectory:true,createReader:()=>({readEntries:resolve=>{finish=resolve;}})};
  const pending=droppedUploads({items:[{kind:'file',webkitGetAsEntry:()=>folder}],files:[]},controller.signal);
  controller.abort();finish([child]);await assert.rejects(pending,/取消/);assert.equal(filesRead,0);
});

class Element extends EventTarget{
  value='';disabled=false;style={};
  focus(){this.dispatchEvent(new Event('focus'));}
}
function event(target,type,values={}){const value=new Event(type,{cancelable:true});for(const [key,data] of Object.entries(values))Object.defineProperty(value,key,{value:data});target.dispatchEvent(value);return value;}
function textFixture(){
  const canvas=new Element(),input=new Element(),sent=[],errors=[];let keys=0,releases=0,enabled=true;
  const {installTextInput}=load('text-input',{innerWidth:1000,innerHeight:700});
  const handler=installTextInput(canvas,input,{enabled:()=>enabled,release:()=>releases++,send:text=>sent.push(text),error:error=>errors.push(error.message),hint:()=>{}});
  input.addEventListener('keydown',()=>keys++);handler.focus({x:900,y:650});
  return {canvas,input,sent,errors,handler,keys:()=>keys,releases:()=>releases,disable:()=>{enabled=false;}};
}
test('Chinese composition commits once for Chromium/WebKit event orders without leaking pre-edit keystrokes',async()=>{
  const h=textFixture();
  event(h.input,'compositionstart');event(h.input,'keydown',{key:'n',code:'KeyN',keyCode:229,isComposing:false});
  h.input.value='ni';event(h.input,'input',{data:'ni',isComposing:true,inputType:'insertCompositionText'});
  assert.deepEqual(h.sent,[]);assert.equal(h.keys(),0);
  event(h.input,'compositionend',{data:'你好'});event(h.input,'keyup',{key:'Enter',code:'Enter',keyCode:13,isComposing:false});
  event(h.input,'input',{data:'你好',isComposing:false,inputType:'insertText'});assert.deepEqual(h.sent,['你好']);assert.equal(h.input.value,'');
  event(h.input,'compositionstart');event(h.input,'input',{data:'世界',isComposing:true,inputType:'insertCompositionText'});event(h.input,'compositionend',{data:'世界'});
  assert.deepEqual(h.sent,['你好','世界']);await new Promise(resolve=>setTimeout(resolve,2));
});
test('local text paste preserves remote Ctrl+V, Unicode and the text size limit',()=>{
  const h=textFixture();event(h.input,'keydown',{key:'v',code:'KeyV',keyCode:86,metaKey:true,ctrlKey:false,altKey:false,isComposing:false});
  const pasted=event(h.input,'paste',{clipboardData:{getData:()=> '中文\n🙂'}});
  assert.equal(h.keys(),0);assert.equal(pasted.defaultPrevented,true);assert.deepEqual(h.sent,['中文\n🙂']);
  event(h.input,'keydown',{key:'v',code:'KeyV',keyCode:86,metaKey:false,ctrlKey:true,shiftKey:false,altKey:false,isComposing:false});assert.equal(h.keys(),1,'plain Ctrl+V remains available to the remote keyboard');
  event(h.input,'paste',{clipboardData:{getData:()=> '汉'.repeat(3000)}});assert.equal(h.errors.length,1);assert.equal(h.sent.length,1);
  event(h.input,'blur');event(h.input,'compositionend',{data:'不应发送'});assert.equal(h.sent.length,1);
  h.disable();event(h.input,'paste',{clipboardData:{getData:()=> 'offline'}});assert.equal(h.sent.length,1);
});

function operationFixture(){
  const sockets=[];
  class Socket{
    static OPEN=1;readyState=0;sent=[];
    constructor(){sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.onopen?.();});}
    send(value){this.sent.push(value);if(typeof value==='string'&&JSON.parse(value).token)queueMicrotask(()=>this.deliver({type:'operations_ready'}));}
    deliver(value){this.onmessage?.({data:value instanceof ArrayBuffer?value:JSON.stringify(value)});}
    close(){this.readyState=3;}
  }
  const {Operations}=load('operations',{WebSocket:Socket,location:{origin:'http://127.0.0.1:22258'}});
  return {ops:new Operations(()=> 'synthetic-test-token'),sockets};
}
test('downloads report actual chunk progress, reject another size and can cancel without reusing a stale socket',async()=>{
  const h=operationFixture(),progress=[];await h.ops.ready();
  let promise=h.ops.download('C:/a.txt',{progress:(...args)=>progress.push(args)});await new Promise(resolve=>setImmediate(resolve));
  let socket=h.sockets[0],id=JSON.parse(socket.sent.at(-1)).id;
  socket.deliver({id,ok:true,name:'a.txt',size:3});socket.deliver(new Uint8Array([65,66,67]).buffer);socket.deliver({id,ok:true,done:true});
  assert.equal(await (await promise).blob.text(),'ABC');assert.ok(progress.some(value=>value[0]===3&&value[1]===3));
  const controller=new AbortController();promise=h.ops.download('C:/folder',{directory:true,signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(promise,/取消/);assert.equal(socket.readyState,3);
  await h.ops.ready();socket=h.sockets[1];promise=h.ops.download('C:/bad.txt');await new Promise(resolve=>setImmediate(resolve));id=JSON.parse(socket.sent.at(-1)).id;
  socket.deliver({id,ok:true,name:'bad.txt',size:3});socket.deliver(new Uint8Array([65]).buffer);socket.deliver({id,ok:true,done:true});await assert.rejects(promise,/大小/);h.ops.close();
});
