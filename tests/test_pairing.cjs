const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {PairingManager,loopbackRequest}=require('../gmssh_windows_bridge/pairing.cjs');

const fixture={schema:1,id:'a'.repeat(32),computer:'LAB-PC',username:'gmssh',addresses:['192.0.2.42'],sshPort:22,
  sshHostPublicKey:'ssh-ed25519 synthetic-public',sshHostFingerprint:'SHA256:synthetic',adapters:[]};
function harness(root,options={}) {
  const events=[],records=[],starts=[];
  let nextPort=35000,adds=0;
  const manager=new PairingManager({root,legacy:options.legacy||[],keychain:options.keychain!==false,
    inspect:async request=>{events.push(request.operation);if(request.operation==='inspect'){const value=JSON.parse(request.connection);return {...value,id:value.sshHostFingerprint==='SHA256:second'?'b'.repeat(32):fixture.id,adapters:value.adapters||[]};}if(options.changedKey)throw Error('host identity changed');return {verified:true};},
    port:async reserved=>{while(reserved.has(nextPort))nextPort++;reserved.add(nextPort);return nextPort++;},
    startDevice:async value=>{starts.push(value);events.push('start');return {...value,accessToken:'s'.repeat(43)};},
    api:async(endpoint,data)=>{
      events.push(endpoint);
      if(endpoint==='/node/list')return {code:0,data:{list:records}};
      if(endpoint==='/node/test'){assert.equal(data.authValue,'synthetic-secret');assert.equal(data.sudoPolicy,'skip');return {code:options.authFailure?1:0};}
      if(endpoint==='/node/add'){adds++;const record={...data,id:String(adds).padStart(32,'0')};delete record.authValue;records.push(record);if(options.lostAddResponse)throw Error('response lost');return {code:0,data:{id:record.id}};}
      if(endpoint==='/node/detail'){const found=records.find(value=>value.id===data.id);return {code:0,data:options.badDetail?{...found,port:found.port+1}:found};}
      throw Error('unexpected native endpoint');
    },changed:async()=>events.push('changed')});
  return {manager,events,records,starts,adds:()=>adds};
}
async function temporary(action) {const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmssh-pair-'));try{await action(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}
const connect=manager=>manager.connect({id:fixture.id,target:fixture.addresses[0],name:'Lab desktop',password:'synthetic-secret'});

test('enrolls a pinned device through native test/add, stores no password or session token and restores it',async()=>temporary(async root=>{
  const current=harness(root);
  current.records.push({id:'9'.repeat(32),ip:'127.0.0.1',port:35000,userName:'unrelated'});
  await current.manager.inspect(JSON.stringify(fixture));
  const result=await connect(current.manager);
  assert.equal(result.existing,false);assert.equal(current.adds(),1);
  assert.deepEqual(current.events,['inspect','probe','/node/list','start','/node/test','/node/add','/node/detail','changed']);
  assert.equal(current.starts[0].monitor.port,35001);
  const body=fs.readFileSync(path.join(root,'catalog.json'),'utf8');
  assert.ok(!body.includes('synthetic-secret')&&!body.includes('accessToken')&&!body.includes('s'.repeat(43)));
  assert.equal(fs.statSync(path.join(root,'catalog.json')).mode&0o777,0o600);
  await connect(current.manager);assert.equal(current.adds(),1);
  const restored=harness(root);await restored.manager.restore();
  assert.equal(restored.starts.length,1);assert.equal(restored.manager.bindings()[0].machineId,result.machineId);
}));

test('retains one pending entry after failed authentication, and retries its existing ports without duplicate records',async()=>temporary(async root=>{
  const settings={authFailure:true},current=harness(root,settings);
  await current.manager.inspect(JSON.stringify(fixture));
  await assert.rejects(connect(current.manager),/认证未通过/);
  assert.equal(current.adds(),0);assert.equal(current.manager.records.length,1);
  const ports=current.manager.records.map(value=>[value.monitorPort,value.desktopPort]);
  settings.authFailure=false;
  await connect(current.manager);
  assert.equal(current.adds(),1);assert.equal(current.starts.length,1);
  assert.deepEqual(current.manager.records.map(value=>[value.monitorPort,value.desktopPort]),ports);
}));

test('recovers a lost add response by exact native endpoint/account match',async()=>temporary(async root=>{
  const current=harness(root,{lostAddResponse:true});
  await current.manager.inspect(JSON.stringify(fixture));
  const result=await connect(current.manager);
  assert.ok(result.machineId);assert.equal(current.adds(),1);
  await connect(current.manager);assert.equal(current.adds(),1);
}));

test('checks live identity before any native authentication and recognizes an existing legacy binding without storing anything',async()=>temporary(async root=>{
  const bad=harness(root,{changedKey:true});await bad.manager.inspect(JSON.stringify(fixture));
  await assert.rejects(connect(bad.manager),/identity changed/);assert.deepEqual(bad.events,['inspect','probe']);
  const legacy=[{machineId:'b'.repeat(32),target:'192.0.2.42',fingerprint:fixture.sshHostFingerprint,monitor:{username:'gmssh',targetPort:22}}];
  const old=harness(root,{legacy});const inspected=await old.manager.inspect(JSON.stringify(fixture));
  assert.equal(inspected.existing.machineId,'b'.repeat(32));
  const result=await old.manager.connect({id:fixture.id,target:'192.0.2.42',name:'Existing'});
  assert.equal(result.existing,true);assert.deepEqual(old.events,['inspect','probe','changed']);
  assert.equal(fs.existsSync(path.join(root,'catalog.json')),false);
}));

test('does not follow a changed saved host identity, and rejects duplicate or colliding catalog ports',async()=>temporary(async root=>{
  const current=harness(root);await current.manager.inspect(JSON.stringify(fixture));await connect(current.manager);
  fs.writeFileSync(path.join(root,fixture.id,'known_hosts'),'changed identity');
  const restored=harness(root);const errors=await restored.manager.restore();
  assert.equal(restored.starts.length,0);assert.equal(errors.length,1);
  const file=path.join(root,'catalog.json'),catalog=JSON.parse(fs.readFileSync(file));
  catalog.devices[0].desktopPort=catalog.devices[0].monitorPort;fs.writeFileSync(file,JSON.stringify(catalog));
  await assert.rejects(harness(root).manager.restore(),/端口冲突/);
}));

test('shared desktop authentication is handed off once, expires, and never enters the catalog',async()=>temporary(async root=>{
  const current=harness(root),shared={...fixture,desktopAuth:'shared-ssh'};
  await current.manager.inspect(JSON.stringify(shared));
  const result=await current.manager.connect({id:fixture.id,target:fixture.addresses[0],name:'Shared login',password:'synthetic-secret',rememberDesktop:true});
  assert.deepEqual(current.manager.takeDesktopAuth(result.machineId),{password:'synthetic-secret',remember:true});
  assert.equal(current.manager.takeDesktopAuth(result.machineId),null);
  current.manager.initialAuth.set(result.machineId,{password:'expired',expires:Date.now()-1});
  assert.equal(current.manager.takeDesktopAuth(result.machineId),null);
  assert.ok(!fs.readFileSync(path.join(root,'catalog.json'),'utf8').includes('synthetic-secret'));
}));

test('restores multiple independent devices without replacing their ports or identities',async()=>temporary(async root=>{
  const current=harness(root);await current.manager.inspect(JSON.stringify(fixture));await connect(current.manager);
  const second={...fixture,id:'b'.repeat(32),computer:'SECOND-PC',addresses:['192.0.2.43'],sshHostFingerprint:'SHA256:second'};
  await current.manager.inspect(JSON.stringify(second));
  await current.manager.connect({id:second.id,target:second.addresses[0],name:'Second desktop',password:'synthetic-secret'});
  const restored=harness(root);await restored.manager.restore();
  assert.equal(restored.starts.length,2);
  assert.equal(new Set(restored.starts.flatMap(value=>[value.port,value.monitor.port])).size,4);
  assert.equal(new Set(restored.manager.bindings().map(value=>value.machineId)).size,2);
}));

test('refuses a mismatched native record, then recovers the same created entry on retry',async()=>temporary(async root=>{
  const settings={badDetail:true},current=harness(root,settings);
  await current.manager.inspect(JSON.stringify(fixture));await assert.rejects(connect(current.manager),/入口与账号回读/);
  assert.equal(current.manager.bindings().length,0);assert.equal(current.adds(),1);
  settings.badDetail=false;await connect(current.manager);assert.equal(current.adds(),1);
  assert.equal(current.manager.bindings().length,1);
}));

test('checks native ports beyond the first page before allocating a bridge',async()=>temporary(async root=>{
  const current=harness(root),pages=[];
  current.manager.api=async(endpoint,data)=>{assert.equal(endpoint,'/node/list');pages.push(data.pageNum);return {code:0,data:{list:Array.from({length:data.pageNum===1?200:1},(_,index)=>({id:'a',ip:'127.0.0.1',port:35000+index,userName:'other'})),total:201}};};
  const records=await current.manager.nativeRecords();assert.equal(records.length,201);assert.deepEqual(pages,[1,2]);
}));

test('a controller without keychain opt-in cannot remember a desktop password',async()=>temporary(async root=>{
  const current=harness(root,{keychain:false});
  const preview=await current.manager.inspect(JSON.stringify({...fixture,desktopAuth:'shared-ssh'}));assert.equal(preview.canRememberDesktop,false);
  const result=await current.manager.connect({id:fixture.id,target:fixture.addresses[0],name:'No keychain',password:'synthetic-secret',rememberDesktop:true});
  assert.equal(current.starts[0].keychain,false);assert.equal(current.manager.takeDesktopAuth(result.machineId).remember,false);
}));

test('native requests stay on loopback, reject unknown operations and never follow a redirect',async()=>{
  let calls=0,redirect=false;
  const server=http.createServer((request,response)=>{calls++;assert.equal(request.url,'/node/test');let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{assert.equal(JSON.parse(body).authValue,'synthetic-secret');if(redirect){response.writeHead(302,{Location:'https://untrusted.invalid/'});response.end();}else response.end(JSON.stringify({code:0}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    assert.equal((await loopbackRequest(server.address().port,'/node/test',{authValue:'synthetic-secret'})).code,0);
    redirect=true;await assert.rejects(loopbackRequest(server.address().port,'/node/test',{authValue:'synthetic-secret'}));
    await assert.rejects(loopbackRequest(server.address().port,'/node/delete',{}));assert.equal(calls,2);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
