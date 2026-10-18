/* Human setup only. Roots/commands are fixed in main; no native machine passwords. */
const {spawn}=require('node:child_process');
const {randomBytes}=require('node:crypto');
const {StringDecoder}=require('node:string_decoder');

class AIAccess {
  constructor({python,root,clipboard,spawnWorker=spawn}){
    Object.assign(this,{python,root,clipboard,spawnWorker});this.pending=new Map();this.children=new Map();this.epochs=new WeakMap();this.busy=false;this.closed=false;
  }
  clear(owner){
    this.pending.delete(owner);
    this.epochs.set(owner,(this.epochs.get(owner)||0)+1);
    for(const child of this.children.get(owner)||[])child.kill('SIGTERM');
  }
  close(){this.closed=true;for(const owner of this.children.keys())this.clear(owner);this.pending.clear();}
  run(owner,request,{prepare=false}={}){
    return new Promise((resolve,reject)=>{
      const env={...process.env,PIP_NO_INPUT:'1',PIP_DISABLE_PIP_VERSION_CHECK:'1'};delete env.PYTHONHOME;delete env.PYTHONPATH;
      const args=prepare?['-m','pip','install','mcp>=1.30,<2']:['-m','gmssh_windows_bridge.ai_setup','--root',this.root];
      const child=this.spawnWorker(this.python,args,{env,stdio:['pipe','pipe','ignore']});
      const children=this.children.get(owner)||new Set();children.add(child);this.children.set(owner,children);
      let output='',settled=false;const epoch=this.epochs.get(owner)||0,decoder=new StringDecoder('utf8');
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);children.delete(child);if(!children.size)this.children.delete(owner);if(this.closed||(this.epochs.get(owner)||0)!==epoch)error=Object.assign(Error('AI_CANCELLED'),{code:'AI_CANCELLED'});error?reject(error):resolve(value);};
      const fail=code=>Object.assign(Error(code),{code});
      const timer=setTimeout(()=>{child.kill('SIGTERM');finish(fail(prepare?'AI_PREPARE_FAILED':'AI_SETUP_TIMEOUT'));},prepare?180000:45000);
      child.once('error',()=>finish(fail('AI_RUNTIME_UNAVAILABLE')));
      child.stdout.on('data',data=>{
        if(prepare)return;
        output+=typeof data==='string'?data:decoder.write(data);
        if(Buffer.byteLength(output)>524288){child.kill('SIGTERM');finish(fail('INVALID_RESPONSE'));}
      });
      child.once('close',code=>{
        if(prepare){finish(code===0?null:fail('AI_PREPARE_FAILED'),{prepared:true});return;}
        output+=decoder.end();
        try{const reply=JSON.parse(output);if(reply.ok!==true){const code=/^[A-Z_]{1,48}$/.test(reply.code)?reply.code:'AI_SETUP_FAILED';finish(Object.assign(fail(code),{message:typeof reply.message==='string'&&reply.message.length<300?reply.message:code}));}else finish(null,reply.data);}
        catch{finish(fail('AI_SETUP_FAILED'));}
      });
      child.stdin.on('error',()=>finish(fail('AI_SETUP_FAILED')));
      child.stdin.end(prepare?'':JSON.stringify(request));
    });
  }
  async invoke(owner,value){
    if(this.closed)throw Object.assign(Error(),{code:'AI_RUNTIME_UNAVAILABLE'});
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!=='action,data'||!value.data||typeof value.data!=='object'||Array.isArray(value.data))throw Object.assign(Error(),{code:'INVALID_ARGUMENT'});
    const {action,data}=value,fields={list:[],doctor:[],prepare:[],clear:[],preview:['code'],'paste-preview':[],enroll:['preview','name','allow'],configure:['device','allow'],credential:['device','value'],check:['device'],config:['format'],copy:['format']};
    if(!Object.hasOwn(fields,action)||Object.keys(data).sort().join()!==[...fields[action]].sort().join())throw Object.assign(Error(),{code:'INVALID_ARGUMENT'});
    if(action==='clear'){this.clear(owner);return {cleared:true};}
    if(this.busy)throw Object.assign(Error(),{code:'AI_SETUP_BUSY'});
    this.busy=true;
    try{
      if(action==='preview'||action==='paste-preview'){
        this.pending.delete(owner);
        const code=action==='paste-preview'?this.clipboard.readText():data.code;
        if(typeof code!=='string'||Buffer.byteLength(code)>32768)throw Object.assign(Error(),{code:'INVALID_ARGUMENT'});
        const result=await this.run(owner,{action:'preview',data:{code}}),id=randomBytes(16).toString('hex');
        this.pending.set(owner,{id,code,existing:result.existing});return {...result,preview:id};
      }
      if(action==='enroll'){
        const staged=this.pending.get(owner);
        if(!staged||staged.id!==data.preview)throw Object.assign(Error(),{code:'AI_PREVIEW_REQUIRED'});
        try{return await this.run(owner,{action:'enroll',data:{code:staged.code,name:data.name,allow:data.allow,replace:staged.existing}});}
        finally{this.pending.delete(owner);}
      }
      if(action==='prepare'){await this.run(owner,null,{prepare:true});return await this.run(owner,{action:'doctor',data:{checkMCP:true}});}
      if(action==='doctor')return await this.run(owner,{action:'doctor',data:{checkMCP:true}});
      if(action==='copy'){
        const result=await this.run(owner,{action:'config',data});this.clipboard.writeText(result.text);return {copied:true};
      }
      return await this.run(owner,{action,data});
    }finally{this.busy=false;}
  }
}
module.exports={AIAccess};
