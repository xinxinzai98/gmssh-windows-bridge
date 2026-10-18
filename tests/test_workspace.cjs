const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Workspace}=require('../gmssh_windows_bridge/workspace.cjs');
const id='a'.repeat(32),other='b'.repeat(32),prefs={layout:'split',ratio:.6,zoom:'fit',quality:'balanced',display:1};
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmssh-workspace-'));let time=1792280000000;const manager=new Workspace({root,clock:()=>time});return {root,manager,tick:ms=>time+=ms,close:()=>fs.rmSync(root,{recursive:true,force:true})};}
const event=(state,overrides={})=>({machineId:id,name:'Synthetic device',channel:'desktop',instance:'desktop-one',state,...overrides});
test('connection lifecycle deduplicates live sessions and persists only bounded local metadata',()=>{
  const f=fixture();try{
    f.manager.event('window-1',event('connecting'));f.tick(1000);f.manager.event('window-1',event('connected'));f.manager.event('window-1',event('connected'));
    assert.equal(f.manager.view().sessions.length,1);f.tick(3000);f.manager.event('window-1',event('disconnected',{reason:'USER_DISCONNECTED'}));const s=f.manager.view().sessions[0];assert.equal(s.duration,4000);assert.equal(s.state,'disconnected');
    f.manager.event('window-1',event('connecting'));assert.equal(f.manager.view().sessions.length,2);
    assert.throws(()=>f.manager.event('window-1',event('connected',{password:'forbidden'})),{code:'INVALID_SESSION'});assert.throws(()=>f.manager.event('window-1',event('failed',{reason:'arbitrary remote error body'})),{code:'INVALID_SESSION'});
    const raw=fs.readFileSync(f.manager.file,'utf8');assert.ok(!raw.includes('password'));assert.equal(fs.statSync(f.manager.file).mode&0o777,0o600);
  }finally{f.close();}
});
test('reopening repairs active records at their last heartbeat, never claiming a continuing session',()=>{
  const f=fixture();try{
    f.manager.event('window-1',event('connected'));f.tick(2000);f.manager.heartbeat();f.tick(20000);const restored=new Workspace({root:f.root,clock:()=>1792280099999});const s=restored.view().sessions[0];assert.equal(s.state,'interrupted');assert.equal(s.reason,'APP_INTERRUPTED');assert.equal(s.duration,2000);assert.equal(restored.live.size,0);
  }finally{f.close();}
});
test('workspace restore separates devices, validates display/layout, and history export contains no config objects',()=>{
  const f=fixture();try{
    f.manager.invoke('layout',{tabs:[id,other],selected:id,devices:{[id]:prefs,[other]:{...prefs,layout:'terminal',display:0,quality:'low'}}});const restored=new Workspace({root:f.root});assert.equal(restored.view().devices[id].quality,'balanced');assert.equal(restored.view().devices[other].quality,'low');
    for(const data of [{tabs:[id,id],selected:id,devices:{}},{tabs:[id],selected:other,devices:{}},{tabs:[id],selected:id,devices:{[id]:{...prefs,display:32}}},{tabs:[id],selected:id,devices:{[id]:{...prefs,password:'not allowed'}}}])assert.throws(()=>f.manager.invoke('layout',data),{code:'INVALID_WORKSPACE'});
    assert.deepEqual(Object.keys(f.manager.invoke('export')).sort(),['exportedAt','kind','schema','sessions']);
    f.manager.event('window-1',event('connected'));f.manager.event('window-2',event('connected'));f.manager.endOwner('window-1');assert.equal(f.manager.view().sessions.filter(s=>s.ended===null).length,1);
  }finally{f.close();}
});
test('retention keeps active records and malformed metadata remains recoverable',()=>{
  const f=fixture();try{
    f.manager.event('window-1',event('connecting'));f.manager.event('window-1',event('failed',{reason:'AUTH_FAILED'}));f.manager.event('window-2',event('opened',{channel:'terminal'}));f.tick(8*86400000);f.manager.invoke('retention',{days:7});assert.equal(f.manager.view().sessions.length,1);assert.equal(f.manager.view().sessions[0].ended,null);
    const raw='{malformed';fs.writeFileSync(f.manager.file,raw);const invalid=new Workspace({root:f.root});assert.throws(()=>invalid.invoke('get'),{code:'WORKSPACE_INVALID'});assert.equal(fs.readFileSync(f.manager.file,'utf8'),raw);
  }finally{f.close();}
});
