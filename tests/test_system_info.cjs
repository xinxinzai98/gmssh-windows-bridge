const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
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
