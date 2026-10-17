const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {FileTasks}=require('../gmssh_windows_bridge/file-tasks.cjs');
const machine='1'.repeat(32),other='2'.repeat(32);
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmssh-task-controls-')),m=new FileTasks({root,resolveBinding:async()=>{throw Error('must not connect');},pickOpen:async()=>{throw Error('must not open a picker');},pickSave:async()=>{throw Error('must not open a picker');}});return {m,close:async()=>{await m.shutdown();fs.rmSync(root,{recursive:true,force:true});},job:(id,status='queued',known={})=>m.newJob(id,'Synthetic','download','C:/资料.txt','资料.txt',{target:path.join(root,'received.txt')},{status,size:7,...known})};}

test('batch pause stops selected queue entries before the running worker finishes, preserving other devices',async()=>{
  const {m,job,close}=fixture();try{
    const running=job(machine,'running'),queued=job(machine),unselected=job(machine),different=job(other);let stopped=false;
    m.running={job:running,worker:{stop(){stopped=true;assert.equal(queued.status,'paused');assert.equal(unselected.status,'queued');assert.equal(different.status,'queued');running.status='paused';}},promise:Promise.resolve()};
    const result=await m.invoke('pause-many',machine,{ids:[running.id,queued.id]});assert.equal(result.paused,2);assert.ok(stopped);m.running=null;
    const saved=JSON.parse(fs.readFileSync(m.journal));assert.equal(saved.jobs.find(j=>j.id===queued.id).status,'paused');
  }finally{m.running=null;await close();}
});

test('invalid or cross-device batch IDs fail before mutating any tasks',async()=>{
  const {m,job,close}=fixture();try{
    const a=job(machine),b=job(other);for(const ids of [[],[a.id,a.id],[a.id,'2'],[a.id,b.id],[a.id,9999]])await assert.rejects(m.invoke('pause-many',machine,{ids}),/INVALID_TRANSFER|TASK_NOT_FOUND/);
    assert.equal(a.status,'queued');assert.equal(b.status,'queued');await assert.rejects(m.invoke('pause-many',null,{ids:[a.id]}),/INVALID_TRANSFER/);
    await assert.rejects(m.invoke('clear',machine,{ids:[a.id,b.id]}),/TASK_NOT_FOUND/);assert.equal(m.jobs.length,2);
  }finally{await close();}
});

test('filtered record cleanup never deletes files or drops unfinished and pending-cleanup tasks',async()=>{
  const {m,job,close}=fixture();try{
    const done=job(machine,'done'),cancelled=job(machine,'cancelled'),pending=job(machine,'cancelled',{cleanupPending:true}),paused=job(machine,'paused'),different=job(other,'done'),later=job(machine,'done');
    fs.writeFileSync(done.local.target,'keep actual content');m.grants.set(done.id,true);
    assert.deepEqual(await m.invoke('clear',machine,{ids:[done.id,cancelled.id,pending.id,paused.id]}),{cleared:2});
    assert.deepEqual(m.jobs.map(j=>j.id),[pending.id,paused.id,different.id,later.id]);assert.equal(fs.readFileSync(done.local.target,'utf8'),'keep actual content');assert.equal(m.grants.has(done.id),false);
    const restored=new FileTasks({root:m.root});assert.deepEqual(restored.jobs.map(j=>j.id),m.jobs.map(j=>j.id));await restored.shutdown();
  }finally{await close();}
});

test('task details are metadata only, keep all 2000 jobs reachable, and need no local or remote I/O',async()=>{
  const {m,job,close}=fixture();try{
    for(let i=0;i<2000;i++)job(i%2?machine:other,'paused');
    const value=await m.invoke('list',null,{});assert.equal(value.jobs.length,2000);assert.equal((await m.invoke('list',machine,{})).jobs.length,1000);
    assert.equal(value.jobs[0].source,'C:/资料.txt');assert.ok(path.isAbsolute(value.jobs[0].target));assert.equal(value.jobs[0].createdAt,m.jobs[0].createdAt);assert.equal(value.jobs[0].needsGrant,true);
    assert.ok(!JSON.stringify(value).includes('partToken'));assert.equal(m.running,undefined);
  }finally{await close();}
});
