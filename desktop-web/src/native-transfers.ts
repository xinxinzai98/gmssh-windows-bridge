import type { TransferTask, UploadEntry } from './transfers';

type Call = (action:string,data?:Record<string,unknown>)=>Promise<any>;
const messages:Record<string,string>={
  COMMIT_UNSUPPORTED:'该磁盘不支持不覆盖保存，临时文件已保留；请选择其他磁盘重新下载',
  CANCELLED_FILE_RETAINED:'已取消；达到完整大小的目标文件已保留，可继续核验',
  PARTIAL_MISSING:'所选目录未找到已传部分，请选择原目录或重新挂载后的同一目录',
  VOLUME_UNAVAILABLE:'磁盘或网络盘暂不可用，请重新连接并确认原保存位置后继续',READ_ONLY_VOLUME:'目标磁盘为只读，请检查挂载方式或选择其他磁盘',FILE_TOO_LARGE:'文件超过目标文件系统的限制，请选择支持大文件的磁盘',
  INVALID_NAME:'文件名不适合目标系统，请更名后重新选择',INVALID_PATH:'请先打开目标磁盘或普通文件夹',INVALID_GRANT:'请在系统窗口重新选择本机文件或保存位置',
  PAUSED:'已暂停，保留已传部分',REAUTHORIZE:'重新选择源文件或确认保存位置后继续',
  NEED_CONNECTION:'请先连接此设备的监控，再继续传输',PEER_CHANGED:'设备身份已变化，请核对连接配置',
  SOURCE_CHANGED:'源文件已变化，请重新创建传输任务',PARTIAL_CHANGED:'已传部分的标识或内容已变化，原文件已保留；请确认原磁盘位置后继续核对',
  HASH_MISMATCH:'内容校验未通过，文件尚未提交',CONFLICT:'目标已有同名文件；下载可点继续另存，上传可改名后继续',
  ACCESS_DENIED:'没有读写权限，请检查所选文件或目录',DISK_FULL:'空间不足，释放空间后可继续',
  DEVICE_CONFIG_CHANGED:'设备连接配置已变化，请先核对该设备',DEVICE_CONFIG_UNAVAILABLE:'设备配置未就绪，请重新连接',
  JOURNAL_INVALID:'任务记录无法读取，原记录已保留，请检查本机文件中心',JOURNAL_WRITE_FAILED:'任务记录无法保存，传输已停止',
  TARGET_CHANGED:'请选择原保存位置，避免恢复到其他文件',UNSUPPORTED_FILE:'仅支持普通文件和文件夹，暂不跟随链接',
  PICKER_BUSY:'已有文件选择窗口，请先完成该窗口',QUERY_BUSY:'正在核对连接，请稍后再试',
  TRANSFER_LIMIT:'最多 2000 项、单文件 1 TiB；请分批传输',CANCELLED:'已取消',TRANSFER_IO:'传输中断，已传部分已保留，可继续',
  REMOTE_IO:'远端读写失败，检查连接或权限后可继续',PROTOCOL_UNSUPPORTED:'本地文件服务版本不匹配，请重开更新后的管理端',
};
export const transferMessage=(code:string)=>messages[code]||'文件任务暂不可用，请检查连接后继续';
export function nativeCall(send:(type:string,data:Record<string,unknown>)=>void){
  let next=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:number}>();
  const receive=(event:MessageEvent)=>{
    if(event.source!==window.parent||event.data?.type!=='gmssh-file-native-result')return;
    const value=pending.get(event.data.requestId);if(!value)return;pending.delete(event.data.requestId);clearTimeout(value.timer);
    const reply=event.data.reply;if(reply?.status==='ok')value.resolve(reply.data);else value.reject(Object.assign(Error(transferMessage(reply?.code)),{code:reply?.code||'UNSUPPORTED'}));
  };
  window.addEventListener('message',receive);
  const call:Call=(action,data={})=>new Promise((resolve,reject)=>{const requestId=++next,timer=window.setTimeout(()=>{pending.delete(requestId);reject(Object.assign(Error('文件中心未响应，请重开管理端'),{code:'UNSUPPORTED'}));},action==='hello'?3000:600_000);pending.set(requestId,{resolve,reject,timer});send('gmssh-file-native',{requestId,action,data});});
  window.addEventListener('pagehide',()=>{window.removeEventListener('message',receive);for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('文件页已关闭'));}pending.clear();},{once:true});
  return call;
}
export class NativeTransfers {
  readonly native=true;items:TransferTask[]=[];private timer?:number;private disposed=false;private polling=false;
  constructor(private call:Call,private changed:(tasks:readonly TransferTask[])=>void){void this.refresh();this.timer=window.setInterval(()=>void this.refresh(),700);}
  async refresh(){if(this.disposed||this.polling)return;this.polling=true;try{const value=await this.call('list');if(this.disposed)return;if(!Array.isArray(value.jobs))throw Error('任务返回格式无效');this.items=value.jobs.map((j:any)=>({id:j.id,kind:j.kind,name:j.name,path:'',relative:j.name,status:j.status,bytes:j.bytes,size:j.size,started:j.started||Date.now(),createdAt:j.createdAt,source:j.source,target:j.target,code:j.code,sha256:j.sha256,cleanupPending:!!j.cleanupPending,copyBytes:j.copyBytes||0,phase:j.phase,message:j.status==='done'?'已校验并保存':transferMessage(j.code||'PAUSED')+(j.needsGrant&&['paused','failed','cancelled'].includes(j.status)?' · 需确认本机文件权限':'' )}));this.changed(this.items);}catch(error){if(!this.disposed){const note=document.getElementById('file-feedback');if(note){note.hidden=false;note.textContent=error instanceof Error?error.message:'任务列表暂不可用';}}}finally{this.polling=false;}}
  async action(action:string,data:Record<string,unknown>={}){await this.call(action,data);await this.refresh();}
  chooseUploads(remote:string,directory:boolean){return this.action('pick-upload',{remote,directory});}
  addUploads(entries:UploadEntry[],remote:string){return this.action('pick-upload',{remote,directory:entries.some(e=>!!e.directory),hints:entries.map(e=>({relative:e.relative,name:e.file?.name||e.relative.split('/').at(-1),directory:!!e.directory,size:e.file?.size||0,modified:e.file?.lastModified||0}))});}
  addDownloads(entries:{path:string;name:string;directory:boolean;size:number}[]){return this.action('pick-download',{entries});}
  retry(id:number,name?:string){return this.action('resume',name?{id,name}:{id});}
  pause(id:number){return this.action('pause',{id});}
  cancel(id:number){return this.action('cancel',{id});}
  cancelAll(){return this.action('cancel-all');}
  clearFinished(){return this.action('clear');}
  dispose(){this.disposed=true;clearInterval(this.timer);}
}
