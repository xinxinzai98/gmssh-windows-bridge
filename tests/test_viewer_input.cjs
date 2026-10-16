const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm');
const esbuild=require('../desktop-web/node_modules/esbuild');
const compiled=esbuild.build({entryPoints:[path.join(__dirname,'../desktop-web/src/main.ts')],bundle:true,platform:'node',format:'cjs',write:false,loader:{'.css':'empty'},plugins:[{
  name:'mock-transports',setup(build){
    build.onResolve({filter:/^\.\/(direct|operations)$/},args=>({path:args.path,namespace:'mock'}));
    build.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='./direct'
      ?'export class DirectClient { constructor(canvas,events){this.events=events;this.connected=false;globalThis.setClient(this)} mouse(event){globalThis.recordMouse(event)} connect(...args){globalThis.recordConnect(args)} disconnect(){this.connected=false;this.events.stopped()} }'
      :'export class Operations {}'}));
  }
}]});
async function harness(config,embedded=false){
  const nodes=new Map(),wire=[],connections=[],windowListeners=new Map();let client;
  function node(id){if(!nodes.has(id))nodes.set(id,{value:'',disabled:true,classList:{add(){},remove(){},toggle(){}},listeners:new Map(),attributes:new Map(),setAttribute(name,value){this.attributes.set(name,value)},getAttribute(name){return this.attributes.get(name)},addEventListener(name,handler){this.listeners.set(name,handler)},focus(){},setPointerCapture(){},width:1920,height:1080,getBoundingClientRect:()=>({left:10,top:40,width:1280,height:800})});return nodes.get(id)}
  const posts=[],window={setTimeout,clearTimeout,addEventListener:(name,handler)=>{if(!windowListeners.has(name))windowListeners.set(name,[]);windowListeners.get(name).push(handler)},removeEventListener:(name,handler)=>{const list=windowListeners.get(name)||[];const index=list.indexOf(handler);if(index>=0)list.splice(index,1);}};window.parent=embedded?{postMessage:(data,origin)=>posts.push({data,origin})}:window;
  const scope={window,setTimeout,clearTimeout,document:{getElementById:node,querySelectorAll:()=>[],addEventListener(){}},location:{hash:'',href:'http://127.0.0.1/test'},URL,URLSearchParams,TextEncoder,
    fetch:config?async()=>({ok:true,json:async()=>({transport:'monitor',keychain:true,has_saved_password:true,capabilities:{},...config})}):()=>new Promise(()=>{}),
    requestAnimationFrame:()=>1,recordMouse:event=>wire.push(JSON.parse(JSON.stringify(event))),recordConnect:args=>connections.push(JSON.parse(JSON.stringify(args))),setClient:value=>{client=value}};
  vm.runInNewContext((await compiled).outputFiles[0].text,scope);
  await new Promise(resolve=>setImmediate(resolve));
  const pointer=(name,x,y,button=0,buttons=0)=>node('screen').listeners.get(name)({clientX:x,clientY:y,button,buttons,pointerId:1,preventDefault(){}});
  // Replay a peer that positions its pointer on move messages before applying buttons.
  function clicks(){let cursor={x:-1,y:-1};const output=[];for(const event of wire){const kind=event.mask&7;if(kind===0)cursor={x:event.x,y:event.y};else if(kind===1||kind===2)output.push({kind,button:event.mask>>3,...cursor})}return output}
  const reopen=(source=window.parent)=>{for(const handler of windowListeners.get('message')||[])handler({source,data:{type:'gmssh-desktop-tool',tool:'reconnect'}})};
  return {pointer,clicks,reopen,connections,node,client,posts,message(data,source=window.parent){for(const handler of [...windowListeners.get('message')||[]])handler({data,source,origin:'null'});}};
}
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
