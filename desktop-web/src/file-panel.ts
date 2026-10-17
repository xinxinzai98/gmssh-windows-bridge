import { Operations, type FileEntry } from './operations';
import { TransferQueue, droppedUploads, selectedUploads, type TransferTask, type TransferCollection } from './transfers';

const get=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const size=(bytes:number)=>bytes>=1024**2?(bytes/1024**2).toFixed(1)+' MiB':bytes>=1024?(bytes/1024).toFixed(1)+' KiB':bytes+' B';
const button=(text:string,run:()=>void)=>{const node=document.createElement('button');node.type='button';node.textContent=text;node.onclick=run;return node;};
export function installFilePanel(options:{token:()=>string;operations:Operations;available:()=>boolean;releaseInputs:()=>void;closeBrowseAfterUse?:boolean;changed?:(tasks:readonly TransferTask[])=>void;permit?:(signal:AbortSignal)=>Promise<()=>void>;queue?:(changed:(tasks:readonly TransferTask[])=>void)=>TransferCollection}) {
  const panel=get('file-panel'),list=get('file-list'),note=get('file-note'),selected=new Map<string,FileEntry>();
  let path='/',entries:FileEntry[]=[],request=0,renderTimer:number|undefined,idleCompleted=0,lastTask=0,mode:'files'|'transfers'='files',disposed=false;
  const pendingDrops=new Set<AbortController>();
  const rows=new Map<number,{root:HTMLElement;name:HTMLElement;detail:HTMLElement;bar:HTMLProgressElement;cancel:HTMLButtonElement;retry:HTMLButtonElement;rename:HTMLInputElement;renameButton:HTMLButtonElement;pause:HTMLButtonElement}>();
  const tell=(text:string)=>{note.textContent=text;};
  const fail=(error:unknown)=>{get('file-feedback').textContent=error instanceof Error?error.message:String(error);get('file-feedback').hidden=false;};
  const run=(action:()=>void|Promise<void>)=>{if(disposed)return;get('file-feedback').hidden=true;try{Promise.resolve(action()).catch(fail);}catch(error){fail(error);}};
  const join=(name:string)=>path==='/'?name+'/':path.replace(/\/$/,'')+'/'+name;
  const save=(file:{blob:Blob;name:string})=>{const url=URL.createObjectURL(file.blob),anchor=document.createElement('a');anchor.href=url;anchor.download=file.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),60_000);};
  const changed=()=>{
    if(disposed)return;
    options.changed?.(queue.items);
    const newest=queue.items.at(-1)?.id||0;if(newest>lastTask){lastTask=newest;setMode('transfers');}
    if(renderTimer===undefined)renderTimer=window.setTimeout(()=>{renderTimer=undefined;renderTransfers();},50);
    const complete=queue.items.filter(item=>item.status==='done').length;
    if(!queue.items.some(item=>item.status==='queued'||item.status==='running'||item.status==='committing')&&complete!==idleCompleted){idleCompleted=complete;if(!panel.hidden)void refresh();}
  };
  const queue:TransferCollection=options.queue?options.queue(changed):new TransferQueue(()=>new Operations(options.token),save,changed,options.permit);
  if(queue.native)for(const node of panel.querySelectorAll('.transfer-hint'))node.textContent='文件直接写入本机；单文件最多 1 TiB。可暂停、继续，重开后需确认原文件或保存位置。拖入文件后通过系统选择窗口确认授权；文件夹保留原目录结构。部分网络盘使用兼容保存，需要额外一份文件大小的空间，完成前请勿打开目标文件。';
  function setMode(next:'files'|'transfers'):void {
    mode=next;get('file-browser-view').hidden=next!=='files';get('transfer-box').hidden=next!=='transfers';
    get('file-browse-tab').setAttribute('aria-selected',String(next==='files'));get('file-transfers-tab').setAttribute('aria-selected',String(next==='transfers'));
    if(next==='transfers')renderTransfers();
  }
  for(const [id,value] of [['file-browse-tab','files'],['file-transfers-tab','transfers']] as const){
    get(id).onclick=()=>setMode(value);get(id).onkeydown=event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const next=value==='files'?'transfers':'files';setMode(next);get(next==='files'?'file-browse-tab':'file-transfers-tab').focus();}};
  }
  function updateSelection():void {
    get<HTMLButtonElement>('download-selected').disabled=!selected.size;
    get('download-count').textContent=selected.size?'（'+selected.size+'）':'';
    get<HTMLInputElement>('select-all-files').checked=path!=='/'&&entries.length>0&&selected.size===entries.length;
  }
  function breadcrumbs():void {
    const target=get('file-location');target.replaceChildren(button('此电脑',()=>void refresh('/')));
    if(path==='/')return;
    const parts=path.replace(/\/$/,'').split('/');
    parts.forEach((part,index)=>{const divider=document.createElement('span');divider.textContent='›';target.append(divider,button(part,()=>void refresh(parts.slice(0,index+1).join('/')+(index===0?'/':''))));});
  }
  async function refresh(next=path):Promise<void> {
    if(disposed)return;
    if(!options.available()){fail('请先接通这台电脑的 SSH 连接，再使用文件互传。');get<HTMLButtonElement>('upload').disabled=get<HTMLButtonElement>('upload-folder').disabled=true;return;}
    const current=++request;tell('正在读取目录…');
    try{
      const reply=await options.operations.list(next);if(disposed||current!==request)return;
      path=reply.path;entries=reply.entries;selected.clear();get<HTMLInputElement>('file-path').value=path;list.replaceChildren();breadcrumbs();
      get<HTMLButtonElement>('upload').disabled=get<HTMLButtonElement>('upload-folder').disabled=path==='/';get<HTMLInputElement>('select-all-files').disabled=path==='/';
      for(const entry of [...entries].sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name))){
        const remote=join(entry.name),row=document.createElement('div');row.className='file-row';
        if(path!=='/'){
          const check=document.createElement('input');check.type='checkbox';check.setAttribute('aria-label','选择 '+entry.name);
          check.onchange=()=>{if(check.checked)selected.set(remote,entry);else selected.delete(remote);updateSelection();};row.append(check);
        }
        const open=button('',()=>{if(entry.directory)void refresh(remote);});open.className='file-open';open.title=entry.name;
        const icon=document.createElement('img');icon.src='/ui-icons/'+(entry.directory?'folder':'file')+'.svg';icon.alt='';const name=document.createElement('span');name.textContent=entry.name;open.append(icon,name);row.append(open);
        if(!entry.directory){const bytes=document.createElement('small');bytes.textContent=size(entry.size);row.append(bytes);}
        if(path!=='/'){
          const download=button('',()=>run(()=>queue.addDownloads([{path:remote,name:entry.name,directory:entry.directory,size:entry.size}])));download.className='file-download';download.title=entry.directory?(queue.native?'下载文件夹':'下载文件夹（ZIP）'):'下载到本机';download.setAttribute('aria-label',download.title+' · '+entry.name);
          const image=document.createElement('img');image.src='/ui-icons/download-simple.svg';image.alt='';download.append(image);row.append(download);
        }
        list.append(row);
      }
      updateSelection();tell(path==='/'?'先打开一个磁盘或文件夹，再上传或选择下载。':reply.truncated?'目录较大，当前显示前 2000 项。':entries.length?entries.length+' 项':'此文件夹为空，可选择文件或拖入上传。');
    }catch(error){if(!disposed&&current===request)fail(error instanceof Error?error.message:'目录读取失败。');}
    finally{if(options.closeBrowseAfterUse&&current===request)options.operations.close();}
  }
  function renderTransfers():void {
    const pending=queue.items.filter(item=>item.status==='queued'||item.status==='running'||item.status==='committing').length;
    const failed=queue.items.filter(item=>item.status==='failed'||item.status==='paused').length;
    get('file-transfer-count').textContent=pending?String(pending):failed?'!':'';get('file-transfer-count').hidden=!pending&&!failed;get('file-transfer-count').dataset.error=String(failed>0);
    get('files').setAttribute('aria-label',pending?'文件互传，'+pending+' 项进行中':failed?'文件互传，'+failed+' 项待处理':'文件互传');
    get('file-queue-count').textContent=queue.items.length?'（'+queue.items.length+'）':'';get('transfer-empty').hidden=!!queue.items.length;
    const summary=pending?pending+' 项待完成':failed?failed+' 项待处理':'传输任务';if(get('transfer-summary').textContent!==summary)get('transfer-summary').textContent=summary;
    get<HTMLButtonElement>('cancel-transfers').disabled=!pending;
    const visible=[...queue.items.filter(item=>item.status==='running'||item.status==='committing'||item.status==='failed'||item.status==='paused'),...queue.items.filter(item=>item.status==='queued'),...queue.items.filter(item=>item.status==='done'||item.status==='cancelled')].slice(0,100);
    const ids=new Set(visible.map(item=>item.id));for(const [id,view] of rows)if(!ids.has(id)){view.root.remove();rows.delete(id);}
    let position=0;
    for(const task of visible){
      let view=rows.get(task.id);
      if(!view){
        const root=document.createElement('article');root.className='transfer-task';const name=document.createElement('strong'),detail=document.createElement('small'),bar=document.createElement('progress');bar.max=100;
        const actions=document.createElement('div');actions.className='transfer-task-actions';
        const cancel=button('取消',()=>run(()=>queue.cancel(task.id))),pause=button('暂停',()=>run(()=>queue.pause?.(task.id))),retry=button('重试',()=>run(()=>queue.retry(task.id)));
        const rename=document.createElement('input');rename.setAttribute('aria-label','重试文件名');rename.value=task.relative?.split('/').pop()||task.name;rename.maxLength=255;
        const renameButton=button('改名重试',()=>run(()=>queue.retry(task.id,rename.value)));
        actions.append(pause,cancel,retry,rename,renameButton);root.append(name,detail,bar,actions);view={root,name,detail,bar,cancel,retry,rename,renameButton,pause};rows.set(task.id,view);
      }
      view.name.textContent=(task.kind==='download'?'↓ ':'↑ ')+task.name;view.name.title=task.name;view.root.dataset.state=task.status;
      const active=task.status==='running'||task.status==='committing',rate=active&&task.phase==='receiving'?task.bytes/Math.max(.1,(Date.now()-task.started)/1000):0;
      const remaining=rate>0&&task.size>task.bytes?Math.ceil((task.size-task.bytes)/rate):0;
      view.detail.textContent=active?(task.phase==='copying'?'正在兼容保存（完成前请勿打开目标文件） · '+size(task.copyBytes||0)+' / '+size(task.size):task.phase==='saving'?'正在校验并保存到目标磁盘':task.phase==='waiting'?'等待前面的文件传输':task.phase==='verifying'?'正在核对文件内容与已传部分':task.phase==='preparing'?'正在打包文件夹 · 已读取 '+size(task.bytes):size(task.bytes)+' / '+size(task.size)+(rate?' · '+size(Math.round(rate))+'/s'+(remaining?' · 约 '+remaining+' 秒':''):'')):task.message||({queued:'排队中',paused:'已暂停',done:'完成',failed:'传输未完成',cancelled:'已取消'} as Record<string,string>)[task.status];
      view.bar.value=task.status==='done'?100:task.phase==='copying'&&task.size>0?100*(task.copyBytes||0)/task.size:task.size>0&&task.phase!=='preparing'?100*task.bytes/task.size:0;
      view.pause.hidden=!queue.pause||!['queued','running','committing'].includes(task.status);view.pause.setAttribute('aria-label','暂停 · '+task.name);view.cancel.hidden=!task.cleanupPending&&!['queued','running','committing','paused','failed'].includes(task.status);view.cancel.textContent=task.cleanupPending?'清理临时文件':task.status==='failed'?'跳过':'取消';
      view.cancel.setAttribute('aria-label',view.cancel.textContent+' · '+task.name);view.retry.setAttribute('aria-label',(queue.native?'继续':'重试')+' · '+task.name);view.renameButton.setAttribute('aria-label','改名重试 · '+task.name);view.rename.setAttribute('aria-label','重试文件名 · '+task.name);
      view.retry.hidden=!['failed','cancelled','paused'].includes(task.status);view.retry.textContent=queue.native?'继续':'重试';const conflict=task.kind==='upload'&&task.status==='failed'&&task.message.includes('同名');view.rename.hidden=view.renameButton.hidden=!conflict;
      const container=get('transfer-list');if(container.children[position]!==view.root)container.insertBefore(view.root,container.children[position]||null);position++;
    }
  }
  const enqueueInput=(id:string)=>{const input=get<HTMLInputElement>(id);input.onchange=()=>{const files=[...input.files||[]];input.value='';run(()=>queue.addUploads(selectedUploads(files),path));};};
  enqueueInput('upload-input');enqueueInput('folder-input');
  get('upload').onclick=()=>queue.chooseUploads?run(()=>queue.chooseUploads!(path,false)):get<HTMLInputElement>('upload-input').click();get('upload-folder').onclick=()=>queue.chooseUploads?run(()=>queue.chooseUploads!(path,true)):get<HTMLInputElement>('folder-input').click();
  get<HTMLFormElement>('path-form').onsubmit=event=>{event.preventDefault();void refresh(get<HTMLInputElement>('file-path').value);};
  get('parent-folder').onclick=()=>{if(path==='/')return;const parts=path.replace(/\/$/,'').split('/');parts.pop();void refresh(parts.length?parts.join('/')+'/':'/');};
  get<HTMLInputElement>('select-all-files').onchange=event=>{selected.clear();const checked=(event.target as HTMLInputElement).checked;for(const entry of entries)if(checked)selected.set(join(entry.name),entry);for(const check of list.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))check.checked=checked;updateSelection();};
  get('download-selected').onclick=()=>run(()=>queue.addDownloads([...selected].map(([remote,entry])=>({path:remote,name:entry.name,directory:entry.directory,size:entry.size}))));
  get('cancel-transfers').onclick=()=>run(()=>queue.cancelAll());get('clear-transfers').onclick=()=>run(()=>queue.clearFinished());
  const open=()=>{if(disposed)return;panel.hidden=false;options.releaseInputs();setMode(mode);get('remote-files-label').textContent='本机 ↔ '+(get('session-label').textContent||'此设备');void refresh();};
  get('files').onclick=open;get('close-files').onclick=()=>{panel.hidden=true;};
  const dragOver=(event:DragEvent)=>{if([...event.dataTransfer?.types||[]].includes('Files')){event.preventDefault();panel.classList.add('drop-active');}};
  const drop=async(event:DragEvent)=>{
    if(disposed)return;
    if(!event.dataTransfer||![...event.dataTransfer.types].includes('Files'))return;event.preventDefault();panel.classList.remove('drop-active');panel.hidden=false;options.releaseInputs();
    if(!options.available()||path==='/'){fail('请先打开目标磁盘和文件夹，再拖入文件。');return;}
    const targetPath=path,controller=new AbortController();pendingDrops.add(controller);
    try{get('file-feedback').hidden=true;const entries=await droppedUploads(event.dataTransfer,controller.signal);if(!disposed&&!controller.signal.aborted)await queue.addUploads(entries,targetPath);}catch(error){if(!disposed)fail(error instanceof Error?error.message:'无法读取拖入的文件。');}finally{pendingDrops.delete(controller);}
  };
  window.addEventListener('dragover',dragOver);window.addEventListener('drop',drop);
  panel.ondragleave=event=>{if(!panel.contains(event.relatedTarget as Node))panel.classList.remove('drop-active');};
  const dispose=()=>{disposed=true;request++;for(const pending of pendingDrops)pending.abort();pendingDrops.clear();if(queue.native)queue.dispose?.();else queue.cancelAll();if(options.closeBrowseAfterUse)options.operations.close();clearTimeout(renderTimer);window.removeEventListener('dragover',dragOver);window.removeEventListener('drop',drop);};
  window.addEventListener('pagehide',dispose,{once:true});
  return {open,dispose,transfers(){if(disposed)return;panel.hidden=false;options.releaseInputs();setMode('transfers');},cancelAll:()=>queue.cancelAll()};
}
