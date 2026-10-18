/* Public connection-file enrollment. No password or session token enters the catalog. */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {randomUUID} = require('node:crypto');
const {spawn} = require('node:child_process');
const {request:requestHttp} = require('node:http');

function loopbackRequest(port,endpoint,data) {
  if(!Number.isInteger(port)||port<1||port>65535||!['/node/list','/node/detail','/node/test','/node/add','/node/edit','/group/list','/group/add'].includes(endpoint))return Promise.reject(Error('GMSSH 本地服务尚未就绪。'));
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify(data);
    const request=requestHttp({hostname:'127.0.0.1',port,path:endpoint,method:'POST',agent:false,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},response=>{
      let bytes=0;const chunks=[];
      if(response.statusCode<200||response.statusCode>=300){response.resume();reject(Error('GMSSH 返回了无效的接入结果。'));return;}
      response.on('data',chunk=>{bytes+=chunk.length;if(bytes>4194304){request.destroy();reject(Error('GMSSH 返回的接入数据过大。'));}else chunks.push(chunk);});
      response.once('error',()=>reject(Error('GMSSH 本地请求未完成，请稍后重试。')));
      response.once('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('无法读取 GMSSH 的接入结果。'));}});
    });
    request.setTimeout(35000,()=>request.destroy());
    request.once('error',()=>reject(Error('GMSSH 本地请求未完成，请稍后重试。')));
    request.end(body);
  });
}

function pythonRequest(python, request) {
  return new Promise((resolve, reject) => {
    const env={...process.env}; delete env.PYTHONHOME; delete env.PYTHONPATH;
    const child=spawn(python,['-m','gmssh_windows_bridge.pairing'],{env,stdio:['pipe','pipe','ignore']});
    let output='', settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(Error('核对连接信息超时，请检查目标地址和网络连接。'));},['redeem-code','choose-target'].includes(request.operation)?25000:15000);
    child.once('error',()=>finish(Error('无法启动本地接入检查，请检查运行环境。')));
    child.stdout.on('data',data=>{output+=data.toString();if(output.length>131072){child.kill();finish(Error('连接检查返回格式无效。'));}});
    child.once('close',()=>{
      try{const result=JSON.parse(output);if(!result.ok)finish(Error(typeof result.message==='string'?result.message:'连接检查未通过。'));else finish(null,result.data);}
      catch{finish(Error('无法读取连接检查结果。'));}
    });
    child.stdin.on('error',()=>finish(Error('连接检查未完成。')));
    child.stdin.end(JSON.stringify(request));
  });
}

async function availablePort(reserved) {
  for(let attempt=0;attempt<20;attempt++) {
    const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
    if(!reserved.has(port)){reserved.add(port);return port;}
  }
  throw Error('无法分配本机连接端口，请关闭冲突程序后重试。');
}

function directory(folder) {
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  if(!fs.lstatSync(folder).isDirectory()||fs.lstatSync(folder).isSymbolicLink())throw Error('本地接入目录不可信，已停止写入。');
}

function connectionText(connection, addresses=connection.addresses) {
  const {id,adapters,...value}=connection;
  return JSON.stringify({...value,addresses:[...new Set(addresses)],wakeAdapters:(adapters||[]).map(({address,mac,prefixLength})=>({address,mac,prefixLength}))});
}

class PairingManager {
  constructor({root,python,legacy=[],reserved=[],keychain=false,startDevice,api,changed=async()=>{},inspect,port=availablePort}) {
    Object.assign(this,{root,legacy,reserved,keychain,startDevice,api,changed,port});
    this.request=inspect||((request)=>pythonRequest(python,request));
    this.records=[];this.running=new Map();this.initialAuth=new Map();this.preview=null;this.busy=false;
  }
  async restore() {
    const file=path.join(this.root,'catalog.json');
    if(!fs.existsSync(file))return [];
    if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>1048576)throw Error('本地设备目录格式无效。');
    const catalog=JSON.parse(fs.readFileSync(file,'utf8'));
    if(catalog.schema!==1||!Array.isArray(catalog.devices)||catalog.devices.length>50)throw Error('本地设备目录版本无效。');
    const ports=new Set([...this.reserved,...this.legacy.flatMap(value=>[value.port,value.monitor?.port])]);
    const ids=new Set(),machineIds=new Set();
    for(const record of catalog.devices) {
      const connection=await this.request({operation:'inspect',connection:record.connection});
      const legacy=record.legacyMachineId?this.legacy.find(value=>value.machineId===record.legacyMachineId):null;
      if(record.legacyMachineId&&(!legacy||record.machineId!==legacy.machineId||connection.sshHostFingerprint!==legacy.fingerprint||connection.username!==legacy.monitor?.username||connection.sshPort!==legacy.monitor?.targetPort||record.monitorPort!==legacy.monitor.port||record.desktopPort!==legacy.port))throw Error('旧设备接入身份或端口不一致。');
      const previous=record.previousTargets||[];
      if(connection.id!==record.id||ids.has(record.id)||!connection.addresses.includes(record.target)||
          record.autoTarget!==undefined&&typeof record.autoTarget!=='boolean'||
          !Array.isArray(previous)||previous.length>32||previous.some(value=>!connection.addresses.includes(value))||
          typeof record.name!=='string'||!record.name.trim()||record.name.length>128||/[\x00-\x1f\x7f]/.test(record.name)||
          (record.machineId!==null&&(!/^[a-f0-9]{32}$/.test(record.machineId)||machineIds.has(record.machineId)||!legacy&&this.legacy.some(value=>value.machineId===record.machineId))))throw Error('本地设备身份无效。');
      const ownPorts=new Set(legacy?[legacy.port,legacy.monitor.port]:[]);
      if(record.monitorPort===record.desktopPort)throw Error('本地设备端口冲突。');
      for(const port of [record.monitorPort,record.desktopPort]){if(!Number.isInteger(port)||port<1||port>65535||ports.has(port)&&!ownPorts.has(port))throw Error('本地设备端口冲突。');ports.add(port);}
      ids.add(record.id);if(record.machineId)machineIds.add(record.machineId);this.records.push({id:record.id,connection:record.connection,target:record.target,name:record.name,monitorPort:record.monitorPort,desktopPort:record.desktopPort,machineId:record.machineId,public:connection,autoTarget:record.autoTarget!==false,...(record.legacyMachineId?{legacyMachineId:record.legacyMachineId}:{}),...(previous.length?{previousTargets:previous}:{})});
    }
    const errors=[];
    for(const record of this.records){try{await this.start(record);}catch{errors.push(record.name+' 的本地服务未能启动，请检查端口和连接文件。');}}
    return errors;
  }
  save() {
    directory(this.root);
    const file=path.join(this.root,'catalog.json'),temporary=file+'.'+randomUUID()+'.tmp';
    const devices=this.records.map(({public:_public,...record})=>record);
    const content=JSON.stringify({schema:1,devices},null,2);
    if(Buffer.byteLength(content)>1048576)throw Error('接入配置超过保存上限，已停止新增。');
    try{fs.writeFileSync(temporary,content,{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}
    finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }
  options(record) {
    const folder=path.join(this.root,record.id),connection=record.public;
    const targets=[...new Set([record.target,...(record.previousTargets||[]),...connection.addresses])];
    const known=targets.map(target=>(connection.sshPort===22?target:`[${target}]:${connection.sshPort}`)+' '+connection.sshHostPublicKey+'\n').join('');
    directory(this.root);directory(folder);
    const knownHosts=path.join(folder,'known_hosts');
    if(fs.existsSync(knownHosts)){
      if(fs.lstatSync(knownHosts).isSymbolicLink()||fs.readFileSync(knownHosts,'utf8').trim().split('\n').some(line=>!known.trim().split('\n').includes(line)))throw Error('已保存的 SSH 主机身份不一致，已停止连接。');
    }
    if(!fs.existsSync(knownHosts)||fs.readFileSync(knownHosts,'utf8')!==known){const temporary=knownHosts+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(temporary,known,{flag:'wx',mode:0o600});fs.renameSync(temporary,knownHosts);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}
    let authorization;
    if(connection.authorization){
      const file=path.join(folder,'controller-connection.json'),temporary=file+'.'+randomUUID()+'.tmp';
      if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('独立授权的本机配置包含链接，已停止启动。');
      try{fs.writeFileSync(temporary,record.connection,{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
      authorization={file,permissions:connection.authorization.controller.permissions};
    }
    const adapter=connection.adapters.find(value=>value.address===record.target);
    const legacy=record.legacyMachineId?this.legacy.find(value=>value.machineId===record.legacyMachineId):null;
    return {target:record.target,label:record.name,machineId:record.machineId,port:record.desktopPort,keychain:authorization?false:this.keychain,...(authorization?{authorization}:{}),
      addresses:connection.addresses,autoAddresses:record.autoTarget!==false?connection.addresses:[],credentialAliases:record.previousTargets||[],
      monitor:{port:record.monitorPort,targetPort:connection.sshPort,username:connection.username,knownHosts,hostKey:legacy?.monitor.hostKey||path.join(folder,'bridge_host_key'),forwardTerminal:true},
      wake:adapter?{mac:adapter.mac,broadcast:adapter.broadcast}:null};
  }
  async start(record) {
    if(!this.running.has(record.id))this.running.set(record.id,await this.startDevice(this.options(record)));
    return this.running.get(record.id);
  }
  bindings() {
    return this.records.filter(record=>record.machineId&&this.running.has(record.id)).map(record=>({...this.running.get(record.id),machineId:record.machineId}));
  }
  takeDesktopAuth(machineId) {
    const value=this.initialAuth.get(machineId);this.initialAuth.delete(machineId);
    return value&&value.expires>Date.now()?{password:value.password,remember:value.remember}:null;
  }
  queueDesktopAuth(machineId,password,remember) {
    const value={password,remember:this.keychain&&remember===true,expires:Date.now()+120000};
    this.initialAuth.set(machineId,value);
    const timer=setTimeout(()=>{if(this.initialAuth.get(machineId)===value)this.initialAuth.delete(machineId);},120000);timer.unref?.();
  }
  existing(connection) {
    return [...this.records.filter(value=>value.machineId).map(value=>({machineId:value.machineId,name:value.name,target:value.target,autoTarget:value.autoTarget!==false,fingerprint:value.public.sshHostFingerprint,username:value.public.username,sshPort:value.public.sshPort,monitorPort:value.monitorPort,...(value.public.authorization?{authorizationId:value.public.authorization.controller.id}:{})})),
      ...this.legacy.map(value=>({machineId:value.machineId,target:value.target,fingerprint:value.fingerprint,username:value.monitor?.username,sshPort:value.monitor?.targetPort,monitorPort:value.monitor?.port}))]
      .find(value=>value.machineId&&value.fingerprint===connection.sshHostFingerprint&&value.username===connection.username&&value.sshPort===connection.sshPort&&(value.authorizationId||null)===(connection.authorization?.controller.id||null));
  }
  async manual(data) {
    if(this.busy)throw Error('正在接入，请等待当前操作完成。');
    const reply=await this.request({...data,operation:'manual'});
    const result=await this.inspect(reply.connectionText);
    return {...result,fromManual:true};
  }

  async edit(machineId) {
    if(this.busy||typeof machineId!=='string')throw Error('当前设备无法编辑，请稍后重试。');
    const record=this.records.find(value=>value.machineId===machineId);
    if(record)return this.inspect(record.connection);
    const legacy=this.legacy.find(value=>value.machineId===machineId);
    if(!legacy?.sshHostPublicKey||!legacy.monitor)throw Error('此设备缺少可编辑的已核验连接信息，请导入连接文件。');
    return this.inspect(JSON.stringify({schema:1,computer:'Windows-PC',username:legacy.monitor.username,sshPort:legacy.monitor.targetPort,addresses:[legacy.target],sshHostPublicKey:legacy.sshHostPublicKey,sshHostFingerprint:legacy.fingerprint,desktopAuth:'manual'}));
  }

  async exportConnection(machineId) {
    const record=this.records.find(value=>value.machineId===machineId);
    const legacy=this.legacy.find(value=>value.machineId===machineId);
    if(!record&&(!legacy?.sshHostPublicKey||!legacy.monitor))throw Error('此 Windows 设备缺少可迁移的主机身份。');
    const source=record?record.connection:JSON.stringify({schema:1,computer:legacy.label||'Windows-PC',username:legacy.monitor.username,sshPort:legacy.monitor.targetPort,addresses:[legacy.target],sshHostPublicKey:legacy.sshHostPublicKey,sshHostFingerprint:legacy.fingerprint,desktopAuth:'manual'});
    const connection=await this.request({operation:'inspect',connection:source});
    if(connection.fromCode||connection.connectionText)throw Error('备份不能保存长效连接码，请使用已接入的设备配置。');
    return {connection:connectionText(connection),target:record?.target||legacy.target,autoTarget:record?record.autoTarget!==false:false};
  }

  // Restore saved configuration while offline. No authentication or remote provisioning runs here.
  async importConnection(item,credentials,{groupId='',rememberDesktop=false}={}) {
    const connection=await this.request({operation:'inspect',connection:item.windows.connection}),target=item.windows.target;
    if(connection.fromCode||connection.username!==item.username||connection.sshPort!==item.port||!connection.addresses.includes(target))throw Error('备份中的 Windows 主机身份不一致。');
    const native=await this.nativeRecords(),existing=this.existing(connection);
    if(existing&&native.some(node=>node.id===existing.machineId))throw Error('Windows 设备已存在，已保留原连接。');
    let record=this.records.find(value=>value.id===connection.id);
    if(record&&record.target!==target)throw Error('此 Windows 设备已有不同的接入记录。');
    if(record&&record.machineId&&!native.some(node=>node.id===record.machineId)){record.machineId=null;record.name=item.name;this.save();}
    if(!record){
      if(this.records.length>=50)throw Error('此版本最多管理 50 台 Windows 电脑。');
      const reserved=new Set([...this.reserved,...native.filter(value=>['127.0.0.1','localhost'].includes(value.ip)).map(value=>Number(value.port)),...this.legacy.flatMap(value=>[value.port,value.monitor?.port]),...this.records.flatMap(value=>[value.monitorPort,value.desktopPort])]);
      record={id:connection.id,connection:connectionText(connection),public:connection,target,autoTarget:item.windows.autoTarget===true,name:item.name,monitorPort:await this.port(reserved),desktopPort:await this.port(reserved),machineId:null};
      this.records.push(record);try{this.save();}catch(error){this.records.pop();throw error;}
    }
    await this.start(record);
    const match=node=>['127.0.0.1','localhost'].includes(node?.ip)&&Number(node.port)===record.monitorPort&&node.userName===connection.username&&/^[a-f0-9]{32}$/.test(node.id);
    let node=native.find(match);
    if(!node){
      const data={name:item.name,ip:'127.0.0.1',port:record.monitorPort,userName:connection.username,authType:'pass',authValue:credentials.authValue,groupId,desc:item.notes||'',sudoPolicy:'skip'};
      try{const reply=await this.api('/node/add',data);if([0,200].includes(reply.code)&&/^[a-f0-9]{32}$/.test(reply.data?.id))node={id:reply.data.id};}catch{}
      finally{data.authValue='';}
      if(!node)node=(await this.nativeRecords()).find(match);
      if(!node)throw Error('GMSSH 未确认保存 Windows 配置，请保留备份并重试。');
    }
    const detail=await this.api('/node/detail',{id:node.id});
    if(![0,200].includes(detail.code)||!match(detail.data)||detail.data.id!==node.id||detail.data.authType!=='pass'||detail.data.name!==item.name||detail.data.sudoPolicy!==undefined&&detail.data.sudoPolicy!=='skip')throw Error('Windows 配置未通过回读，导入记录已保留供重试。');
    record.machineId=node.id;this.save();
    if(connection.desktopAuth==='shared-ssh')this.queueDesktopAuth(node.id,credentials.authValue,rememberDesktop);
    return node.id;
  }

  async replaceTarget(existing,connection,target,password,rememberDesktop,autoTarget=false) {
    const detail=await this.api('/node/detail',{id:existing.machineId});
    const match=value=>value?.id===existing.machineId&&['127.0.0.1','localhost'].includes(value.ip)&&Number(value.port)===existing.monitorPort&&value.userName===connection.username;
    if(![0,200].includes(detail.code)||!match(detail.data)||detail.data.authType!=='pass'||typeof detail.data.name!=='string')throw Error('原设备的入口或账号不一致，已停止更新地址。');
    const original=detail.data;
    await this.request({operation:'test-login',connection:connectionText(connection),target,password});
    const managed=this.records.find(value=>value.machineId===existing.machineId);
    const legacy=this.legacy.find(value=>value.machineId===existing.machineId);
    if(!managed&&(!legacy?.monitor?.hostKey||!Number.isInteger(legacy.port)))throw Error('旧设备缺少可迁移的本机连接配置。');
    const old=managed?{...managed}:{id:connection.id,target:existing.target,name:original.name,monitorPort:existing.monitorPort,desktopPort:legacy.port,machineId:existing.machineId,legacyMachineId:existing.machineId,public:connection,connection:connectionText(connection,[existing.target,...connection.addresses])};
    const previous=[...new Set([old.target,...(old.previousTargets||[])])].filter(value=>value!==target);
    if(previous.length>31)throw Error('此设备保存的旧地址过多，请先核对连接配置。');
    const publicValue=await this.request({operation:'inspect',connection:connectionText({...connection,addresses:[...new Set([target,...previous,...connection.addresses])].slice(0,32)})});
    if(publicValue.id!==old.id||!publicValue.addresses.includes(target))throw Error('新地址配置未通过身份核对，原连接已保留。');
    const candidate={...old,target,autoTarget,previousTargets:previous,public:publicValue,connection:connectionText(publicValue)};
    const oldBinding=managed?this.running.get(old.id):legacy;
    if(!oldBinding?.stop)throw Error('当前连接尚不支持地址切换，请重开新版客户端后重试。');
    this.options(old); // Verify existing local pins before stopping or replacing anything.
    const knownFile=path.join(this.root,old.id,'known_hosts');
    const savedKnown=fs.existsSync(knownFile)?fs.readFileSync(knownFile):null;
    const recordIndex=managed?this.records.indexOf(managed):this.records.length;
    let replacement,edited=false,inserted=false;
    const data={id:existing.machineId,name:original.name,ip:original.ip,port:existing.monitorPort,userName:connection.username,authType:'pass',authValue:password,groupId:original.groupId||'',desc:original.desc||'',sudoPolicy:'skip'};
    try {
      await oldBinding.stop();this.running.delete(old.id);
      replacement=await this.start(candidate);
      const tested=await this.api('/node/test',data);
      if(![0,200].includes(tested.code))throw Error('新地址认证未通过。');
      const saved=await this.api('/node/edit',data);
      if(![0,200].includes(saved.code))throw Error('GMSSH 未确认保存新地址连接。');
      edited=true;
      const checked=await this.api('/node/detail',{id:existing.machineId});
      if(![0,200].includes(checked.code)||!match(checked.data)||checked.data.authType!=='pass'||checked.data.sudoPolicy!==undefined&&checked.data.sudoPolicy!=='skip')throw Error('新地址连接未通过原卡片回读。');
      if(managed)this.records[recordIndex]=candidate;else{this.records.push(candidate);inserted=true;}
      this.save();
    }catch(error){
      try {
        if(replacement?.stop)await replacement.stop();this.running.delete(old.id);
        if(savedKnown!==null)fs.writeFileSync(knownFile,savedKnown,{mode:0o600});else if(fs.existsSync(knownFile))fs.unlinkSync(knownFile);
        if(managed)this.records[recordIndex]=old;else if(inserted)this.records.splice(this.records.indexOf(candidate),1);
        if(managed)await this.start(old);else this.legacy[this.legacy.indexOf(legacy)]=await this.startDevice(legacy);
        if(edited){const restored=await this.api('/node/edit',data);if(![0,200].includes(restored.code))throw Error('原连接配置未确认恢复。');}
      }catch{throw Error('地址切换未完成，原记录已保留；本地服务恢复也未完成，请重开客户端检查。');}
      throw Error('地址切换未完成，已保留原设备配置。'+error.message);
    }finally{data.authValue='';}
    if(connection.desktopAuth==='shared-ssh')this.queueDesktopAuth(existing.machineId,password,rememberDesktop);
    await this.changed();
    return {machineId:existing.machineId,existing:true,credentialsUpdated:true,addressUpdated:true};
  }
  async inspect(text) {
    if(this.busy)throw Error('另一台电脑正在接入，请等待当前操作完成。');
    const {connectionText,fromCode,...connection}=await this.request({operation:'inspect',connection:text});
    if(fromCode===true&&(typeof connectionText!=='string'||typeof text!=='string'||Buffer.byteLength(text)>32768))throw Error('连接码格式无效。');
    this.preview={connection,text:fromCode===true?connectionText:text,code:fromCode===true?text:undefined};
    return {...connection,fromCode:fromCode===true,canRememberDesktop:this.keychain,existing:this.existing(connection)||null};
  }
  clearPreview(){if(!this.busy)this.preview=null;}
  async nativeRecords() {
    const records=[];
    for(let pageNum=1;pageNum<=50;pageNum++){
      const reply=await this.api('/node/list',{cond:'',groupId:'',pageNum,pageSize:200});
      if(![0,200].includes(reply.code)||!Array.isArray(reply.data?.list))throw Error('无法读取 GMSSH 设备列表，请先打开首页后重试。');
      records.push(...reply.data.list.map(({id,ip,port,userName})=>({id,ip,port,userName})));
      if(reply.data.list.length<200||Number.isFinite(reply.data.total)&&records.length>=reply.data.total)return records;
    }
    throw Error('设备列表超出此预览版的接入检查范围，已停止创建新连接。');
  }
  async connect({id,target,name,password,rememberDesktop=false,refreshPassword=false,autoTarget=false}) {
    if(this.busy)throw Error('正在接入，请勿重复提交。');
    if(!this.preview||id!==this.preview.connection.id)throw Error('请先重新导入这台电脑的连接文件。');
    let {connection,text,code}=this.preview;
    if(typeof target!=='string'||typeof name!=='string'||!name.trim()||name.length>128||/[\x00-\x1f\x7f]/.test(name))throw Error('请选择有效地址并填写设备名称。');
    if(autoTarget===true&&code){
      this.busy=true;
      try{const route=await this.request({operation:'choose-target',connection:code,preferred:this.existing(connection)?.target});if(!connection.addresses.includes(route.target)||route.verified!==true)throw Error('自动选择的地址未通过主机身份核对。');target=route.target;}
      finally{this.busy=false;}
    }
    if(!connection.addresses.includes(target)){
      const expectedPort=connection.authorization?.port||connection.sshPort,endpoint=await this.request({operation:'endpoint',target,port:expectedPort});
      if(endpoint.port!==expectedPort)throw Error('端口与连接信息不同，请用手动填写核对该端口的主机身份。');
      target=endpoint.target;
      connection={...connection,addresses:[...new Set([target,...connection.addresses])]};text=connectionText(connection);
    }
    const existing=this.existing(connection);
    const addressChanged=existing&&existing.target!==target;
    if(code)refreshPassword=true;
    if(!code&&(!existing||refreshPassword===true||addressChanged)&&(typeof password!=='string'||!password||Buffer.byteLength(password)>1024))throw Error('请输入 Windows 当前的 GMSSH 连接密码。');
    const resolvePassword=async()=>{
      if(!code)return;
      const result=await this.request({operation:'redeem-code',connection:code,target});
      if(connection.authorization&&result.permissions&&Object.keys(result.permissions).sort().join()==='clipboard,files,input,power,terminal,view'&&Object.values(result.permissions).every(value=>typeof value==='boolean')){Object.assign(connection.authorization.controller.permissions,result.permissions);text=connectionText(connection);const record=this.records.find(value=>value.id===connection.id);if(record){record.public=connection;record.connection=text;this.options(record);this.save();const running=this.running.get(record.id);if(running?.authorization)running.authorization.permissions=connection.authorization.controller.permissions;}}
      if(typeof result.password!=='string'||!result.password||Buffer.byteLength(result.password)>1024)throw Error('Windows 接入响应无效。');
      password=result.password;result.password='';
    };
    this.busy=true;
    try {
      await this.request({operation:'probe',connection:text,target});
      if(existing){
        const authorizationChanged=connection.authorization&&this.records.some(value=>value.machineId===existing.machineId&&JSON.stringify(value.public.authorization)!==JSON.stringify(connection.authorization));
        if(addressChanged||authorizationChanged||code&&existing.autoTarget!==undefined&&existing.autoTarget!==(autoTarget===true)){await resolvePassword();const result=await this.replaceTarget(existing,connection,target,password,rememberDesktop,autoTarget===true);if(code)delete this.preview.code;return result;}
        const managed=this.records.find(record=>record.machineId===existing.machineId);
        if(managed){await this.start(managed);this.save();}
        if(refreshPassword===true){
          const match=value=>value?.id===existing.machineId&&['127.0.0.1','localhost'].includes(value.ip)&&Number(value.port)===existing.monitorPort&&value.userName===connection.username;
          const detail=await this.api('/node/detail',{id:existing.machineId});
          if(![0,200].includes(detail.code)||!Number.isInteger(existing.monitorPort)||!match(detail.data)||typeof detail.data.name!=='string')throw Error('原连接的入口或账号不一致，已停止更新密码。');
          const original=detail.data;
          await resolvePassword();
          const data={name:original.name,ip:original.ip,port:existing.monitorPort,userName:connection.username,authType:'pass',authValue:password,groupId:original.groupId||'',desc:original.desc||'',sudoPolicy:'skip'};
          try{
            const tested=await this.api('/node/test',data);
            if(![0,200].includes(tested.code))throw Error('新连接密码认证未通过，原连接配置已保留。');
            const edited=await this.api('/node/edit',{...data,id:existing.machineId});
            if(![0,200].includes(edited.code))throw Error('新密码已通过认证，但 GMSSH 未确认保存，请重试。');
            const saved=await this.api('/node/detail',{id:existing.machineId});
            // GMSSH 2.0.4 accepts sudoPolicy on writes but omits it from detail responses.
            if(![0,200].includes(saved.code)||!match(saved.data)||saved.data.authType!=='pass'||
                saved.data.sudoPolicy!==undefined&&saved.data.sudoPolicy!=='skip')throw Error('更新后的连接记录未通过回读，请保留原设备并重试。');
            if(connection.desktopAuth==='shared-ssh')this.queueDesktopAuth(existing.machineId,password,rememberDesktop);
          }finally{data.authValue='';password='';}
        }
        await this.changed();if(code)delete this.preview.code;return {machineId:existing.machineId,existing:true,credentialsUpdated:refreshPassword===true,...(connection.authorization?{permissions:connection.authorization.controller.permissions}:{})};
      }
      for(const value of [...this.legacy,...this.bindings()])if(value.target===target&&!connection.authorization)throw Error('此地址已配置为另一台电脑，已停止创建重复连接。');
      let native=await this.nativeRecords();
      let record=this.records.find(value=>value.id===id);
      if(record&&record.target!==target)throw Error('这台电脑已有待完成的接入，请使用原先选择的地址重试。');
      if(!record){
        if(this.records.length>=50)throw Error('此预览版最多管理 50 台 Windows 电脑。');
        const reserved=new Set([...this.reserved,...native.filter(value=>['localhost','127.0.0.1'].includes(value.ip)).map(value=>Number(value.port)),...this.legacy.flatMap(value=>[value.port,value.monitor?.port]),...this.records.flatMap(value=>[value.monitorPort,value.desktopPort])]);
        const normalized=connectionText(connection);
        record={id,connection:normalized,public:connection,target,autoTarget:autoTarget===true,name:name.trim(),monitorPort:await this.port(reserved),desktopPort:await this.port(reserved),machineId:null};
        this.records.push(record);try{this.save();}catch(error){this.records.pop();throw error;}
      }
      await this.start(record);
      const match=value=>['localhost','127.0.0.1'].includes(value.ip)&&Number(value.port)===record.monitorPort&&value.userName===connection.username&&/^[a-f0-9]{32}$/.test(value.id);
      let node=native.find(match);
      await resolvePassword();
      const initial=connection.desktopAuth==='shared-ssh'?{password,remember:rememberDesktop}:null;
      {
        const data={name:record.name,ip:'127.0.0.1',port:record.monitorPort,userName:connection.username,authType:'pass',authValue:password,groupId:'',desc:connection.computer+' · '+target+(connection.authorization?' · 独立授权，权限由服务端管理':' · 监控/终端/桌面'),sudoPolicy:'skip'};
        try{
          const tested=await this.api('/node/test',data);
          if(![0,200].includes(tested.code))throw Error('连接认证未通过，请核对 Windows 安装时设置的 GMSSH 连接密码后重试。');
          if(!node)try{const added=await this.api('/node/add',data);if([0,200].includes(added.code)&&/^[a-f0-9]{32}$/.test(added.data?.id))node={id:added.data.id};}catch{}
          if(!node){native=await this.nativeRecords();node=native.find(match);}
          if(!node)throw Error('GMSSH 尚未确认添加结果，请重试；原接入信息已保留，不会重新分配入口。');
        }finally{data.authValue='';password='';}
      }
      const detail=await this.api('/node/detail',{id:node.id});
      if(![0,200].includes(detail.code)||!match(detail.data||{})||detail.data.id!==node.id||detail.data.authType!=='pass'||
          detail.data.sudoPolicy!==undefined&&detail.data.sudoPolicy!=='skip')throw Error('保存的 GMSSH 连接未通过入口与账号回读，请保留接入信息后重试。');
      record.machineId=node.id;this.save();
      if(initial)this.queueDesktopAuth(record.machineId,initial.password,initial.remember);
      await this.changed();if(code)delete this.preview.code;
      return {machineId:record.machineId,existing:false,...(connection.authorization?{permissions:connection.authorization.controller.permissions}:{})};
    }finally{password='';this.busy=false;}
  }
}

module.exports={PairingManager,pythonRequest,loopbackRequest};
