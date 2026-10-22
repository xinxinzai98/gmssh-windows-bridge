const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm');
const esbuild=require('../desktop-web/node_modules/esbuild');
const compiled=esbuild.build({entryPoints:[path.join(__dirname,'../desktop-web/src/main.ts')],bundle:true,platform:'node',format:'cjs',write:false,loader:{'.css':'empty'},plugins:[{
  name:'mock-transports',setup(build){
    build.onResolve({filter:/^\.\/(direct|operations)$/},args=>({path:args.path,namespace:'mock'}));
    build.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='./direct'
      ?'export class DirectClient { constructor(canvas,events){this.events=events;this.connected=false;globalThis.setClient(this)} mouse(event){globalThis.recordMouse(event)} connect(...args){globalThis.recordConnect(args)} disconnect(){this.connected=false;this.events.stopped()} unlockWindows(password){globalThis.recordUnlock(password)} }'
      :'export class Operations { request(op,values){return globalThis.recordOperation(op,values)} close(){} }'}));
  }
}]});
async function harness(config,embedded=false){
  const nodes=new Map(),wire=[],connections=[],windowListeners=new Map(),operationRequests=[],unlocks=[];let client,operationReply={configured:false,autoUnlock:false},statusReplies=[];
  function node(id){if(!nodes.has(id))nodes.set(id,{value:'',disabled:true,classList:{add(){},remove(){},toggle(){}},listeners:new Map(),attributes:new Map(),append(){},before(){},after(){},showModal(){this.open=true},querySelectorAll:()=>[],setAttribute(name,value){this.attributes.set(name,value)},getAttribute(name){return this.attributes.get(name)},addEventListener(name,handler){this.listeners.set(name,handler)},focus(){},blur(){this.blurred=true;this.listeners.get('blur')?.()},setPointerCapture(){},width:1920,height:1080,getBoundingClientRect:()=>({left:10,top:40,width:1280,height:800})});return nodes.get(id)}
  let timerId=0;const timers=new Map();
  const posts=[],window={setTimeout(handler,delay){if(![1000,2000,4000,8000].includes(delay))return setTimeout(handler,delay);const id=++timerId;timers.set(id,{handler,delay});return id},clearTimeout(id){if(!timers.delete(id))clearTimeout(id)},addEventListener:(name,handler)=>{if(!windowListeners.has(name))windowListeners.set(name,[]);windowListeners.get(name).push(handler)},removeEventListener:(name,handler)=>{const list=windowListeners.get(name)||[];const index=list.indexOf(handler);if(index>=0)list.splice(index,1);}};window.parent=embedded?{postMessage:(data,origin)=>posts.push({data,origin})}:window;
  const scope={window,setTimeout,clearTimeout,clearInterval,document:{getElementById:node,createElement:tag=>node(Symbol(tag)),querySelectorAll:()=>[],addEventListener(){}},location:{hash:'',href:'http://127.0.0.1/test'},URL,URLSearchParams,TextEncoder,crypto:require('node:crypto').webcrypto,
    fetch:config?async()=>({ok:true,json:async()=>({transport:'monitor',keychain:true,has_saved_password:true,capabilities:{},...config})}):()=>new Promise(()=>{}),
    requestAnimationFrame:()=>1,recordMouse:event=>wire.push(JSON.parse(JSON.stringify(event))),recordConnect:args=>connections.push(JSON.parse(JSON.stringify(args))),setClient:value=>{client=value},recordUnlock:password=>unlocks.push(password),recordOperation:(op,values)=>{operationRequests.push({op,...values});return Promise.resolve(values?.action==='check'?(statusReplies.shift()||{state:'unknown'}):{...operationReply})}};
  vm.runInNewContext((await compiled).outputFiles[0].text,scope);
  await new Promise(resolve=>setImmediate(resolve));
  const pointer=(name,x,y,button=0,buttons=0)=>node('screen').listeners.get(name)({clientX:x,clientY:y,button,buttons,pointerId:1,preventDefault(){}});
  // Replay a peer that positions its pointer on move messages before applying buttons.
  function clicks(){let cursor={x:-1,y:-1};const output=[];for(const event of wire){const kind=event.mask&7;if(kind===0)cursor={x:event.x,y:event.y};else if(kind===1||kind===2)output.push({kind,button:event.mask>>3,...cursor})}return output}
  const reopen=(source=window.parent)=>{for(const handler of windowListeners.get('message')||[])handler({source,data:{type:'gmssh-desktop-tool',tool:'reconnect'}})};
  return {pointer,clicks,reopen,connections,node,client,posts,operationRequests,unlocks,runTransportTimer(){for(const [id,timer] of [...timers])if([2000,4000,8000].includes(timer.delay)){timers.delete(id);timer.handler()}},runRecoveryTimer(){for(const [id,timer] of [...timers])if(timer.delay===2000){timers.delete(id);timer.handler()}},async runStatusTimer(){for(const [id,timer] of [...timers])if(timer.delay===1000){timers.delete(id);timer.handler()}await new Promise(resolve=>setImmediate(resolve))},windowEvent(name){for(const handler of windowListeners.get(name)||[])handler()},setStatusReplies(value){statusReplies=value},setOperationReply(value){operationReply=value},message(data,source=window.parent){for(const handler of [...windowListeners.get('message')||[]])handler({data,source,origin:'null'});}};
}
test('transient desktop transport loss gets three saved-connection attempts without replaying input or resetting on a brief frame',async()=>{
  const h=await harness({});h.client.connected=true;h.client.events.frame();h.node('desktop-input').value='uncommitted synthetic input';
  for(let i=0;i<4;i++){
    h.client.connected=false;h.client.events.lifecycle('failed','OPERATION_TIMEOUT');h.client.events.stopped();h.runTransportTimer();
    if(i<3){assert.equal(h.connections.length,i+1);assert.match(h.node('status').textContent,/重新连接/);h.client.connected=true;h.client.events.frame();}
  }
  assert.equal(h.connections.length,3);assert.equal(h.node('desktop-input').value,'');assert.equal(h.node('desktop-input').blurred,true);
  assert.ok(h.connections.every(args=>JSON.stringify(args)==='["","","monitor",{"saved":true,"remember":false,"token":""}]'));
  assert.deepEqual(h.clicks(),[]);assert.deepEqual(h.unlocks,[]);
});
test('transport recovery stops for authorization, identity, remote rejection and explicit close reasons',async()=>{
  for(const code of ['AUTH_FAILED','ACCESS_DENIED','PEER_CHANGED','DESKTOP_AUTH_FAILED','SESSION_CLOSED','REMOTE_OPERATION_FAILED','DESKTOP_TRANSPORT_FAILED']){
    const h=await harness({});h.client.connected=true;h.client.events.frame();h.client.connected=false;h.client.events.lifecycle('failed',code);h.client.events.stopped();h.runTransportTimer();assert.equal(h.connections.length,0,code);
  }
});
test('typed credentials, missing saved authentication, manual disconnect and page close cancel a pending recovery',async()=>{
  for(const mode of ['typed','unsaved','disconnect','pagehide']){
    const h=await harness({has_saved_password:mode!=='unsaved'});h.client.connected=true;h.client.events.frame();h.client.connected=false;h.client.events.lifecycle('failed','REMOTE_IO');h.client.events.stopped();
    if(mode==='typed')h.node('desktop-password').value='synthetic-new-password';
    if(mode==='disconnect')h.node('disconnect').listeners.get('click')();
    if(mode==='pagehide')h.windowEvent('pagehide');
    h.runTransportTimer();assert.equal(h.connections.length,0,mode);
    if(mode==='typed'){assert.equal(h.node('desktop-password').value,'synthetic-new-password');assert.equal(h.node('connection-label').textContent,'未连接');assert.match(h.node('status').textContent,/手动连接/);}
  }
});
test('independent authorization reconnects without a desktop password or another Windows-unlock attempt',async()=>{
  const h=await harness({keychain:false,has_saved_password:false,authorization:{view:true,input:false,clipboard:false,files:false,terminal:false,power:false}},true);
  h.message({type:'gmssh-desktop-access',token:'A'.repeat(43)});h.client.connected=true;h.client.events.frame();h.client.connected=false;h.client.events.lifecycle('failed','REMOTE_IO');h.client.events.stopped();h.runTransportTimer();
  assert.deepEqual(h.connections,[['','','monitor',{saved:false,remember:false,token:'A'.repeat(43)}]]);assert.deepEqual(h.unlocks,[]);assert.equal(h.operationRequests.length,0);
});
test('an explicit remote desktop rejection also cancels the one-time Windows-login recovery',async()=>{
  for(const code of ['SESSION_CLOSED','REMOTE_OPERATION_FAILED']){
    const h=await harness({capabilities:{windows_login:true}});h.client.connected=true;h.client.windowsUnlockSupported=true;h.client.connectionGeneration=1;
    h.setOperationReply({configured:true,autoUnlock:true,password:'synthetic-Windows-secret'});h.client.events.frame();await new Promise(resolve=>setImmediate(resolve));
    h.client.connected=false;h.client.events.lifecycle('failed',code);h.client.events.stopped();h.runTransportTimer();assert.equal(h.connections.length,0,code);assert.equal(h.unlocks.length,1);
  }
});
test('an immediate click reaches the scaled canvas position without a preceding move',async()=>{
  const h=await harness();h.pointer('pointerdown',650,440);h.pointer('pointerup',650,440);
  assert.deepEqual(h.clicks(),[{kind:1,button:1,x:960,y:540},{kind:2,button:1,x:960,y:540}]);
});
test('rapid movement, right click and drag release keep their final positions before the next animation frame',async()=>{
  const h=await harness();h.pointer('pointermove',40,150);h.pointer('pointerdown',800,300,2,2);h.pointer('pointermove',850,400,2,2);h.pointer('pointerup',900,500,2);
  assert.deepEqual(h.clicks(),[{kind:1,button:2,x:1185,y:330},{kind:2,button:2,x:1335,y:630}]);
});
test('reopening a disconnected viewer uses only saved authentication and ignores concurrent or connected requests',async()=>{
  const h=await harness({});h.reopen({});assert.equal(h.connections.length,0);
  h.reopen();assert.deepEqual(h.connections,[['','','monitor',{saved:true,remember:false,token:''}]]);
  h.reopen();assert.equal(h.connections.length,1);
  h.node('connect').disabled=false;h.client.connected=true;h.reopen();assert.equal(h.connections.length,1);
});
test('reopening never submits a typed password or retries unavailable saved credentials',async()=>{
  for(const config of [{has_saved_password:false},{keychain:false},{transport:'ssh'}]){
    const h=await harness(config);h.reopen();assert.equal(h.connections.length,0);
  }
  const h=await harness({});h.node('desktop-password').value='synthetic-typed-secret';h.reopen();
  assert.equal(h.connections.length,0);assert.equal(h.node('desktop-password').value,'synthetic-typed-secret');
  h.node('desktop-password').value='';h.client.events.credential(false);h.reopen();assert.equal(h.connections.length,0);
});
test('connection settings stay open across live frames and allow disconnecting then reopening the same viewer',async()=>{
  const h=await harness({});h.client.connected=true;h.client.events.frame();
  assert.equal(h.node('login-wrap').hidden,true);
  h.node('reconnect').onclick();h.client.events.frame();h.client.events.frame();
  assert.equal(h.node('login-wrap').hidden,false);
  h.node('disconnect').listeners.get('click')();
  assert.equal(h.client.connected,false);assert.equal(h.node('connect').disabled,false);
  h.reopen();assert.equal(h.connections.length,1);
  h.client.events.frame();assert.equal(h.node('login-wrap').hidden,true);
});
test('the embedded desktop files button delegates to the independent center without requiring a desktop connection',async()=>{
  const h=await harness({capabilities:{files:true}},true);h.node('file-panel').hidden=true;h.node('files').onclick();
  assert.equal(h.posts[0].data.type,'gmssh-open-file-center');assert.equal(h.node('file-panel').hidden,true);assert.equal(h.connections.length,0);
  h.message({type:'gmssh-file-center-opened',requestId:h.posts[0].data.requestId});await new Promise(resolve=>setTimeout(resolve,1250));assert.equal(h.node('file-panel').hidden,true);
});
test('an older parent that does not acknowledge independent files retains the existing sidebar',async()=>{
  const h=await harness({capabilities:{files:true}},true);h.node('file-panel').hidden=true;h.node('files').onclick();
  h.message({type:'gmssh-file-center-opened',requestId:h.posts[0].data.requestId},{});await new Promise(resolve=>setTimeout(resolve,1250));assert.equal(h.node('file-panel').hidden,false);assert.equal(h.connections.length,0);
});

test('failed desktop authentication stops saved-credential retries until an explicit login submission',async()=>{
  const h=await harness({});h.client.events.lifecycle('failed','DESKTOP_AUTH_FAILED');h.reopen();h.reopen();assert.equal(h.connections.length,0);
  h.node('desktop-password').value='synthetic-new-login';h.node('login').listeners.get('submit')({preventDefault(){}});assert.equal(h.connections.length,1);assert.equal(h.node('desktop-password').value,'');
});

test('Windows auto-unlock stays off by default and only tries once across frames and reconnects',async()=>{
  const h=await harness({capabilities:{windows_login:true}});h.client.connected=true;h.client.windowsUnlockSupported=true;h.client.connectionGeneration=1;
  h.client.events.frame();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.unlocks.length,0);
  const enabled=await harness({capabilities:{windows_login:true}});enabled.client.connected=true;enabled.client.windowsUnlockSupported=true;enabled.client.connectionGeneration=1;
  enabled.setOperationReply({configured:true,autoUnlock:true,password:'synthetic-Windows-secret'});
  enabled.client.events.frame();enabled.client.events.frame();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(enabled.unlocks,['synthetic-Windows-secret']);
  enabled.client.events.stopped();enabled.client.events.frame();await new Promise(resolve=>setImmediate(resolve));assert.equal(enabled.unlocks.length,1);
  assert.equal(enabled.node('desktop-password').value,'');assert.equal(enabled.node('windows-login-password').value,'');
});
test('an incompatible peer never fetches Windows credentials and disabling removes only Windows settings',async()=>{
  const h=await harness({capabilities:{windows_login:true}});h.client.connected=true;h.client.windowsUnlockSupported=false;
  h.client.events.frame();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.operationRequests.length,0);
  h.node('desktop-password').value='synthetic-connection-password';
  await h.node('windows-unlock').onclick();h.node('windows-auto-unlock').checked=false;await h.node('save-windows-unlock').onclick();
  assert.equal(h.operationRequests.at(-1).action,'clear');assert.equal(h.node('desktop-password').value,'synthetic-connection-password');
  assert.equal(h.unlocks.length,0);
});
test('a Windows login session switch reconnects once using only saved desktop authentication',async()=>{
  const h=await harness({capabilities:{windows_login:true}});h.client.connected=true;h.client.windowsUnlockSupported=true;h.client.connectionGeneration=1;
  h.setOperationReply({configured:true,autoUnlock:true,password:'synthetic-Windows-secret'});
  h.client.events.frame();await new Promise(resolve=>setImmediate(resolve));
  h.client.connected=false;h.client.events.lifecycle('failed','DESKTOP_FAILED');h.client.events.stopped();h.runRecoveryTimer();
  assert.deepEqual(h.connections,[['','','monitor',{saved:true,remember:false,token:''}]]);
  h.client.connected=true;h.client.events.frame();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.unlocks,['synthetic-Windows-secret']);
  h.client.connected=false;h.client.events.lifecycle('failed','DESKTOP_FAILED');h.client.events.stopped();h.runRecoveryTimer();assert.equal(h.connections.length,1);
});
test('login recovery respects manual disconnect, authentication failure and unsaved credentials',async()=>{
  for(const mode of ['off','disconnect','auth','unsaved','typed']){
    const h=await harness({capabilities:{windows_login:true},has_saved_password:mode!=='unsaved'});h.client.connected=true;h.client.windowsUnlockSupported=true;
    if(mode!=='off')h.setOperationReply({configured:true,autoUnlock:true,password:'synthetic-Windows-secret'});
    h.client.events.frame();await new Promise(resolve=>setImmediate(resolve));h.client.connected=false;
    h.client.events.lifecycle('failed',mode==='auth'?'DESKTOP_AUTH_FAILED':'DESKTOP_FAILED');h.client.events.stopped();
    if(mode==='disconnect')h.node('disconnect').listeners.get('click')();
    if(mode==='typed')h.node('desktop-password').value='synthetic-typed-secret';
    h.runRecoveryTimer();assert.equal(h.connections.length,0,mode);
  }
});
test('Windows unlock success comes from the live result, without another password attempt',async()=>{
  const h=await harness({capabilities:{windows_login:true}});h.client.connected=true;h.client.windowsUnlockSupported=true;h.client.connectionGeneration=1;
  h.setOperationReply({configured:true,autoUnlock:true,password:'synthetic-Windows-secret'});h.setStatusReplies([{state:'locked-or-secure'},{state:'unlocked'}]);
  h.client.events.frame();await new Promise(resolve=>setImmediate(resolve));
  assert.match(h.node('status').textContent,/正在确认/);await h.runStatusTimer();assert.doesNotMatch(h.node('status').textContent,/当前已解锁/);
  h.client.events.stopped();h.client.events.frame();await h.runStatusTimer();
  assert.equal(h.node('status').textContent,'Windows 当前已解锁。');assert.equal(h.node('windows-unlock-note').textContent,'Windows 当前已解锁。');
  assert.deepEqual(h.unlocks,['synthetic-Windows-secret']);assert.equal(h.operationRequests.filter(x=>x.action==='load').length,1);
  assert.ok(h.operationRequests.filter(x=>x.action==='check').every(x=>JSON.stringify(x.settings)==='{}'));
});
test('unconfirmed Windows login stays explicit and disconnect cancels pending result queries',async()=>{
  for(const mode of ['timeout','disconnect','unauthorized']){
    const h=await harness({capabilities:{windows_login:true}});h.client.connected=true;h.client.windowsUnlockSupported=true;
    h.setOperationReply({configured:true,autoUnlock:true,password:'synthetic-Windows-secret'});
    if(mode==='unauthorized')h.setStatusReplies([{state:'unauthorized'}]);
    h.client.events.frame();await new Promise(resolve=>setImmediate(resolve));
    if(mode==='disconnect')h.node('disconnect').listeners.get('click')();
    for(let i=0;i<31;i++)await h.runStatusTimer();
    assert.equal(h.unlocks.length,1);
    if(mode==='disconnect')assert.equal(h.operationRequests.filter(x=>x.action==='check').length,0);
    else if(mode==='unauthorized')assert.match(h.node('status').textContent,/授权或设备身份/);
    else assert.match(h.node('status').textContent,/未能确认.*不会自动重试密码/);
  }
});
