import { Operations, type FileEntry } from './operations';
import { TransferQueue, droppedUploads, selectedUploads, validateRelativePath, type TransferTask, type TransferCollection } from './transfers';
import { transferStageMessage } from './native-transfers';

const get=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const size=(bytes:number)=>bytes>=1024**2?(bytes/1024**2).toFixed(1)+' MiB':bytes>=1024?(bytes/1024).toFixed(1)+' KiB':bytes+' B';
const button=(text:string,run:()=>void)=>{const node=document.createElement('button');node.type='button';node.textContent=text;node.onclick=run;return node;};
export function browseEntries(entries:readonly FileEntry[],query:string,order:string):FileEntry[]{
  const text=query.trim().toLocaleLowerCase(),names=(a:FileEntry,b:FileEntry)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true,sensitivity:'base'});
  return entries.filter(entry=>entry.name.toLocaleLowerCase().includes(text)).sort((a,b)=>Number(b.directory)-Number(a.directory)||(order==='size'?b.size-a.size:order==='modified'?b.modified-a.modified:0)||names(a,b));
}
const modified=(value:number)=>value>0&&Number.isFinite(new Date(value*1000).getTime())?new Date(value*1000).toLocaleString():'时间未知';
export function folderTarget(base:string,name:string,posix=false):string {
  if(!(posix?base.startsWith('/'):/^[A-Za-z]:\//.test(base)))throw Error('请先打开一个磁盘或文件夹。');
  if(name.includes('/'))throw Error('请输入单个文件夹名称，不要包含路径。');
  const target=base.replace(/\/?$/,'/')+validateRelativePath(name,posix);
  if(target.length>1024)throw Error('目标路径过长，请使用更短的文件夹名称。');
  return target;
}
export function installFilePanel(options:{token:()=>string;operations:Operations;posix?:boolean;unavailable?:()=>string;available:()=>boolean;writable?:()=>boolean;releaseInputs:()=>void;closeBrowseAfterUse?:boolean;changed?:(tasks:readonly TransferTask[])=>void;permit?:(signal:AbortSignal)=>Promise<()=>void>;queue?:(changed:(tasks:readonly TransferTask[])=>void)=>TransferCollection}) {
  const panel=get('file-panel'),list=get('file-list'),note=get('file-note'),selected=new Map<string,FileEntry>();
  let path='/',entries:FileEntry[]=[],visibleEntries:FileEntry[]=[],truncated=false,request=0,renderTimer:number|undefined,idleCompleted=0,lastTask=0,mode:'files'|'transfers'='files',disposed=false,taskLimit=50,browsing=false,creating=false,folderBase='';
  const computer=()=>path==='/'&&!options.posix;
  const writable=()=>options.available()&&(options.writable?.()??true);
  type Location={path:string;query:string;order:string;scroll:number;outerScroll:number};
  const history:Location[]=[];let historyIndex=-1;
  const pendingDrops=new Set<AbortController>();
  const rows=new Map<number,{root:HTMLElement;name:HTMLElement;detail:HTMLElement;bar:HTMLProgressElement;cancel:HTMLButtonElement;retry:HTMLButtonElement;rename:HTMLInputElement;renameButton:HTMLButtonElement;pause:HTMLButtonElement;copy:HTMLButtonElement;description:HTMLElement}>();
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
  const back=button('',()=>void refresh(history[historyIndex-1].path,historyIndex-1)),forward=button('',()=>void refresh(history[historyIndex+1].path,historyIndex+1));
  for(const [node,label] of [[back,'后退到上个目录'],[forward,'前进到下个目录']] as const){node.className='file-history-button';node.setAttribute('aria-label',label);const image=document.createElement('img');image.src='/ui-icons/arrow-left.svg';image.alt='';node.append(image);}forward.classList.add('file-forward');get('parent-folder').before(back,forward);
  const folderForm=document.createElement('form'),folderHeading=document.createElement('strong'),folderName=document.createElement('input'),folderMessage=document.createElement('p'),folderResult=document.createElement('p');
  folderForm.className='file-new-folder';folderForm.hidden=true;folderForm.setAttribute('aria-label','新建文件夹');folderName.type='text';folderName.maxLength=255;folderName.required=true;folderName.autocomplete='off';folderName.placeholder='文件夹名称';folderName.setAttribute('aria-label','新文件夹名称');folderMessage.setAttribute('role','status');folderResult.className='file-folder-result';folderResult.setAttribute('role','status');folderResult.hidden=true;
  const createFolder=button('创建',()=>{}),cancelFolder=button('取消',()=>{folderForm.hidden=true;folderName.value='';newFolder.focus();}),newFolder=button('新建文件夹',()=>{if(browsing||creating||computer()||!writable())return;folderBase=path;folderHeading.textContent='在 '+folderBase+' 中新建';folderMessage.textContent='';folderName.value='';folderResult.hidden=true;folderForm.hidden=false;folderName.focus();folderName.scrollIntoView({block:'nearest'});});
  createFolder.type='submit';const folderActions=document.createElement('div');folderActions.append(createFolder,cancelFolder);folderForm.append(folderHeading,folderName,folderActions,folderMessage);get('upload-folder').after(newFolder);get('file-note').before(folderForm,folderResult);
  const placesBox=document.createElement('details'),placesTitle=document.createElement('summary'),placesList=document.createElement('div'),placesMessage=document.createElement('p');placesBox.className='file-places';placesBox.hidden=true;placesTitle.textContent='常用目录';placesMessage.setAttribute('role','status');placesBox.append(placesTitle,placesList,placesMessage);get('file-note').before(placesBox);
  let placeItems:{path:string;label:string}[]=[],placesBusy=false,placesLoaded=false;
  const remember=button('收藏目录',()=>void placeAction('add',path));remember.hidden=true;remember.title='将当前目录收藏到本机';browserTools.append(remember);
  function applyPlaces(value:{items?:{path:string;label:string}[]}):void {
    if(!Array.isArray(value.items)||value.items.length>12||value.items.some(item=>!item||typeof item.path!=='string'||item.path.length>1024||!(options.posix?item.path.startsWith('/'):/^[A-Za-z]:\//.test(item.path))||typeof item.label!=='string'||!item.label||item.label.length>80))throw Error('常用目录返回格式无效，原列表已保留。');
    placeItems=value.items;placesLoaded=true;renderPlaces();
  }
  function renderPlaces():void {
    placesTitle.textContent='常用目录（'+placeItems.length+' / 12）';placesList.replaceChildren();
    if(!placeItems.length){const empty=document.createElement('p');empty.textContent='尚未收藏目录。进入常用文件夹后点击“收藏目录”。';placesList.append(empty);}
    for(const item of placeItems){
      const row=document.createElement('div'),label=document.createElement('strong'),fullPath=document.createElement('small'),info=document.createElement('div');row.className='file-place';label.textContent=item.label;fullPath.textContent=item.path;info.append(label,fullPath);
      const open=button('打开',()=>void placeAction('open',item.path)),remove=button('移除',()=>void placeAction('remove',item.path));open.setAttribute('aria-label','打开收藏 '+item.path);remove.setAttribute('aria-label','移除收藏 '+item.path);remove.title='只移除本机收藏，不删除目录';open.disabled=placesBusy||browsing||creating;remove.disabled=placesBusy;row.append(info,open,remove);placesList.append(row);
    }
  }
  async function placeAction(op:'list'|'add'|'remove'|'open',target?:string):Promise<void> {
    if(disposed||placesBusy||!queue.places||op==='open'&&(browsing||creating))return;const at=request;placesBusy=true;placesMessage.textContent=op==='open'?'正在核对设备身份…':op==='add'?'正在核对并保存收藏…':'';updateSelection();
    try{
      const value=await queue.places(op,target?{path:target,...(op==='add'?{label:(target.replace(/\/$/,'').split('/').at(-1)||target).slice(0,80)}:{})}:undefined);if(disposed)return;
      if(op==='open'){
        if(typeof value.path!=='string')throw Error('收藏目录返回格式无效。');if(request!==at||creating){placesMessage.textContent='当前操作位置已变化，未打开该收藏。';return;}
        placesMessage.textContent='';await refresh(value.path);
      }else{applyPlaces(value);placesMessage.textContent=op==='add'?'已收藏：'+target:op==='remove'?'已移除收藏，目录保留。':'收藏保存在本机；点击打开时核对设备身份。';}
    }catch(error){if(!disposed){placesMessage.textContent=(error as Error).message;placesBox.open=true;}}
    finally{placesBusy=false;if(!disposed)updateSelection();}
  }
  placesBox.ontoggle=()=>{if(placesBox.open&&!placesBusy)void placeAction('list');};
  const location=():Location=>({path,query:fileSearch.value,order:fileOrder.value,scroll:list.scrollTop,outerScroll:get('file-browser-view').scrollTop});
  folderForm.onsubmit=event=>{event.preventDefault();if(disposed||browsing||creating)return;let target:string;try{if(!writable())throw Error('此授权仅允许读取文件。');if(folderBase!==path)throw Error('目录已变化，请重新打开新建窗口。');target=folderTarget(folderBase,folderName.value,options.posix);}catch(error){folderMessage.textContent=(error as Error).message;return;}
    void (async()=>{creating=true;updateSelection();folderMessage.textContent='正在创建 '+target+'…';
      try{const reply=await options.operations.mkdir(target);if(disposed)return;folderForm.hidden=true;folderName.value='';fileSearch.value='';folderResult.textContent=(reply.created?'已创建文件夹：':'文件夹已存在，未改动：')+reply.path;folderResult.hidden=false;creating=false;await refresh(folderBase);if(!disposed)newFolder.focus();}
      catch(error){if(!disposed)folderMessage.textContent='未确认创建结果：'+(error as Error).message+' 可刷新目录核对后再试。';}
      finally{creating=false;if(!disposed){updateSelection();if(options.closeBrowseAfterUse&&!browsing)options.operations.close();}}
    })();
  };
  const copyStatus=document.createElement('p');copyStatus.className='transfer-hint';copyStatus.setAttribute('role','status');copyStatus.hidden=true;get('transfer-list').before(copyStatus);
  const tell=(text:string)=>{note.textContent=text;};
  const fail=(error:unknown)=>{get('file-feedback').textContent=error instanceof Error?error.message:String(error);get('file-feedback').hidden=false;};
  const run=(action:()=>void|Promise<void>)=>{if(disposed)return;get('file-feedback').hidden=true;copyStatus.hidden=true;try{Promise.resolve(action()).catch(fail);}catch(error){fail(error);}};
  const runWrite=(action:()=>void|Promise<void>)=>run(()=>{if(!writable())throw Error('此授权仅允许读取文件，上传不可用。');return action();});
  const join=(name:string)=>computer()?name+'/':path.replace(/\/$/,'')+'/'+name;
  const save=(file:{blob:Blob;name:string})=>{const url=URL.createObjectURL(file.blob),anchor=document.createElement('a');anchor.href=url;anchor.download=file.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),60_000);};
  const changed=()=>{
    if(disposed)return;
    options.changed?.(queue.items);
    const newest=queue.items.at(-1)?.id||0;if(newest>lastTask){lastTask=newest;setMode('transfers');}
    if(renderTimer===undefined)renderTimer=window.setTimeout(()=>{renderTimer=undefined;renderTransfers();},50);
    const complete=queue.items.filter(item=>item.status==='done').length;
    if(!queue.items.some(item=>item.status==='queued'||item.status==='running'||item.status==='committing')&&complete!==idleCompleted){idleCompleted=complete;if(!panel.hidden&&mode==='files'&&!browsing&&!creating&&folderForm.hidden&&!computer())void refresh();}
  };
  const queue:TransferCollection=options.queue?options.queue(changed):new TransferQueue(()=>new Operations(options.token),save,changed,options.permit);
  if(queue.places){remember.hidden=placesBox.hidden=false;void placeAction('list');}
  if(queue.native)for(const node of panel.querySelectorAll('.transfer-hint'))node.textContent='保存到本机磁盘，校验通过后才完成。可暂停、继续；重开后需确认原文件或保存位置。单文件上限 1 TiB，文件夹保留目录结构。';
  function setMode(next:'files'|'transfers'):void {
    mode=next;get('file-browser-view').hidden=next!=='files';get('transfer-box').hidden=next!=='transfers';
    get('file-browse-tab').setAttribute('aria-selected',String(next==='files'));get('file-transfers-tab').setAttribute('aria-selected',String(next==='transfers'));
    if(next==='transfers')renderTransfers();
  }
  for(const [id,value] of [['file-browse-tab','files'],['file-transfers-tab','transfers']] as const){
    get(id).onclick=()=>{setMode(value);if(value==='files'&&!browsing&&!creating)void refresh();};get(id).onkeydown=event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const next=value==='files'?'transfers':'files';setMode(next);if(next==='files'&&!browsing&&!creating)void refresh();get(next==='files'?'file-browse-tab':'file-transfers-tab').focus();}};
  }
  function updateSelection():void {
    const busy=browsing||creating;get<HTMLButtonElement>('upload').disabled=get<HTMLButtonElement>('upload-folder').disabled=newFolder.disabled=busy||computer()||!writable();refreshButton.disabled=busy;get<HTMLButtonElement>('parent-folder').disabled=busy||path==='/';back.disabled=busy||historyIndex<=0;forward.disabled=busy||historyIndex>=history.length-1;
    back.title=history[historyIndex-1]?.path||'没有上个目录';forward.title=history[historyIndex+1]?.path||'没有下个目录';get('path-form').inert=get('file-location').inert=creating;list.inert=busy;folderName.disabled=createFolder.disabled=busy;cancelFolder.disabled=creating;
    const saved=placeItems.some(item=>item.path===path);remember.textContent=saved?'已收藏':'收藏目录';remember.disabled=busy||placesBusy||!placesLoaded||computer()||saved;for(const node of placesList.querySelectorAll<HTMLButtonElement>('button'))node.disabled=placesBusy||node.textContent==='打开'&&busy;
    get<HTMLButtonElement>('download-selected').disabled=busy||!selected.size;
    get('download-count').textContent=selected.size?'（'+selected.size+'）':'';
    const count=visibleEntries.filter(entry=>selected.has(join(entry.name))).length,all=get<HTMLInputElement>('select-all-files');all.disabled=busy||computer()||!visibleEntries.length;all.checked=!computer()&&visibleEntries.length>0&&count===visibleEntries.length;all.indeterminate=count>0&&count<visibleEntries.length;
    selectionInfo.hidden=!selected.size;selectionText.textContent='已选 '+selected.size+' 项'+(selected.size>count?'（'+(selected.size-count)+' 项被筛选隐藏）':'');clearSelection.disabled=busy;
  }
  function breadcrumbs():void {
    const target=get('file-location');target.replaceChildren(button(options.posix?'根目录':'此电脑',()=>void refresh('/')));
    if(path==='/')return;
    const parts=path.replace(/\/$/,'').split('/');
    parts.forEach((part,index)=>{if(!part)return;const divider=document.createElement('span');divider.textContent='›';target.append(divider,button(part,()=>void refresh(parts.slice(0,index+1).join('/')+(index===0?'/':''))));});
  }
  async function refresh(next=path,historyTarget?:number):Promise<void> {
    if(disposed||creating)return;
    if(historyIndex>=0)history[historyIndex]=location();
    if(!options.available()){updateSelection();fail(options.unavailable?.()||'请先接通这台电脑的 SSH 连接，再使用文件互传。');return;}
    const current=++request;browsing=true;list.setAttribute('aria-busy','true');list.inert=true;updateSelection();tell('正在读取目录…');get('file-feedback').hidden=true;
    try{
      const reply=await options.operations.list(next);if(disposed||current!==request)return;
      const restore=historyTarget===undefined?(path===reply.path?history[historyIndex]:undefined):history[historyTarget];if(historyTarget!==undefined&&restore?.path!==reply.path)throw Error('目录位置已变化，请重新打开该路径。');
      if(path!==reply.path){selected.clear();fileSearch.value=restore?.query||'';if(restore)fileOrder.value=restore.order;folderForm.hidden=folderResult.hidden=true;folderName.value='';}else for(const [remote,old] of selected){const current=reply.entries.find(entry=>join(entry.name)===remote);if(!current||current.directory!==old.directory)selected.delete(remote);else selected.set(remote,current);}
      const changed=path!==reply.path;
      path=reply.path;entries=reply.entries;truncated=reply.truncated;browsing=false;get<HTMLInputElement>('file-path').value=path;breadcrumbs();renderFiles();
      if(historyTarget!==undefined)historyIndex=historyTarget;else if(changed||historyIndex<0){history.splice(historyIndex+1);history.push(location());if(history.length>64)history.shift();historyIndex=history.length-1;}
      list.scrollTop=restore?.scroll||0;get('file-browser-view').scrollTop=restore?.outerScroll||0;history[historyIndex]=location();
    }catch(error){if(!disposed&&current===request){get<HTMLInputElement>('file-path').value=path;fail(error instanceof Error?error.message:'目录读取失败。');tell('读取失败，仍显示上次成功的目录：'+path);}}
    finally{if(current===request){browsing=false;list.inert=false;list.setAttribute('aria-busy','false');updateSelection();if(options.closeBrowseAfterUse)options.operations.close();}}
  }
  function renderFiles():void {
      visibleEntries=browseEntries(entries,fileSearch.value,fileOrder.value);list.replaceChildren();
      for(const entry of visibleEntries){
        const remote=join(entry.name),row=document.createElement('div');row.className='file-row';
        if(!computer()){
          const check=document.createElement('input');check.type='checkbox';check.setAttribute('aria-label','选择 '+entry.name);
          check.checked=selected.has(remote);check.onchange=()=>{if(check.checked)selected.set(remote,entry);else selected.delete(remote);updateSelection();};row.append(check);
        }
        const open=button('',()=>{if(entry.directory)void refresh(remote);});open.className='file-open';open.title=entry.name+'\n'+remote+'\n修改时间：'+modified(entry.modified);
        const icon=document.createElement('img');icon.src='/ui-icons/'+(entry.directory?'folder':'file')+'.svg';icon.alt='';const name=document.createElement('span');name.textContent=entry.name;open.append(icon,name);row.append(open);
        if(!computer()){const meta=document.createElement('div');meta.className='file-entry-meta';const bytes=document.createElement('small'),date=document.createElement('small');bytes.textContent=entry.directory?'文件夹':size(entry.size);date.className='file-modified';date.textContent=modified(entry.modified);meta.append(bytes,date);row.append(meta);}
        if(!computer()){
          const download=button('',()=>run(()=>queue.addDownloads([{path:remote,name:entry.name,directory:entry.directory,size:entry.size}])));download.className='file-download';download.title=entry.directory?(queue.native?'下载文件夹':'下载文件夹（ZIP）'):'下载到本机';download.setAttribute('aria-label',download.title+' · '+entry.name);
          const image=document.createElement('img');image.src='/ui-icons/download-simple.svg';image.alt='';download.append(image);row.append(download);
        }
        list.append(row);
      }
      updateSelection();tell((browsing?'正在读取目录…':fileSearch.value.trim()?visibleEntries.length+' / '+entries.length+' 项匹配，仅筛选当前已读取的目录':computer()?'先打开一个磁盘或文件夹，再上传或选择下载。':entries.length?entries.length+' 项':'此文件夹为空，可选择文件或拖入上传。')+(truncated?' · 目录较大，仅载入前 2000 项；未搜索未载入的文件。':''));
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
        const copy=button('复制诊断',()=>run(async()=>{await queue.copyDiagnostic?.(task.id);copyStatus.textContent='诊断已复制，可粘贴给维护者。';copyStatus.hidden=false;}));
        actions.append(pause,cancel,retry,rename,renameButton,copy);root.append(name,detail,bar,expanded,actions);view={root,name,detail,bar,cancel,retry,rename,renameButton,pause,copy,description};rows.set(task.id,view);
      }
      view.name.textContent=(task.kind==='download'?'↓ ':'↑ ')+task.name;view.name.title=task.name;view.root.dataset.state=task.status;
      const active=task.status==='running'||task.status==='committing',rate=active&&task.phase==='receiving'?task.bytes/Math.max(.1,(Date.now()-task.started)/1000):0;
      const remaining=rate>0&&task.size>task.bytes?Math.ceil((task.size-task.bytes)/rate):0;
      view.detail.textContent=active?(task.phase==='copying'?'正在兼容保存（完成前请勿打开目标文件） · '+size(task.copyBytes||0)+' / '+size(task.size):task.phase==='saving'?'正在校验并保存到目标磁盘':task.phase==='waiting'?'等待前面的文件传输':task.phase==='verifying'?'正在核对文件内容与已传部分'+(task.verifyTotal?' · '+size(task.verifyBytes||0)+' / '+size(task.verifyTotal):''):task.phase==='preparing'?'正在打包文件夹 · 已读取 '+size(task.bytes):size(task.bytes)+' / '+size(task.size)+(rate?' · '+size(Math.round(rate))+'/s'+(remaining?' · 约 '+remaining+' 秒':''):'')):task.message||({queued:'排队中',paused:'已暂停',done:'完成',failed:'传输未完成',cancelled:'已取消'} as Record<string,string>)[task.status];
      view.bar.value=task.status==='done'?100:task.phase==='verifying'&&task.verifyTotal?100*(task.verifyBytes||0)/task.verifyTotal:task.phase==='copying'&&task.size>0?100*(task.copyBytes||0)/task.size:task.size>0&&task.phase!=='preparing'?100*task.bytes/task.size:0;
      view.bar.setAttribute('aria-label',task.name+(task.phase==='verifying'?' 的校验进度':' 的传输进度'));view.description.textContent=(task.source?'来源：'+task.source+'\n':'')+(task.target?'目标：'+task.target+'\n':'')+(task.createdAt?'创建时间：'+new Date(task.createdAt).toLocaleString()+'\n':'')+(task.code?'状态代码：'+task.code+'\n':'')+(task.sha256?'SHA-256：'+task.sha256:'')+(!queue.native?'远端路径：'+task.path:'');
      if(active&&task.phase==='verifying'&&!task.verifyTotal&&transferStageMessage(task.stage))view.detail.textContent=transferStageMessage(task.stage);
      view.copy.hidden=!queue.copyDiagnostic||!task.diagnostic;view.copy.setAttribute('aria-label','复制诊断 · '+task.name);
      if(task.diagnostic)view.description.textContent+='\n上次失败阶段：'+(transferStageMessage(task.diagnostic.stage)||task.diagnostic.stage)+'\n上次错误：'+(task.diagnostic.code||'未知')+(task.diagnostic.at?'\n发生时间：'+new Date(task.diagnostic.at).toLocaleString():'');
      view.pause.hidden=!queue.pause||!['queued','running','committing'].includes(task.status);view.pause.setAttribute('aria-label','暂停 · '+task.name);view.cancel.hidden=!task.cleanupPending&&!['queued','running','committing','paused','failed'].includes(task.status);view.cancel.textContent=task.cleanupPending?'清理临时文件':task.status==='failed'?'跳过':'取消';
      view.cancel.setAttribute('aria-label',view.cancel.textContent+' · '+task.name);view.retry.setAttribute('aria-label',(queue.native?'继续':'重试')+' · '+task.name);view.renameButton.setAttribute('aria-label','改名重试 · '+task.name);view.rename.setAttribute('aria-label','重试文件名 · '+task.name);
      view.retry.hidden=!['failed','cancelled','paused'].includes(task.status);view.retry.disabled=view.renameButton.disabled=task.kind==='upload'&&!writable();view.retry.textContent=queue.native?'继续':'重试';const conflict=task.kind==='upload'&&task.status==='failed'&&task.message.includes('同名');view.rename.hidden=view.renameButton.hidden=!conflict;
      const container=get('transfer-list');if(container.children[position]!==view.root)container.insertBefore(view.root,container.children[position]||null);position++;
    }
  }
  const enqueueInput=(id:string)=>{const input=get<HTMLInputElement>(id);input.onchange=()=>{const files=[...input.files||[]];input.value='';runWrite(()=>queue.addUploads(selectedUploads(files),path));};};
  enqueueInput('upload-input');enqueueInput('folder-input');
  get('upload').onclick=()=>runWrite(()=>queue.chooseUploads?queue.chooseUploads(path,false):get<HTMLInputElement>('upload-input').click());get('upload-folder').onclick=()=>runWrite(()=>queue.chooseUploads?queue.chooseUploads(path,true):get<HTMLInputElement>('folder-input').click());
  get<HTMLFormElement>('path-form').onsubmit=event=>{event.preventDefault();void refresh(get<HTMLInputElement>('file-path').value);};
  get('parent-folder').onclick=()=>{if(path==='/')return;const parts=path.replace(/\/$/,'').split('/');parts.pop();void refresh(parts.length?parts.join('/')+'/':'/');};
  get<HTMLInputElement>('select-all-files').onchange=event=>{const checked=(event.target as HTMLInputElement).checked;for(const entry of visibleEntries)if(checked)selected.set(join(entry.name),entry);else selected.delete(join(entry.name));for(const check of list.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))check.checked=checked;updateSelection();};
  get('download-selected').onclick=()=>run(()=>queue.addDownloads([...selected].map(([remote,entry])=>({path:remote,name:entry.name,directory:entry.directory,size:entry.size}))));
  get('cancel-transfers').onclick=()=>run(()=>queue.cancelAll());get('clear-transfers').onclick=()=>run(()=>queue.clearFinished());
  const open=()=>{if(disposed)return;panel.hidden=false;options.releaseInputs();setMode(mode);get('remote-files-label').textContent='本机 '+(options.available()&&!writable()?'← ':'↔ ')+(get('session-label').textContent||'此设备')+(options.available()&&!writable()?'（文件只读）':'');void refresh();};
  get('files').onclick=open;get('close-files').onclick=()=>{panel.hidden=true;};
  const dragOver=(event:DragEvent)=>{if([...event.dataTransfer?.types||[]].includes('Files')){event.preventDefault();panel.classList.add('drop-active');}};
  const drop=async(event:DragEvent)=>{
    if(disposed)return;
    if(!event.dataTransfer||![...event.dataTransfer.types].includes('Files'))return;event.preventDefault();panel.classList.remove('drop-active');panel.hidden=false;options.releaseInputs();
    if(!options.available()||computer()){fail('请先打开目标磁盘和文件夹，再拖入文件。');return;}
    if(!writable()){fail('此授权仅允许读取文件，拖入上传不可用。');return;}
    const targetPath=path,controller=new AbortController();pendingDrops.add(controller);
    try{get('file-feedback').hidden=true;const entries=await droppedUploads(event.dataTransfer,controller.signal,options.posix);if(!disposed&&!controller.signal.aborted){if(!writable())throw Error('文件权限已变化，未开始上传。');await queue.addUploads(entries,targetPath);}}catch(error){if(!disposed)fail(error instanceof Error?error.message:'无法读取拖入的文件。');}finally{pendingDrops.delete(controller);}
  };
  window.addEventListener('dragover',dragOver);window.addEventListener('drop',drop);
  panel.ondragleave=event=>{if(!panel.contains(event.relatedTarget as Node))panel.classList.remove('drop-active');};
  const dispose=()=>{disposed=true;request++;for(const pending of pendingDrops)pending.abort();pendingDrops.clear();if(queue.native)queue.dispose?.();else queue.cancelAll();if(options.closeBrowseAfterUse)options.operations.close();clearTimeout(renderTimer);window.removeEventListener('dragover',dragOver);window.removeEventListener('drop',drop);};
  window.addEventListener('pagehide',dispose,{once:true});
  return {open,dispose,transfers(){if(disposed)return;panel.hidden=false;options.releaseInputs();setMode('transfers');},cancelAll:()=>queue.cancelAll()};
}
