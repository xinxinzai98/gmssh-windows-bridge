/* Saved Linux credentials remain in main; only public host pins persist here. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ID=/^[a-f0-9]{32}$/i,PEER=/^SHA256:[A-Za-z0-9+/]{43}$/;
const fail=code=>Object.assign(Error(code),{code});
class LinuxFiles {
  constructor({root,api,inspect,confirm}){Object.assign(this,{root,api,inspect,confirm});this.pending=new Map();this.file=path.join(root,'linux-host-pins.json');this.pins=null;}
  read(){
    if(this.pins)return this.pins;
    try{
      fs.mkdirSync(this.root,{recursive:true,mode:0o700});
      if(fs.lstatSync(this.root).isSymbolicLink())throw fail('HOST_PINS_INVALID');
      let value={schema:1,hosts:{}};
      if(fs.existsSync(this.file)){
        const s=fs.lstatSync(this.file);if(!s.isFile()||s.isSymbolicLink()||s.size>2*1024**2)throw fail('HOST_PINS_INVALID');
        value=JSON.parse(fs.readFileSync(this.file,'utf8'));
      }
      if(value?.schema!==1||!value.hosts||typeof value.hosts!=='object'||Array.isArray(value.hosts)||Object.keys(value.hosts).length>10000)throw fail('HOST_PINS_INVALID');
      for(const [id,p] of Object.entries(value.hosts))if(!ID.test(id)||!p||typeof p.endpoint!=='string'||p.endpoint.length>300||!PEER.test(p.peer))throw fail('HOST_PINS_INVALID');
      return this.pins=value.hosts;
    }catch{throw fail('HOST_PINS_INVALID');}
  }
  save(hosts){
    const temp=this.file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';let fd;
    try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({schema:1,hosts}));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,this.file);this.pins=hosts;}
    catch{throw fail('HOST_PINS_WRITE_FAILED');}
    finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  async nodes(id){
    const seen=new Set(),nodes=[];
    while(id){
      if(!ID.test(id)||seen.has(id)||seen.size>=8)throw fail('INVALID_DEVICE');seen.add(id);
      const reply=await this.api('/node/detail',{id}),n=reply?.data;
      if(![0,200].includes(reply?.code)||n?.id!==id||typeof n.ip!=='string'||!n.ip||n.ip.length>253||/[\s/\\\x00]/.test(n.ip)||!Number.isInteger(Number(n.port))||Number(n.port)<1||Number(n.port)>65535||typeof n.userName!=='string'||!n.userName||n.userName.length>128||!['pass','ca'].includes(n.authType)||typeof n.authValue!=='string'||!n.authValue||Buffer.byteLength(n.authValue)>262144||n.keyPass!==undefined&&typeof n.keyPass!=='string')throw fail('DEVICE_CONFIG_UNAVAILABLE');
      nodes.unshift(n);id=n.bastionNodeId||'';
    }
    return nodes;
  }
  async resolve(id){
    if(this.pending.has(id))return this.pending.get(id);
    const pending=this.verified(id).finally(()=>this.pending.delete(id));this.pending.set(id,pending);return pending;
  }
  async verified(id){
    const nodes=await this.nodes(id),pins=this.read();
    const ssh=nodes.map(n=>{
      const endpoint=JSON.stringify([n.ip,Number(n.port)]),stored=pins[n.id];
      if(stored&&stored.endpoint!==endpoint)throw fail('DEVICE_CONFIG_CHANGED');
      return {host:n.ip,port:Number(n.port),username:n.userName,authType:n.authType,authValue:n.authValue,...(n.keyPass?{keyPass:n.keyPass}:{}),peer:stored?.peer||null,timeout:Number.isInteger(Number(n.sshTimeout))?Math.max(3,Math.min(60,Number(n.sshTimeout))):15};
    });
    for(let remaining=nodes.length;remaining>=0;remaining--){
      if(ssh.every(n=>n.peer))return {ssh,label:String(nodes.at(-1).name||'Linux 设备').slice(0,128)};
      const reply=await this.inspect(ssh),t=reply?.trust;
      if(!t||!Number.isInteger(t.index)||!ssh[t.index]||ssh[t.index].peer||!PEER.test(t.peer)||t.host!==ssh[t.index].host||t.port!==ssh[t.index].port||typeof t.algorithm!=='string'||t.algorithm.length>64)throw fail('INVALID_RESPONSE');
      if(!await this.confirm({name:String(nodes[t.index].name||'Linux 设备').slice(0,128),host:t.host,port:t.port,algorithm:t.algorithm,peer:t.peer,bastion:t.index<nodes.length-1}))throw fail('HOST_UNVERIFIED');
      // Re-read the selected device chain after the modal, before retaining trust.
      const now=await this.nodes(id);
      if(JSON.stringify(now.map(n=>[n.id,n.ip,n.port,n.userName,n.bastionNodeId||'']))!==JSON.stringify(nodes.map(n=>[n.id,n.ip,n.port,n.userName,n.bastionNodeId||''])))throw fail('DEVICE_CONFIG_CHANGED');
      const entry={endpoint:JSON.stringify([t.host,t.port]),peer:t.peer},current=this.read(),old=current[nodes[t.index].id];
      if(old&&(old.endpoint!==entry.endpoint||old.peer!==entry.peer))throw fail('PEER_CHANGED');
      this.save({...current,[nodes[t.index].id]:entry});ssh[t.index].peer=t.peer;
    }
    throw fail('HOST_UNVERIFIED');
  }
}
module.exports={LinuxFiles};
