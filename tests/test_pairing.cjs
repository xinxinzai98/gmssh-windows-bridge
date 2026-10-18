const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {PairingManager,loopbackRequest}=require('../gmssh_windows_bridge/pairing.cjs');

const fixture={schema:1,id:'a'.repeat(32),computer:'LAB-PC',username:'gmssh',addresses:['192.0.2.42'],sshPort:22,
  sshHostPublicKey:'ssh-ed25519 synthetic-public',sshHostFingerprint:'SHA256:synthetic',adapters:[]};
test('code auto-address probes only before redeeming and explicit selection does not fall back',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmssh-auto-route-'));const {manager,events,records}=harness(root);const original=manager.request.bind(manager);
 try{
  manager.request=async request=>{if(request.operation==='choose-target'){events.push('choose-target');return {target:'192.0.2.42',verified:true};}return original(request);};
  await manager.inspect('GMSSH-CONNECT1.synthetic');await manager.connect({id:fixture.id,target:'192.0.2.42',name:'Automatic',autoTarget:true});
  assert.ok(events.indexOf('choose-target')<events.indexOf('redeem-code'));assert.equal(records.length,1);assert.equal(manager.records[0].autoTarget,true);assert.deepEqual(manager.bindings()[0].autoAddresses,['192.0.2.42']);
  events.length=0;await manager.inspect('GMSSH-CONNECT1.synthetic');await manager.connect({id:fixture.id,target:'192.0.2.42',name:'Explicit'});assert.ok(!events.includes('choose-target'));assert.equal(manager.records[0].autoTarget,false);assert.deepEqual(manager.bindings()[0].autoAddresses,[]);
 }finally{await Promise.all([...manager.running.values()].map(value=>value.stop?.()));fs.rmSync(root,{recursive:true,force:true});}
});
test('automatic addresses and their common pin survive reopening while manual targets remain fixed',async()=>temporary(async root=>{
 const h=harness(root),connection={...fixture,addresses:['192.0.2.42','2001:db8::42']};await h.manager.inspect(JSON.stringify(connection));await connect(h.manager);
 h.manager.records[0].autoTarget=true;h.manager.save();
 const reopened=harness(root);await reopened.manager.restore();assert.deepEqual(reopened.starts[0].autoAddresses,connection.addresses);
 const pins=fs.readFileSync(path.join(root,fixture.id,'known_hosts'),'utf8');assert.ok(pins.includes('2001:db8::42 '+fixture.sshHostPublicKey));
 reopened.manager.records[0].autoTarget=false;reopened.manager.save();const manual=harness(root);await manual.manager.restore();assert.deepEqual(manual.starts[0].autoAddresses,[]);
}));
function harness(root,options={}) {
  const events=[],records=[],starts=[];
  let nextPort=35000,adds=0;
  const manager=new PairingManager({root,legacy:options.legacy||[],keychain:options.keychain!==false,
    inspect:async request=>{events.push(request.operation);if(request.operation==='inspect'){const fromCode=request.connection.startsWith('GMSSH-CONNECT1.');const value=fromCode?{...fixture,desktopAuth:'shared-ssh'}:JSON.parse(request.connection);return {...value,id:value.sshHostFingerprint==='SHA256:second'?'b'.repeat(32):fixture.id,adapters:value.adapters||[],...(fromCode?{fromCode:true,connectionText:JSON.stringify(value)}:{})};}if(request.operation==='endpoint')return {target:options.endpointTarget||request.target,port:options.endpointPort||request.port};if(request.operation==='manual'){assert.equal(request.password,undefined);return {connectionText:JSON.stringify(options.manualConnection)};}if(options.changedKey)throw Error('host identity changed');if(request.operation==='test-login'){if(options.loginFailure)throw Error('pinned login failed');assert.equal(request.password,options.acceptedPassword||'synthetic-secret');}if(request.operation==='redeem-code'){if(options.revokedCode)throw Error('连接码已失效');return {password:options.acceptedPassword||'synthetic-secret'};}return {verified:true};},
    port:async reserved=>{while(reserved.has(nextPort))nextPort++;reserved.add(nextPort);return nextPort++;},
    startDevice:async value=>{starts.push(value);events.push('start');if(options.startFailure){options.startFailure=false;throw Error('start failed');}return {...value,accessToken:'s'.repeat(43),stop:async()=>events.push('stop')};},
    api:async(endpoint,data)=>{
      events.push(endpoint);
      if(endpoint==='/node/list')return {code:0,data:{list:records}};
      if(endpoint==='/node/test'){assert.equal(data.authValue,options.acceptedPassword||'synthetic-secret');assert.equal(data.sudoPolicy,'skip');return {code:options.authFailure?1:0};}
      if(endpoint==='/node/edit'){const record=records.find(value=>value.id===data.id);assert.ok(record);assert.equal(data.authValue,options.acceptedPassword||'synthetic-secret');const {authValue,...publicFields}=data;Object.assign(record,publicFields);return {code:0};}
      if(endpoint==='/node/add'){adds++;const record={...data,id:String(adds).padStart(32,'0')};delete record.authValue;records.push(record);if(options.lostAddResponse)throw Error('response lost');return {code:0,data:{id:record.id}};}
      if(endpoint==='/node/detail'){const found=records.find(value=>value.id===data.id),detail=options.badDetail?{...found,port:found.port+1}:{...found};if(options.omitSudoPolicy)delete detail.sudoPolicy;if(options.returnedSudoPolicy)detail.sudoPolicy=options.returnedSudoPolicy;return {code:0,data:detail};}
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

test('a reusable connection code fills credentials in memory, preserves the original card and never enters the catalog',async()=>temporary(async root=>{
  const options={},current=harness(root,options),code='GMSSH-CONNECT1.synthetic-access-credential';
  const preview=await current.manager.inspect(code);assert.equal(preview.fromCode,true);assert.ok(!JSON.stringify(preview).includes('synthetic-access-credential'));
  const form={id:fixture.id,target:fixture.addresses[0],name:'From code',rememberDesktop:true};
  const first=await current.manager.connect(form);assert.equal(current.adds(),1);
  assert.deepEqual(current.manager.takeDesktopAuth(first.machineId),{password:'synthetic-secret',remember:true});
  assert.equal(current.manager.preview.code,undefined);
  options.acceptedPassword='synthetic-new-secret';await current.manager.inspect(code);
  const second=await current.manager.connect(form);assert.equal(second.machineId,first.machineId);assert.equal(second.credentialsUpdated,true);assert.equal(current.adds(),1);
  const catalog=fs.readFileSync(path.join(root,'catalog.json'),'utf8');
  for(const secret of [code,'synthetic-secret',options.acceptedPassword,'synthetic-access-credential'])assert.ok(!catalog.includes(secret));
  assert.ok(current.events.indexOf('probe')<current.events.indexOf('redeem-code'));
  current.manager.takeDesktopAuth(first.machineId);
  options.revokedCode=true;await current.manager.inspect(code);const before=current.events.length;
  await assert.rejects(current.manager.connect(form),/已失效/);assert.ok(!current.events.slice(before).includes('/node/edit'));
  current.manager.clearPreview();assert.equal(current.manager.preview,null);
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

test('refreshes a changed password on the exact existing native record and hands the new desktop credential off once',async()=>temporary(async root=>{
  const options={},current=harness(root,options),shared={...fixture,desktopAuth:'shared-ssh'};
  await current.manager.inspect(JSON.stringify(shared));const first=await connect(current.manager);
  current.manager.takeDesktopAuth(first.machineId);
  const before=fs.readFileSync(path.join(root,'catalog.json'),'utf8');
  options.acceptedPassword='synthetic-rotated-secret';
  const preview=await current.manager.inspect(JSON.stringify(shared));
  assert.equal(preview.existing.name,'Lab desktop');
  const result=await current.manager.connect({id:fixture.id,target:fixture.addresses[0],name:'Ignored rename',password:options.acceptedPassword,refreshPassword:true,rememberDesktop:true});
  assert.equal(result.machineId,first.machineId);assert.equal(result.credentialsUpdated,true);assert.equal(current.adds(),1);
  assert.equal(current.records[0].name,'Lab desktop');assert.equal(current.starts.length,1);
  assert.deepEqual(current.manager.takeDesktopAuth(first.machineId),{password:options.acceptedPassword,remember:true});
  assert.equal(current.manager.takeDesktopAuth(first.machineId),null);
  assert.equal(fs.readFileSync(path.join(root,'catalog.json'),'utf8'),before);
}));

test('rejects an invalid replacement password or changed native endpoint before saving credentials',async()=>temporary(async root=>{
  const options={},current=harness(root,options);
  await current.manager.inspect(JSON.stringify(fixture));await connect(current.manager);
  const refresh={id:fixture.id,target:fixture.addresses[0],name:'Existing',password:'synthetic-secret',refreshPassword:true};
  options.authFailure=true;
  await assert.rejects(current.manager.connect(refresh),/认证未通过/);
  assert.ok(!current.events.includes('/node/edit'));assert.equal(current.manager.initialAuth.size,0);
  options.authFailure=false;options.badDetail=true;const count=current.events.length;
  await assert.rejects(current.manager.connect(refresh),/入口或账号不一致/);
  assert.deepEqual(current.events.slice(count),['probe','/node/detail']);assert.equal(current.adds(),1);
}));

test('accepts native detail responses without the write-only sudoPolicy and still rejects a conflicting policy',async()=>temporary(async root=>{
  const options={omitSudoPolicy:true},current=harness(root,options),shared={...fixture,desktopAuth:'shared-ssh'};
  await current.manager.inspect(JSON.stringify(shared));const first=await connect(current.manager);
  current.manager.takeDesktopAuth(first.machineId);
  options.acceptedPassword='synthetic-rotated-secret';
  const refresh={id:fixture.id,target:fixture.addresses[0],name:'Existing',password:options.acceptedPassword,refreshPassword:true};
  assert.equal((await current.manager.connect(refresh)).machineId,first.machineId);
  assert.ok(current.manager.takeDesktopAuth(first.machineId));
  options.returnedSudoPolicy='require';
  await assert.rejects(current.manager.connect(refresh),/未通过回读/);
  assert.equal(current.manager.initialAuth.size,0);assert.equal(current.adds(),1);
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

test('switches a verified IPv4 device to a supplied IPv6 address without changing its card or local ports',async()=>temporary(async root=>{
  const options={endpointTarget:'2001:db8::42'},current=harness(root,options);
  await current.manager.inspect(JSON.stringify({...fixture,desktopAuth:'shared-ssh'}));
  const first=await connect(current.manager);current.manager.takeDesktopAuth(first.machineId);
  const original={...current.manager.records[0]},count=current.events.length;
  const result=await current.manager.connect({id:fixture.id,target:'[2001:0DB8::0042]:22',name:'Ignored rename',password:'synthetic-secret',rememberDesktop:true});
  assert.equal(result.machineId,first.machineId);assert.equal(result.addressUpdated,true);assert.equal(current.adds(),1);
  const record=current.manager.records[0];
  assert.equal(record.target,'2001:db8::42');assert.equal(record.name,original.name);
  assert.deepEqual([record.monitorPort,record.desktopPort],[original.monitorPort,original.desktopPort]);
  assert.deepEqual(record.previousTargets,[fixture.addresses[0]]);
  assert.deepEqual(current.starts.at(-1).credentialAliases,[fixture.addresses[0]]);
  assert.ok(current.events.indexOf('test-login',count)<current.events.indexOf('stop',count));
  const known=fs.readFileSync(path.join(root,fixture.id,'known_hosts'),'utf8');
  assert.ok(known.includes('2001:db8::42 '+fixture.sshHostPublicKey)&&known.includes(fixture.addresses[0]+' '+fixture.sshHostPublicKey));
  assert.deepEqual(current.manager.takeDesktopAuth(first.machineId),{password:'synthetic-secret',remember:true});
  assert.ok(!fs.readFileSync(path.join(root,'catalog.json'),'utf8').includes('synthetic-secret'));
  const restored=harness(root);assert.deepEqual(await restored.manager.restore(),[]);
  assert.equal(restored.manager.bindings()[0].target,'2001:db8::42');assert.equal(restored.manager.bindings()[0].machineId,first.machineId);
  assert.equal((await restored.manager.edit(first.machineId)).existing.target,'2001:db8::42');
}));

test('rejects a changed SSH identity or invalid password before stopping the original address',async()=>temporary(async root=>{
  const options={endpointTarget:'2001:db8::42'},current=harness(root,options);
  await current.manager.inspect(JSON.stringify(fixture));await connect(current.manager);
  const original=fs.readFileSync(path.join(root,'catalog.json'),'utf8');
  const update={id:fixture.id,target:'2001:db8::42',name:'Same card',password:'synthetic-secret'};
  for(const failure of ['changedKey','loginFailure']){
    options[failure]=true;const count=current.events.length;
    await assert.rejects(current.manager.connect(update));
    assert.ok(!current.events.slice(count).includes('stop'));assert.equal(current.manager.bindings()[0].target,fixture.addresses[0]);
    assert.equal(fs.readFileSync(path.join(root,'catalog.json'),'utf8'),original);options[failure]=false;
  }
}));

test('rolls back the address, host pins, service and catalog when a replacement cannot start or save',async()=>temporary(async root=>{
  const options={endpointTarget:'2001:db8::42'},current=harness(root,options);
  await current.manager.inspect(JSON.stringify(fixture));await connect(current.manager);
  const file=path.join(root,'catalog.json'),knownFile=path.join(root,fixture.id,'known_hosts');
  const before=fs.readFileSync(file,'utf8'),knownBefore=fs.readFileSync(knownFile,'utf8');
  for(const failure of ['start','native-test','catalog-save']){
    options.startFailure=failure==='start';options.authFailure=failure==='native-test';
    const save=current.manager.save;
    if(failure==='catalog-save')current.manager.save=()=>{throw Error('synthetic disk full');};
    await assert.rejects(current.manager.connect({id:fixture.id,target:'2001:db8::42',name:'Same card',password:'synthetic-secret'}),/已保留原设备配置/);
    current.manager.save=save;options.authFailure=false;
    assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.readFileSync(knownFile,'utf8'),knownBefore);
    assert.equal(current.manager.bindings()[0].target,fixture.addresses[0]);assert.equal(current.adds(),1);
    assert.equal(current.manager.records[0].previousTargets,undefined);
  }
}));

test('adopts and restores the existing fixed-device card with its original bridge identity and reserved ports',async()=>temporary(async root=>{
  const machineId='c'.repeat(32),events=[];
  const legacy={machineId,target:fixture.addresses[0],port:22253,sshHostPublicKey:fixture.sshHostPublicKey,fingerprint:fixture.sshHostFingerprint,
    monitor:{username:'gmssh',targetPort:22,port:22252,hostKey:'/synthetic/original-bridge-host-key'},stop:async()=>events.push('legacy-stop')};
  const current=harness(root,{legacy:[legacy],endpointTarget:'2001:db8::42'});
  current.records.push({id:machineId,name:'Original A4',ip:'127.0.0.1',port:22252,userName:'gmssh',authType:'pass',sudoPolicy:'skip'});
  assert.equal((await current.manager.edit(machineId)).desktopAuth,'manual');
  const result=await current.manager.connect({id:fixture.id,target:'2001:db8::42',name:'Ignored rename',password:'synthetic-secret'});
  assert.equal(result.machineId,machineId);assert.equal(current.adds(),0);assert.deepEqual(events,['legacy-stop']);
  assert.equal(current.starts[0].monitor.hostKey,legacy.monitor.hostKey);
  assert.equal(current.starts[0].monitor.port,22252);assert.equal(current.starts[0].port,22253);
  assert.equal(legacy.target,fixture.addresses[0]);
  const restored=harness(root,{legacy:[legacy]});assert.deepEqual(await restored.manager.restore(),[]);
  assert.equal(restored.starts.length,1);assert.equal(restored.starts[0].machineId,machineId);
  const wrongLegacy={...legacy,fingerprint:'SHA256:different'};
  await assert.rejects(harness(root,{legacy:[wrongLegacy]}).manager.restore(),/身份或端口不一致/);
}));

test('manual IPv6 enrollment preserves an explicit nondefault SSH port and requires a new identity check for another port',async()=>temporary(async root=>{
  const options={manualConnection:{...fixture,addresses:['2001:db8::42'],sshPort:2222},endpointTarget:'2001:db8::42'},current=harness(root,options);
  const preview=await current.manager.manual({computer:'LAB-PC',target:'[2001:db8::42]:2222',port:22,username:'gmssh'});
  assert.equal(preview.fromManual,true);assert.equal(preview.sshPort,2222);
  const result=await current.manager.connect({id:fixture.id,target:'2001:db8::42',name:'Manual IPv6',password:'synthetic-secret'});
  assert.equal(result.existing,false);assert.equal(current.starts[0].monitor.targetPort,2222);
  assert.ok(fs.readFileSync(path.join(root,fixture.id,'known_hosts'),'utf8').startsWith('[2001:db8::42]:2222 '));
  options.endpointPort=2223;const before=current.events.length;
  await assert.rejects(current.manager.connect({id:fixture.id,target:'[2001:db8::42]:2223',name:'Manual IPv6',password:'synthetic-secret'}),/端口与连接信息不同/);
  assert.ok(!current.events.slice(before).includes('probe'));
}));
