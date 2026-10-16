/* Local UI fixture backed by real native task code and synthetic disk SFTP. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {FileTasks,proof}=require('../gmssh_windows_bridge/file-tasks.cjs');
async function main(){
 const web=path.resolve(process.argv[2]),work=path.resolve(process.argv[3]),source=path.resolve(__dirname,'..'),python=process.env.GMSSH_TEST_PYTHON||'python3',id='1'.repeat(32);fs.mkdirSync(work,{recursive:true});
 const remote=path.join(work,'remote'),local=path.join(work,'local');fs.mkdirSync(remote);fs.mkdirSync(local);
 const content=Buffer.alloc(16*1024**2,71);Buffer.from('Synthetic file-center content, no device access.\n').copy(content);fs.writeFileSync(path.join(remote,'资料.bin'),content);fs.writeFileSync(path.join(local,'上传演示.txt'),'Synthetic upload 中文');const expected=crypto.createHash('sha256').update(content).digest('hex');
 const fixture=spawn(python,[path.join(__dirname,'stream_fixture.py'),remote,web],{stdio:['ignore','pipe','inherit']});
 const raw=await new Promise(resolve=>fixture.stdout.once('data',b=>resolve(JSON.parse(b.toString().split('\n')[0]))));
 const binding={viewerUrl:raw.url,accessToken:raw.token,machineId:id,label:'演示工作站',target:'192.0.2.40'};
 const calls=[],make=()=>new FileTasks({root:path.join(work,'journal'),python,resolveBinding:async value=>value===id?binding:null,
  pickOpen:async()=>({filePaths:[path.join(local,'上传演示.txt')]}),pickSave:async options=>({filePath:path.join(local,path.basename(options.defaultPath||'资料.bin'))}),
  spawnWorker:(program,args,options)=>spawn(program,['-c',"import sys,runpy;sys.path.insert(0,sys.argv[1]);runpy.run_module('gmssh_windows_bridge.transfer_worker',run_name='__main__')",source],options)});
 let manager=make();const peer=(await manager.probe(id)).peer;
 const job=manager.newJob(id,binding.label,'download','C:/资料.bin','资料.bin',{target:path.join(local,'资料.bin')},{size:content.length,peer,sha256:expected,status:'running',expectedRemote:{size:content.length,modified:Math.floor(fs.statSync(path.join(remote,'资料.bin')).mtimeMs/1000),sha256:expected}});
 job.local.part=path.join(local,'.gmssh-transfer-'+job.partToken+'.part');fs.writeFileSync(job.local.part,content.subarray(0,2*1024**2));const fd=fs.openSync(job.local.part,'r');job.local.partProof=proof(fd);fs.closeSync(fd);job.bytes=2*1024**2;manager.save();manager.closed=true;manager=make();
 const tests=path.join(web,'tests');fs.mkdirSync(tests,{recursive:true});for(const name of ['native-file-entry.html','native-files-driver.js','native-file-small.html'])fs.copyFileSync(path.join(__dirname,name),path.join(tests,name));
 const page=path.join(web,'files.html');fs.writeFileSync(page,fs.readFileSync(page,'utf8').replace('</html>','<script src="/tests/native-files-driver.js"></script></html>'));
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/native'&&req.method==='POST'){
    let raw='';for await(const b of req){raw+=b;if(raw.length>262144)throw Error('limit');}const value=JSON.parse(raw);calls.push(value.action);let reply;
    try{reply={status:'ok',data:await manager.invoke(value.action,value.machineId,value.data)};}catch(error){reply={status:'error',code:error.code||'TRANSFER_IO'};}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(reply));return;
   }
   if(url.pathname==='/fixture-config.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({devices:[binding]}));return;}
   if(url.pathname==='/state'){res.setHeader('Content-Type','application/json');const final=path.join(local,'资料.bin');res.end(JSON.stringify({tasks:manager.list().jobs,calls,verified:fs.existsSync(final)&&crypto.createHash('sha256').update(fs.readFileSync(final)).digest('hex')===expected,uploaded:fs.existsSync(path.join(remote,'上传演示.txt'))}));return;}
   if(url.pathname==='/restore'&&req.method==='POST'){await manager.shutdown();manager=make();res.end('{}');return;}
   const file=path.resolve(web,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(web+path.sep)||!fs.statSync(file).isFile())throw Error('not found');res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream');fs.createReadStream(file).pipe(res);
  }catch{res.statusCode=404;res.end('fixture request unavailable');}
 });
 server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port+'/tests/native-file-entry.html'));
 const stop=async()=>{await manager.shutdown();server.close();fixture.kill('SIGTERM');process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
