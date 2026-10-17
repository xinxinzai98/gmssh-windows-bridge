/* Native transfer ownership and permission grants. Renderer paths never grant local access. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const MAX_SIZE=1024**4,MAX_JOBS=2000,ACTIVE=new Set(['queued','running','committing']);
const HEX=/^[a-f0-9]{64}$/,ID=/^[a-f0-9]{32}$/i,PEER=/^SHA256:[A-Za-z0-9+/]{43}$/;
const unsigned=value=>BigInt.asUintN(64,BigInt(value)).toString();
const fail=code=>Object.assign(Error(code),{code});
function name(value){if(typeof value!=='string'||!value||value.length>255||value==='.'||value==='..'||/[<>:"/\\|?*\x00-\x1f\x7f]/.test(value)||/[. ]$/.test(value)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value))throw fail('INVALID_NAME');return value;}
function remote(value){if(typeof value!=='string'||value.length>1024||!/^[A-Za-z]:\//.test(value))throw fail('INVALID_PATH');const parts=value.slice(3).split('/').filter(Boolean);parts.forEach(name);return value[0].toUpperCase()+':/'+parts.join('/');}
function relative(value){if(typeof value!=='string'||value.split('/').length>32)throw fail('INVALID_NAME');return value.split('/').map(name).join('/');}
function size(value){if(!Number.isSafeInteger(value)||value<0||value>MAX_SIZE)throw fail('TRANSFER_LIMIT');return value;}
function proof(fd){const s=fs.fstatSync(fd,{bigint:true});if(!s.isFile())throw fail('UNSUPPORTED_FILE');return {size:size(Number(s.size)),modifiedNs:s.mtimeNs.toString(),dev:unsigned(s.dev),ino:unsigned(s.ino)};}
function openFile(file,flags){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())throw fail('UNSUPPORTED_FILE');return fs.openSync(file,flags|(fs.constants.O_NOFOLLOW||0));}
function canonicalFile(file){if(typeof file!=='string'||!path.isAbsolute(file))throw fail('INVALID_GRANT');return path.join(fs.realpathSync(path.dirname(file)),path.basename(file));}
function directory(folder){const real=fs.realpathSync(folder),s=fs.lstatSync(real);if(!s.isDirectory()||s.isSymbolicLink())throw fail('INVALID_GRANT');return real;}
function directoryProof(value){const info=typeof value==='number'?fs.fstatSync(value,{bigint:true}):fs.statSync(value,{bigint:true});if(!info.isDirectory())throw fail('VOLUME_UNAVAILABLE');return {dev:unsigned(info.dev),ino:unsigned(info.ino)};}
function closeGrant(fd){if(fd>=0){try{fs.closeSync(fd);}catch{ /* Content flush/verification is acknowledged by the worker before closing its grant. */ }}}
function sameFile(a,b){return !!a&&!!b&&a.dev===b.dev&&a.ino===b.ino;}
function errorCode(error){if(['ENODEV','ENXIO','ESTALE','EIO','ENOTCONN','ETIMEDOUT','ENOENT'].includes(error.code))return 'VOLUME_UNAVAILABLE';if(error.code==='EROFS')return 'READ_ONLY_VOLUME';if(error.code==='EFBIG')return 'FILE_TOO_LARGE';return ['ENOTSUP','EOPNOTSUPP','EXDEV'].includes(error.code)?'COMMIT_UNSUPPORTED':['ENOSPC','EDQUOT'].includes(error.code)?'DISK_FULL':['EACCES','EPERM'].includes(error.code)?'ACCESS_DENIED':error.code==='EEXIST'?'CONFLICT':error.code||'TRANSFER_IO';}
function atomic(file,value){const temp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);const parent=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}}
function validJob(j){
  if(!j||!Number.isSafeInteger(j.id)||j.id<1||!ID.test(j.machineId)||!ID.test(j.partToken)||!['upload','download','directory'].includes(j.kind)||!['queued','running','committing','paused','done','failed','cancelled'].includes(j.status)||typeof j.name!=='string'||j.name.length>1024||!j.local||typeof j.local!=='object'||j.peer!==null&&!PEER.test(j.peer)||j.sha256!==null&&!HEX.test(j.sha256))throw fail('JOURNAL_INVALID');
  remote(j.remote);size(j.size);size(j.bytes);if(j.bytes>j.size)throw fail('JOURNAL_INVALID');
  for(const key of ['source','target','part','root'])if(j.local[key]!==undefined&&(typeof j.local[key]!=='string'||!path.isAbsolute(j.local[key])||j.local[key].length>4096))throw fail('JOURNAL_INVALID');
  if(typeof j.device!=='string'||j.device.length>128||!j.name||j.name.length>1024||typeof j.createdAt!=='string')throw fail('JOURNAL_INVALID');
  if(j.kind==='upload'&&(!j.local.source||!j.local.proof)||j.kind==='download'&&!j.local.target)throw fail('JOURNAL_INVALID');
  for(const p of [j.local.proof,j.local.partProof,j.local.copyProof,j.local.directoryProof].filter(Boolean))for(const key of ['dev','ino']){if(typeof p[key]!=='string'||!/^[-]?\d{1,30}$/.test(p[key]))throw fail('JOURNAL_INVALID');p[key]=unsigned(p[key]);}
  for(const p of [j.local.proof,j.local.partProof,j.local.copyProof].filter(Boolean))if(!Number.isSafeInteger(p.size)||p.size<0||p.size>MAX_SIZE||!['modifiedNs','dev','ino'].every(k=>typeof p[k]==='string'&&/^\d{1,30}$/.test(p[k])))throw fail('JOURNAL_INVALID');
  if(j.local.directoryProof&&!['dev','ino'].every(k=>typeof j.local.directoryProof[k]==='string'&&/^\d{1,30}$/.test(j.local.directoryProof[k])))throw fail('JOURNAL_INVALID');
  if(j.local.part&&j.local.part!==path.join(path.dirname(j.local.target),'.gmssh-transfer-'+j.partToken+'.part'))throw fail('JOURNAL_INVALID');
  return j;
}

class FileTasks {
  constructor({root,python,resolveBinding,pickOpen,pickSave,spawnWorker=spawn}){
    Object.assign(this,{root,python,resolveBinding,pickOpen,pickSave,spawnWorker});this.jobs=[];this.next=1;this.grants=new Map();this.queries=new Set();this.version=0;this.closed=false;this.dialogBusy=false;
    this.journal=path.join(root,'transfer-journal.json');
    try{
      if(fs.existsSync(root)&&(!fs.lstatSync(root).isDirectory()||fs.lstatSync(root).isSymbolicLink()))throw fail('JOURNAL_INVALID');
      fs.mkdirSync(root,{recursive:true,mode:0o700});fs.chmodSync(root,0o700);
      if(fs.existsSync(this.journal)){
        const s=fs.lstatSync(this.journal);if(!s.isFile()||s.isSymbolicLink()||s.size>32*1024*1024)throw fail('JOURNAL_INVALID');
        const v=JSON.parse(fs.readFileSync(this.journal,'utf8'));if(v.schema!==1||!Array.isArray(v.jobs)||v.jobs.length>MAX_JOBS||!Number.isSafeInteger(v.next)||v.next<1)throw fail('JOURNAL_INVALID');
        this.jobs=v.jobs.map(validJob);if(new Set(this.jobs.map(j=>j.id)).size!==this.jobs.length||this.jobs.some(j=>j.id>=v.next))throw fail('JOURNAL_INVALID');this.next=v.next;
        for(const job of this.jobs)if(ACTIVE.has(job.status)){job.recoverCommit=job.status==='committing';job.status='paused';job.code='REAUTHORIZE';}
      }
    }catch{this.jobs=[];this.readyError='JOURNAL_INVALID';}
  }
  save(){if(this.readyError)throw fail(this.readyError);atomic(this.journal,{schema:1,next:this.next,jobs:this.jobs});this.version++;}
  activeCount(){return this.jobs.filter(j=>ACTIVE.has(j.status)).length;}
  list(machineId){return {version:this.version,jobs:this.jobs.filter(j=>!machineId||j.machineId===machineId).map(j=>({id:j.id,machineId:j.machineId,device:j.device,name:j.name,kind:j.kind,status:j.status,bytes:j.bytes,size:j.size,phase:j.phase||'',copyBytes:j.copyBytes||0,code:j.code||'',sha256:j.status==='done'?j.sha256:null,started:j.started||0,needsGrant:!this.grants.has(j.id)&&j.status!=='done',cleanupPending:!!j.cleanupPending}))};}
  job(machineId,id){const j=this.jobs.find(j=>j.id===id&&j.machineId===machineId);if(!j)throw fail('TASK_NOT_FOUND');return j;}
  async binding(machineId){if(!ID.test(machineId))throw fail('INVALID_DEVICE');const value=await this.resolveBinding(machineId);if(!value)throw fail('DEVICE_CONFIG_UNAVAILABLE');return value;}
  async picker(run){if(this.dialogBusy)throw fail('PICKER_BUSY');this.dialogBusy=true;try{return await run();}finally{this.dialogBusy=false;}}
  newJob(machineId,device,kind,target,label,local={},known={}){
    if(this.jobs.length>=MAX_JOBS)throw fail('TRANSFER_LIMIT');
    const j={id:this.next++,machineId,device:String(device||'设备').slice(0,128),kind,remote:remote(target),name:label,local,partToken:crypto.randomBytes(16).toString('hex'),peer:null,sha256:null,size:0,bytes:0,status:'queued',createdAt:new Date().toISOString(),...known};this.jobs.push(j);return j;
  }
  run(command,fd=-1,onEvent=async()=>{},directoryFd=-1){
    const env={...process.env};delete env.PYTHONPATH;delete env.PYTHONHOME;
    const child=this.spawnWorker(this.python,['-m','gmssh_windows_bridge.transfer_worker'],{env,stdio:['pipe','pipe','ignore','ignore',fd<0?'ignore':fd,directoryFd<0?'ignore':directoryFd]});
    let text='',result,problem,chain=Promise.resolve(),settled=false;
    const processLine=async line=>{const event=JSON.parse(line);if(!event||typeof event!=='object')throw fail('INVALID_RESPONSE');if(event.event==='prepared'){await onEvent(event);child.stdin.write('{"ack":"prepared"}\n');}else if(event.event==='error')problem=fail(typeof event.code==='string'&&/^[A-Z_]{1,48}$/.test(event.code)?event.code:'TRANSFER_IO');else if(event.event==='done'){result=event.result;await onEvent(event);}else if(['progress','checkpoint'].includes(event.event))await onEvent(event);else throw fail('INVALID_RESPONSE');};
    const promise=new Promise((resolve,reject)=>{
      child.on('error',error=>{if(!settled){settled=true;reject(fail(errorCode(error)));}});
      child.stdout.on('data',chunk=>{text+=chunk.toString('utf8');if(text.length>4*1024*1024){problem=fail('INVALID_RESPONSE');child.kill('SIGKILL');return;}let n;while((n=text.indexOf('\n'))>=0){const line=text.slice(0,n);text=text.slice(n+1);chain=chain.then(()=>processLine(line)).catch(error=>{problem=error;child.stdin.destroy();child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);child.once('close',()=>clearTimeout(timer));});}});
      child.on('close',(code)=>{chain.finally(()=>{if(settled)return;settled=true;if(problem)reject(problem);else if(code!==0||!result)reject(fail('TRANSFER_IO'));else resolve(result);});});
      child.stdin.on('error',()=>{});child.stdin.write(JSON.stringify(command)+'\n');
    });
    const running={promise,stop:()=>{child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);promise.finally(()=>clearTimeout(timer)).catch(()=>{});}};return running;
  }
  async query(machineId,kind,values={}){if(this.queries.size>=2)throw fail('QUERY_BUSY');const b=await this.binding(machineId),running=this.run({url:b.viewerUrl,token:b.accessToken,kind,...values});this.queries.add(running);try{return await running.promise;}finally{this.queries.delete(running);}}
  async probe(machineId,peer=null){return this.query(machineId,'probe',{peer});}
  async pickUpload(machineId,{remote:target,directory:folder=false,hints=[]}={}){
    target=remote(target);const b=await this.binding(machineId),identity=await this.probe(machineId);if(!PEER.test(identity.peer))throw fail('INVALID_RESPONSE');if(!Array.isArray(hints)||hints.length>2000)throw fail('TRANSFER_LIMIT');
    const chosen=await this.picker(()=>this.pickOpen({title:hints.length?'确认拖入的本机文件，授权可恢复的读取':'选择上传的'+(folder?'文件夹':'文件'),properties:hints.length?['openFile','openDirectory','multiSelections']:folder?['openDirectory']:['openFile','multiSelections']}));
    if(chosen.canceled||!chosen.filePaths?.length)return {cancelled:true};if(this.closed)throw fail('MANAGER_CLOSED');
    const sources=[],dirs=[];
    const walk=(full,rel,depth)=>{if(depth>32||sources.length+dirs.length>=2000)throw fail('TRANSFER_LIMIT');const s=fs.lstatSync(full);if(s.isSymbolicLink())throw fail('UNSUPPORTED_FILE');if(s.isDirectory()){dirs.push(rel);for(const entry of fs.readdirSync(full))walk(path.join(full,entry),relative(rel+'/'+entry),depth+1);}else if(s.isFile()){const fd=openFile(full,fs.constants.O_RDONLY);try{sources.push({full,relative:rel,proof:proof(fd)});}finally{fs.closeSync(fd);}}else throw fail('UNSUPPORTED_FILE');};
    for(const file of chosen.filePaths){const full=canonicalFile(file);if(folder||hints.some(h=>h.directory))walk(full,name(path.basename(full)),0);else{const fd=openFile(full,fs.constants.O_RDONLY);try{sources.push({full,relative:name(path.basename(full)),proof:proof(fd)});}finally{fs.closeSync(fd);}}}
    if(hints.length){const expected=hints.filter(h=>!h.directory);if(expected.length!==sources.length||sources.some(s=>!expected.some(h=>(h.relative===s.relative||h.name===path.basename(s.relative))&&h.size===s.proof.size&&Math.floor(Number(BigInt(s.proof.modifiedNs)/1000000n))===h.modified)))throw fail('SOURCE_CHANGED');}
    if(this.jobs.length+sources.length+dirs.length>MAX_JOBS)throw fail('TRANSFER_LIMIT');
    const staged=[...dirs.map(rel=>({kind:'directory',target:remote(target.replace(/\/$/,'')+'/'+rel),label:rel,known:{peer:identity.peer}})),...sources.map(s=>({kind:'upload',target:remote(target.replace(/\/$/,'')+'/'+s.relative),label:s.relative,local:{source:s.full,proof:s.proof},known:{size:s.proof.size,peer:identity.peer}}))];
    for(const row of staged){const j=this.newJob(machineId,b.label,row.kind,row.target,row.label,row.local,row.known);this.grants.set(j.id,true);}
    this.save();this.pump();return {count:sources.length};
  }
  childTarget(root,rel){const parts=relative(rel).split('/');let current=root;for(const part of parts.slice(0,-1)){current=path.join(current,part);if(!fs.existsSync(current))fs.mkdirSync(current,0o700);const s=fs.lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink())throw fail('INVALID_GRANT');}return path.join(current,parts.at(-1));}
  async pickDownload(machineId,{entries}={}){
    const b=await this.binding(machineId);if(!Array.isArray(entries)||!entries.length||entries.length>2000)throw fail('INVALID_TRANSFER');
    const files=entries.map(e=>({path:remote(e.path),name:name(e.name),directory:e.directory===true,size:size(e.size)})),identity=await this.probe(machineId);if(!PEER.test(identity.peer))throw fail('INVALID_RESPONSE');
    let root,targets=[];
    if(files.length===1&&!files[0].directory){const picked=await this.picker(()=>this.pickSave({title:'保存下载文件',defaultPath:files[0].name}));if(picked.canceled||!picked.filePath)return {cancelled:true};targets=[{file:files[0],target:canonicalFile(picked.filePath)}];}
    else{
      const picked=await this.picker(()=>this.pickOpen({title:'选择下载目录',properties:['openDirectory','createDirectory']}));if(picked.canceled||!picked.filePaths?.length)return {cancelled:true};root=directory(picked.filePaths[0]);
      for(const file of files){if(!file.directory)targets.push({file,target:this.childTarget(root,file.name)});else{const manifest=await this.query(machineId,'walk',{remote:file.path,peer:identity.peer});if(!PEER.test(manifest.peer)||!Array.isArray(manifest.entries)||manifest.entries.length>2000)throw fail('INVALID_RESPONSE');for(const row of manifest.entries){const rel=row.relative?relative(file.name+'/'+row.relative):file.name;if(row.directory){this.childTarget(root,rel+'/placeholder');}else targets.push({file:{path:remote(file.path.replace(/\/$/,'')+'/'+row.relative),name:rel,size:size(row.size),known:{size:row.size,modified:row.modified}},target:this.childTarget(root,rel)});}}}
    }
    if(this.closed)throw fail('MANAGER_CLOSED');if(this.jobs.length+targets.length>MAX_JOBS)throw fail('TRANSFER_LIMIT');
    for(const {file,target} of targets){const j=this.newJob(machineId,b.label,'download',file.path,file.name,{target,directoryProof:directoryProof(path.dirname(target))},{size:file.size,selectedRemote:file.known||null,peer:identity.peer});this.grants.set(j.id,{parent:j.local.directoryProof,revalidate:false});}
    this.save();this.pump();return {count:targets.length};
  }
  async resume(machineId,id,newName){
    const j=this.job(machineId,id);if(j.status==='done')throw fail('TASK_FINISHED');if(ACTIVE.has(j.status))throw fail('TASK_BUSY');if(!(j.kind==='download'&&j.recoverCommit&&j.sha256))await this.probe(machineId,j.peer);
    if(newName){if(j.kind!=='upload')throw fail('INVALID_NAME');j.remote=remote(j.remote.slice(0,j.remote.lastIndexOf('/')+1)+name(newName));j.name=j.name.split('/').slice(0,-1).concat(newName).join('/');}
    if(j.kind==='download'&&j.code==='CONFLICT')this.grants.delete(id);
    if(!this.grants.has(id)){
      if(j.kind==='upload'){
        const selected=await this.picker(()=>this.pickOpen({title:'重新选择源文件以恢复上传',defaultPath:j.local.source,properties:['openFile']}));if(selected.canceled||!selected.filePaths?.length)return {cancelled:true};const source=canonicalFile(selected.filePaths[0]),fd=openFile(source,fs.constants.O_RDONLY);let p;try{p=proof(fd);}finally{fs.closeSync(fd);}if(p.size!==j.local.proof.size||p.modifiedNs!==j.local.proof.modifiedNs)throw fail('SOURCE_CHANGED');j.local.source=source;j.local.proof=p;
      }else if(j.kind==='download'){
        const selected=await this.picker(()=>this.pickSave({title:'确认原目标位置以恢复下载',defaultPath:j.local.target}));if(selected.canceled||!selected.filePath)return {cancelled:true};const target=canonicalFile(selected.filePath);
        if(target!==j.local.target){
          const part=path.join(path.dirname(target),'.gmssh-transfer-'+j.partToken+'.part');
          if(!j.local.part||!(j.expectedRemote?.sha256||j.recoverCommit&&j.sha256)||(!fs.existsSync(part)&&!(j.recoverCommit&&fs.existsSync(target))))throw fail('PARTIAL_MISSING');
          j.local.target=target;j.local.part=part;
        }
      }
      this.grants.set(id,j.kind==='download'?{parent:directoryProof(path.dirname(j.local.target)),revalidate:true}:true);
    }
    j.status='queued';j.code='';this.save();this.pump();return {resumed:true};
  }
  async pause(machineId,id){const j=this.job(machineId,id);if(this.running?.job===j){this.running.reason='pause';this.running.worker?.stop();await this.running.promise;}else if(ACTIVE.has(j.status)){j.status='paused';j.code='PAUSED';this.save();}return {paused:true};}
  async cancel(machineId,id){const j=this.job(machineId,id);if(j.status==='done'){if(!j.cleanupPending||j.kind!=='upload')throw fail('TASK_FINISHED');await this.query(machineId,'discard',{remote:j.remote,peer:j.peer,partToken:j.partToken,size:j.size,sha256:j.sha256});j.cleanupPending=false;this.save();return {cleaned:true};}await this.pause(machineId,id);
    if(j.kind==='download'&&j.local.part&&!this.grants.has(id)){
      j.status='cancelled';j.code='CANCELLED';j.cleanupPending=true;this.save();
      const picked=await this.picker(()=>this.pickSave({title:'确认原保存位置并清理本任务的临时文件',defaultPath:j.local.target}));
      if(picked.canceled||!picked.filePath)return {cancelled:true,cleanupPending:true};
      if(canonicalFile(picked.filePath)!==j.local.target)throw fail('TARGET_CHANGED');this.grants.set(id,true);
    }
    let retained=false;
    if(j.kind==='download'&&this.grants.has(id)){
      const owned=[];
      for(const [file,expected,isPart] of [[j.local.part,j.local.partProof,true],[j.local.target,j.local.copyProof,false]])if(file&&expected){
        try{const fd=openFile(file,fs.constants.O_RDONLY);let p;try{p=proof(fd);}finally{closeGrant(fd);}if(!sameFile(p,expected)){this.grants.delete(id);throw fail('PARTIAL_CHANGED');}owned.push({file,remove:isPart||p.size<j.size,isPart});}
        catch(error){if(error.code!=='ENOENT')throw error;}
      }
      for(const entry of owned)if(entry.remove){fs.unlinkSync(entry.file);if(!entry.isPart)j.local.copyProof=undefined;}else retained=true;
      j.local.part=undefined;j.local.partProof=undefined;j.cleanupPending=false;if(!retained){j.local.copyProof=undefined;j.recoverCommit=false;}
    }
    if(j.kind==='upload'&&j.sha256&&j.peer){try{await this.query(machineId,'discard',{remote:j.remote,peer:j.peer,partToken:j.partToken,size:j.size,sha256:j.sha256});j.cleanupPending=false;}catch{j.cleanupPending=true;}}
    j.status='cancelled';j.code=retained?'CANCELLED_FILE_RETAINED':'CANCELLED';j.bytes=0;if(j.kind==='upload'&&!j.cleanupPending){j.partToken=crypto.randomBytes(16).toString('hex');j.sha256=null;}this.save();return {cancelled:true};
  }
  async pauseAll(){if(this.readyError)return;for(const j of this.jobs)if(j.status==='queued'){j.status='paused';j.code='PAUSED';}if(this.running){this.running.reason='pause';this.running.worker?.stop();await this.running.promise;}this.save();}
  async shutdown(){this.closed=true;try{await this.pauseAll();}finally{const pending=[...this.queries];for(const q of pending)q.stop();await Promise.allSettled(pending.map(q=>q.promise));this.grants.clear();}}
  clear(machineId){this.jobs=this.jobs.filter(j=>j.machineId!==machineId||!['done','cancelled'].includes(j.status)||j.cleanupPending);this.save();}
  async invoke(action,machineId,data={}){
    if(this.readyError)throw fail(this.readyError);if(this.closed)throw fail('MANAGER_CLOSED');
    const keys={hello:[],list:[],'pick-upload':['remote','directory','hints'],'pick-download':['entries'],resume:['id','name'],pause:['id'],cancel:['id'],clear:[],'cancel-all':[]}[action];
    if(!keys||(machineId!=null&&!ID.test(machineId))||!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!keys.includes(k))||(!['hello','list'].includes(action)&&!ID.test(machineId)))throw fail('INVALID_TRANSFER');
    if(['resume','pause','cancel'].includes(action)&&!Number.isSafeInteger(data.id))throw fail('INVALID_TRANSFER');
    try{
    if(action==='hello')return {protocol:2,maximum:MAX_SIZE};
    if(action==='list')return this.list(machineId);
    if(action==='pick-upload')return await this.pickUpload(machineId,data);
    if(action==='pick-download')return await this.pickDownload(machineId,data);
    if(action==='resume')return await this.resume(machineId,data.id,data.name);
    if(action==='pause')return await this.pause(machineId,data.id);
    if(action==='cancel')return await this.cancel(machineId,data.id);
    if(action==='clear'){this.clear(machineId);return {};}
    if(action==='cancel-all'){const pending=this.jobs.filter(j=>j.machineId===machineId&&['queued','running','committing','paused','failed'].includes(j.status));for(const j of pending)if(j.status==='queued')j.status='paused';for(const j of pending)await this.cancel(machineId,j.id);return {};}
    throw fail('INVALID_TRANSFER');
    }catch(error){throw fail(errorCode(error));}
  }
  pump(){if(this.running||this.closed||this.readyError)return;const job=this.jobs.find(j=>j.status==='queued');if(!job)return;const run={job,reason:null,worker:null,promise:null};this.running=run;run.promise=this.execute(run).finally(()=>{this.running=null;if(!this.closed)this.pump();});}
  async execute(run){
    const j=run.job;let fd=-1,directoryFd=-1;
    try{
      if(!this.grants.has(j.id))throw fail('REAUTHORIZE');const b=j.kind==='download'&&j.recoverCommit?null:await this.binding(j.machineId);if(run.reason)throw fail('PAUSED');j.status='running';j.started=Date.now();j.phase='verifying';j.code='';this.save();
      if(j.kind==='directory'){const command={url:b.viewerUrl,token:b.accessToken,kind:'mkdir',remote:j.remote,peer:j.peer};run.worker=this.run(command);const result=await run.worker.promise;j.peer=result.peer;if(run.reason)throw fail('PAUSED');j.status='done';j.phase='';this.save();return;}
      if(j.kind==='upload'){
        fd=openFile(j.local.source,fs.constants.O_RDONLY);const p=proof(fd);if(p.size!==j.local.proof.size||p.modifiedNs!==j.local.proof.modifiedNs||p.dev!==j.local.proof.dev||p.ino!==j.local.proof.ino)throw fail('SOURCE_CHANGED');
      }else{
        const target=canonicalFile(j.local.target);if(target!==j.local.target)throw fail('TARGET_CHANGED');
        const grant=this.grants.get(j.id);directoryFd=fs.openSync(path.dirname(target),fs.constants.O_RDONLY|(fs.constants.O_DIRECTORY||0)|(fs.constants.O_NOFOLLOW||0));const parent=directoryProof(directoryFd);
        if(grant!==true&&!sameFile(grant.parent,parent))throw fail('VOLUME_UNAVAILABLE');
        if(j.recoverCommit){await this.recoverCommit(j,run,directoryFd);return;}
        if(fs.existsSync(target))throw fail('CONFLICT');
        if(j.local.part){fd=openFile(j.local.part,fs.constants.O_RDWR);const p=proof(fd);if(!sameFile(p,j.local.partProof)){if(!grant.revalidate||!j.local.directoryProof||sameFile(parent,j.local.directoryProof)||!j.expectedRemote?.sha256)throw fail('PARTIAL_CHANGED');run.rebind=true;}}
        else{j.local.part=path.join(path.dirname(target),'.gmssh-transfer-'+j.partToken+'.part');fd=fs.openSync(j.local.part,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_RDWR|(fs.constants.O_NOFOLLOW||0),0o600);j.local.partProof=proof(fd);this.save();}
      }
      const command={url:b.viewerUrl,token:b.accessToken,kind:j.kind,remote:j.remote,peer:j.peer,partToken:j.partToken,sha256:j.sha256,localProof:j.local.proof,expected:j.expectedRemote||null};let lastSave=0;
      run.worker=this.run(command,fd,async event=>{
        if(event.event==='prepared'){
          if(!PEER.test(event.peer)||j.peer&&j.peer!==event.peer)throw fail('PEER_CHANGED');j.peer=event.peer;j.size=size(event.size);
          if(event.expected){if(j.selectedRemote&&['size','modified'].some(k=>j.selectedRemote[k]!==event.expected[k]))throw fail('SOURCE_CHANGED');if(!HEX.test(event.expected.sha256))throw fail('INVALID_RESPONSE');j.expectedRemote=event.expected;j.sha256=event.expected.sha256;}
          else{if(!HEX.test(event.sha256))throw fail('INVALID_RESPONSE');j.sha256=event.sha256;}
          if(run.rebind){j.local.partProof=proof(fd);j.local.directoryProof=directoryProof(directoryFd);}
          this.save();
        }else if(event.event==='checkpoint'){j.bytes=size(event.offset);if(j.bytes>j.size||!HEX.test(event.sha256))throw fail('INVALID_RESPONSE');j.prefixSha256=event.sha256;if(j.phase!=='receiving')j.started=Date.now();j.phase='receiving';this.version++;if(Date.now()-lastSave>500){this.save();lastSave=Date.now();}}
        else if(event.event==='progress'){j.phase='verifying';this.version++;}
        else if(event.event==='done')j.peakRssBytes=event.peakRssBytes;
      });
      const result=await run.worker.promise;if(run.reason)throw fail('PAUSED');if(result.sha256!==j.sha256||result.offset!==j.size||result.peer!==j.peer)throw fail('HASH_MISMATCH');
      j.bytes=j.size;
      if(j.kind==='download')await this.commit(j,run,fd,directoryFd,false);
      j.status='done';j.phase='';j.code='';this.save();if(j.kind==='download'){j.local.part=undefined;j.recoverCommit=false;}this.grants.delete(j.id);
      if(j.kind==='upload'){try{await this.query(j.machineId,'discard',{remote:j.remote,peer:j.peer,partToken:j.partToken,size:j.size,sha256:j.sha256});}catch{j.cleanupPending=true;this.save();}}
    }catch(error){j.status=run.reason?'paused':'failed';j.code=run.reason?'PAUSED':errorCode(error);j.phase='';if(j.kind==='download'&&['VOLUME_UNAVAILABLE','TARGET_CHANGED'].includes(j.code))this.grants.delete(j.id);if(j.kind==='download'&&fd>=0){try{const p=proof(fd);if(p.dev===j.local.partProof?.dev&&p.ino===j.local.partProof?.ino&&p.size<=j.size)j.bytes=p.size;}catch{}}try{this.save();}catch{j.code='JOURNAL_WRITE_FAILED';}}
    finally{closeGrant(fd);closeGrant(directoryFd);}
  }
  async commit(j,run,fd,directoryFd,alreadyFinal){
    const parent=directoryProof(directoryFd),p=proof(fd);j.status='committing';j.phase='saving';j.recoverCommit=true;this.save();
    const command={kind:'commit',source:path.basename(alreadyFinal?j.local.target:j.local.part),target:path.basename(j.local.target),size:j.size,sha256:j.sha256,expected:p,directoryProof:parent,copyProof:j.local.copyProof||null,allowRebind:!!(run.rebind||this.grants.get(j.id)?.revalidate&&j.local.directoryProof&&!sameFile(parent,j.local.directoryProof))};
    run.worker=this.run(command,fd,async event=>{
      if(event.event==='prepared'){
        if(event.size!==j.size||event.sha256!==j.sha256||!sameFile(event.localProof,p)||!sameFile(event.directoryProof,parent))throw fail('INVALID_RESPONSE');
        j.local.partProof=event.localProof;if(event.copyProof){j.local.copyProof=event.copyProof;j.commitMethod='copy';j.phase='copying';j.copyBytes=event.copyProof.size;}this.save();
      }else if(event.event==='progress'){j.phase=j.local.copyProof?'copying':'saving';this.version++;}
      else if(event.event==='checkpoint'){j.copyBytes=size(event.offset);j.phase='copying';this.version++;}
    },directoryFd);
    const result=await run.worker.promise;
    if(result.sha256!==j.sha256||result.offset!==j.size)throw fail('HASH_MISMATCH');
    if(!sameFile(directoryProof(path.dirname(j.local.target)),parent))throw fail('VOLUME_UNAVAILABLE');
    j.commitMethod=result.method;j.directorySynced=result.directorySynced;j.local.directoryProof=parent;
    if(run.reason)throw fail('PAUSED');
  }
  async recoverCommit(j,run,directoryFd){
    const hasPart=!!j.local.part&&fs.existsSync(j.local.part),file=hasPart?j.local.part:j.local.target,fd=openFile(file,fs.constants.O_RDONLY);
    try{
      const p=proof(fd),grant=this.grants.get(j.id),parent=directoryProof(directoryFd);
      if(hasPart&&!sameFile(p,j.local.partProof)&&(!grant.revalidate||!j.local.directoryProof||sameFile(parent,j.local.directoryProof)))throw fail('PARTIAL_CHANGED');
      await this.commit(j,run,fd,directoryFd,!hasPart);j.status='done';j.bytes=j.size;j.phase='';j.code='';this.save();j.local.part=undefined;j.recoverCommit=false;this.grants.delete(j.id);
    }finally{closeGrant(fd);}
  }
}
module.exports={FileTasks,remote,name,relative,proof,MAX_SIZE};
