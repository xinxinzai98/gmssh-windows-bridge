import './style.css';
import './files.css';
import { Operations } from './operations';
import { installFilePanel } from './file-panel';
import type { TransferTask } from './transfers';

const get=(id:string)=>document.getElementById(id)!;
let token='',available=false,configured=false,loaded=false,parentOrigin='*',timer:number|undefined;
let tasks:readonly TransferTask[]=[];
let activity='';
let leaseId=0;
const permits=new Map<number,{resolve:(release:()=>void)=>void;reject:(error:Error)=>void;abort:()=>void;signal:AbortSignal}>();
const send=(type:string,data:Record<string,unknown>={})=>{if(window.parent!==window)window.parent.postMessage({type,...data},parentOrigin);};
function permit(signal:AbortSignal):Promise<()=>void>{
  if(window.parent===window)return Promise.resolve(()=>{});
  if(signal.aborted)return Promise.reject(Error('已取消传输。'));
  return new Promise((resolve,reject)=>{const requestId=++leaseId,abort=()=>{permits.delete(requestId);send('gmssh-file-lease-release',{requestId});reject(Error('已取消传输。'));};permits.set(requestId,{resolve,reject,abort,signal});signal.addEventListener('abort',abort,{once:true});send('gmssh-file-lease-request',{requestId});});
}
const snapshot=()=>({active:tasks.filter(t=>['queued','running'].includes(t.status)).length,failed:tasks.filter(t=>t.status==='failed').length,total:tasks.length,
  tasks:[...tasks.filter(t=>['running','failed'].includes(t.status)),...tasks.filter(t=>t.status==='queued'),...tasks.filter(t=>['done','cancelled'].includes(t.status)).slice().reverse()].slice(0,100).map(t=>({id:t.id,name:t.name.slice(0,255),kind:t.kind,status:t.status,bytes:t.bytes,size:t.size,message:(t.phase==='waiting'?'等待前面的文件传输':t.message).slice(0,512)}))});
const panel=installFilePanel({token:()=>token,operations:new Operations(()=>token),available:()=>available&&!!token,releaseInputs:()=>{},closeBrowseAfterUse:true,permit,changed(value){
  tasks=value;const state=snapshot(),key=state.active+':'+state.failed;
  if(key!==activity){activity=key;clearTimeout(timer);timer=undefined;send('gmssh-file-state',state);}
  else if(timer===undefined)timer=window.setTimeout(()=>{timer=undefined;send('gmssh-file-state',snapshot());},150);
}});
function open(){if(loaded&&configured){get('file-note').textContent='';panel.open();}}
window.addEventListener('message',event=>{
  if(event.source!==window.parent||window.parent===window)return;
  const data=event.data;
  if(data?.type==='gmssh-file-access'&&typeof data.token==='string'&&/^[A-Za-z0-9_-]{32,128}$/.test(data.token)){
    token=data.token;parentOrigin=event.origin==='null'?'*':event.origin;get('session-label').textContent=typeof data.label==='string'?data.label.slice(0,128):'此设备';
    if(!configured){configured=true;open();}return;
  }
  if(!configured)return;
  if(['gmssh-file-lease','gmssh-file-lease-error'].includes(data?.type)&&Number.isSafeInteger(data.requestId)){
    const pending=permits.get(data.requestId);
    if(!pending){send('gmssh-file-lease-release',{requestId:data.requestId});return;}
    permits.delete(data.requestId);pending.signal.removeEventListener('abort',pending.abort);
    if(data.type==='gmssh-file-lease-error')pending.reject(Error(data.code==='FILE_CENTER_UNAVAILABLE'?'本机文件任务协调未就绪，请重新打开管理端。':'设备配置已变化，请重新打开文件通道。'));
    else pending.resolve(()=>send('gmssh-file-lease-release',{requestId:data.requestId}));return;
  }
  if(data?.type==='gmssh-file-tool'){
    if(data.tool==='transfers')panel.transfers();else if(data.tool==='refresh')panel.open();else if(data.tool==='cancel-all')panel.cancelAll();
  }else if(data?.type==='gmssh-file-state-request')send('gmssh-file-state',snapshot());
});
get('close-files').onclick=()=>send('gmssh-file-hide');
fetch('/config.json').then(async reply=>{if(!reply.ok)throw Error();return reply.json();}).then(config=>{available=config.capabilities?.files===true;loaded=true;open();}).catch(()=>{get('file-feedback').hidden=false;get('file-feedback').textContent='本地文件服务未就绪，请重新打开管理端。';});
window.addEventListener('pagehide',()=>{clearTimeout(timer);panel.dispose();},{once:true});
send('gmssh-file-ready');
