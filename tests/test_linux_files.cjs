const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {LinuxFiles}=require('../gmssh_windows_bridge/linux-files.cjs');
const {FileTasks,remote}=require('../gmssh_windows_bridge/file-tasks.cjs');
const machine='e'.repeat(32),bastion='d'.repeat(32),peer='SHA256:'+'a'.repeat(43),peer2='SHA256:'+'b'.repeat(43);
const node=id=>({id,name:'Synthetic Linux',ip:'127.0.0.1',port:22,userName:'fixture',authType:'pass',authValue:'synthetic-password',bastionNodeId:id===machine?bastion:''});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<3000;i++){if(fn())return;await delay(10);}throw Error('Synthetic Linux task timed out');}

test('Linux main resolves a bastion chain, confirms before auth and only persists host pins',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmssh-linux-pins-'));let confirms=0,inspections=0;
  const manager=new LinuxFiles({root,api:async(_,{id})=>({code:0,data:node(id)}),inspect:async ssh=>{inspections++;const index=ssh.findIndex(n=>!n.peer);assert.equal(ssh.length,2);assert.equal(ssh[0].peer,index===0?null:peer);return {trust:{index,host:ssh[index].host,port:ssh[index].port,algorithm:'ssh-ed25519',peer:index===0?peer:peer2}};},confirm:async()=>{confirms++;return true;}});
  try{
    const result=await manager.resolve(machine);assert.equal(confirms,2);assert.equal(inspections,2);assert.deepEqual(result.ssh.map(n=>n.peer),[peer,peer2]);
    const text=fs.readFileSync(manager.file,'utf8');assert.ok(!text.includes('synthetic-password'));assert.ok(!text.includes('authValue'));assert.equal(fs.statSync(manager.file).mode&0o777,0o600);
    await manager.resolve(machine);assert.equal(inspections,2);assert.equal(confirms,2);
    const changed=new LinuxFiles({root,api:async(_,{id})=>({code:0,data:{...node(id),ip:'changed.example.invalid'}}),inspect:()=>assert.fail('must not contact changed address'),confirm:()=>assert.fail('must not silently replace pin')});
    await assert.rejects(changed.resolve(machine),{code:'DEVICE_CONFIG_CHANGED'});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('unconfirmed keys, cycles and changed configuration fail without saving trust',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmssh-linux-stop-'));let change=false;
  const args={root,api:async(_,{id})=>({code:0,data:{...node(id),bastionNodeId:'',...(change?{port:23}:{})}}),inspect:async()=>({trust:{index:0,host:'127.0.0.1',port:22,algorithm:'ssh-ed25519',peer}})};
  try{
    const refused=new LinuxFiles({...args,confirm:async()=>false});await assert.rejects(refused.resolve(machine),{code:'HOST_UNVERIFIED'});assert.equal(fs.existsSync(refused.file),false);
    const changed=new LinuxFiles({...args,confirm:async()=>{change=true;return true;}});await assert.rejects(changed.resolve(machine),{code:'DEVICE_CONFIG_CHANGED'});assert.equal(fs.existsSync(changed.file),false);
    const cycle=new LinuxFiles({...args,api:async(_,{id})=>({code:0,data:{...node(id),bastionNodeId:id}})});await assert.rejects(cycle.resolve(machine),{code:'INVALID_DEVICE'});
    for(const bad of ['/../secret','relative','/x/./y','/bad\0'])assert.throws(()=>remote(bad));assert.equal(remote('/folder: name?/file.'),'/folder: name?/file.');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Linux file tasks use the shared FD-granted queue, recover after reopen, and never journal credentials',{timeout:120000,skip:process.platform==='win32'?'Unix controller only':false},async()=>{
  const root=path.resolve(__dirname,'..'),python=process.env.GMSSH_TEST_PYTHON||'python3',folder=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gmssh-linux-queue-'))),store=path.join(folder,'remote');fs.mkdirSync(store);
  const server=spawn(python,['-u','-m','tests.linux_sftp_fixture',store],{cwd:root,stdio:['ignore','pipe','pipe']});let manager,reopened;
  try{
    const info=await new Promise((resolve,reject)=>{let body='',err='';const timer=setTimeout(()=>reject(Error('SSH fixture startup '+err)),15000);server.stderr.on('data',chunk=>err+=chunk);server.on('error',reject);server.stdout.on('data',chunk=>{body+=chunk;if(body.includes('\n')){clearTimeout(timer);resolve(JSON.parse(body.split('\n')[0]));}});});
    const ssh=[{host:'127.0.0.1',port:info.port,username:'fixture',authType:'pass',authValue:'synthetic-password',peer:info.peer}],binding={ssh,label:'Synthetic Linux'};
    const source=path.join(folder,'中文:?.bin'),target=path.join(folder,'received.bin');fs.writeFileSync(source,Buffer.alloc(16*1024**2,93));
    const config={root:path.join(folder,'journal'),python,resolveBinding:async id=>id===machine?binding:null,pickOpen:async()=>({filePaths:[source]}),pickSave:async()=>({filePath:target}),spawnWorker:(program,args,options)=>spawn(program,['-c',"import sys,runpy;sys.path.insert(0,sys.argv[1]);runpy.run_module('gmssh_windows_bridge.transfer_worker',run_name='__main__')",root],options)};
    manager=new FileTasks(config);
    assert.equal((await manager.invoke('hello',null)).linuxFiles,true);
    assert.equal((await manager.invoke('fs-list',machine,{path:'/'})).entries.length,0);
    assert.equal((await manager.invoke('fs-mkdir',machine,{path:'/test: folder'})).created,true);
    await manager.invoke('pick-upload',machine,{remote:'/test: folder'});await until(()=>!manager.running);assert.equal(manager.jobs[0].status,'done',manager.jobs[0].code);
    const listing=await manager.invoke('fs-list',machine,{path:'/test: folder'});assert.equal(listing.entries[0].name,'中文:?.bin');
    await manager.invoke('pick-download',machine,{entries:[{path:'/test: folder/中文:?.bin',name:'中文:?.bin',directory:false,size:16*1024**2}]});
    await until(()=>manager.jobs[1].bytes>0);if(manager.jobs[1].status!=='done')await manager.pause(machine,manager.jobs[1].id);await manager.shutdown();
    reopened=new FileTasks(config);if(reopened.jobs[1].status!=='done'){assert.equal(reopened.list().jobs[1].needsGrant,true);await reopened.invoke('resume',machine,{id:reopened.jobs[1].id});await until(()=>!reopened.running);}
    assert.equal(reopened.jobs[1].status,'done',reopened.jobs[1].code);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'));
    const journal=fs.readFileSync(reopened.journal,'utf8');assert.ok(!journal.includes('synthetic-password'));assert.ok(!journal.includes('authValue'));assert.ok(JSON.parse(journal).jobs.every(job=>!('ssh' in job)));
  }finally{await manager?.shutdown();await reopened?.shutdown();server.kill('SIGTERM');await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));fs.rmSync(folder,{recursive:true,force:true});}
});
