const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {AIAccess}=require('../gmssh_windows_bridge/ai-manager.cjs');

function fixture({deferred=false}={}){
 const calls=[],copies=[],owner={},secret='GMSSH-AUTH2.synthetic-sensitive-code';let pending;
 const manager=new AIAccess({python:'/synthetic/python',root:'/synthetic/private ai',clipboard:{readText:()=>secret,writeText:text=>copies.push(text)},spawnWorker:(program,args,options)=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stdin=new EventEmitter();
  child.stdin.end=text=>{calls.push({program,args,options,value:text&&JSON.parse(text)});const response=()=>{const request=text&&JSON.parse(text);const data=request?.action==='preview'?{id:'a'.repeat(32),name:'合成电脑',existing:false}:request?.action==='config'?{text:'safe configuration'}:{saved:true};const raw=Buffer.from(JSON.stringify({ok:true,data}));for(const byte of raw)child.stdout.emit('data',Buffer.from([byte]));child.emit('close',0);};if(deferred)pending=response;else setImmediate(response);};
  child.kill=()=>{setImmediate(()=>child.emit('close',1));};return child;
 }});
 return {manager,calls,copies,owner,secret,release:()=>pending?.()};
}
test('stage authorization in main, preserve UTF-8 and never send it through argv or preview results',async()=>{
 const c=fixture();const preview=await c.manager.invoke(c.owner,{action:'paste-preview',data:{}});
 assert.equal(preview.name,'合成电脑');assert.ok(!JSON.stringify(preview).includes(c.secret));assert.ok(!JSON.stringify(c.calls[0].args).includes(c.secret));assert.equal(c.calls[0].value.data.code,c.secret);
 await c.manager.invoke(c.owner,{action:'enroll',data:{preview:preview.preview,name:'合成电脑',allow:['inspect']}});
 assert.equal(c.calls[1].value.data.code,c.secret);assert.equal(c.calls[1].value.data.replace,false);assert.equal(c.manager.pending.size,0);
 c.manager.close();
});
test('reject forged previews, caller commands and other-window enrollment before spawning',async()=>{
 const c=fixture();await assert.rejects(c.manager.invoke(c.owner,{action:'doctor',data:{command:'unexpected'}}),{code:'INVALID_ARGUMENT'});
 const preview=await c.manager.invoke(c.owner,{action:'preview',data:{code:c.secret}}),before=c.calls.length;
 await assert.rejects(c.manager.invoke({}, {action:'enroll',data:{preview:preview.preview,name:'x',allow:['inspect']}}),{code:'AI_PREVIEW_REQUIRED'});
 assert.equal(c.calls.length,before);c.manager.close();
});
test('closing a preview cancels its child and cannot re-stage a late secret',async()=>{
 const c=fixture({deferred:true});const action=c.manager.invoke(c.owner,{action:'preview',data:{code:c.secret}});
 await c.manager.invoke(c.owner,{action:'clear',data:{}});c.release();await assert.rejects(action,{code:'AI_CANCELLED'});
 assert.equal(c.manager.pending.size,0);c.manager.close();
});
test('configuration copy is generated in main and never accepts arbitrary clipboard contents',async()=>{
 const c=fixture();await c.manager.invoke(c.owner,{action:'copy',data:{format:'codex'}});
 assert.deepEqual(c.copies,['safe configuration']);assert.deepEqual(c.calls[0].value,{action:'config',data:{format:'codex'}});
 await assert.rejects(c.manager.invoke(c.owner,{action:'copy',data:{format:'json',text:'untrusted'}}),{code:'INVALID_ARGUMENT'});c.manager.close();
});
test('task history accepts only fixed read actions and rejects execution fields',async()=>{
 const c=fixture();await c.manager.invoke(c.owner,{action:'history',data:{device:'a'.repeat(32)}});
 await c.manager.invoke(c.owner,{action:'task',data:{device:'a'.repeat(32),taskId:'b'.repeat(32)}});
 assert.deepEqual(c.calls.map(v=>v.value.action),['history','task']);const before=c.calls.length;
 await assert.rejects(c.manager.invoke(c.owner,{action:'task',data:{device:'a'.repeat(32),taskId:'b'.repeat(32),script:'unexpected'}}),{code:'INVALID_ARGUMENT'});
 await assert.rejects(c.manager.invoke(c.owner,{action:'cancel',data:{device:'a'.repeat(32),taskId:'b'.repeat(32)}}),{code:'INVALID_ARGUMENT'});
 assert.equal(c.calls.length,before);c.manager.close();
});
