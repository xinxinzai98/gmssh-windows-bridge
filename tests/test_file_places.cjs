const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {FileTasks}=require('../gmssh_windows_bridge/file-tasks.cjs');
const machine='1'.repeat(32),other='2'.repeat(32),peer='SHA256:'+'A'.repeat(43),another='SHA256:'+'B'.repeat(43);
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmssh-places-')),m=new FileTasks({root,resolveBinding:async()=>{throw Error('must not connect without an explicit action');},pickOpen:async()=>{throw Error('must not grant local access');},pickSave:async()=>{throw Error('must not grant local access');}});let calls=0;
  m.probe=async(id,expected)=>{calls++;const actual=id===machine?peer:another;if(expected&&expected!==actual)throw Object.assign(Error('PEER_CHANGED'),{code:'PEER_CHANGED'});return {peer:actual};};
  return {root,m,calls:()=>calls,close:async()=>{await m.shutdown();fs.rmSync(root,{recursive:true,force:true});}};
}
if(process.platform==='win32'){test('Mac controller places storage',{skip:'native controller requires Unix directory sync'},()=>{});}else{
test('favorites survive manager reopening as private metadata without reading a local file or connecting on list',async()=>{
  const f=fixture();try{
    assert.equal((await f.m.invoke('hello',null)).places,true);assert.deepEqual((await f.m.invoke('places',machine,{op:'list'})).items,[]);assert.equal(f.calls(),0);
    const result=await f.m.invoke('places',machine,{op:'add',path:'C:/资料',label:'资料'});result.items[0].path='C:/not-a-grant';assert.equal(fs.statSync(f.m.placesFile).mode&0o777,0o600);assert.equal(fs.statSync(f.root).mode&0o777,0o700);
    const restored=new FileTasks({root:f.root,resolveBinding:async()=>{throw Error('must not connect on reopen');}});assert.deepEqual((await restored.invoke('places',machine,{op:'list'})).items,[{path:'C:/资料',label:'资料'}]);assert.equal(restored.jobs.length,0);assert.equal(restored.grants.size,0);await restored.shutdown();
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f.m.placesFile))).sort(),['devices','schema']);
  }finally{await f.close();}
});
test('opening a favorite pins the saved peer; changed identities never rebind its paths or expose another device',async()=>{
  const f=fixture();try{
    await f.m.invoke('places',machine,{op:'add',path:'C:/资料',label:'资料'});await f.m.invoke('places',other,{op:'add',path:'D:/独立',label:'其他设备'});
    assert.deepEqual((await f.m.invoke('places',machine,{op:'list'})).items,[{path:'C:/资料',label:'资料'}]);assert.deepEqual(await f.m.invoke('places',machine,{op:'open',path:'C:/资料'}),{path:'C:/资料'});
    await assert.rejects(f.m.invoke('places',other,{op:'open',path:'C:/资料'}),/PLACE_NOT_FOUND/);
    const before=fs.readFileSync(f.m.placesFile,'utf8');f.m.probe=async()=>({peer:another});await assert.rejects(f.m.invoke('places',machine,{op:'open',path:'C:/资料'}),/PEER_CHANGED/);await assert.rejects(f.m.invoke('places',machine,{op:'add',path:'C:/新目录',label:'新'}),/PEER_CHANGED/);assert.equal(fs.readFileSync(f.m.placesFile,'utf8'),before);
    f.m.probe=async()=>{throw Error('remove is metadata only');};await f.m.invoke('places',machine,{op:'remove',path:'C:/资料'});assert.equal((await f.m.invoke('places',machine,{op:'list'})).items.length,0);assert.equal((await f.m.invoke('places',other,{op:'list'})).items.length,1);
  }finally{await f.close();}
});
test('favorite limits and invalid input are enforced before granting access; duplicates retain one entry',async()=>{
  const f=fixture();try{
    for(const values of [{op:'__proto__'},{op:'add',path:'/../private/local',label:'bad'},{op:'add',path:'C:/../escape',label:'bad'},{op:'add',path:'C:/ok',label:'\n'},{op:'list',path:'C:/bad'},{op:'add',path:'C:/ok',label:'ok',token:'not accepted'}])await assert.rejects(f.m.invoke('places',machine,values));
    assert.equal(f.calls(),0);for(let i=0;i<12;i++)await f.m.invoke('places',machine,{op:'add',path:'C:/folder-'+i,label:'目录 '+i});
    await f.m.invoke('places',machine,{op:'add',path:'C:/folder-0',label:'同一目录'});assert.equal((await f.m.invoke('places',machine,{op:'list'})).items.length,12);await assert.rejects(f.m.invoke('places',machine,{op:'add',path:'C:/overflow',label:'超出'}),/PLACES_LIMIT/);
    assert.equal(f.m.grants.size,0);assert.equal(f.m.jobs.length,0);
  }finally{await f.close();}
});
test('corrupt and linked favorites fail separately from the transfer journal and preserve their original data',async()=>{
  for(const contents of [null,'broken',JSON.stringify({schema:1,devices:[]}),JSON.stringify({schema:1,devices:{[machine]:{peer,items:[{path:'/../local/path',label:'bad'}]}}}),JSON.stringify({schema:1,devices:{[machine]:{peer,items:[{path:'C:/a',label:'a'},{path:'C:/a',label:'a'}]}}})]){const f=fixture();try{
    const original=path.join(f.root,'original.txt');fs.writeFileSync(original,'preserve this metadata');if(contents===null)fs.symlinkSync(original,f.m.placesFile);else fs.writeFileSync(f.m.placesFile,contents);
    await assert.rejects(f.m.invoke('places',machine,{op:'list'}),/PLACES_INVALID/);assert.equal(f.m.readyError,undefined);assert.deepEqual((await f.m.invoke('list',machine)).jobs,[]);assert.equal((await f.m.invoke('hello',null)).protocol,2);assert.equal(fs.readFileSync(original,'utf8'),'preserve this metadata');if(contents!==null)assert.equal(fs.readFileSync(f.m.placesFile,'utf8'),contents);
  }finally{await f.close();}}
});
test('a failed atomic save preserves the earlier favorites in memory and on disk',async()=>{
  const f=fixture(),rename=fs.renameSync;try{
    await f.m.invoke('places',machine,{op:'add',path:'C:/safe',label:'保留'});const before=fs.readFileSync(f.m.placesFile,'utf8');fs.renameSync=(from,to)=>{if(to===f.m.placesFile)throw Object.assign(Error('synthetic storage full'),{code:'ENOSPC'});return rename(from,to);};
    await assert.rejects(f.m.invoke('places',machine,{op:'add',path:'C:/unsaved',label:'未保存'}),/PLACES_WRITE_FAILED/);assert.equal(fs.readFileSync(f.m.placesFile,'utf8'),before);assert.deepEqual((await f.m.invoke('places',machine,{op:'list'})).items,[{path:'C:/safe',label:'保留'}]);
  }finally{fs.renameSync=rename;await f.close();}
});
test('concurrent windows keep both updates after the asynchronous peer check',async()=>{
  const f=fixture();try{const pending=[];f.m.probe=()=>new Promise(resolve=>pending.push(()=>resolve({peer})));const a=f.m.invoke('places',machine,{op:'add',path:'C:/one',label:'一'}),b=f.m.invoke('places',machine,{op:'add',path:'C:/two',label:'二'});assert.equal(pending.length,2);pending[1]();pending[0]();await Promise.all([a,b]);assert.equal((await f.m.invoke('places',machine,{op:'list'})).items.length,2);}finally{await f.close();}
});
}
