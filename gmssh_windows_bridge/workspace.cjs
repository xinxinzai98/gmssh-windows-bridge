/* Local metadata only: no commands, screen contents, clipboard, keys or credentials. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ID=/^[a-f0-9]{32}$/i,CHANNELS=new Set(['desktop','terminal','files','tools']);
const fail=code=>Object.assign(Error(code),{code});
function preferences(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['layout','ratio','zoom','quality','display'].includes(k))||!['overview','desktop','terminal','split'].includes(value.layout)||!Number.isFinite(value.ratio)||value.ratio<.25||value.ratio>.75||!['fit','100'].includes(value.zoom)||!['low','balanced','best'].includes(value.quality)||!Number.isInteger(value.display)||value.display<0||value.display>31)throw fail('INVALID_WORKSPACE');
  return {...value};
}
class Workspace {
  constructor({root,clock=Date.now}){
    this.root=root;this.clock=clock;this.file=path.join(root,'workspace-history.json');this.state={schema:1,retention:30,tabs:[],selected:null,devices:{},sessions:[]};this.live=new Map();
    try{
      fs.mkdirSync(root,{recursive:true,mode:0o700});if(fs.lstatSync(root).isSymbolicLink())throw fail('WORKSPACE_INVALID');
      if(fs.existsSync(this.file)){
        const info=fs.lstatSync(this.file);if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024**2)throw fail('WORKSPACE_INVALID');
        const value=JSON.parse(fs.readFileSync(this.file,'utf8'));
        if(value.schema!==1||![7,30,90,365].includes(value.retention)||!Array.isArray(value.tabs)||value.tabs.length>50||value.tabs.some(id=>!ID.test(id))||new Set(value.tabs).size!==value.tabs.length||value.selected!==null&&!value.tabs.includes(value.selected)||!value.devices||Array.isArray(value.devices)||Object.keys(value.devices).length>200||!Array.isArray(value.sessions)||value.sessions.length>10000)throw fail('WORKSPACE_INVALID');
        for(const [id,p] of Object.entries(value.devices)){if(!ID.test(id))throw fail('WORKSPACE_INVALID');preferences(p);}
        for(const entry of value.sessions){if(!entry||!ID.test(entry.id)||!ID.test(entry.machineId)||!CHANNELS.has(entry.channel)||typeof entry.name!=='string'||entry.name.length>128||!['connecting','connected','opened','disconnected','failed','interrupted','completed'].includes(entry.state)||!Number.isFinite(entry.started)||!Number.isFinite(entry.updated)||entry.ended!==null&&!Number.isFinite(entry.ended)||typeof entry.reason!=='string'||entry.reason&&!/^[A-Z_]{1,48}$/.test(entry.reason))throw fail('WORKSPACE_INVALID');}
        this.state=value;
        for(const entry of value.sessions)if(entry.ended===null){entry.state='interrupted';entry.ended=entry.updated;entry.reason='APP_INTERRUPTED';}
      }
      this.prune();this.save();
    }catch{this.error='WORKSPACE_INVALID';}
  }
  save(){
    if(this.error)throw fail(this.error);const temp=this.file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';let fd;
    try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(this.state));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,this.file);}
    catch{throw fail('WORKSPACE_WRITE_FAILED');}
    finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  prune(){const cutoff=this.clock()-this.state.retention*86400000;this.state.sessions=this.state.sessions.filter(s=>s.ended===null||s.ended>=cutoff);while(this.state.sessions.length>=10000){const index=this.state.sessions.findIndex(s=>s.ended!==null);if(index<0)throw fail('HISTORY_LIMIT');this.state.sessions.splice(index,1);}}
  view(){if(this.error)throw fail(this.error);return JSON.parse(JSON.stringify({...this.state,sessions:this.state.sessions.map(s=>({...s,duration:Math.max(0,(s.ended??this.clock())-s.started)}))}));}
  event(owner,data){
    if(this.error)throw fail(this.error);
    if(!data||Object.keys(data).some(k=>!['machineId','name','channel','instance','state','reason'].includes(k))||!ID.test(data.machineId)||typeof data.name!=='string'||!data.name||data.name.length>128||!CHANNELS.has(data.channel)||typeof data.instance!=='string'||!/^[a-zA-Z0-9:_-]{1,100}$/.test(data.instance)||!['connecting','connected','opened','disconnected','failed','completed'].includes(data.state)||data.reason!==undefined&&!/^[A-Z_]{1,48}$/.test(data.reason))throw fail('INVALID_SESSION');
    const key=owner+':'+data.machineId+':'+data.channel+':'+data.instance;let entry=this.live.get(key);const now=this.clock();
    if(!entry){if(!['connecting','connected','opened'].includes(data.state))return {};this.prune();entry={id:crypto.randomBytes(16).toString('hex'),machineId:data.machineId,name:data.name,channel:data.channel,state:data.state,started:now,updated:now,ended:null,reason:''};this.state.sessions.push(entry);this.live.set(key,entry);}
    entry.state=data.state;entry.updated=now;entry.reason=data.reason||'';
    if(['disconnected','failed','completed'].includes(data.state)){entry.ended=now;this.live.delete(key);}
    this.save();return {id:entry.id};
  }
  endOwner(owner,reason='WINDOW_CLOSED'){const now=this.clock();let changed=false;for(const [key,entry] of this.live)if(key.startsWith(owner+':')){entry.ended=entry.updated=now;entry.state='disconnected';entry.reason=reason;this.live.delete(key);changed=true;}if(changed)this.save();}
  heartbeat(){const now=this.clock();if(!this.live.size)return;for(const entry of this.live.values())entry.updated=now;this.save();}
  invoke(action,data={}){
    if(this.error)throw fail(this.error);
    if(action==='get'){this.prune();return this.view();}
    if(action==='layout'){
      if(Object.keys(data).sort().join()!=='devices,selected,tabs'||!Array.isArray(data.tabs)||data.tabs.length>50||data.tabs.some(id=>!ID.test(id))||new Set(data.tabs).size!==data.tabs.length||data.selected!==null&&!data.tabs.includes(data.selected)||!data.devices||Array.isArray(data.devices)||Object.keys(data.devices).length>200)throw fail('INVALID_WORKSPACE');
      const devices={};for(const [id,value] of Object.entries(data.devices)){if(!ID.test(id))throw fail('INVALID_WORKSPACE');devices[id]=preferences(value);}
      Object.assign(this.state,{tabs:[...data.tabs],selected:data.selected,devices});this.save();return {};
    }
    if(action==='retention'){if(Object.keys(data).join()!=='days'||![7,30,90,365].includes(data.days))throw fail('INVALID_WORKSPACE');this.state.retention=data.days;this.prune();this.save();return {};}
    if(action==='export')return {schema:1,kind:'gmssh-connection-history',exportedAt:new Date(this.clock()).toISOString(),sessions:this.view().sessions};
    throw fail('INVALID_WORKSPACE');
  }
}
module.exports={Workspace,preferences};
