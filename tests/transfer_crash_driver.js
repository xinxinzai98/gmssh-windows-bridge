/* Task-owned child process used only to test a hard controller exit. */
const {FileTasks}=require('../gmssh_windows_bridge/file-tasks.cjs');
const {spawn}=require('node:child_process');
const readline=require('node:readline'),path=require('node:path');
readline.createInterface({input:process.stdin}).once('line',async raw=>{
  const c=JSON.parse(raw),source=path.resolve(__dirname,'..');
  const manager=new FileTasks({root:c.root,python:c.python,resolveBinding:async()=>c.binding,
    pickOpen:async()=>({canceled:true,filePaths:[]}),pickSave:async()=>({filePath:c.target}),
    spawnWorker:(python,args,options)=>spawn(python,['-c',"import sys,runpy;sys.path.insert(0,sys.argv[1]);runpy.run_module('gmssh_windows_bridge.transfer_worker',run_name='__main__')",source],options)});
  await manager.pickDownload('1'.repeat(32),{entries:[{path:'C:/large.bin',name:'large.bin',directory:false,size:520*1024**2}]});
  setInterval(()=>process.stdout.write(JSON.stringify(manager.list())+'\n'),15);
});
