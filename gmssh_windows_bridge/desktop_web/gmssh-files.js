/* One manager-owned workspace; hiding a desktop never detaches file iframes. */
window.installGMSSHFileCenter=function({viewerUrl,devices=[]}){
  if(window.gmsshFilesController){window.gmsshFilesController.update(devices);return window.gmsshFilesController;}
  const base=new URL(viewerUrl),make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};
  if(base.protocol!=='http:'||!['127.0.0.1','localhost'].includes(base.hostname))throw Error('Local file assets required');
  const icon=name=>{const n=make('img','gm-ui-icon');n.src=new URL('ui-icons/'+name+'.svg',base).href;n.alt='';return n;};
  const button=(text,run,name)=>{const n=make('button','gm-ui-button',text);n.type='button';n.onclick=run;if(name)n.prepend(icon(name));return n;};
  const root=make('section','gm-files-center');root.hidden=true;root.id='gmssh-file-center';root.setAttribute('aria-label','文件中心');root.setAttribute('role','tabpanel');
  const title=make('h2','','文件中心'),selector=make('select');selector.setAttribute('aria-label','文件设备');
  const browse=button('设备文件',()=>show('files'),'folder'),transfers=button('全部任务',()=>show('tasks'),'arrows-left-right'),hideButton=button('收起',hide,'x');
  browse.setAttribute('aria-pressed','true');transfers.setAttribute('aria-pressed','false');
  const head=make('header','gm-files-header');head.append(title,selector,browse,transfers,hideButton);
  const content=make('div','gm-files-content'),frames=make('div','gm-files-frames'),tasksPane=make('div','gm-files-tasks');tasksPane.hidden=true;
  const note=make('p','gm-files-note');note.setAttribute('role','status');const nativePane=make('div','gm-files-native');nativePane.hidden=true;
  content.append(frames,tasksPane,nativePane);root.append(head,note,content);document.body.append(root);
  const tab=button('文件中心',()=>open(),'arrows-left-right');tab.classList.add('gm-files-tab');tab.setAttribute('role','tab');tab.setAttribute('aria-controls',root.id);tab.setAttribute('aria-selected','false');
  const tabSlot=make('div','gm-files-tabs');tabSlot.setAttribute('role','tablist');tabSlot.setAttribute('aria-label','文件中心入口');tabSlot.append(tab);
  const badge=make('span','gm-files-badge');badge.hidden=true;tab.append(badge);
  const records=new Map(),leaseQueue=[];let holder,selected,mode='files',disposed=false,reported='',activityUpdate=Promise.resolve({status:'ok'});
  const leaseMessage=(record,type,requestId)=>record.frame?.contentWindow?.postMessage({type,requestId},new URL(record.device.viewerUrl).origin);
  function pumpLeases(){while(!holder&&leaseQueue.length){const next=leaseQueue.shift();if(next.record.pending||next.record.removed){leaseMessage(next.record,'gmssh-file-lease-error',next.requestId);continue;}holder=next;report().then(reply=>{if(holder!==next||disposed)return;if(reply?.status==='ok')leaseMessage(next.record,'gmssh-file-lease',next.requestId);else{next.record.frame?.contentWindow?.postMessage({type:'gmssh-file-lease-error',requestId:next.requestId,code:'FILE_CENTER_UNAVAILABLE'},new URL(next.record.device.viewerUrl).origin);releaseLease(next.record,next.requestId);}});}}
  function releaseLease(record,requestId){for(let i=leaseQueue.length-1;i>=0;i--)if(leaseQueue[i].record===record&&(requestId===undefined||leaseQueue[i].requestId===requestId))leaseQueue.splice(i,1);if(holder?.record===record&&(requestId===undefined||holder.requestId===requestId))holder=undefined;pumpLeases();report();}
  function mount(){const header=document.querySelector('.tabs-container');if(header&&!header.contains(tabSlot))header.append(tabSlot);if(!root.hidden)root.style.top=Math.max(40,header?.getBoundingClientRect().bottom||48)+'px';}
  const observer=new MutationObserver(mount);observer.observe(document.body,{childList:true,subtree:true});window.addEventListener('resize',mount);mount();
  const stateEmpty=()=>({active:0,failed:0,total:0,tasks:[]});
  const counts=()=>{const sum=[...records.values()].reduce((sum,r)=>({active:sum.active+r.state.active,failed:sum.failed+r.state.failed,total:sum.total+r.state.total}),{active:0,failed:0,total:0});sum.active=Math.max(sum.active,leaseQueue.length+(holder?1:0));return sum;};
  function report(){
    const summary=counts(),key=summary.active+':'+summary.failed;
    badge.hidden=!summary.active&&!summary.failed;badge.textContent=summary.active?String(summary.active):'!';badge.dataset.error=String(summary.failed>0);
    transfers.lastChild.textContent='全部任务'+(summary.active?'（'+summary.active+'）':summary.failed?'（待处理 '+summary.failed+'）':'');
    tab.setAttribute('aria-label',summary.active?'文件中心，'+summary.active+' 项待完成':'文件中心');
    if(key!==reported){reported=key;activityUpdate=Promise.resolve(window.electronAPI?.invoke('render-to-main',{type:'gmssh-files-state',data:{active:summary.active,failed:summary.failed}})||{status:'ok'}).catch(()=>({status:'error'}));}
    return activityUpdate;
  }
  function publicDevices(){
    const native=window.gmsshHomeController?.filesDevices?.()||[],list=[];
    for(const [id,record] of records){const node=native.find(n=>n.id===id);list.push({id,name:node?.name||record.device.label||record.device.target||'设备',windows:true,removed:record.removed});}
    for(const node of native)if(!node.windows&&!list.some(item=>item.id===node.id))list.push(node);
    return list;
  }
  function refreshSelector(){
    const list=publicDevices();selector.replaceChildren();
    for(const item of list){const option=make('option','',item.name+(item.removed?'（配置已移除）':''));option.value=item.id;selector.append(option);}
    if(!list.some(item=>item.id===selected))selected=list[0]?.id;
    if(selected)selector.value=selected;selector.disabled=!list.length;
  }
  const send=(record,tool)=>record.frame?.contentWindow?.postMessage({type:'gmssh-file-tool',tool},new URL(record.device.viewerUrl).origin);
  function access(record){if(!record.frame)return;record.frame.contentWindow?.postMessage({type:'gmssh-file-access',token:record.device.accessToken,label:publicDevices().find(n=>n.id===record.device.machineId)?.name||record.device.label||record.device.target},new URL(record.device.viewerUrl).origin);}
  function frameFor(record){
    if(record.frame)return record.frame;
    const frame=make('iframe');frame.src=new URL('files.html',record.device.viewerUrl).href;frame.title=(record.device.label||record.device.target||'设备')+' · 文件互传';frame.referrerPolicy='no-referrer';record.frame=frame;record.loaded=false;frame.onload=()=>{if(record.loaded){releaseLease(record);if(record.state.active){record.state={...record.state,active:0,failed:record.state.failed+record.state.active,tasks:record.state.tasks.map(t=>['running','queued'].includes(t.status)?{...t,status:'failed',message:'文件页已重新载入，请重新选择未完成的文件。'}:t)};report();}}record.loaded=true;access(record);};frames.append(frame);return frame;
  }
  function show(next){
    mode=next;browse.setAttribute('aria-pressed',String(next==='files'));transfers.setAttribute('aria-pressed',String(next==='tasks'));tasksPane.hidden=next!=='tasks';frames.hidden=next!=='files';nativePane.hidden=true;
    for(const [id,r] of records)if(r.frame)r.frame.hidden=id!==selected;
    if(next==='tasks'){note.textContent='Windows 文件任务独立于桌面标签；收起中心后继续传输。Linux 任务仍由原生文件工具管理。';renderTasks();return;}
    const record=records.get(selected);note.textContent='收起文件中心或关闭桌面标签不会取消传输。退出管理端会停止未完成任务。';
    if(record){
      if(record.pending||record.removed){nativePane.hidden=false;frames.hidden=true;nativePane.replaceChildren(make('h3','','设备配置已变化'),make('p','gm-muted',record.state.active?'原通道的任务仍在处理，结束后可重新打开文件通道。不会把任务自动转给其他设备。':'原任务记录已保留；更新通道后需重新选择失败的文件。'));
        if(!record.state.active&&!record.removed)nativePane.append(button('更新文件通道',()=>{record.frame?.remove();record.frame=undefined;record.device=record.pending;record.pending=undefined;record.state=stateEmpty();report();show('files');}));
      }else frameFor(record).hidden=false;
      return;
    }
    frames.hidden=true;nativePane.hidden=false;nativePane.replaceChildren(make('h3','','使用原生文件工具'),make('p','gm-muted',selected?'此 Linux 设备继续使用 GMSSH 原生文件管理；其任务不计入本中心的 Windows 队列。':'请先添加一台设备，再打开文件中心。'));
    if(selected)nativePane.append(button('打开文件互传',()=>{hide();window.gmsshHomeController?.openNativeFiles?.(selected);},'arrows-left-right'));
  }
  function renderTasks(){
    tasksPane.replaceChildren();const all=[...records.values()].flatMap(r=>r.state.tasks.map(task=>({record:r,task}))),summary=counts();
    const heading=make('div','gm-files-task-head');heading.append(make('strong','',summary.active?summary.active+' 项待完成':summary.failed?summary.failed+' 项待处理':'传输任务'),button('取消全部待完成',cancelAll));tasksPane.append(heading);
    if(!all.length){tasksPane.append(make('p','gm-muted','还没有传输任务。选择设备上传或下载后，任务会出现在这里。'));return;}
    const rank={running:0,failed:1,queued:2,cancelled:3,done:4};all.sort((a,b)=>rank[a.task.status]-rank[b.task.status]);
    for(const {record,task} of all.slice(0,200)){const row=make('article','gm-files-task'),name=make('strong','',task.name),device=publicDevices().find(d=>d.id===record.device.machineId)?.name||record.device.target;
      const labels={queued:'排队中',running:'传输中',done:'完成',failed:'未完成',cancelled:'已取消'};const detail=make('p','gm-muted',device+' · '+labels[task.status]+' · '+(task.message||Math.round(task.bytes/1048576)+' / '+Math.round(task.size/1048576)+' MiB'));row.dataset.state=task.status;
      const progress=make('progress');progress.max=100;progress.value=task.status==='done'?100:task.size>0?100*task.bytes/task.size:0;
      const locate=button('查看任务',()=>{selected=record.device.machineId;selector.value=selected;show('files');send(record,'transfers');});locate.setAttribute('aria-label','查看 '+device+' 的任务 '+task.name);locate.disabled=!!record.pending||record.removed;if(locate.disabled)locate.title='原连接配置已变化，请先核对文件通道。';row.append(name,detail,progress,locate);tasksPane.append(row);
    }
    if(summary.total>all.length)tasksPane.append(make('p','gm-muted','每台设备在总览中保留最多 100 项摘要，完整任务及重试请进入该设备。'));
  }
  function hide(){root.hidden=true;tab.classList.remove('active');tab.setAttribute('aria-selected','false');document.documentElement.removeAttribute('data-gmssh-files-active');}
  function open(id){if(disposed)return;for(const c of window.gmsshWindowsControllers?.values()||[])c.hide();document.documentElement.removeAttribute('data-windows-desktop-active');refreshSelector();if(id&&publicDevices().some(n=>n.id===id))selected=id;if(selected)selector.value=selected;root.hidden=false;tab.classList.add('active');tab.setAttribute('aria-selected','true');document.documentElement.setAttribute('data-gmssh-files-active','');mount();show('files');}
  selector.onchange=()=>{selected=selector.value;show('files');};
  function cancelAll(){for(const r of records.values())if(r.state.active)send(r,'cancel-all');}
  function update(values){
    if(!Array.isArray(values)||values.length>200)throw Error('Invalid file devices');
    const ids=new Set();
    for(const device of values){
      const url=new URL(device.viewerUrl);
      if(!/^[a-f0-9]{32}$/i.test(device.machineId)||ids.has(device.machineId)||url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.hash||url.search||typeof device.accessToken!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(device.accessToken))throw Error('Verified file device required');
      ids.add(device.machineId);const record=records.get(device.machineId);
      if(record){record.removed=false;if(record.frame&&record.device.viewerUrl!==device.viewerUrl)record.pending={...device};else{record.device={...device};record.pending=undefined;access(record);}}
      else records.set(device.machineId,{device:{...device},state:stateEmpty()});
    }
    for(const [id,record] of records)if(!ids.has(id)){if(record.frame||record.state.total)record.removed=true;else records.delete(id);}
    refreshSelector();if(!root.hidden)show(mode);report();
  }
  function receive(event){
    const record=[...records.values()].find(r=>r.frame?.contentWindow===event.source);
    if(record&&event.origin===new URL(record.device.viewerUrl).origin){
      if(event.data?.type==='gmssh-file-ready'){access(record);return;}
      if(event.data?.type==='gmssh-file-hide'){hide();return;}
      if(['gmssh-file-lease-request','gmssh-file-lease-release'].includes(event.data?.type)){
        const requestId=event.data.requestId;if(!Number.isSafeInteger(requestId)||requestId<1)return;
        if(event.data.type==='gmssh-file-lease-release'){releaseLease(record,requestId);return;}
        if(holder?.record===record||leaseQueue.some(value=>value.record===record))return;
        leaseQueue.push({record,requestId});pumpLeases();return;
      }
      if(event.data?.type!=='gmssh-file-state')return;const data=event.data;
      if(!['active','failed','total'].every(key=>Number.isInteger(data[key])&&data[key]>=0&&data[key]<=2000)||data.active+data.failed>data.total||!Array.isArray(data.tasks)||data.tasks.length>100)return;
      if(data.tasks.some(t=>!Number.isSafeInteger(t.id)||t.id<1||typeof t.name!=='string'||t.name.length>255||!['upload','download','directory'].includes(t.kind)||!['queued','running','done','failed','cancelled'].includes(t.status)||!Number.isSafeInteger(t.bytes)||t.bytes<0||!Number.isSafeInteger(t.size)||t.size<0||typeof t.message!=='string'||t.message.length>512))return;
      record.state={active:data.active,failed:data.failed,total:data.total,tasks:data.tasks.map(t=>({id:t.id,name:t.name,kind:t.kind,status:t.status,bytes:t.bytes,size:t.size,message:t.message}))};report();if(!root.hidden&&mode==='tasks')renderTasks();return;
    }
    if(event.data?.type!=='gmssh-open-file-center'||typeof event.data.requestId!=='string'||event.data.requestId.length>80)return;
    for(const [id,r] of records){const frame=window.gmsshWindowsControllers?.get(id)?.frame?.();if(frame?.contentWindow===event.source&&event.origin===new URL(r.device.viewerUrl).origin){open(id);event.source.postMessage({type:'gmssh-file-center-opened',requestId:event.data.requestId},event.origin);break;}}
  }
  function click(event){if(event.target instanceof Element&&event.target.closest('.tabs-container')&&!event.target.closest('.gm-files-tab'))hide();}
  window.addEventListener('message',receive);document.addEventListener('click',click,true);
  const controller={open,hide,update,cancelAll,pending:()=>counts().active,remove(){disposed=true;cancelAll();observer.disconnect();window.removeEventListener('resize',mount);window.removeEventListener('message',receive);document.removeEventListener('click',click,true);root.remove();tabSlot.remove();records.clear();leaseQueue.length=0;holder=undefined;document.documentElement.removeAttribute('data-gmssh-files-active');delete window.gmsshFilesController;void window.electronAPI?.invoke('render-to-main',{type:'gmssh-files-state',data:{active:0,failed:0}}).catch(()=>{});}};
  window.gmsshFilesController=controller;update(devices);return controller;
};
