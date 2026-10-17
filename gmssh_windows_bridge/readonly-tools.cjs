/* Fixed read-only queries. Credentials and native connection records stay in main. */
const net = require('node:net');
const { spawn } = require('node:child_process');
const VERSION = '0.4.0a20';
const MAX_OUTPUT = 262144;
const stamp = () => new Date().toISOString();
const failure = error => ({error});
const tools = new Set(['diagnostics','capabilities','processes','services','logs','log-detail']);
function optionsFor(tool, options) {
  if(!tools.has(tool)||!options||typeof options!=='object'||Array.isArray(options))throw Error('INVALID_QUERY');
  const keys={diagnostics:[],capabilities:[],processes:['limit','search','sort'],services:['limit','search','sort'],logs:['source','limit','hours'],'log-detail':['source','recordId']}[tool];
  if(Object.keys(options).sort().join()!==keys.slice().sort().join())throw Error('INVALID_QUERY');
  if('limit' in options&&![50,100,200].includes(options.limit))throw Error('INVALID_QUERY');
  if('search' in options&&(typeof options.search!=='string'||options.search.length>64||/[\x00-\x1f\x7f]/.test(options.search)))throw Error('INVALID_QUERY');
  if('sort' in options&&!(tool==='processes'?['name','cpu','memory','pid']:['name','state']).includes(options.sort))throw Error('INVALID_QUERY');
  if('source' in options&&!(tool==='log-detail'||tool==='logs'))throw Error('INVALID_QUERY');
  return options;
}
function linuxCommand(tool, values) {
  const options=optionsFor(tool,values);
  let command;
  if(tool==='capabilities'||tool==='diagnostics')command="printf 'GMSSH_CAPS\\n'; uname -sr; for x in ps systemctl journalctl; do if command -v $x >/dev/null 2>&1; then printf '%s=yes\\n' $x; else printf '%s=no\\n' $x; fi; done";
  else if(tool==='processes')command="command -v ps >/dev/null 2>&1 || { printf 'GMSSH_UNSUPPORTED\\n'; exit; }; rows=$(LC_ALL=C ps -eo pid=,pcpu=,rss=,comm= 2>/dev/null) || { printf 'GMSSH_QUERY_FAILED\\n'; exit; }; printf 'GMSSH_PROCESSES\\n%s\\n' \"$rows\" | head -n 4098";
  else if(tool==='services')command="command -v systemctl >/dev/null 2>&1 || { printf 'GMSSH_UNSUPPORTED\\n'; exit; }; rows=$(LC_ALL=C systemctl list-units --type=service --all --no-pager --plain --no-legend 2>/dev/null) || { printf 'GMSSH_BACKEND_UNAVAILABLE\\n'; exit; }; printf 'GMSSH_SERVICES\\n%s\\n' \"$rows\" | head -n 4098";
  else {
    if(options.source!=='journal')throw Error('INVALID_QUERY');
    if(tool==='logs'&&![1,6,24].includes(options.hours))throw Error('INVALID_QUERY');
    if(tool==='log-detail'&&(typeof options.recordId!=='string'||!/^[A-Za-z0-9;=:_\-.]{1,512}$/.test(options.recordId)))throw Error('INVALID_QUERY');
    const selector=tool==='log-detail'?"--cursor='"+options.recordId+"' --lines=1 --reverse":"--since='-"+options.hours+" hours' --lines="+(options.limit+1);
    command="command -v journalctl >/dev/null 2>&1 || { printf 'GMSSH_UNSUPPORTED\\n'; exit; }; rows=$(LC_ALL=C journalctl --quiet --no-pager --output=json "+selector+" 2>&1); gmssh_query_status=$?; if test $gmssh_query_status -ne 0; then case \"$rows\" in *Permission*|*denied*|*not\\ permitted*) printf 'GMSSH_ACCESS_DENIED\\n';; *) printf 'GMSSH_QUERY_FAILED\\n';; esac; exit; fi; printf 'GMSSH_JOURNAL\\n%s\\n' \"$rows\" | head -c 250000";
  }
  return 'LC_ALL=C; export LC_ALL; '+command+'\n';
}
const clean=(value,max=128)=>typeof value==='string'?value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').slice(0,max):'';
function linuxResult(tool,options,raw) {
  optionsFor(tool,options);
  if(typeof raw!=='string'||Buffer.byteLength(raw)>MAX_OUTPUT)throw Error('INVALID_RESPONSE');
  const lines=raw.replace(/\r/g,'').trimEnd().split('\n'), marker=lines.shift();
  const result={schema:1,kind:'linux',tool,sampledAt:stamp(),state:'passed',code:'OK',items:[],truncated:false};
  const unavailable={GMSSH_UNSUPPORTED:['unsupported','TOOL_UNAVAILABLE'],GMSSH_BACKEND_UNAVAILABLE:['unsupported','SERVICE_BACKEND_UNAVAILABLE'],GMSSH_ACCESS_DENIED:['failed','ACCESS_DENIED'],GMSSH_QUERY_FAILED:['failed','QUERY_FAILED']};
  if(unavailable[marker])return {...result,state:unavailable[marker][0],code:unavailable[marker][1]};
  if(tool==='capabilities'||tool==='diagnostics'){
    if(marker!=='GMSSH_CAPS'||!lines[0])throw Error('INVALID_RESPONSE');
    return {...result,versions:{controller:VERSION,bridge:VERSION,server:null,engine:null,os:clean(lines[0])},capabilities:{processes:lines.includes('ps=yes'),services:lines.includes('systemctl=yes'),logs:lines.includes('journalctl=yes'),sources:['journal']}};
  }
  if(tool==='processes'){
    if(marker!=='GMSSH_PROCESSES')throw Error('INVALID_RESPONSE');
    const parsed=lines.filter(Boolean).map(line=>{
      const match=line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);if(!match)throw Error('INVALID_RESPONSE');
      const pid=Number(match[1]),cpuPercent=Number(match[2]),memoryBytes=Number(match[3])*1024;
      if(!Number.isSafeInteger(pid)||!Number.isFinite(cpuPercent)||cpuPercent<0||!Number.isSafeInteger(memoryBytes))throw Error('INVALID_RESPONSE');
      return {pid,name:clean(match[4]),cpuPercent,memoryBytes};
    });
    result.truncated=parsed.length>4096;result.items=parsed.slice(0,4096);result.units={cpu:'ps-lifetime-average',memory:'resident-set'};
  }else if(tool==='services'){
    if(marker!=='GMSSH_SERVICES')throw Error('INVALID_RESPONSE');
    result.items=lines.filter(line=>line.trim()).map(line=>{
      const match=line.match(/^\s*([\w@:.\\-]+\.service)\s+\S+\s+(\S+)\s+(\S+)\s*(.*)$/);if(!match)throw Error('INVALID_RESPONSE');
      return {name:clean(match[1]),displayName:clean(match[4]),state:clean(match[2]+' / '+match[3]),startType:null};
    });result.truncated=result.items.length>4096;result.items=result.items.slice(0,4096);
  }else{
    if(marker!=='GMSSH_JOURNAL')throw Error('INVALID_RESPONSE');
    if(Buffer.byteLength(raw)>=249997){
      result.truncated=true;
      // A byte cap can cut the final JSON record; keep preceding complete records.
      try{JSON.parse(lines.at(-1));}catch{lines.pop();}
      if(!lines.length)throw Error('INVALID_RESPONSE');
    }
    result.items=lines.filter(line=>line.trim()).map(line=>{
      let entry;try{entry=JSON.parse(line);}catch{throw Error('INVALID_RESPONSE');}
      if(typeof entry.__CURSOR!=='string'||!/^[A-Za-z0-9;=:_\-.]{1,512}$/.test(entry.__CURSOR))throw Error('INVALID_RESPONSE');
      const micros=Number(entry.__REALTIME_TIMESTAMP);if(!Number.isFinite(micros)||micros<=0)throw Error('INVALID_RESPONSE');
      const message=clean(entry.MESSAGE,4096),item={recordId:entry.__CURSOR,source:'journal',time:new Date(micros/1000).toISOString(),level:['紧急','警报','严重','错误','警告','通知','信息','调试'][Number(entry.PRIORITY)]||'—',provider:clean(entry.SYSLOG_IDENTIFIER||entry._SYSTEMD_UNIT||''),eventId:null};
      return tool==='log-detail'?{...item,message,messageTruncated:typeof entry.MESSAGE==='string'&&entry.MESSAGE.length>4096}:{...item,preview:message.replace(/[\r\n\t]+/g,' ').slice(0,100)};
    });
    if(tool==='log-detail'){
      result.items=result.items.filter(item=>item.recordId===options.recordId);
      if(!result.items.length)return {...result,state:'failed',code:'LOG_RECORD_UNAVAILABLE'};
    }
    // journalctl returns chronological output; put the most recent record first.
    else result.items.reverse();
  }
  if('search' in options){const search=options.search.toLocaleLowerCase();result.items=result.items.filter(item=>[item.name,item.displayName,String(item.pid??'')].some(value=>value?.toLocaleLowerCase().includes(search)));}
  if('sort' in options){const key={cpu:'cpuPercent',memory:'memoryBytes',pid:'pid',name:'name',state:'state'}[options.sort];result.items.sort((a,b)=>['cpu','memory'].includes(options.sort)?b[key]-a[key]:options.sort==='pid'?a.pid-b.pid:String(a[key]).localeCompare(String(b[key])));}
  const limit=tool==='log-detail'?1:options.limit;result.truncated ||= result.items.length>limit;result.items=result.items.slice(0,limit);
  return result;
}
function nativeScript(machineId,tool,options) {
  if(!/^[a-f0-9]{32}$/i.test(machineId))throw Error('INVALID_QUERY');
  const command=linuxCommand(tool,options);
  const inner='(async()=>{if(typeof window.$gm?.execShell!=="function")return {error:"NATIVE_SDK_UNAVAILABLE"};const r=await window.$gm.execShell('+JSON.stringify({cmd:command,timeout:15})+');if(![0,200].includes(r?.code)&&r?.exitCode!==0)return {error:"NATIVE_QUERY_FAILED"};const s=typeof r.data==="string"?r.data:r.stdout;if(typeof s!=="string"||s.length>262144)return {error:"INVALID_RESPONSE"};return {output:s};})()';
  return '(async()=>{const id='+JSON.stringify(machineId)+';const v=Array.from(document.querySelectorAll("webview.home-container-view")).find(v=>{try{const u=new URL(v.getAttribute("src"));return u.protocol==="http:"&&["127.0.0.1","localhost"].includes(u.hostname)&&/\\/(newweb|web)\\//.test(u.pathname)&&new URLSearchParams(u.hash.split("?")[1]||"").get("machineId")===id;}catch{return false;}});if(!v)return {error:"NATIVE_SESSION_REQUIRED"};return await v.executeJavaScript('+JSON.stringify(inner)+');})()';
}
function windowsQuery(python,binding,tool,options) {
  optionsFor(tool,options);
  return new Promise(resolve=>{
    const env={...process.env};delete env.PYTHONPATH;delete env.PYTHONHOME;
    const child=spawn(python,['-m','gmssh_windows_bridge.readonly_cli'],{env,stdio:['pipe','pipe','ignore']});
    let chunks=[],size=0,done=false;
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);resolve(result);};
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish(failure('QUERY_TIMEOUT'));},27000);
    child.on('error',()=>finish(failure('LOCAL_SERVICE_UNAVAILABLE')));
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>MAX_OUTPUT){child.kill('SIGTERM');finish(failure('INVALID_RESPONSE'));}else chunks.push(chunk);});
    child.on('close',code=>{if(code!==0)return finish(failure('LOCAL_SERVICE_UNAVAILABLE'));try{finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(failure('INVALID_RESPONSE'));}});
    child.stdin?.on('error',()=>{});
    child.stdin?.end(JSON.stringify({url:binding.viewerUrl,token:binding.accessToken,tool,options}));
  });
}
async function tcpProbe(address,port){
  if(typeof address!=='string'||address.length>253||!Number.isInteger(port)||port<1||port>65535)return {state:'unchecked',code:'TARGET_UNKNOWN',sampledAt:stamp()};
  return new Promise(resolve=>{const start=performance.now(),socket=net.createConnection({host:address,port});let done=false;
    const finish=(state,code)=>{if(done)return;done=true;socket.destroy();resolve({state,code,sampledAt:stamp(),latencyMs:state==='passed'?Math.round((performance.now()-start)*10)/10:null});};
    socket.setTimeout(2000,()=>finish('failed','TCP_TIMEOUT'));socket.on('connect',()=>finish('passed','TCP_REACHABLE'));socket.on('error',error=>finish('failed',error.code==='ECONNREFUSED'?'TCP_REFUSED':error.code==='ENOTFOUND'?'ADDRESS_UNRESOLVED':'TCP_UNREACHABLE'));
  });
}
async function query({api,pairing,legacy,python,sender},data){
  if(!data||Object.keys(data).sort().join()!=='machineId,options,tool'||!/^[a-f0-9]{32}$/i.test(data.machineId))throw Error('INVALID_QUERY');
  const {machineId,tool,options}=data;optionsFor(tool,options);
  const reply=await api('/node/detail',{id:machineId});
  if(![0,200].includes(reply.code)||reply.data?.id!==machineId)return failure('DEVICE_CONFIG_UNAVAILABLE');
  const node=reply.data,binding=[...(pairing?.bindings()||[]),...legacy].find(item=>item.machineId===machineId);
  const context={machineId,name:clean(node.name),kind:binding?'windows':'linux',address:binding?.target||clean(node.ip,253),port:binding?.monitor?.targetPort||Number(node.port)};
  if(binding)return {context,result:await windowsQuery(python,binding,tool,options)};
  let timer;
  const script=Promise.race([sender.executeJavaScript(nativeScript(machineId,tool,options)).catch(()=>failure('NATIVE_QUERY_FAILED')),new Promise(resolve=>{timer=setTimeout(()=>resolve(failure('QUERY_TIMEOUT')),18000);})]).finally(()=>clearTimeout(timer));
  const [tcp,native]=await Promise.all([tool==='diagnostics'?tcpProbe(context.address,context.port):null,script]);
  if(tool!=='diagnostics')return {context,result:native.error?native:linuxResult(tool,options,native.output)};
  const sampledAt=stamp(),passed=!native.error,caps=passed?linuxResult('capabilities',{},native.output):null;
  return {context,result:{schema:1,kind:'linux',tool,sampledAt,versions:caps?.versions||{controller:VERSION,bridge:VERSION,server:null,engine:null},stages:[
    {id:'target',state:'passed',code:'SAVED_TARGET',sampledAt},{id:'tcp',...tcp},
    {id:'identity',state:'unchecked',code:'NATIVE_IDENTITY_NOT_EXPOSED',sampledAt},
    {id:'auth',state:passed?'passed':'unchecked',code:passed?'NATIVE_SESSION_READY':native.error,sampledAt},
    {id:'monitor',state:passed?'passed':'unchecked',code:passed?'NATIVE_QUERY_OK':native.error,sampledAt},
    {id:'files',state:'unchecked',code:'NATIVE_SFTP_NOT_EXPOSED',sampledAt},
    {id:'desktopAuth',state:'unsupported',code:'NATIVE_DESKTOP_NOT_EXPOSED',sampledAt}
  ]}};
}
module.exports={optionsFor,linuxCommand,linuxResult,nativeScript,windowsQuery,tcpProbe,query,VERSION};
