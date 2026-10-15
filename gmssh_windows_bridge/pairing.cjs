/* Public connection-file enrollment. No password or session token enters the catalog. */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {randomUUID} = require('node:crypto');
const {spawn} = require('node:child_process');
const {request:requestHttp} = require('node:http');

function loopbackRequest(port,endpoint,data) {
  if(!Number.isInteger(port)||port<1||port>65535||!['/node/list','/node/detail','/node/test','/node/add'].includes(endpoint))return Promise.reject(Error('GMSSH 本地服务尚未就绪。'));
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
    const timer=setTimeout(()=>{child.kill();finish(Error('核对连接信息超时，请检查局域网连接。'));},15000);
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
    const ids=new Set(),machineIds=new Set(this.legacy.map(value=>value.machineId).filter(Boolean));
    for(const record of catalog.devices) {
      const connection=await this.request({operation:'inspect',connection:record.connection});
      if(connection.id!==record.id||ids.has(record.id)||!connection.addresses.includes(record.target)||
          typeof record.name!=='string'||!record.name.trim()||record.name.length>128||/[\x00-\x1f\x7f]/.test(record.name)||
          (record.machineId!==null&&(!/^[a-f0-9]{32}$/.test(record.machineId)||machineIds.has(record.machineId))))throw Error('本地设备身份无效。');
      for(const port of [record.monitorPort,record.desktopPort]){if(!Number.isInteger(port)||port<1||port>65535||ports.has(port))throw Error('本地设备端口冲突。');ports.add(port);}
      ids.add(record.id);if(record.machineId)machineIds.add(record.machineId);this.records.push({id:record.id,connection:record.connection,target:record.target,name:record.name,monitorPort:record.monitorPort,desktopPort:record.desktopPort,machineId:record.machineId,public:connection});
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
    const endpoint=connection.sshPort===22?record.target:`[${record.target}]:${connection.sshPort}`;
    const known=endpoint+' '+connection.sshHostPublicKey+'\n';
    directory(this.root);directory(folder);
    const knownHosts=path.join(folder,'known_hosts');
    if(fs.existsSync(knownHosts)){
      if(fs.lstatSync(knownHosts).isSymbolicLink()||fs.readFileSync(knownHosts,'utf8')!==known)throw Error('已保存的 SSH 主机身份不一致，已停止连接。');
    }else fs.writeFileSync(knownHosts,known,{flag:'wx',mode:0o600});
    const adapter=connection.adapters.find(value=>value.address===record.target);
    return {target:record.target,label:record.name,machineId:record.machineId,port:record.desktopPort,keychain:this.keychain,
      monitor:{port:record.monitorPort,targetPort:connection.sshPort,username:connection.username,knownHosts,hostKey:path.join(folder,'bridge_host_key'),forwardTerminal:true},
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
  existing(connection) {
    return [...this.legacy.map(value=>({machineId:value.machineId,target:value.target,fingerprint:value.fingerprint,username:value.monitor?.username,sshPort:value.monitor?.targetPort})),
      ...this.records.filter(value=>value.machineId).map(value=>({machineId:value.machineId,target:value.target,fingerprint:value.public.sshHostFingerprint,username:value.public.username,sshPort:value.public.sshPort}))]
      .find(value=>value.machineId&&value.fingerprint===connection.sshHostFingerprint&&value.username===connection.username&&value.sshPort===connection.sshPort);
  }
  async inspect(text) {
    if(this.busy)throw Error('另一台电脑正在接入，请等待当前操作完成。');
    const connection=await this.request({operation:'inspect',connection:text});
    this.preview={connection,text};
    return {...connection,canRememberDesktop:this.keychain,existing:this.existing(connection)||null};
  }
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
  async connect({id,target,name,password,rememberDesktop=false}) {
    if(this.busy)throw Error('正在接入，请勿重复提交。');
    if(!this.preview||id!==this.preview.connection.id)throw Error('请先重新导入这台电脑的连接文件。');
    const {connection,text}=this.preview;
    if(!connection.addresses.includes(target)||typeof name!=='string'||!name.trim()||name.length>128||/[\x00-\x1f\x7f]/.test(name))throw Error('请选择有效地址并填写设备名称。');
    const existing=this.existing(connection);
    if(!existing&&(typeof password!=='string'||!password||Buffer.byteLength(password)>1024))throw Error('请输入 Windows 安装时设置的连接密码。');
    this.busy=true;
    try {
      await this.request({operation:'probe',connection:text,target});
      if(existing){if(existing.target!==target)throw Error('同一主机身份已使用另一个地址接入，请先核对原设备的地址配置。');const managed=this.records.find(record=>record.machineId===existing.machineId);if(managed){await this.start(managed);this.save();}await this.changed();return {machineId:existing.machineId,existing:true};}
      for(const value of [...this.legacy,...this.bindings()])if(value.target===target)throw Error('此地址已配置为另一台电脑，已停止创建重复连接。');
      let native=await this.nativeRecords();
      let record=this.records.find(value=>value.id===id);
      if(record&&record.target!==target)throw Error('这台电脑已有待完成的接入，请使用原先选择的地址重试。');
      if(!record){
        if(this.records.length>=50)throw Error('此预览版最多管理 50 台 Windows 电脑。');
        const reserved=new Set([...this.reserved,...native.filter(value=>['localhost','127.0.0.1'].includes(value.ip)).map(value=>Number(value.port)),...this.legacy.flatMap(value=>[value.port,value.monitor?.port]),...this.records.flatMap(value=>[value.monitorPort,value.desktopPort])]);
        const {id:_id,adapters,...publicExport}=connection;
        const normalized=JSON.stringify({...publicExport,wakeAdapters:adapters.map(({address,mac,prefixLength})=>({address,mac,prefixLength}))});
        record={id,connection:normalized,public:connection,target,name:name.trim(),monitorPort:await this.port(reserved),desktopPort:await this.port(reserved),machineId:null};
        this.records.push(record);try{this.save();}catch(error){this.records.pop();throw error;}
      }
      await this.start(record);
      const match=value=>['localhost','127.0.0.1'].includes(value.ip)&&Number(value.port)===record.monitorPort&&value.userName===connection.username&&/^[a-f0-9]{32}$/.test(value.id);
      let node=native.find(match);
      const initial=connection.desktopAuth==='shared-ssh'?{password,remember:this.keychain&&rememberDesktop===true,expires:Date.now()+120000}:null;
      {
        const data={name:record.name,ip:'127.0.0.1',port:record.monitorPort,userName:connection.username,authType:'pass',authValue:password,groupId:'',desc:connection.computer+' · LAN '+target+' · 监控/终端/桌面',sudoPolicy:'skip'};
        try{
          const tested=await this.api('/node/test',data);
          if(![0,200].includes(tested.code))throw Error('连接认证未通过，请核对 Windows 安装时设置的 GMSSH 连接密码后重试。');
          if(!node)try{const added=await this.api('/node/add',data);if([0,200].includes(added.code)&&/^[a-f0-9]{32}$/.test(added.data?.id))node={id:added.data.id};}catch{}
          if(!node){native=await this.nativeRecords();node=native.find(match);}
          if(!node)throw Error('GMSSH 尚未确认添加结果，请重试；原接入信息已保留，不会重新分配入口。');
        }finally{data.authValue='';password='';}
      }
      const detail=await this.api('/node/detail',{id:node.id});
      if(![0,200].includes(detail.code)||!match(detail.data||{})||detail.data.id!==node.id||detail.data.sudoPolicy!=='skip')throw Error('保存的 GMSSH 连接未通过入口与账号回读，请保留接入信息后重试。');
      record.machineId=node.id;this.save();
      if(initial){this.initialAuth.set(record.machineId,initial);const timer=setTimeout(()=>this.initialAuth.delete(record.machineId),120000);timer.unref?.();}
      await this.changed();
      return {machineId:record.machineId,existing:false};
    }finally{password='';this.busy=false;}
  }
}

module.exports={PairingManager,pythonRequest,loopbackRequest};
