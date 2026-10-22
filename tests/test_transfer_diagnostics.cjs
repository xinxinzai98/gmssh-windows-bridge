const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {FileTasks}=require('../gmssh_windows_bridge/file-tasks.cjs');
const machine='1'.repeat(32),token='synthetic-private-token-never-exported';
function manager(root,worker){return new FileTasks({root,python:process.execPath,resolveBinding:async()=>({viewerUrl:'http://127.0.0.1:12345/',accessToken:token,label:'Private device name'}),pickOpen:async()=>({canceled:true}),pickSave:async()=>({canceled:true}),spawnWorker:worker});}
async function failedJob(script){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmssh-startup-'));let starts=0;
  const worker=(_python,_args,options)=>{starts++;return spawn(process.execPath,['-e',script],options);};
  const m=manager(root,worker);const j=m.newJob(machine,'Private device name','directory','C:/Private-folder','Private-folder');m.grants.set(j.id,true);m.save();m.pump();await m.running.promise;
  return {m,root,worker,starts,async close(){await m.shutdown();fs.rmSync(root,{recursive:true,force:true});}};
}
test('failure stage survives reopen and the diagnostic export excludes private connection and paths',async()=>{
  const run=await failedJob(`process.stdin.once('data',raw=>{
    if(JSON.parse(raw).diagnostics!==1)process.exit(8);
    console.log(JSON.stringify({event:'stage',stage:'local-auth'}));
    console.log(JSON.stringify({event:'error',code:'LOCAL_SERVICE_TIMEOUT',diagnostic:{stage:'local-auth',version:'0.4.0a35',errorType:'TimeoutError',token:'${token}',message:'C:/Private-folder',host:'192.0.2.1'}}));
    process.exit(0);
  });`);
  try{
    const j=run.m.jobs[0];assert.equal(j.status,'failed');assert.equal(j.code,'LOCAL_SERVICE_TIMEOUT');assert.equal(run.starts,1);
    assert.equal(j.diagnostic.stage,'local-auth');assert.equal(j.diagnostic.errorType,'TimeoutError');assert.ok(j.diagnostic.at);
    await run.m.shutdown();const restored=manager(run.root,run.worker);assert.equal(restored.running,undefined);
    const report=await restored.invoke('diagnostic',machine,{id:j.id});assert.equal(report.lastFailure.stage,'local-auth');
    const text=JSON.stringify(report);for(const secret of [token,'C:/','Private-folder','Private device name',machine,'192.0.2.1'])assert.ok(!text.includes(secret));
    await assert.rejects(restored.invoke('diagnostic','2'.repeat(32),{id:j.id}),/TASK_NOT_FOUND/);
    await restored.shutdown();
  }finally{await run.close();}
});
test('an early worker exit preserves its exit code without capturing raw stderr or restarting it',async()=>{
  const run=await failedJob("process.stderr.write('private path and credential details');process.exit(7)");
  try{const j=run.m.jobs[0];assert.equal(j.code,'WORKER_EXITED');assert.equal(j.diagnostic.exitCode,7);assert.equal(j.diagnostic.stage,'worker-start');assert.equal(run.starts,1);assert.ok(!fs.readFileSync(run.m.journal,'utf8').includes('credential'));}
  finally{await run.close();}
});
test('a clean worker exit without a result is distinct from a transport failure',async()=>{
  const run=await failedJob('process.exit(0)');
  try{assert.equal(run.m.jobs[0].code,'WORKER_NO_RESULT');assert.equal(run.m.jobs[0].diagnostic.exitCode,0);}
  finally{await run.close();}
});
test('a missing worker executable reports its startup failure rather than a missing transfer volume',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmssh-startup-'));const m=manager(root,(_p,_a,options)=>spawn(path.join(root,'missing-python'),[],options));
  try{const j=m.newJob(machine,'Synthetic','directory','C:/folder','folder');m.grants.set(j.id,true);m.save();m.pump();await m.running.promise;assert.equal(m.jobs[0].code,'WORKER_START_FAILED');assert.equal(m.jobs[0].diagnostic.systemCode,'ENOENT');}
  finally{await m.shutdown();fs.rmSync(root,{recursive:true,force:true});}
});
