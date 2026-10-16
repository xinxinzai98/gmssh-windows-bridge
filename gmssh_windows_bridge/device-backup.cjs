/* Portable, selected-device backups. Decryption and saved SSH credentials stay in main. */
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {randomUUID,randomBytes,scrypt,createCipheriv,createDecipheriv}=require('node:crypto');
const {promisify}=require('node:util');
const derive=promisify(scrypt),MAX_FILE=8*1024*1024,MAX_DEVICES=200;
const FORMAT='gmssh-device-backup',AAD=Buffer.from(FORMAT+':1');
const idPattern=/^[a-f0-9]{32}$/,refPattern=/^[a-f0-9-]{36}$/;
function text(value,label,max=128,empty=false,multiline=false){if(typeof value!=='string'||(!empty&&!value.trim())||value.length>max||(multiline?/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/:/[\x00-\x1f\x7f]/).test(value))throw Error(label+'格式无效。');return value;}
function address(value){text(value,'连接地址',253);const host=value.replace(/^\[([^\]]+)\]$/,'$1');if(!net.isIP(host)&&!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))throw Error('连接地址格式无效。');return net.isIP(host)===6?new URL('http://['+host+']/').hostname.slice(1,-1):host.toLowerCase();}
function port(value){if(!Number.isInteger(value)||value<1||value>65535)throw Error('SSH 端口无效。');return value;}
function credentials(value,required=false){
  if(value===undefined&&!required)return;
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.authValue!=='string'||!value.authValue||Buffer.byteLength(value.authValue)>262144||value.keyPass!==undefined&&(typeof value.keyPass!=='string'||Buffer.byteLength(value.keyPass)>1024))throw Error('请补充所选设备的 SSH 密码或私钥。');
  return {authValue:value.authValue,...(value.keyPass?{keyPass:value.keyPass}:{})};
}
function validatePayload(value){
  if(!value||!Array.isArray(value.devices)||!value.devices.length||value.devices.length>MAX_DEVICES||typeof value.createdAt!=='string'||value.createdAt.length>40||!Number.isFinite(Date.parse(value.createdAt)))throw Error('备份格式或设备数量无效（每份最多 200 台）。');
  const refs=new Set();
  const devices=value.devices.map(item=>{
    if(!item||!refPattern.test(item.ref)||refs.has(item.ref)||!['linux','windows'].includes(item.kind)||!['pass','ca'].includes(item.authType))throw Error('备份中的设备身份或认证方式无效。');
    refs.add(item.ref);
    const result={ref:item.ref,kind:item.kind,name:text(item.name,'设备名称'),address:address(item.address),port:port(item.port),username:text(item.username,'账号'),authType:item.authType,group:text(item.group||'','分组',128,true),notes:text(item.notes||'','备注',4096,true,true),bastion:item.bastion||''};
    if(result.bastion&&!refPattern.test(result.bastion))throw Error('跳板机引用无效。');
    if(item.sshTimeout!==undefined){if(!Number.isInteger(item.sshTimeout)||item.sshTimeout<1||item.sshTimeout>600)throw Error('SSH 超时参数无效。');result.sshTimeout=item.sshTimeout;}
    const auth=credentials(item.credentials);if(auth)result.credentials=auth;
    if(item.kind==='windows'){
      if(item.authType!=='pass'||!item.windows||result.bastion||typeof item.windows.connection!=='string'||Buffer.byteLength(item.windows.connection)>65536||item.windows.target!==result.address)throw Error('Windows 桥接配置无效。');
      result.windows={connection:item.windows.connection,target:result.address};
    }else if(item.windows!==undefined)throw Error('设备系统与桥接配置不一致。');
    return result;
  });
  const byRef=new Map(devices.map(item=>[item.ref,item])),done=new Set(),visiting=new Set(),ordered=[];
  function visit(item){if(done.has(item.ref))return;if(visiting.has(item.ref))throw Error('跳板机配置存在循环。');visiting.add(item.ref);if(item.bastion){const parent=byRef.get(item.bastion);if(!parent||parent.kind!=='linux')throw Error('备份缺少依赖的 Linux 跳板机，请一并选择。');visit(parent);}visiting.delete(item.ref);done.add(item.ref);ordered.push(item);}
  for(const item of devices)visit(item);
  return {createdAt:value.createdAt,devices:ordered};
}
function envelope(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length>MAX_FILE)throw Error('备份文件不能超过 8 MiB。');
  let value;try{value=JSON.parse(buffer.toString('utf8'));}catch{throw Error('无法读取备份文件，请选择 GMSSH 导出的配置备份。');}
  if(value?.format!==FORMAT||value.version!==1||typeof value.encrypted!=='boolean')throw Error('不支持此备份格式或版本。');
  return value;
}
function password(value){if(typeof value!=='string'||value.length<8||Buffer.byteLength(value)>1024)throw Error('备份口令至少 8 个字符，最多 1 KiB。');return value;}
async function encode(payload,encrypted,secret){
  payload=validatePayload(payload);if(!encrypted&&payload.devices.some(item=>item.credentials))throw Error('普通配置不得包含登录凭据。');
  const content=Buffer.from(JSON.stringify(payload));
  if(content.length>5*1024*1024)throw Error('所选配置过大，请分批导出。');
  if(!encrypted)return Buffer.from(JSON.stringify({format:FORMAT,version:1,encrypted:false,payload},null,2));
  const salt=randomBytes(16),iv=randomBytes(12),key=await derive(password(secret),salt,32,{N:32768,r:8,p:1,maxmem:128*1024*1024});
  try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(AAD);const body=Buffer.concat([cipher.update(content),cipher.final()]);return Buffer.from(JSON.stringify({format:FORMAT,version:1,encrypted:true,algorithm:'aes-256-gcm+scrypt-v1',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:body.toString('base64')}));}
  finally{key.fill(0);content.fill(0);}
}
function binary(value,length){if(typeof value!=='string'||value.length>MAX_FILE||!value||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw Error();const result=Buffer.from(value,'base64');if(result.toString('base64')!==value||length&&result.length!==length)throw Error();return result;}
async function decode(buffer,secret){
  const value=envelope(buffer);if(!value.encrypted){const payload=validatePayload(value.payload);if(payload.devices.some(item=>item.credentials))throw Error('普通配置文件不得携带明文凭据，请使用加密备份。');return payload;}
  if(value.algorithm!=='aes-256-gcm+scrypt-v1')throw Error('不支持此备份加密方式。');
  let key,plain;
  try{key=await derive(password(secret),binary(value.salt,16),32,{N:32768,r:8,p:1,maxmem:128*1024*1024});const decipher=createDecipheriv('aes-256-gcm',key,binary(value.iv,12));decipher.setAAD(AAD);decipher.setAuthTag(binary(value.tag,16));plain=Buffer.concat([decipher.update(binary(value.ciphertext)),decipher.final()]);if(plain.length>5*1024*1024)throw Error();return validatePayload(JSON.parse(plain.toString('utf8')));}
  catch{throw Error('备份口令不正确，或文件已损坏。');}finally{key?.fill(0);plain?.fill(0);}
}
function writeBackup(file,body){
  if(fs.existsSync(file)&&(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()))throw Error('请选择普通文件作为备份保存位置。');
  const temporary=path.join(path.dirname(file),'.gmssh-backup-'+randomUUID()+'.tmp');
  try{fs.writeFileSync(temporary,body,{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
const endpoint=item=>[address(item.address||item.ip),port(Number(item.port)),item.username||item.userName].join('\0');
class DeviceBackup {
  constructor({api,pairing,changed=async()=>{}}){Object.assign(this,{api,pairing,changed});this.busy=false;this.writing=false;this.epoch=0;this.preview=null;this.file=null;}
  clear(){if(this.writing)return;this.epoch++;this.file?.fill(0);this.file=null;this.preview=null;clearTimeout(this.expiry);}
  expire(){clearTimeout(this.expiry);this.expiry=setTimeout(()=>this.clear(),15*60*1000);this.expiry.unref?.();}
  async native(){
    const nodes=[];
    for(let pageNum=1;pageNum<=50;pageNum++){
      const reply=await this.api('/node/list',{cond:'',groupId:'',pageNum,pageSize:200});
      if(![0,200].includes(reply.code)||!Array.isArray(reply.data?.list)||reply.data.list.some(item=>!idPattern.test(item.id)))throw Error('设备列表不可用，请先解锁 GMSSH 机器仓库。');
      nodes.push(...reply.data.list);if(reply.data.list.length<200||Number.isFinite(reply.data.total)&&nodes.length>=reply.data.total)return nodes;
    }throw Error('设备列表过大，请先缩小设备仓库。');
  }
  async groups(){const reply=await this.api('/group/list',{});const list=Array.isArray(reply.data)?reply.data:reply.data?.list;if(![0,200].includes(reply.code)||!Array.isArray(list))throw Error('无法读取分组信息。');return list.map(item=>({id:item.id,name:item.name}));}
  windowBinding(node){return this.pairing.records.find(item=>item.machineId===node.id)||this.pairing.legacy.find(item=>item.machineId===node.id);}
  publicNode(node,groups){const binding=this.windowBinding(node);return {id:node.id,name:node.name,kind:binding?'windows':'linux',address:binding?.target||node.ip,port:binding?.public?.sshPort||binding?.monitor?.targetPort||Number(node.port),username:node.userName,group:groups.find(item=>item.id===node.groupId)?.name||'',dependsOn:node.bastionNodeId||''};}
  async list(){const [nodes,groups]=await Promise.all([this.native(),this.groups()]);return nodes.map(node=>this.publicNode(node,groups));}
  async export(ids,encrypted,secret){
    if(this.busy||this.pairing.busy)throw Error('正在保存设备，请稍后再导出。');
    if(!Array.isArray(ids)||!ids.length||ids.length>MAX_DEVICES||new Set(ids).size!==ids.length||ids.some(id=>!idPattern.test(id))||typeof encrypted!=='boolean')throw Error('请勾选 1 至 200 台设备。');
    this.busy=this.writing=this.pairing.busy=true;
    try{
      const [nodes,groups]=await Promise.all([this.native(),this.groups()]),refs=new Map(ids.map(id=>[id,randomUUID()])),devices=[];
      for(const id of ids){
        const original=nodes.find(node=>node.id===id);if(!original)throw Error('设备列表已变化，请重新选择。');
        const reply=await this.api('/node/detail',{id});if(![0,200].includes(reply.code)||reply.data?.id!==id)throw Error('所选设备配置不可读，请先解锁机器仓库。');
        const node=reply.data,info=this.publicNode(node,groups),binding=this.windowBinding(node);
        if(node.bastionNodeId&&!refs.has(node.bastionNodeId))throw Error('所选设备依赖跳板机，请将对应跳板机一并勾选。');
        if(!binding&&['127.0.0.1','localhost','::1'].includes(address(node.ip)))throw Error('本机连接不能直接迁移；请先确认它的真实目标及桥接绑定。');
        const item={ref:refs.get(id),kind:info.kind,name:node.name,address:info.address,port:info.port,username:node.userName,authType:node.authType,group:info.group,notes:node.desc||'',bastion:refs.get(node.bastionNodeId)||'',...(node.sshTimeout?{sshTimeout:Number(node.sshTimeout)}:{})};
        if(binding)item.windows=await this.pairing.exportConnection(id);
        if(encrypted&&node.authValue)item.credentials=credentials({authValue:node.authValue,...(node.authType==='ca'&&node.keyPass?{keyPass:node.keyPass}:{})});
        devices.push(item);
      }
      return await encode({createdAt:new Date().toISOString(),devices},encrypted,secret);
    }finally{secret='';this.busy=this.writing=this.pairing.busy=false;}
  }
  open(body){if(this.busy)throw Error('正在导入，请等待操作结束。');this.clear();const value=envelope(body);this.file=Buffer.from(body);this.expire();return {encrypted:value.encrypted};}
  async inspect(secret){
    if(this.busy||!this.file)throw Error('请先重新选择备份文件。');
    this.busy=true;const run=this.epoch;
    try{
      const payload=await decode(this.file,secret),identities=new Set();
      for(const item of payload.devices)if(item.kind==='windows'){
        const connection=await this.pairing.request({operation:'inspect',connection:item.windows.connection});
        if(connection.fromCode||connection.connectionText||connection.username!==item.username||connection.sshPort!==item.port||!connection.addresses.includes(item.address))throw Error('Windows 备份的主机身份与地址不一致。');
        item.identity=connection.id;
      }
      for(const item of payload.devices){const key=item.kind+'\0'+(item.identity||endpoint(item));if(identities.has(key))throw Error('备份中包含重复的设备连接。');identities.add(key);}
      if(run!==this.epoch)throw Error('已取消读取备份。');
      this.preview={id:randomUUID(),...payload};this.expire();const description=await this.describe();if(run!==this.epoch)throw Error('已取消读取备份。');return description;
    }finally{secret='';this.busy=false;}
  }
  async describe(){
    const nodes=await this.native();
    return {id:this.preview.id,createdAt:this.preview.createdAt,canRememberDesktop:this.pairing.keychain===true,devices:this.preview.devices.map(item=>{
      const existing=item.kind==='windows'?this.pairing.records.some(record=>record.id===item.identity&&nodes.some(node=>node.id===record.machineId))||this.pairing.legacy.some(record=>nodes.some(node=>node.id===record.machineId)&&record.fingerprint===JSON.parse(item.windows.connection).sshHostFingerprint&&record.monitor?.username===item.username&&record.monitor?.targetPort===item.port):nodes.some(node=>!this.windowBinding(node)&&endpoint(node)===endpoint(item));
      const conflict=item.kind==='windows'&&[...this.pairing.records,...this.pairing.legacy].some(record=>record.target===item.address&&record.id!==item.identity&&(record.public?.sshHostFingerprint||record.fingerprint)!==JSON.parse(item.windows.connection).sshHostFingerprint);
      return {ref:item.ref,kind:item.kind,name:item.name,address:item.address,port:item.port,username:item.username,group:item.group,authType:item.authType,bastion:item.bastion,hasCredentials:!!item.credentials,keyPassRequired:item.authType==='ca'&&!item.credentials,status:conflict?'conflict':existing?'existing':'new'};
    })};
  }
  async import({id,ids,auth={},rememberDesktop=false}){
    if(this.busy||this.pairing.busy||!this.preview||id!==this.preview.id)throw Error('导入预览已失效，请重新打开备份。');
    if(!Array.isArray(ids)||!ids.length||ids.length>MAX_DEVICES||new Set(ids).size!==ids.length||ids.some(ref=>!this.preview.devices.some(item=>item.ref===ref)))throw Error('请勾选需要导入的设备。');
    const description=await this.describe(),selected=this.preview.devices.filter(item=>ids.includes(item.ref)),states=new Map(description.devices.map(item=>[item.ref,item.status]));
    for(const item of selected){if(states.get(item.ref)==='conflict')throw Error('目标地址存在不同的已核验设备，已停止导入。');if(item.bastion&&!ids.includes(item.bastion))throw Error('请一并勾选依赖的跳板机。');if(states.get(item.ref)==='new')credentials(item.credentials||auth[item.ref],true);}
    if(this.busy||this.pairing.busy||!this.preview||id!==this.preview.id)throw Error('另一项配置操作已开始，请重新核对后导入。');
    this.busy=this.writing=this.pairing.busy=true;const results=[],restored=new Map();
    try{
      const nodes=await this.native(),groups=await this.groups();
      for(const item of selected){
        let login;
        try{
          if(item.bastion&&!restored.has(item.bastion))throw Error('依赖的跳板机未导入，请先处理该设备。');
          const existing=item.kind==='windows'?nodes.find(node=>this.pairing.records.some(record=>record.machineId===node.id&&record.id===item.identity)||this.pairing.legacy.some(record=>record.machineId===node.id&&record.fingerprint===JSON.parse(item.windows.connection).sshHostFingerprint&&record.monitor?.username===item.username&&record.monitor?.targetPort===item.port)):nodes.find(node=>!this.windowBinding(node)&&endpoint(node)===endpoint(item));
          if(existing){restored.set(item.ref,existing.id);results.push({ref:item.ref,status:'skipped'});continue;}
          login=credentials(item.credentials||auth[item.ref],true);
          const matched=groups.filter(group=>group.name===item.group);if(item.group&&matched.length>1)throw Error('同名分组不唯一，请先整理目标管理端的分组。');
          let groupId=matched[0]?.id||'';
          if(item.group&&!groupId){const reply=await this.api('/group/add',{name:item.group});if(![0,200].includes(reply.code))throw Error('未能创建所需分组。');const read=await this.groups(),found=read.filter(group=>group.name===item.group);if(found.length!==1)throw Error('分组保存结果未确认。');groupId=found[0].id;groups.push(found[0]);}
          let machineId;
          if(item.kind==='windows')machineId=await this.pairing.importConnection(item,login,{groupId,rememberDesktop});
          else{
            const data={name:item.name,ip:item.address,port:item.port,userName:item.username,authType:item.authType,...login,groupId,desc:item.notes,bastionNodeId:restored.get(item.bastion)||'',...(item.sshTimeout?{sshTimeout:item.sshTimeout}:{})};
            let reply;try{reply=await this.api('/node/add',data);}catch{}finally{data.authValue='';delete data.keyPass;}
            const current=await this.native(),node=current.find(node=>!this.windowBinding(node)&&endpoint(node)===endpoint(item)&&!nodes.some(old=>old.id===node.id));
            if(!node||reply&&!([0,200].includes(reply.code)))throw Error('新增设备的保存结果未确认，请重试；已有配置保留。');
            const checked=await this.api('/node/detail',{id:node.id});if(![0,200].includes(checked.code)||checked.data?.id!==node.id||endpoint(checked.data)!==endpoint(item)||checked.data.name!==item.name||checked.data.authType!==item.authType)throw Error('新增配置未通过回读，请检查设备列表后重试。');
            machineId=node.id;nodes.push(node);
          }
          restored.set(item.ref,machineId);results.push({ref:item.ref,status:'imported'});
        }catch(error){results.push({ref:item.ref,status:'failed',message:error instanceof Error?error.message:'导入未完成。'});}
        finally{login=undefined;}
      }
      await this.changed();
      if(!results.some(item=>item.status==='failed')){this.busy=this.writing=false;this.clear();}else this.expire();
      return {results};
    }finally{this.busy=this.writing=this.pairing.busy=false;}
  }
}
module.exports={DeviceBackup,encode,decode,writeBackup,validatePayload,MAX_FILE};
