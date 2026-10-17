const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {FileTasks,proof}=require('../gmssh_windows_bridge/file-tasks.cjs');
const source=path.resolve(__dirname,'..'),python=process.env.GMSSH_TEST_PYTHON||'python3',id='1'.repeat(32),wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<1000;i++){const result=fn();if(result)return result;await wait(10);}throw Error('volume test timed out');}
const digest=file=>{const h=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),b=Buffer.alloc(1024*1024);try{let n;while((n=fs.readSync(fd,b,0,b.length,null)))h.update(b.subarray(0,n));return h.digest('hex');}finally{fs.closeSync(fd);}};
function worker(copy=false,extra=''){return(program,_args,options)=>{const steps=["import sys,runpy","sys.path.insert(0,sys.argv[1])"];if(copy)steps.push("import errno,os,gmssh_windows_bridge.local_commit as c","c.rename_exclusive=lambda *a:(_ for _ in ()).throw(OSError(errno.ENOTSUP,'synthetic unsupported rename'))","os.link=lambda *a,**kw:(_ for _ in ()).throw(OSError(errno.ENOTSUP,'synthetic unsupported links'))");if(process.env.GMSSH_TEST_DEBUG)steps.push("import gmssh_windows_bridge.local_commit as c,traceback;original_code=c.io_code;c.io_code=lambda e:(traceback.print_exc(),original_code(e))[1]");if(process.env.GMSSH_TEST_DEBUG)steps.push("import gmssh_windows_bridge.file_stream as f,traceback;original_error=f.StreamError.__init__;f.StreamError.__init__=lambda self,code:(traceback.print_stack(),original_error(self,code))[1]");if(extra)steps.push(extra);steps.push("runpy.run_module('gmssh_windows_bridge.transfer_worker',run_name='__main__')");return spawn(program,['-c',steps.join(';'),source],process.env.GMSSH_TEST_DEBUG?{...options,stdio:options.stdio.map((v,i)=>i===2?'inherit':v)}:options);};}
function context(copy=false,base){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gmssh-volume-test-'))),folder=fs.mkdtempSync(path.join(base||root,'files-'));const selection={save:null};
 const m=new FileTasks({root:path.join(root,'journal'),python,spawnWorker:worker(copy),resolveBinding:async()=>({viewerUrl:'http://127.0.0.1:9/',accessToken:'s'.repeat(43)}),pickSave:async()=>({filePath:selection.save,canceled:!selection.save}),pickOpen:async()=>({canceled:true,filePaths:[]})});
 // Local-commit fixtures do not contact a real SSH server.
 m.probe=async()=>({peer:'SHA256:'+'A'.repeat(43)});
 return {root,folder,m,selection,cleanup:async()=>{await m.shutdown();fs.rmSync(folder,{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});}};
}
function prepare(c,bytes=8*1024**2){
 const token=crypto.randomBytes(16).toString('hex'),part=path.join(c.folder,'.gmssh-transfer-'+token+'.part'),target=path.join(c.folder,'保存-中文.bin');const fd=fs.openSync(part,'wx');fs.ftruncateSync(fd,bytes);if(bytes)fs.writeSync(fd,Buffer.from('test'),0,Math.min(4,bytes),0);const p=proof(fd);fs.closeSync(fd);const d=fs.statSync(c.folder,{bigint:true});
 const j=c.m.newJob(id,'Synthetic volume','download','C:/file.bin','file.bin',{part,target,partProof:p,directoryProof:{dev:BigInt.asUintN(64,d.dev).toString(),ino:BigInt.asUintN(64,d.ino).toString()}},{partToken:token,status:'paused',size:bytes,bytes,sha256:digest(part),peer:'SHA256:'+'A'.repeat(43),recoverCommit:true});c.m.save();c.selection.save=target;return j;
}
async function resume(c,j){await c.m.resume(id,j.id);await until(()=>!c.m.running);return c.m.jobs[0];}
if(process.platform==='win32')test('native volume save grants',{skip:'Mac/Unix controller'},()=>{});else{
 test('no rename or hard links: bounded compatibility copy, no overwrite, both files survive a conflict',async()=>{
  const c=context(true);try{const j=prepare(c);const sha=j.sha256;await resume(c,j);assert.equal(j.status,'done',j.code);assert.equal(j.commitMethod,'copy');assert.equal(digest(j.local.target),sha);assert.equal(fs.readdirSync(c.folder).some(f=>f.endsWith('.part')),false);}finally{await c.cleanup();}
  const d=context(true);try{const j=prepare(d);fs.writeFileSync(j.local.target,'keep existing');await resume(d,j);assert.equal(j.code,'CONFLICT');assert.equal(fs.readFileSync(j.local.target,'utf8'),'keep existing');assert.ok(fs.existsSync(j.local.part));}finally{await d.cleanup();}
 });
 test('compatibility copy pauses, reopens and verifies the existing prefix before resuming',async()=>{
  const c=context(true);let restored;try{
   c.m.spawnWorker=worker(true,"import os,time;original=os.pwrite;os.pwrite=lambda *a:(time.sleep(.003),original(*a))[1]");const j=prepare(c,32*1024**2);await c.m.resume(id,j.id);await until(()=>j.copyBytes>=2*1024**2);await c.m.pause(id,j.id);assert.equal(j.status,'paused');assert.ok(j.local.copyProof);assert.ok(fs.statSync(j.local.target).size<j.size);await c.m.shutdown();
   restored=new FileTasks({root:c.m.root,python,spawnWorker:worker(true),resolveBinding:c.m.resolveBinding,pickOpen:c.m.pickOpen,pickSave:c.m.pickSave});restored.probe=c.m.probe;await restored.resume(id,j.id);await until(()=>!restored.running);assert.equal(restored.jobs[0].status,'done',restored.jobs[0].code);assert.equal(digest(j.local.target),j.sha256);
  }finally{await restored?.shutdown();await c.cleanup();}
 });
 test('altered compatibility-copy bytes are rejected without overwriting them',async()=>{
  const c=context(true);try{c.m.spawnWorker=worker(true,"import os,time;original=os.pwrite;os.pwrite=lambda *a:(time.sleep(.003),original(*a))[1]");const j=prepare(c,16*1024**2);await c.m.resume(id,j.id);await until(()=>j.copyBytes>0);await c.m.pause(id,j.id);const fd=fs.openSync(j.local.target,'r+');fs.writeSync(fd,Buffer.from('bad!'),0,4,0);fs.closeSync(fd);await resume(c,j);assert.equal(j.status,'failed');assert.equal(j.code,'HASH_MISMATCH');assert.ok(fs.existsSync(j.local.part));const head=Buffer.alloc(4),check=fs.openSync(j.local.target,'r');fs.readSync(check,head,0,4,0);fs.closeSync(check);assert.equal(head.toString(),'bad!');}finally{await c.cleanup();}
 });
 test('directory flush unsupported still saves verified contents, and read-only volumes fail clearly',async()=>{
  const c=context();try{c.m.spawnWorker=worker(false,"import gmssh_windows_bridge.local_commit as c;c.sync_directory=lambda fd:False");const j=prepare(c,10);await resume(c,j);assert.equal(j.status,'done',j.code);assert.equal(j.directorySynced,false);}finally{await c.cleanup();}
  const d=context();try{d.m.spawnWorker=worker(false,"import errno,gmssh_windows_bridge.local_commit as c;c.rename_exclusive=lambda *a:(_ for _ in ()).throw(OSError(errno.EROFS,'synthetic read only'))");const j=prepare(d,10);await resume(d,j);assert.equal(j.code,'READ_ONLY_VOLUME');assert.ok(fs.existsSync(j.local.part));assert.equal(fs.existsSync(j.local.target),false);}finally{await d.cleanup();}
 });
 test('missing mount path is retained without fallback to a different directory',async()=>{
  const c=context();try{const j=prepare(c,10),old=c.folder+'.offline';fs.renameSync(c.folder,old);await assert.rejects(c.m.invoke('resume',id,{id:j.id}),/VOLUME_UNAVAILABLE/);assert.equal(fs.existsSync(c.folder),false);fs.renameSync(old,c.folder);await resume(c,j);assert.equal(j.status,'done',j.code);}finally{await c.cleanup();}
 });
 test('SMB mounted share saves through the actual filesystem', {skip:!process.env.GMSSH_TEST_VOLUME_DIR,timeout:60000},async()=>{
  const c=context(false,process.env.GMSSH_TEST_VOLUME_DIR);try{const j=prepare(c,8*1024**2),sha=j.sha256;await resume(c,j);if(process.env.GMSSH_TEST_DEBUG)console.log(JSON.stringify(j));assert.equal(j.status,'done',j.code);assert.equal(digest(j.local.target),sha);console.log('mounted-volume commit method:',j.commitMethod,'directory sync:',j.directorySynced);}finally{await c.cleanup();}
 });
 test('remounted directories revalidate the complete part and can follow a changed mount path',async()=>{
  const c=context();try{const j=prepare(c,10),old=c.folder+'.old';j.expectedRemote={size:j.size,modified:0,sha256:j.sha256};c.m.save();fs.renameSync(c.folder,old);fs.mkdirSync(c.folder);fs.copyFileSync(path.join(old,path.basename(j.local.part)),j.local.part);await resume(c,j);assert.equal(j.status,'done',j.code);assert.equal(digest(j.local.target),j.sha256);fs.rmSync(old,{recursive:true,force:true});}finally{await c.cleanup();}
  const d=context();try{const j=prepare(d,10),old=d.folder,changed=old+'-remounted';j.expectedRemote={size:j.size,modified:0,sha256:j.sha256};d.m.save();fs.renameSync(old,changed);d.selection.save=path.join(changed,path.basename(j.local.target));await resume(d,j);assert.equal(j.status,'done',j.code);assert.equal(digest(j.local.target),j.sha256);fs.rmSync(changed,{recursive:true,force:true});}finally{await d.cleanup();}
 });
 test('a signed legacy file ID is normalized when its journal is reopened',async()=>{
  const c=context();try{const j=prepare(c,1);j.local.partProof.ino='-1';c.m.save();const restored=new FileTasks({root:c.m.root,python,spawnWorker:worker(),resolveBinding:c.m.resolveBinding,pickOpen:c.m.pickOpen,pickSave:c.m.pickSave});assert.equal(restored.readyError,undefined);assert.equal(restored.jobs[0].local.partProof.ino,'18446744073709551615');await restored.shutdown();}finally{await c.cleanup();}
 });
 test('saving a verified local part does not require the original remote host to be online',async()=>{
  const c=context();try{const j=prepare(c,10);c.m.probe=async()=>{throw Error('remote is offline');};c.m.resolveBinding=async()=>{throw Error('remote is offline');};await resume(c,j);assert.equal(j.status,'done',j.code);}finally{await c.cleanup();}
 });
 test('actual SMB compatibility copy can pause and reopen safely', {skip:!process.env.GMSSH_TEST_VOLUME_DIR,timeout:60000},async()=>{
  const c=context(false,process.env.GMSSH_TEST_VOLUME_DIR);let restored;try{c.m.spawnWorker=worker(false,"import os,time;original=os.pwrite;os.pwrite=lambda *a:(time.sleep(.004),original(*a))[1]");const j=prepare(c,16*1024**2);await c.m.resume(id,j.id);await until(()=>j.copyBytes>=2*1024**2);await c.m.pause(id,j.id);assert.equal(j.status,'paused');await c.m.shutdown();restored=new FileTasks({root:c.m.root,python,spawnWorker:worker(),resolveBinding:c.m.resolveBinding,pickSave:c.m.pickSave,pickOpen:c.m.pickOpen});await restored.resume(id,j.id);await until(()=>!restored.running);assert.equal(restored.jobs[0].status,'done',restored.jobs[0].code);assert.equal(digest(j.local.target),j.sha256);}finally{await restored?.shutdown();await c.cleanup();}
 });

 test('cancelled compatibility copy cleans only its owned partial files',async()=>{
  const c=context(true);try{c.m.spawnWorker=worker(true,"import os,time;original=os.pwrite;os.pwrite=lambda *a:(time.sleep(.003),original(*a))[1]");const j=prepare(c,16*1024**2);await c.m.resume(id,j.id);await until(()=>j.copyBytes>0);const part=j.local.part,target=j.local.target;await c.m.cancel(id,j.id);assert.equal(j.status,'cancelled');assert.equal(fs.existsSync(part),false);assert.equal(fs.existsSync(target),false);assert.equal(j.recoverCommit,false);}finally{await c.cleanup();}
 });
 test('a copy reservation is never written before its journal acknowledgement',async()=>{
  const c=context(true),save=c.m.save.bind(c.m);let injected=false;try{const j=prepare(c);c.m.save=()=>{if(!injected&&j.local.copyProof){injected=true;throw Object.assign(Error('synthetic journal full'),{code:'ENOSPC'});}save();};await resume(c,j);assert.equal(j.status,'failed');assert.equal(fs.statSync(j.local.target).size,0);assert.ok(fs.existsSync(j.local.part));await resume(c,j);assert.equal(j.status,'done',j.code);assert.equal(digest(j.local.target),j.sha256);}finally{await c.cleanup();}
 });

 test('a download conflict can use a new filename without redownloading its verified part',async()=>{
  const c=context(true);try{const j=prepare(c,12),old=j.local.target;fs.writeFileSync(old,'keep');await resume(c,j);assert.equal(j.code,'CONFLICT');c.selection.save=path.join(c.folder,'另存.bin');await resume(c,j);assert.equal(j.status,'done',j.code);assert.equal(fs.readFileSync(old,'utf8'),'keep');assert.equal(digest(j.local.target),j.sha256);}finally{await c.cleanup();}
 });

}
