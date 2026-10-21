const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {FileTasks,proof}=require('../gmssh_windows_bridge/file-tasks.cjs');
const root=path.resolve(__dirname,'..'),machine='1'.repeat(32),python=process.env.GMSSH_TEST_PYTHON||'python3';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,ms=45000){const end=Date.now()+ms;while(Date.now()<end){const value=check();if(value)return value;await delay(15);}throw Error('Timed out waiting for synthetic transfer');}
async function hash(file){const h=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
let dir,remote,server,binding,spawnWorker;
if(process.platform==='win32'){test('native controller FD grants',{skip:'Mac/Unix controller only'},()=>{});}else{
test.before(async()=>{
  dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gmssh-stream-test-')));remote=path.join(dir,'remote');fs.mkdirSync(remote);
  server=spawn(python,[path.join(root,'tests/stream_fixture.py'),remote],{cwd:root,stdio:['ignore','pipe','pipe']});
  binding=await new Promise((resolve,reject)=>{let out='',err='';const timer=setTimeout(()=>reject(Error('Fixture startup: '+err)),20000);server.stderr.on('data',b=>err+=b);server.stdout.on('data',b=>{out+=b;const n=out.indexOf('\n');if(n>=0){clearTimeout(timer);const value=JSON.parse(out.slice(0,n));resolve({viewerUrl:value.url,accessToken:value.token,label:'Synthetic desktop'});}});server.on('error',reject);});
  // Import the working source even when this reusable Python environment contains an older wheel.
  spawnWorker=(program,args,options)=>spawn(program,['-c',"import sys,runpy;sys.path.insert(0,sys.argv[1]);runpy.run_module('gmssh_windows_bridge.transfer_worker',run_name='__main__')",root],options);
});
test.after(async()=>{if(server){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}if(dir)fs.rmSync(dir,{recursive:true,force:true});});
function manager(label,select={}){return new FileTasks({root:path.join(dir,label),python,spawnWorker,resolveBinding:async id=>id===machine?binding:null,pickOpen:async()=>({canceled:!select.open,filePaths:select.open?[select.open]:[]}),pickSave:async()=>({canceled:!select.save,filePath:select.save})});}
const entry=(name,size)=>({path:'C:/'+name,name,directory:false,size});
const finish=async m=>{await until(()=>!m.running&&!m.jobs.some(j=>j.status==='queued'));return m.jobs.at(-1);};

test('native upload and download stream a 520 MiB file with bounded worker memory', {timeout:120000},async()=>{
  const source=path.join(dir,'large.bin'),fd=fs.openSync(source,'wx');fs.ftruncateSync(fd,520*1024**2);fs.writeSync(fd,Buffer.from('bounded synthetic start'),0,23,0);fs.closeSync(fd);
  const m=manager('large',{open:source,save:path.join(dir,'received.bin')}),baseline=process.memoryUsage().rss;let peakMain=baseline;const sample=setInterval(()=>peakMain=Math.max(peakMain,process.memoryUsage().rss),20);
  try{
    await m.invoke('pick-upload',machine,{remote:'C:/',directory:false});let job=await finish(m);assert.equal(job.status,'done',job.code);assert.ok(job.peakRssBytes<160*1024**2,job.peakRssBytes);assert.equal(await hash(source),await hash(path.join(remote,'large.bin')));
    await m.invoke('pick-download',machine,{entries:[entry('large.bin',520*1024**2)]});job=await finish(m);assert.equal(job.status,'done',job.code);assert.ok(job.peakRssBytes<160*1024**2,job.peakRssBytes);assert.equal(await hash(source),await hash(path.join(dir,'received.bin')));
    assert.equal(fs.readdirSync(remote).some(n=>n.endsWith('.part')||n.endsWith('.part.json')),false);
    const journal=fs.readFileSync(m.journal,'utf8');assert.ok(!journal.includes(binding.token));assert.ok(!journal.includes(binding.url));assert.equal(fs.statSync(m.journal).mode&0o777,0o600);
    assert.ok(peakMain-baseline<160*1024**2,'main-process RSS grew with file size');console.log('520 MiB streaming peak worker RSS:',m.jobs.map(j=>j.peakRssBytes),'main delta:',peakMain-baseline);
  }finally{clearInterval(sample);await m.shutdown();}
});

test('download pauses, survives manager reopen without reading a saved path, then resumes',async()=>{
  const target=path.join(dir,'resumed.bin'),m=manager('resume-download',{save:target});let again;
  try{
    await m.invoke('pick-download',machine,{entries:[entry('large.bin',520*1024**2)]});await until(()=>m.jobs[0].bytes>=2*1024**2);await m.pause(machine,m.jobs[0].id);const before=m.jobs[0].bytes;assert.ok(before>0&&before<520*1024**2);assert.equal(fs.existsSync(target),false);await m.shutdown();
    // A vanished save directory cannot trigger a read or error during restoration.
    const part=m.jobs[0].local.part,moved=part+'.moved';fs.renameSync(part,moved);
    again=manager('resume-download',{save:target});assert.equal(again.readyError,undefined);assert.equal(again.jobs[0].status,'paused');assert.equal(again.running,undefined);assert.equal(again.list().jobs[0].needsGrant,true);fs.renameSync(moved,part);
    await again.invoke('resume',machine,{id:again.jobs[0].id});const job=await finish(again);assert.equal(job.status,'done',job.code);assert.equal(await hash(target),await hash(path.join(remote,'large.bin')));
  }finally{await m.shutdown();await again?.shutdown();}
});

test('upload resumes an owned remote partial and does not overwrite an existing file',async()=>{
  const source=path.join(dir,'resume-upload.bin');fs.copyFileSync(path.join(dir,'large.bin'),source);
  const m=manager('resume-upload',{open:source});let again;
  try{
    await m.invoke('pick-upload',machine,{remote:'C:/'});await until(()=>m.jobs[0].bytes>0);await m.pause(machine,m.jobs[0].id);const part=path.join(remote,'.gmssh-transfer-'+m.jobs[0].partToken+'.part');assert.ok(fs.statSync(part).size>0);await m.shutdown();
    again=manager('resume-upload',{open:source});await again.invoke('resume',machine,{id:again.jobs[0].id});let job=await finish(again);assert.equal(job.status,'done',job.code);assert.equal(await hash(source),await hash(path.join(remote,'resume-upload.bin')));
    await again.invoke('pick-upload',machine,{remote:'C:/'});job=await finish(again);assert.equal(job.status,'failed');assert.equal(job.code,'CONFLICT');
    await again.invoke('resume',machine,{id:job.id,name:'different-name.bin'});job=await finish(again);assert.equal(job.status,'done',job.code);assert.equal(await hash(path.join(remote,'different-name.bin')),await hash(source));
  }finally{await m.shutdown();await again?.shutdown();}
});

test('changed source is rejected after restart and a forged renderer local path grants no access',async()=>{
  const source=path.join(dir,'changed.bin');fs.writeFileSync(source,'old');const m=manager('changed',{open:source});
  try{
    await assert.rejects(m.invoke('pick-upload',machine,{remote:'C:/',source:'/arbitrary/private/file'}),/INVALID_TRANSFER/);
    // Snapshot an explicitly chosen, paused task before a new process restores it.
    m.closed=true;await assert.rejects(m.pickUpload(machine,{remote:'C:/'}),/MANAGER_CLOSED/);m.closed=false;
    const fd=fs.openSync(source,'r');const p=proof(fd);fs.closeSync(fd);const j=m.newJob(machine,'Synthetic','upload','C:/changed.bin','changed.bin',{source,proof:p},{size:3,status:'running'});m.save();
    fs.writeFileSync(source,'changed');const again=manager('changed',{open:source});assert.equal(again.jobs[0].status,'paused');assert.equal(again.running,undefined);await assert.rejects(again.resume(machine,j.id),/SOURCE_CHANGED/);await again.shutdown();
  }finally{await m.shutdown();}
});

test('cancelling removes only the owned local partial, and a destination conflict preserves both files',async()=>{
  const target=path.join(dir,'cancelled.bin'),m=manager('cancel',{save:target});
  try{
    await m.pickDownload(machine,{entries:[entry('large.bin',520*1024**2)]});await until(()=>m.jobs[0].bytes>0);await m.pause(machine,m.jobs[0].id);const part=m.jobs[0].local.part;
    fs.writeFileSync(target,'keep destination');await m.resume(machine,m.jobs[0].id);let job=await finish(m);assert.equal(job.code,'CONFLICT');assert.equal(fs.readFileSync(target,'utf8'),'keep destination');assert.ok(fs.existsSync(part));await m.cancel(machine,job.id);assert.equal(fs.existsSync(part),false);assert.equal(fs.readFileSync(target,'utf8'),'keep destination');
  }finally{await m.shutdown();}
});

test('folders preserve hierarchy and empty folders without a ZIP or a renderer Blob',async()=>{
  const source=path.join(dir,'folder');fs.mkdirSync(source);fs.mkdirSync(path.join(source,'empty'));fs.writeFileSync(path.join(source,'one.txt'),'one');const download=path.join(dir,'folder-download');fs.mkdirSync(download);
  const pick={open:source},m=manager('folder',pick);
  try{
    await m.pickUpload(machine,{remote:'C:/',directory:true});await finish(m);assert.ok(m.jobs.every(j=>j.status==='done'),JSON.stringify(m.list()));assert.ok(fs.statSync(path.join(remote,'folder/empty')).isDirectory());
    pick.open=download;await m.pickDownload(machine,{entries:[{path:'C:/folder',name:'folder',directory:true,size:0}]});await finish(m);assert.ok(m.jobs.every(j=>j.status==='done'),JSON.stringify(m.list()));assert.equal(fs.readFileSync(path.join(download,'folder/one.txt'),'utf8'),'one');assert.ok(fs.statSync(path.join(download,'folder/empty')).isDirectory());
  }finally{await m.shutdown();}
});

test('a corrupt journal fails closed and never falls back to an empty or browser-only queue',async()=>{
  const folder=path.join(dir,'bad');fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'transfer-journal.json'),'broken');const m=manager('bad');assert.equal(m.readyError,'JOURNAL_INVALID');await assert.rejects(m.invoke('hello',null),/JOURNAL_INVALID/);assert.equal(fs.readFileSync(m.journal,'utf8'),'broken');await m.shutdown();assert.equal(fs.readFileSync(m.journal,'utf8'),'broken');
});

test('verification reports its own bounded progress without changing transferred bytes',async()=>{
  const m=manager('verification-progress');
  const j=m.newJob(machine,'Synthetic','directory','C:/folder','folder',{},
    {status:'running',phase:'verifying',size:1024,bytes:256,verifyBytes:128,verifyTotal:512});
  m.save();const listed=m.list().jobs[0];
  assert.equal(listed.bytes,256);assert.equal(listed.verifyBytes,128);assert.equal(listed.verifyTotal,512);
  await m.shutdown();
  const data=JSON.parse(fs.readFileSync(m.journal,'utf8'));data.jobs[0].verifyBytes=513;
  fs.writeFileSync(m.journal,JSON.stringify(data));const invalid=manager('verification-progress');
  assert.equal(invalid.readyError,'JOURNAL_INVALID');await invalid.shutdown();
});

test('a crash during final download commit recovers the original inode after a fresh grant',async()=>{
  const target=path.join(dir,'commit.bin'),m=manager('commit',{save:target}),part=path.join(dir,'.gmssh-transfer-'+'b'.repeat(32)+'.part');fs.writeFileSync(part,'verified commit bytes');
  const fd=fs.openSync(part,'r');const p=proof(fd);fs.closeSync(fd);const peer=(await m.probe(machine)).peer;
  const j=m.newJob(machine,'Synthetic','download','C:/unused.bin','commit.bin',{target,part,partProof:p},{partToken:'b'.repeat(32),size:p.size,bytes:p.size,peer,sha256:await hash(part),status:'committing'});m.save();fs.linkSync(part,target);
  const restored=manager('commit',{save:target});
  try{assert.equal(restored.jobs[0].status,'paused');assert.equal(restored.jobs[0].needsGrant,undefined);await restored.resume(machine,j.id);const job=await finish(restored);assert.equal(job.status,'done',job.code);assert.equal(fs.readFileSync(target,'utf8'),'verified commit bytes');assert.equal(fs.existsSync(part),false);}finally{await restored.shutdown();await m.shutdown();}
});

test('a replaced partial and a changed peer are rejected before transfer or deletion',async()=>{
  const target=path.join(dir,'tamper.bin'),m=manager('tamper',{save:target});
  try{
    await m.pickDownload(machine,{entries:[entry('large.bin',520*1024**2)]});await until(()=>m.jobs[0].bytes>0);await m.pause(machine,m.jobs[0].id);const j=m.jobs[0],part=j.local.part;
    // Rename the inode aside so the filesystem cannot reuse it for the replacement.
    fs.renameSync(part,part+'.original');fs.writeFileSync(part,'unrelated replacement');await m.resume(machine,j.id);let job=await finish(m);assert.equal(job.code,'PARTIAL_CHANGED');await assert.rejects(m.cancel(machine,j.id),/PARTIAL_CHANGED/);assert.equal(fs.readFileSync(part,'utf8'),'unrelated replacement');
    j.peer='SHA256:'+'A'.repeat(43);await assert.rejects(m.resume(machine,j.id),/PEER_CHANGED/);assert.equal(fs.readFileSync(part,'utf8'),'unrelated replacement');
  }finally{await m.shutdown();}
});

test('ENOSPC from the actual worker keeps the partial recoverable and never commits a destination',async()=>{
  const target=path.join(dir,'disk-full.bin'),m=manager('disk-full',{save:target});
  m.spawnWorker=(program,args,options)=>spawn(program,['-c',"import sys,runpy,os;sys.path.insert(0,sys.argv[1]);os.pwrite=lambda *a:(_ for _ in ()).throw(OSError(28,'synthetic ENOSPC'));runpy.run_module('gmssh_windows_bridge.transfer_worker',run_name='__main__')",root],options);
  try{
    await m.pickDownload(machine,{entries:[{path:'C:/folder/one.txt',name:'one.txt',directory:false,size:3}]});let job=await finish(m);assert.equal(job.code,'DISK_FULL');assert.equal(fs.existsSync(target),false);assert.ok(fs.existsSync(job.local.part));
    m.spawnWorker=spawnWorker;await m.resume(machine,job.id);job=await finish(m);assert.equal(job.status,'done',job.code);assert.equal(fs.readFileSync(target,'utf8'),'one');
  }finally{await m.shutdown();}
});


test('a hard controller exit leaves a recoverable journal and stops orphaned transfer I/O',async()=>{
  const target=path.join(dir,'hard-reopen.bin'),folder=path.join(dir,'hard-reopen'),child=spawn(process.execPath,[path.join(root,'tests/transfer_crash_driver.js')],{stdio:['pipe','pipe','inherit']});
  const ready=new Promise((resolve,reject)=>{let text='';const timeout=setTimeout(()=>reject(Error('crash checkpoint timeout')),20000);child.stdout.on('data',b=>{text+=b;let n;while((n=text.indexOf('\n'))>=0){const line=text.slice(0,n);text=text.slice(n+1);const state=JSON.parse(line);if(state.jobs[0]?.bytes>0){clearTimeout(timeout);resolve();}}});child.on('error',reject);child.on('exit',()=>{clearTimeout(timeout);reject(Error('crash fixture exited before checkpoint'));});});
  child.stdin.end(JSON.stringify({root:folder,python,binding,target})+'\n');
  try{await ready;}finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}}
  const record=JSON.parse(fs.readFileSync(path.join(folder,'transfer-journal.json'))).jobs[0];assert.equal(record.status,'running');assert.equal(fs.existsSync(target),false);
  await delay(500);const stopped=fs.statSync(record.local.part).size;await delay(200);assert.equal(fs.statSync(record.local.part).size,stopped);
  const restored=manager('hard-reopen',{save:target});
  try{assert.equal(restored.jobs[0].status,'paused');assert.equal(restored.running,undefined);await restored.resume(machine,record.id);const job=await finish(restored);assert.equal(job.status,'done',job.code);assert.equal(await hash(target),await hash(path.join(remote,'large.bin')));}finally{await restored.shutdown();}
});


test('a real loopback channel disconnect retains the partial and resumes without restarting from zero',async()=>{
  const target=path.join(dir,'channel-resume.bin'),m=manager('channel-resume',{save:target});fs.writeFileSync(path.join(remote,'.fixture-disconnect-on-read'),'');
  try{
    await m.pickDownload(machine,{entries:[entry('large.bin',520*1024**2)]});let job=await finish(m);assert.equal(job.status,'failed');assert.ok(fs.statSync(job.local.part).size>=1024*1024);assert.equal(fs.existsSync(target),false);
    await m.resume(machine,job.id);job=await finish(m);assert.equal(job.status,'done',job.code);assert.equal(await hash(target),await hash(path.join(remote,'large.bin')));
  }finally{await m.shutdown();}
});


test('a failed completion journal write still recognizes the committed download on retry',async()=>{
  const target=path.join(dir,'journal-commit.bin'),m=manager('journal-commit',{save:target}),save=m.save.bind(m);let injected=false;
  m.save=()=>{if(!injected&&m.jobs.some(j=>j.status==='done')){injected=true;throw Object.assign(Error('synthetic journal ENOSPC'),{code:'ENOSPC'});}save();};
  try{
    await m.pickDownload(machine,{entries:[{path:'C:/folder/one.txt',name:'one.txt',directory:false,size:3}]});let job=await finish(m);assert.equal(job.status,'failed');assert.equal(job.recoverCommit,true);assert.equal(fs.readFileSync(target,'utf8'),'one');
    await m.resume(machine,job.id);job=await finish(m);assert.equal(job.status,'done',job.code);assert.equal(fs.readFileSync(target,'utf8'),'one');
  }finally{await m.shutdown();}
});


test('cancel after reopen asks for permission and retains cleanup metadata until the owned part is removed',async()=>{
  const target=path.join(dir,'cleanup-grant.bin'),m=manager('cleanup-grant',{save:target}),selected={};let restored;
  try{
    await m.pickDownload(machine,{entries:[entry('large.bin',520*1024**2)]});await until(()=>m.jobs[0].bytes>0);await m.pause(machine,m.jobs[0].id);const part=m.jobs[0].local.part;await m.shutdown();
    restored=manager('cleanup-grant',selected);await restored.cancel(machine,restored.jobs[0].id);assert.equal(restored.jobs[0].cleanupPending,true);assert.ok(fs.existsSync(part));restored.clear(machine);assert.equal(restored.jobs.length,1);
    selected.save=target;await restored.cancel(machine,restored.jobs[0].id);assert.equal(restored.jobs[0].cleanupPending,false);assert.equal(fs.existsSync(part),false);restored.clear(machine);assert.equal(restored.jobs.length,0);
  }finally{await m.shutdown();await restored?.shutdown();}
});


test('a filesystem without hard links completes through exclusive rename',async()=>{
  const target=path.join(dir,'unsupported-volume.bin'),m=manager('unsupported-volume',{save:target}),link=fs.linkSync;
  fs.linkSync=()=>{throw Object.assign(Error('synthetic unsupported hard links'),{code:'ENOTSUP'});};
  try{await m.pickDownload(machine,{entries:[{path:'C:/folder/one.txt',name:'one.txt',directory:false,size:3}]});const job=await finish(m);assert.equal(job.status,'done',job.code);assert.equal(fs.readFileSync(target,'utf8'),'one');}
  finally{fs.linkSync=link;await m.shutdown();}
});

test('a queued task pins the device before file selection and rejects a changed identity before writing',async()=>{
  const source=path.join(dir,'identity-before-start.txt');fs.writeFileSync(source,'pin this upload');const m=manager('queued-identity',{open:source}),pump=m.pump.bind(m),marker=path.join(remote,'.fixture-host-key');m.pump=()=>{};
  try{
    await m.pickUpload(machine,{remote:'C:/'});assert.ok(m.jobs[0].peer.startsWith('SHA256:'));fs.writeFileSync(marker,'different synthetic host key');m.pump=pump;pump();let job=await finish(m);assert.equal(job.code,'PEER_CHANGED');assert.equal(fs.existsSync(path.join(remote,'identity-before-start.txt')),false);assert.equal(fs.existsSync(path.join(remote,'.gmssh-transfer-'+job.partToken+'.part')),false);
    fs.unlinkSync(marker);await m.resume(machine,job.id);job=await finish(m);assert.equal(job.status,'done',job.code);assert.equal(fs.readFileSync(path.join(remote,'identity-before-start.txt'),'utf8'),'pin this upload');
  }finally{if(fs.existsSync(marker))fs.unlinkSync(marker);await m.shutdown();}
});


test('download resumes after a remount changes the directory and partial file IDs',async()=>{
  const folder=path.join(dir,'replug');fs.mkdirSync(folder);const target=path.join(folder,'resumed.bin'),m=manager('remount-download',{save:target});let restored;
  try{await m.pickDownload(machine,{entries:[entry('large.bin',520*1024**2)]});await until(()=>m.jobs[0].bytes>0);await m.pause(machine,m.jobs[0].id);const j=m.jobs[0],old=folder+'.unplugged';await m.shutdown();fs.renameSync(folder,old);fs.mkdirSync(folder);fs.copyFileSync(path.join(old,path.basename(j.local.part)),j.local.part);restored=manager('remount-download',{save:target});await restored.resume(machine,j.id);const job=await finish(restored);assert.equal(job.status,'done',job.code);assert.equal(await hash(target),await hash(path.join(remote,'large.bin')));}
  finally{await m.shutdown();await restored?.shutdown();}
});

test('full download and save to an actual SMB-mounted share', {skip:!process.env.GMSSH_TEST_VOLUME_DIR,timeout:60000},async()=>{
  const folder=fs.mkdtempSync(path.join(process.env.GMSSH_TEST_VOLUME_DIR||dir,'gmssh-download-')),target=path.join(folder,'中文互传.bin'),m=manager('smb-download',{save:target});
  try{await m.pickDownload(machine,{entries:[{path:'C:/folder/one.txt',name:'one.txt',directory:false,size:3}]});const job=await finish(m);assert.equal(job.status,'done',job.code);assert.equal(fs.readFileSync(target,'utf8'),'one');assert.equal(job.commitMethod,'copy');}
  finally{await m.shutdown();fs.rmSync(folder,{recursive:true,force:true});}
});

}
