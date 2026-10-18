const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {DeviceBackup,encode,decode,writeBackup}=require('../gmssh_windows_bridge/device-backup.cjs');
const {PairingManager}=require('../gmssh_windows_bridge/pairing.cjs');
const id=number=>number.toString(16).padStart(32,'0');
const node=(number,extra={})=>({id:id(number),name:'测试电脑 '+number,ip:'192.0.2.'+number,port:22,userName:'tester',authType:'pass',authValue:'synthetic-ssh-secret-'+number,groupId:'',desc:'两行\n备注',...extra});
function harness(initial=[],options={}){
  const nodes=structuredClone(initial),groups=[{id:'g1',name:'测试分组'}],events=[],starts=[];let next=100,port=34000;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmssh-backup-'));
  const api=async(route,data)=>{
    events.push({route,data:structuredClone(data)});
    if(route==='/node/list')return {code:0,data:{list:nodes}};
    if(route==='/node/detail')return {code:0,data:structuredClone(nodes.find(node=>node.id===data.id))};
    if(route==='/group/list')return {code:0,data:groups};
    if(route==='/group/add'){groups.push({id:'g'+groups.length,name:data.name});return {code:0};}
    if(route==='/node/add'){
      if(data.ip===options.failAddress)return {code:1};
      const value={...structuredClone(data),id:id(next++)};nodes.push(value);
      if(options.lostReply){options.lostReply=false;throw Error('synthetic lost reply');}
      return {code:0,data:{id:value.id}};
    }
    throw Error('Unexpected operation '+route);
  };
  const pairing=new PairingManager({root,legacy:[],keychain:true,api,reserved:[34000],port:async reserved=>{while(reserved.has(port))port++;reserved.add(port);return port++;},
    inspect:async request=>{events.push({operation:request.operation});assert.equal(request.operation,'inspect');const value=JSON.parse(request.connection);return {...value,id:id(999),adapters:[]};},
    startDevice:async value=>{starts.push(value);return {...value,stop:async()=>{}};}});
  const manager=new DeviceBackup({api,pairing});
  return {manager,pairing,nodes,groups,events,starts,dispose(){manager.clear();fs.rmSync(root,{recursive:true,force:true});}};
}
const payload=devices=>({createdAt:'2026-01-01T00:00:00Z',devices});
const portable=extra=>({ref:randomUUID(),kind:'linux',name:'迁移电脑',address:'192.0.2.42',port:2222,username:'tester',authType:'pass',group:'',notes:'',bastion:'',...extra});

test('selective exports omit all credentials in ordinary files and reveal none in list or preview',async()=>{
  const source=harness([node(1),node(2,{authType:'ca',authValue:'synthetic-private-key',keyPass:'synthetic-key-pass'})]);
  try{
    const listed=JSON.stringify(await source.manager.list());for(const secret of ['synthetic-ssh-secret','synthetic-private-key','synthetic-key-pass'])assert.ok(!listed.includes(secret));
    const plain=await source.manager.export([id(2)],false);
    assert.ok(!plain.includes('synthetic-private-key')&&!plain.includes('synthetic-key-pass'));const saved=await decode(plain);assert.equal(saved.devices.length,1);assert.equal(saved.devices[0].name,'测试电脑 2');
    source.manager.open(plain);const preview=await source.manager.inspect();assert.equal(preview.devices.length,1);assert.equal(preview.devices[0].hasCredentials,false);assert.ok(!JSON.stringify(preview).includes('synthetic-private-key'));
    const encrypted=await source.manager.export([id(1),id(2)],true,'synthetic-backup-password');
    for(const secret of ['synthetic-ssh-secret','synthetic-private-key','synthetic-key-pass','synthetic-backup-password'])assert.ok(!encrypted.includes(secret));
    const restored=await decode(encrypted,'synthetic-backup-password');assert.equal(restored.devices[1].credentials.keyPass,'synthetic-key-pass');
    source.manager.open(encrypted);const checked=await source.manager.inspect('synthetic-backup-password');assert.ok(!JSON.stringify(checked).includes('synthetic-ssh-secret'));assert.ok(checked.devices.every(item=>item.hasCredentials));
  }finally{source.dispose();}
});
test('authenticated encryption rejects a wrong password, tampering, plaintext secrets and unbounded files',async()=>{
  const entry=portable({credentials:{authValue:'synthetic-secret'}}),body=await encode(payload([entry]),true,'synthetic-backup-password');
  await assert.rejects(decode(body,'wrong-password'),/口令不正确/);const changed=JSON.parse(body);changed.ciphertext=(changed.ciphertext[0]==='A'?'B':'A')+changed.ciphertext.slice(1);await assert.rejects(decode(Buffer.from(JSON.stringify(changed)),'synthetic-backup-password'),/口令不正确/);
  await assert.rejects(encode(payload([entry]),false),/不得包含/);
  await assert.rejects(decode(Buffer.from(JSON.stringify({format:'gmssh-device-backup',version:1,encrypted:false,payload:payload([entry])}))),/明文凭据/);
  await assert.rejects(decode(Buffer.alloc(8*1024*1024+1)),/8 MiB/);
});
test('offline Linux import restores groups and selected bastion dependencies, preserves duplicates and uses no remote test',async()=>{
  const parent=portable({address:'2001:db8::1',name:'跳板机',group:'新分组',authType:'ca',credentials:{authValue:'synthetic-key',keyPass:'synthetic-passphrase'}});
  const child=portable({address:'192.0.2.8',name:'业务电脑',group:'新分组',bastion:parent.ref,credentials:{authValue:'synthetic-password'}}),unselected=portable({address:'192.0.2.9',credentials:{authValue:'synthetic-other'}});
  const target=harness();
  try{
    target.manager.open(await encode(payload([child,parent,unselected]),true,'synthetic-backup-password'));let preview=await target.manager.inspect('synthetic-backup-password');
    await assert.rejects(target.manager.import({id:preview.id,ids:[child.ref]}),/跳板机/);assert.equal(target.nodes.length,0);
    const result=await target.manager.import({id:preview.id,ids:[child.ref,parent.ref]});assert.deepEqual(result.results.map(item=>item.status),['imported','imported']);assert.equal(target.nodes.length,2);
    const restoredParent=target.nodes.find(node=>node.name==='跳板机'),restoredChild=target.nodes.find(node=>node.name==='业务电脑');assert.equal(restoredParent.keyPass,'synthetic-passphrase');assert.equal(restoredChild.bastionNodeId,restoredParent.id);assert.equal(restoredChild.groupId,restoredParent.groupId);
    assert.ok(!target.events.some(event=>['/node/test','/node/edit'].includes(event.route)));assert.equal(target.starts.length,0);
    target.manager.open(await encode(payload([parent,child]),true,'synthetic-backup-password'));preview=await target.manager.inspect('synthetic-backup-password');assert.ok(preview.devices.every(item=>item.status==='existing'));
    const again=await target.manager.import({id:preview.id,ids:[parent.ref,child.ref]});assert.ok(again.results.every(item=>item.status==='skipped'));assert.equal(target.nodes.length,2);
  }finally{target.dispose();}
});
test('plain configuration requires user-supplied credentials before any write and reports partial failure honestly',async()=>{
  const first=portable({address:'192.0.2.11'}),second=portable({address:'192.0.2.12'}),target=harness([],{failAddress:'192.0.2.12',lostReply:true});
  try{
    target.manager.open(await encode(payload([first,second]),false));const preview=await target.manager.inspect();await assert.rejects(target.manager.import({id:preview.id,ids:[first.ref,second.ref]}),/补充/);assert.equal(target.nodes.length,0);
    const reply=await target.manager.import({id:preview.id,ids:[first.ref,second.ref],auth:{[first.ref]:{authValue:'synthetic-first'},[second.ref]:{authValue:'synthetic-second'}}});assert.deepEqual(reply.results.map(item=>item.status),['imported','failed']);assert.equal(target.nodes.length,1);assert.ok(target.manager.preview);
    assert.equal(target.pairing.busy,false);await assert.rejects(target.manager.import({id:'stale',ids:[first.ref]}),/失效/);
  }finally{target.dispose();}
});
test('Windows transfer recreates local bridge ports and pinned metadata without remote login or exporting local paths',async()=>{
  const connection={schema:1,computer:'LAB-PC',username:'tester',sshPort:22,addresses:['192.0.2.42'],sshHostPublicKey:'ssh-ed25519 synthetic-public',sshHostFingerprint:'SHA256:synthetic',desktopAuth:'shared-ssh'};
  const source=harness([node(1,{ip:'127.0.0.1',port:29999})]);source.pairing.records.push({id:id(999),machineId:id(1),target:'192.0.2.42',connection:JSON.stringify(connection),public:{...connection,id:id(999),adapters:[]},monitorPort:29999,desktopPort:29998,name:'Source'});
  const target=harness([node(2,{ip:'127.0.0.1',port:34001,userName:'unrelated'})]);
  try{
    const body=await source.manager.export([id(1)],true,'synthetic-backup-password'),raw=JSON.stringify(await decode(body,'synthetic-backup-password'));
    assert.ok(!raw.includes('29999')&&!raw.includes('29998')&&!raw.includes('known_hosts')&&!raw.includes('accessToken')&&!raw.includes(source.pairing.root));
    target.manager.open(body);const preview=await target.manager.inspect('synthetic-backup-password');const result=await target.manager.import({id:preview.id,ids:preview.devices.map(item=>item.ref),rememberDesktop:true});assert.equal(result.results[0].status,'imported');
    const record=target.pairing.records[0];assert.equal(record.target,'192.0.2.42');assert.equal(record.monitorPort,34002);assert.equal(target.starts.length,1);assert.equal(target.pairing.takeDesktopAuth(record.machineId).password,'synthetic-ssh-secret-1');
    assert.equal(record.autoTarget,true);assert.deepEqual(target.starts[0].autoAddresses,connection.addresses);
    assert.ok(!target.events.some(event=>event.operation&&event.operation!=='inspect'||event.route==='/node/test'));
    assert.ok(!fs.readFileSync(path.join(target.pairing.root,'catalog.json'),'utf8').includes('synthetic-ssh-secret-1'));
    const same=await target.pairing.exportConnection(record.machineId);assert.equal(JSON.parse(same.connection).sshHostFingerprint,connection.sshHostFingerprint);
    const removed=record.machineId;target.nodes.splice(target.nodes.findIndex(node=>node.id===removed),1);
    target.manager.open(body);const again=await target.manager.inspect('synthetic-backup-password');assert.equal(again.devices[0].status,'new');
    const recovered=await target.manager.import({id:again.id,ids:again.devices.map(item=>item.ref)});assert.equal(recovered.results[0].status,'imported');assert.notEqual(record.machineId,removed);assert.equal(record.monitorPort,34002);assert.equal(target.starts.length,1);
  }finally{source.dispose();target.dispose();}
});
test('selection validation rejects missing dependencies, cycles, duplicates and arbitrary host text before writing',async()=>{
  const source=harness([node(1,{bastionNodeId:id(2)}),node(2)]);
  try{await assert.rejects(source.manager.export([id(1)],false),/跳板机/);await assert.rejects(source.manager.export([id(1),id(1)],false),/勾选/);}
  finally{source.dispose();}
  const first=portable(),second=portable();first.bastion=second.ref;second.bastion=first.ref;
  await assert.rejects(encode(payload([first,second]),false),/循环/);await assert.rejects(encode(payload([portable({address:'https://untrusted.invalid/'})]),false),/地址/);
});
test('cancelling a slow preview discards its eventual decrypted result and saved files are private and atomic',async()=>{
  const target=harness();let release;const original=target.manager.native.bind(target.manager);target.manager.native=async()=>{await new Promise(resolve=>release=resolve);return original();};
  try{
    const plain=await encode(payload([portable()]),false);target.manager.open(plain);const reading=target.manager.inspect();while(!release)await new Promise(resolve=>setImmediate(resolve));target.manager.clear();release();await assert.rejects(reading);assert.equal(target.manager.preview,null);assert.equal(target.manager.file,null);
    const file=path.join(target.pairing.root,'selected.json');writeBackup(file,plain);assert.deepEqual(fs.readFileSync(file),plain);if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);
    if(process.platform!=='win32'){const link=path.join(target.pairing.root,'link.json');fs.symlinkSync(file,link);assert.throws(()=>writeBackup(link,plain),/普通文件/);}
  }finally{target.dispose();}
});
