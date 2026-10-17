import type { Operations, DownloadProgress } from './operations';

export type UploadEntry = { file?:File; relative:string; directory?:boolean };
export type TransferTask = {
  id:number; kind:'upload'|'download'|'directory'; name:string; path:string; relative?:string; file?:File; directory?:boolean;
  status:'queued'|'running'|'committing'|'paused'|'done'|'failed'|'cancelled'; bytes:number; size:number; started:number; phase:string; message:string; cleanupPending?:boolean;copyBytes?:number;source?:string;target?:string;code?:string;createdAt?:string;sha256?:string|null;
};
export type TransferCollection = {items:TransferTask[];addUploads:(entries:UploadEntry[],base:string)=>void|Promise<void>;addDownloads:(entries:{path:string;name:string;directory:boolean;size:number}[])=>void|Promise<void>;retry:(id:number,name?:string)=>void|Promise<void>;cancel:(id:number)=>void|Promise<void>;cancelAll:()=>void|Promise<void>;clearFinished:()=>void|Promise<void>} & {native?:boolean;pause?:(id:number)=>void|Promise<void>;dispose?:()=>void;chooseUploads?:(remote:string,directory:boolean)=>void|Promise<void>};
type Worker = Pick<Operations,'mkdir'|'upload'|'download'|'close'>;
const MAX_FILE=512*1024*1024,MAX_QUEUE=2000;
export function validateRelativePath(value:string):string {
  const parts=value.split('/');
  if(!value||parts.length>32||parts.some(part=>!part||part==='.'||part==='..'||part.length>255||/[<>:"\\|?*\x00-\x1f\x7f]/.test(part)||/[. ]$/.test(part)||/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))throw Error('文件夹层级或文件名不适合 Windows，请更名后重新选择。');
  return parts.join('/');
}
const join=(base:string,relative:string)=>base.replace(/\/?$/,'/')+relative;

export function selectedUploads(files:Iterable<File>):UploadEntry[] {
  return [...files].map(file=>({file,relative:validateRelativePath(file.webkitRelativePath||file.name)}));
}
export async function droppedUploads(data:DataTransfer,signal?:AbortSignal):Promise<UploadEntry[]> {
  const output:UploadEntry[]=[];
  const check=()=>{if(signal?.aborted)throw Error('已取消读取文件夹。');};
  const add=(item:UploadEntry)=>{if(output.length>=MAX_QUEUE)throw Error('一次拖入最多 2000 个文件和文件夹，请分批选择。');validateRelativePath(item.relative);output.push(item);};
  const visit=async(entry:FileSystemEntry,parent=''):Promise<void>=>{
    check();
    const relative=validateRelativePath(parent+entry.name);
    if(entry.isFile){const file=await new Promise<File>((resolve,reject)=>(entry as FileSystemFileEntry).file(resolve,reject));check();add({file,relative});}
    else if(entry.isDirectory){
      add({relative,directory:true});const reader=(entry as FileSystemDirectoryEntry).createReader();
      for(;;){check();const children=await new Promise<FileSystemEntry[]>((resolve,reject)=>reader.readEntries(resolve,reject));check();if(!children.length)break;for(const child of children)await visit(child,relative+'/');}
    }
  };
  check();const entries=[...data.items].filter(item=>item.kind==='file').map(item=>item.webkitGetAsEntry?.());
  if(entries.length&&entries.every(Boolean)){for(const entry of entries)await visit(entry!);return output;}
  return selectedUploads(data.files);
}

export class TransferQueue {
  items:TransferTask[]=[];
  #next=0;
  #running?:Promise<void>;
  #abort?:AbortController;
  #worker?:Worker;
  #directories=new Set<string>();
  constructor(private worker:()=>Worker,private save:(file:{blob:Blob;name:string})=>void|Promise<void>,private changed:(items:readonly TransferTask[])=>void,private permit?:(signal:AbortSignal)=>Promise<()=>void>){}
  addUploads(entries:UploadEntry[],base:string):void {
    if(!/^[A-Za-z]:\//.test(base))throw Error('请先打开磁盘或文件夹，再上传。');
    if(entries.length+this.items.length>MAX_QUEUE)throw Error('任务列表最多 2000 项，请清除已完成任务后分批选择。');
    const tasks=entries.map(entry=>{
      const relative=validateRelativePath(entry.relative);
      if(!entry.directory&&!entry.file)throw Error('没有读取到文件，请重新选择。');
      const size=entry.file?.size||0,tooLarge=size>MAX_FILE;
      return {...this.task(entry.directory?'directory':'upload',relative,base),relative,file:entry.file,size,status:tooLarge?'failed':'queued',message:tooLarge?'单文件暂限 512 MiB。':''} as TransferTask;
    });
    this.items.push(...tasks);this.notify();this.pump();
  }
  addDownloads(entries:{path:string;name:string;directory:boolean;size:number}[]):void {
    if(entries.length+this.items.length>MAX_QUEUE)throw Error('任务列表已满，请先清除已完成任务。');
    const tasks=entries.map(entry=>{
      if(!/^[A-Za-z]:\//.test(entry.path))throw Error('请先选择磁盘里的文件或普通文件夹。');
      return {...this.task('download',entry.name,entry.path),directory:entry.directory,size:entry.directory?0:entry.size};
    });
    this.items.push(...tasks);this.notify();this.pump();
  }
  private task(kind:TransferTask['kind'],name:string,path:string):TransferTask {
    return {id:++this.#next,kind,name,path,status:'queued',bytes:0,size:0,started:0,phase:'',message:''};
  }
  cancel(id:number):void {
    const task=this.items.find(item=>item.id===id);if(!task)return;
    if(task.status==='running'){this.#abort?.abort();return;}
    if(task.status==='queued'||task.status==='failed'){task.status='cancelled';task.message='已跳过';this.notify();}
  }
  retry(id:number,name?:string):void {
    const task=this.items.find(item=>item.id===id);if(!task||!['failed','cancelled'].includes(task.status))return;
    if(task.kind==='upload'&&!task.file)throw Error('本机文件已释放，请重新选择。');
    if(name){
      if(task.kind!=='upload')throw Error('只有上传文件可以改名重试。');
      validateRelativePath(name);if(name.includes('/'))throw Error('这里只能填写文件名。');
      task.relative=task.relative!.split('/').slice(0,-1).concat(name).join('/');task.name=task.relative;
    }
    task.status='queued';task.bytes=0;task.phase=task.message='';this.#directories.clear();this.notify();this.pump();
  }
  clearFinished():void {this.items=this.items.filter(item=>!['done','cancelled'].includes(item.status));this.notify();}
  cancelAll():void {for(const task of this.items)if(task.status==='queued'){task.status='cancelled';task.message='已取消传输';}this.#abort?.abort();this.notify();}
  async idle():Promise<void>{while(this.#running)await this.#running;}
  private notify():void {this.changed(this.items);}
  private pump():void {
    if(this.#running)return;
    this.#running=this.run().finally(()=>{this.#running=undefined;if(this.items.some(item=>item.status==='queued'))this.pump();});
  }
  private async ensureDirectories(task:TransferTask):Promise<void> {
    const parts=task.relative!.split('/');if(task.kind==='upload')parts.pop();let path=task.path;
    for(const part of parts){
      if(this.#abort?.signal.aborted)throw Error('已取消传输。');
      path=join(path,part);if(!this.#directories.has(path)){await this.#worker!.mkdir(path);this.#directories.add(path);}
    }
  }
  private async run():Promise<void> {
    this.#worker=this.worker();this.#directories.clear();
    try {
      for(;;){
        const task=this.items.find(item=>item.status==='queued');if(!task)break;
        const controller=new AbortController();this.#abort=controller;
        const abort=()=>this.#worker!.close(Error('已取消传输。'));controller.signal.addEventListener('abort',abort,{once:true});
        task.status='running';task.started=Date.now();task.message='';task.phase=this.permit?'waiting':'';this.notify();let release:(()=>void)|undefined;
        const progress:DownloadProgress=(bytes,total,phase)=>{if(task.phase!==phase)task.started=Date.now();task.bytes=bytes;if(phase==='receiving')task.size=total;task.phase=phase;this.notify();};
        try {
          if(this.permit)release=await this.permit(controller.signal);
          if(controller.signal.aborted)throw Error('已取消传输。');
          if(task.kind==='download'){
            const file=await this.#worker.download(task.path,{directory:task.directory,signal:controller.signal,progress});
            if(controller.signal.aborted)throw Error('已取消传输。');
            await this.save(file);task.message='已接收并交给本机保存';
          }else{
            await this.ensureDirectories(task);
            if(task.kind==='upload'){
              const parent=task.relative!.split('/').slice(0,-1).join('/');
              await this.#worker.upload(task.file!,parent?join(task.path,parent):task.path,bytes=>progress(bytes,task.size,'receiving'),()=>controller.signal.aborted,task.relative!.split('/').pop()!);
            }
            task.message=task.kind==='directory'?'文件夹已准备':'上传完成';
          }
          if(controller.signal.aborted)throw Error('已取消传输。');
          task.status='done';task.file=undefined;
        }catch(error){task.status=controller.signal.aborted?'cancelled':'failed';task.message=controller.signal.aborted?'已取消传输':error instanceof Error?error.message:'传输未完成';this.#directories.clear();}
        finally{if(this.permit)this.#worker?.close();release?.();controller.signal.removeEventListener('abort',abort);this.#abort=undefined;this.notify();}
      }
    }finally{this.#worker?.close();this.#worker=undefined;}
  }
}
