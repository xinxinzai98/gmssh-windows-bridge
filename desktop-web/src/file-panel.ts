import { Operations, type FileEntry } from './operations';
import { TransferQueue, droppedUploads, selectedUploads, type TransferTask, type TransferCollection } from './transfers';

const get=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const size=(bytes:number)=>bytes>=1024**2?(bytes/1024**2).toFixed(1)+' MiB':bytes>=1024?(bytes/1024).toFixed(1)+' KiB':bytes+' B';
const button=(text:string,run:()=>void)=>{const node=document.createElement('button');node.type='button';node.textContent=text;node.onclick=run;return node;};
export function browseEntries(entries:readonly FileEntry[],query:string,order:string):FileEntry[]{
  const text=query.trim().toLocaleLowerCase(),names=(a:FileEntry,b:FileEntry)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true,sensitivity:'base'});
  return entries.filter(entry=>entry.name.toLocaleLowerCase().includes(text)).sort((a,b)=>Number(b.directory)-Number(a.directory)||(order==='size'?b.size-a.size:order==='modified'?b.modified-a.modified:0)||names(a,b));
}
const modified=(value:number)=>value>0&&Number.isFinite(new Date(value*1000).getTime())?new Date(value*1000).toLocaleString():'时间未知';
export function installFilePanel(options:{token:()=>string;operations:Operations;available:()=>boolean;releaseInputs:()=>void;closeBrowseAfterUse?:boolean;changed?:(tasks:readonly TransferTask[])=>void;permit?:(signal:AbortSignal)=>Promise<()=>void>;queue?:(changed:(tasks:readonly TransferTask[])=>void)=>TransferCollection}) {
  const panel=get('file-panel'),list=get('file-list'),note=get('file-note'),selected=new Map<string,FileEntry>();
  let path='/',entries:FileEntry[]=[],visibleEntries:FileEntry[]=[],truncated=false,request=0,renderTimer:number|undefined,idleCompleted=0,lastTask=0,mode:'files'|'transfers'='files',disposed=false,taskLimit=50,browsing=false;
  const pendingDrops=new Set<AbortController>();
  const rows=new Map<number,{root:HTMLElement;name:HTMLElement;detail:HTMLElement;bar:HTMLProgressElement;cancel:HTMLButtonElement;retry:HTMLButtonElement;rename:HTMLInputElement;renameButton:HTMLButtonElement;pause:HTMLButtonElement;description:HTMLElement}>();
  const filters=document.createElement('div'),search=document.createElement('input'),status=document.createElement('select'),matches=document.createElement('p');filters.className='transfer-filters';
  search.type='search';search.placeholder='搜索文件名或路径';search.maxLength=256;search.setAttribute('aria-label','搜索此设备的任务');status.setAttribute('aria-label','筛选此设备的任务状态');
  for(const [value,label] of [['all','全部状态'],['active','进行中与排队'],['attention','需要处理'],['paused','已暂停'],['failed','未完成'],['done','已完成'],['cancelled','已取消']]){const option=document.createElement('option');option.value=value;option.textContent=label;status.append(option);}
  filters.append(search,status);matches.className='transfer-matches';const more=button('显示更多',()=>{taskLimit+=50;renderTransfers();});more.className='transfer-more';get('transfer-list').before(filters,matches);get('transfer-list').after(more);
  search.oninput=status.onchange=()=>{taskLimit=50;renderTransfers();};
  const browserTools=document.createElement('div'),fileSearch=document.createElement('input'),fileOrder=document.createElement('select'),selectionInfo=document.createElement('div'),selectionText=document.createElement('small');browserTools.className='file-browser-tools';selectionInfo.className='file-selected-info';
  fileSearch.type='search';fileSearch.placeholder='搜索当前目录';fileSearch.maxLength=256;fileSearch.setAttribute('aria-label','搜索当前目录');fileSearch.title='只筛选当前已读取的目录，不搜索子目录';fileOrder.setAttribute('aria-label','文件排序');
  for(const [value,label] of [['name','名称顺序'],['size','大文件优先'],['modified','最近修改优先']]){const option=document.createElement('option');option.value=value;option.textContent=label;fileOrder.append(option);}
  const refreshButton=button('刷新',()=>void refresh()),clearSelection=button('清空选择',()=>{selected.clear();renderFiles();});refreshButton.title='重新读取当前目录';refreshButton.setAttribute('aria-label','刷新当前目录');
  browserTools.append(fileSearch,fileOrder,refreshButton);selectionInfo.append(selectionText,clearSelection);get('file-note').before(browserTools,selectionInfo);
  fileSearch.oninput=fileOrder.onchange=()=>renderFiles();
  get('select-all-files').setAttribute('aria-label','全选当前筛选结果');
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
    if(!queue.items.some(item=>item.status==='queued'||item.status==='running'||item.status==='committing')&&complete!==idleCompleted){idleCompleted=complete;if(!panel.hidden&&mode==='files'&&!browsing&&path!=='/')void refresh();}
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
    get<HTMLButtonElement>('upload').disabled=get<HTMLButtonElement>('upload-folder').disabled=browsing||path==='/'||!options.available();refreshButton.disabled=browsing;get<HTMLButtonElement>('parent-folder').disabled=browsing||path==='/';
    get<HTMLButtonElement>('download-selected').disabled=browsing||!selected.size;
    get('download-count').textContent=selected.size?'（'+selected.size+'）':'';
    const count=visibleEntries.filter(entry=>selected.has(join(entry.name))).length,all=get<HTMLInputElement>('select-all-files');all.disabled=browsing||path==='/'||!visibleEntries.length;all.checked=path!=='/'&&visibleEntries.length>0&&count===visibleEntries.length;all.indeterminate=count>0&&count<visibleEntries.length;
    selectionInfo.hidden=!selected.size;selectionText.textContent='已选 '+selected.size+' 项'+(selected.size>count?'（'+(selected.size-count)+' 项被筛选隐藏）':'');clearSelection.disabled=browsing;
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
    const current=++request;browsing=true;list.setAttribute('aria-busy','true');list.inert=true;updateSelection();tell('正在读取目录…');get('file-feedback').hidden=true;
    try{
      const reply=await options.operations.list(next);if(disposed||current!==request)return;
      if(path!==reply.path){selected.clear();fileSearch.value='';}else for(const [remote,old] of selected){const current=reply.entries.find(entry=>join(entry.name)===remote);if(!current||current.directory!==old.directory)selected.delete(remote);else selected.set(remote,current);}
      path=reply.path;entries=reply.entries;truncated=reply.truncated;browsing=false;get<HTMLInputElement>('file-path').value=path;breadcrumbs();renderFiles();
    }catch(error){if(!disposed&&current===request){get<HTMLInputElement>('file-path').value=path;fail(error instanceof Error?error.message:'目录读取失败。');tell('读取失败，仍显示上次成功的目录：'+path);}}
    finally{if(current===request){browsing=false;list.inert=false;list.setAttribute('aria-busy','false');updateSelection();if(options.closeBrowseAfterUse)options.operations.close();}}
  }
  function renderFiles():void {
      visibleEntries=browseEntries(entries,fileSearch.value,fileOrder.value);list.replaceChildren();
      for(const entry of visibleEntries){
        const remote=join(entry.name),row=document.createElement('div');row.className='file-row';
        if(path!=='/'){
          const check=document.createElement('input');check.type='checkbox';check.setAttribute('aria-label','选择 '+entry.name);
          check.checked=selected.has(remote);check.onchange=()=>{if(check.checked)selected.set(remote,entry);else selected.delete(remote);updateSelection();};row.append(check);
        }
        const open=button('',()=>{if(entry.directory)void refresh(remote);});open.className='file-open';open.title=entry.name+'\n'+remote+'\n修改时间：'+modified(entry.modified);
        const icon=document.createElement('img');icon.src='/ui-icons/'+(entry.directory?'folder':'file')+'.svg';icon.alt='';const name=document.createElement('span');name.textContent=entry.name;open.append(icon,name);row.append(open);
        if(path!=='/'){const meta=document.createElement('div');meta.className='file-entry-meta';const bytes=document.createElement('small'),date=document.createElement('small');bytes.textContent=entry.directory?'文件夹':size(entry.size);date.className='file-modified';date.textContent=modified(entry.modified);meta.append(bytes,date);row.append(meta);}
        if(path!=='/'){
          const download=button('',()=>run(()=>queue.addDownloads([{path:remote,name:entry.name,directory:entry.directory,size:entry.size}])));download.className='file-download';download.title=entry.directory?(queue.native?'下载文件夹':'下载文件夹（ZIP）'):'下载到本机';download.setAttribute('aria-label',download.title+' · '+entry.name);
          const image=document.createElement('img');image.src='/ui-icons/download-simple.svg';image.alt='';download.append(image);row.append(download);
        }
        list.append(row);
      }
      updateSelection();tell((browsing?'正在读取目录…':fileSearch.value.trim()?visibleEntries.length+' / '+entries.length+' 项匹配，仅筛选当前已读取的目录':path==='/'?'先打开一个磁盘或文件夹，再上传或选择下载。':entries.length?entries.length+' 项':'此文件夹为空，可选择文件或拖入上传。')+(truncated?' · 目录较大，仅载入前 2000 项；未搜索未载入的文件。':''));
  }
  function renderTransfers():void {
    const pending=queue.items.filter(item=>item.status==='queued'||item.status==='running'||item.status==='committing').length;
    const failed=queue.items.filter(item=>item.status==='failed'||item.status==='paused').length;
    get('file-transfer-count').textContent=pending?String(pending):failed?'!':'';get('file-transfer-count').hidden=!pending&&!failed;get('file-transfer-count').dataset.error=String(failed>0);
    get('files').setAttribute('aria-label',pending?'文件互传，'+pending+' 项进行中':failed?'文件互传，'+failed+' 项待处理':'文件互传');
    get('file-queue-count').textContent=queue.items.length?'（'+queue.items.length+'）':'';
    const summary=pending?pending+' 项待完成':failed?failed+' 项待处理':'传输任务';if(get('transfer-summary').textContent!==summary)get('transfer-summary').textContent=summary;
    get<HTMLButtonElement>('cancel-transfers').disabled=!pending;
    const query=search.value.trim().toLocaleLowerCase(),ordered=[...queue.items.filter(item=>item.status==='running'||item.status==='committing'||item.status==='failed'||item.status==='paused'),...queue.items.filter(item=>item.status==='queued'),...queue.items.filter(item=>item.status==='done'||item.status==='cancelled').reverse()];
    const filtered=ordered.filter(item=>(status.value==='all'||status.value==='active'&&['queued','running','committing'].includes(item.status)||status.value==='attention'&&(item.cleanupPending||['paused','failed'].includes(item.status))||item.status===status.value)&&(!query||[item.name,item.source,item.target].some(value=>String(value||'').toLocaleLowerCase().includes(query))));
    matches.textContent=filtered.length+' / '+queue.items.length+' 项';get('transfer-empty').hidden=!!filtered.length;get('transfer-empty').textContent=queue.items.length?'没有符合筛选条件的任务。':'还没有传输任务，可切换到“文件”选择上传或下载。';
    more.hidden=filtered.length<=taskLimit;more.textContent='再显示 '+Math.min(50,filtered.length-taskLimit)+' 项（剩余 '+Math.max(0,filtered.length-taskLimit)+' 项）';const visible=filtered.slice(0,taskLimit);
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
        const expanded=document.createElement('details'),summary=document.createElement('summary'),description=document.createElement('p');expanded.className='transfer-details';summary.textContent='详细信息';expanded.append(summary,description);
        actions.append(pause,cancel,retry,rename,renameButton);root.append(name,detail,bar,expanded,actions);view={root,name,detail,bar,cancel,retry,rename,renameButton,pause,description};rows.set(task.id,view);
      }
      view.name.textContent=(task.kind==='download'?'↓ ':'↑ ')+task.name;view.name.title=task.name;view.root.dataset.state=task.status;
      const active=task.status==='running'||task.status==='committing',rate=active&&task.phase==='receiving'?task.bytes/Math.max(.1,(Date.now()-task.started)/1000):0;
      const remaining=rate>0&&task.size>task.bytes?Math.ceil((task.size-task.bytes)/rate):0;
      view.detail.textContent=active?(task.phase==='copying'?'正在兼容保存（完成前请勿打开目标文件） · '+size(task.copyBytes||0)+' / '+size(task.size):task.phase==='saving'?'正在校验并保存到目标磁盘':task.phase==='waiting'?'等待前面的文件传输':task.phase==='verifying'?'正在核对文件内容与已传部分':task.phase==='preparing'?'正在打包文件夹 · 已读取 '+size(task.bytes):size(task.bytes)+' / '+size(task.size)+(rate?' · '+size(Math.round(rate))+'/s'+(remaining?' · 约 '+remaining+' 秒':''):'')):task.message||({queued:'排队中',paused:'已暂停',done:'完成',failed:'传输未完成',cancelled:'已取消'} as Record<string,string>)[task.status];
      view.bar.value=task.status==='done'?100:task.phase==='copying'&&task.size>0?100*(task.copyBytes||0)/task.size:task.size>0&&task.phase!=='preparing'?100*task.bytes/task.size:0;
      view.bar.setAttribute('aria-label',task.name+' 的进度');view.description.textContent=(task.source?'来源：'+task.source+'\n':'')+(task.target?'目标：'+task.target+'\n':'')+(task.createdAt?'创建时间：'+new Date(task.createdAt).toLocaleString()+'\n':'')+(task.code?'状态代码：'+task.code+'\n':'')+(task.sha256?'SHA-256：'+task.sha256:'')+(!queue.native?'远端路径：'+task.path:'');
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
  get<HTMLInputElement>('select-all-files').onchange=event=>{const checked=(event.target as HTMLInputElement).checked;for(const entry of visibleEntries)if(checked)selected.set(join(entry.name),entry);else selected.delete(join(entry.name));for(const check of list.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))check.checked=checked;updateSelection();};
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
