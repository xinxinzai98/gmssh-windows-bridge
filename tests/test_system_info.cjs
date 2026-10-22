const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(){
  const listeners={},sockets=[],sent=[],replies=[],timers=new Map();let next=0;
  const parent={postMessage:value=>replies.push(value)};
  class Socket{constructor(){sockets.push(this);}send(text){assert.ok(!this.closed,'a closed sampling socket must not send');sent.push(JSON.parse(text));}close(){this.closed=true;}}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../desktop-web/public/system-info.js'),'utf8'),{window:{parent,addEventListener:(name,fn)=>listeners[name]=fn},location:{origin:'http://127.0.0.1:22253'},WebSocket:Socket,setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)});
  const deliver=()=>listeners.message({source:parent,origin:'null',data:{type:'gmssh-system-info-request',requestId:7,token:'s'.repeat(43)}});
  return {sockets,sent,replies,timers,deliver};
}
test('sampling keeps fixed failure stages without exporting remote details or credentials',()=>{
  for(const [remote,expected] of [['OPERATION_TIMEOUT','OPERATION_TIMEOUT'],['private-remote-detail','QUERY_FAILED'],['constructor','QUERY_FAILED']]){
    const f=fixture();f.deliver();const s=f.sockets[0];s.onopen();s.onmessage({data:JSON.stringify({type:'operations_ready'})});
    s.onmessage({data:JSON.stringify({id:1,ok:false,code:remote,message:'private-response-secret'})});
    assert.equal(f.replies[0].code,expected);assert.equal(f.replies[0].stage,'query');assert.ok(Number.isFinite(f.replies[0].elapsedMs));
    assert.ok(!JSON.stringify(f.replies).includes('private-'));assert.ok(!JSON.stringify(f.replies).includes('s'.repeat(43)));assert.equal(f.timers.size,0);
  }
});
test('operation channel rejection is reported before starting the fixed query',()=>{
  const f=fixture();f.deliver();const s=f.sockets[0];s.onopen();
  s.onmessage({data:JSON.stringify({type:'error',code:'OperationsUnavailable',message:'private-channel-detail'})});
  assert.equal(f.replies[0].code,'OPERATIONS_UNAVAILABLE');assert.equal(f.replies[0].stage,'authorize');
  assert.equal(f.sent.length,1);assert.equal(f.timers.size,0);assert.ok(!JSON.stringify(f.replies).includes('private-'));
});
test('sampling timeout closes once and ignores late authentication and query callbacks',()=>{
  const f=fixture();f.deliver();const s=f.sockets[0];f.timers.values().next().value();
  assert.equal(f.replies[0].code,'SYSTEM_INFO_TIMEOUT');assert.equal(f.replies[0].stage,'connect');
  assert.doesNotThrow(()=>s.onopen());assert.doesNotThrow(()=>s.onmessage({data:JSON.stringify({type:'operations_ready'})}));
  assert.equal(f.sent.length,0);assert.equal(f.replies.length,1);f.deliver();assert.equal(f.sockets.length,2);
});
test('information bridge keeps credentials out of URLs and permits only its fixed read operation',()=>{
  const listeners={},sockets=[],sent=[],replies=[],parent={postMessage:(...args)=>replies.push(args)};
  class Socket{constructor(url){this.url=url;sockets.push(this);}send(text){sent.push(JSON.parse(text));}close(){this.closed=true;}}
  const source=fs.readFileSync(path.join(__dirname,'../desktop-web/public/system-info.js'),'utf8');
  vm.runInNewContext(source,{window:{parent,addEventListener:(name,fn)=>listeners[name]=fn},location:{origin:'http://127.0.0.1:22253'},WebSocket:Socket,setTimeout:()=>1,clearTimeout:()=>{}});
  const request={type:'gmssh-system-info-request',requestId:4,token:'s'.repeat(43)};
  const deliver=(source,data=request)=>listeners.message({source,data,origin:'null'});
  deliver({},request);deliver(parent,{...request,token:'bad'});assert.equal(sockets.length,0);
  deliver(parent);assert.equal(sockets[0].url,'ws://127.0.0.1:22253/operations');
  sockets[0].onopen();assert.equal(sent[0].token,request.token);
  sockets[0].onmessage({data:JSON.stringify({type:'operations_ready'})});assert.deepEqual(sent[1],{id:1,op:'system-info'});
  deliver(parent);assert.equal(sockets.length,1);
  sockets[0].onmessage({data:JSON.stringify({id:1,ok:true,info:{cpu:'fixture'}})});
  assert.equal(replies[0][0].requestId,4);assert.equal(replies[0][0].info.cpu,'fixture');assert.equal(replies[0][1],'*');assert.equal(sockets[0].closed,true);
  assert.equal('token' in replies[0][0],false);
  deliver(parent);sockets[1].onmessage({data:JSON.stringify({ok:false})});assert.equal(replies[1][0].ok,false);
});
