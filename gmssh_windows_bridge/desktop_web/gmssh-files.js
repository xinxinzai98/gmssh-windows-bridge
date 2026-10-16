/* One manager-owned workspace; hiding a desktop never detaches file iframes. */
window.installGMSSHFileCenter=function({viewerUrl,devices=[]}){
  if(window.gmsshFilesController){window.gmsshFilesController.update(devices);return window.gmsshFilesController;}
  const base=new URL(viewerUrl),make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};
  if(base.protocol!=='http:'||!['127.0.0.1','localhost'].includes(base.hostname))throw Error('Local file assets required');
  const bytes=value=>value>=1024**3?(value/1024**3).toFixed(1)+' GiB':value>=1024**2?(value/1024**2).toFixed(1)+' MiB':value>=1024?(value/1024).toFixed(1)+' KiB':value+' B';
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
  const records=new Map(),leaseQueue=[];let holder,selected,mode='files',disposed=false,reported='',activityUpdate=Promise.resolve({status:'ok'}),nativeTasks=[],nativeProtocol=false,nativePoll,nativePolling=false;
  const nativeInvoke=(action,machineId=null,data={})=>Promise.resolve(window.electronAPI?.invoke('render-to-main',{type:'gmssh-transfer',data:{action,machineId,data}})).then(value=>value||{status:'error',code:'UNSUPPORTED'}).catch(()=>({status:'error',code:'UNSUPPORTED'}));
  const nativeReady=nativeInvoke('hello').then(async reply=>{if(disposed)return reply;if(reply.status==='ok'&&reply.data?.protocol===2){nativeProtocol=true;controller.native=true;await pollNative();nativePoll=setInterval(pollNative,700);}return reply;});
  async function pollNative(){if(!nativeProtocol||disposed||nativePolling)return;nativePolling=true;try{const reply=await nativeInvoke('list');if(disposed)return;if(reply.status==='ok'&&Array.isArray(reply.data?.jobs)){nativeTasks=reply.data.jobs;report();if(!root.hidden&&mode==='tasks')renderTasks();}}finally{nativePolling=false;}}
  const leaseMessage=(record,type,requestId)=>record.frame?.contentWindow?.postMessage({type,requestId},new URL(record.device.viewerUrl).origin);
  function pumpLeases(){while(!holder&&leaseQueue.length){const next=leaseQueue.shift();if(next.record.pending||next.record.removed){leaseMessage(next.record,'gmssh-file-lease-error',next.requestId);continue;}holder=next;report().then(reply=>{if(holder!==next||disposed)return;if(reply?.status==='ok')leaseMessage(next.record,'gmssh-file-lease',next.requestId);else{next.record.frame?.contentWindow?.postMessage({type:'gmssh-file-lease-error',requestId:next.requestId,code:'FILE_CENTER_UNAVAILABLE'},new URL(next.record.device.viewerUrl).origin);releaseLease(next.record,next.requestId);}});}}
  function releaseLease(record,requestId){for(let i=leaseQueue.length-1;i>=0;i--)if(leaseQueue[i].record===record&&(requestId===undefined||leaseQueue[i].requestId===requestId))leaseQueue.splice(i,1);if(holder?.record===record&&(requestId===undefined||holder.requestId===requestId))holder=undefined;pumpLeases();report();}
  function mount(){const header=document.querySelector('.tabs-container');if(header&&!header.contains(tabSlot))header.append(tabSlot);if(!root.hidden)root.style.top=Math.max(40,header?.getBoundingClientRect().bottom||48)+'px';}
  const observer=new MutationObserver(mount);observer.observe(document.body,{childList:true,subtree:true});window.addEventListener('resize',mount);mount();
  const stateEmpty=()=>({active:0,failed:0,total:0,tasks:[]});
  const counts=()=>{const sum=[...records.values()].reduce((sum,r)=>({active:sum.active+r.state.active,failed:sum.failed+r.state.failed,total:sum.total+r.state.total}),{active:0,failed:0,total:0});sum.active=Math.max(sum.active,leaseQueue.length+(holder?1:0));sum.active+=nativeTasks.filter(t=>['queued','running','committing'].includes(t.status)).length;sum.failed+=nativeTasks.filter(t=>['failed','paused'].includes(t.status)).length;sum.total+=nativeTasks.length;return sum;};
  function report(){
    const summary=counts(),key=summary.active+':'+summary.failed;
    badge.hidden=!summary.active&&!summary.failed;badge.textContent=summary.active?String(summary.active):'!';badge.dataset.error=String(summary.failed>0);
    transfers.lastChild.textContent='全部任务'+(summary.active?'（'+summary.active+'）':summary.failed?'（待处理 '+summary.failed+'）':'');
    tab.setAttribute('aria-label',summary.active?'文件中心，'+summary.active+' 项待完成':'文件中心');
    if(key!==reported){reported=key;activityUpdate=Promise.resolve(window.electronAPI?.invoke('render-to-main',{type:'gmssh-files-state',data:{active:Math.max(0,summary.active-nativeTasks.filter(t=>['queued','running','committing'].includes(t.status)).length),failed:summary.failed}})||{status:'ok'}).catch(()=>({status:'error'}));}
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
  const send=(record,tool)=>{if(!record)return;if(!record.frame||!record.loaded){record.pendingTool=tool;return;}record.frame.contentWindow?.postMessage({type:'gmssh-file-tool',tool},new URL(record.device.viewerUrl).origin);};
  function access(record){if(!record.frame)return;record.frame.contentWindow?.postMessage({type:'gmssh-file-access',token:record.device.accessToken,label:publicDevices().find(n=>n.id===record.device.machineId)?.name||record.device.label||record.device.target},new URL(record.device.viewerUrl).origin);if(record.pendingTool){const tool=record.pendingTool;delete record.pendingTool;record.frame.contentWindow?.postMessage({type:'gmssh-file-tool',tool},new URL(record.device.viewerUrl).origin);}}
  function frameFor(record){
    if(record.frame)return record.frame;
    const frame=make('iframe');frame.src=new URL('files.html',record.device.viewerUrl).href;frame.title=(record.device.label||record.device.target||'设备')+' · 文件互传';frame.referrerPolicy='no-referrer';record.frame=frame;record.loaded=false;frame.onload=()=>{if(record.loaded){releaseLease(record);if(record.state.active){record.state={...record.state,active:0,failed:record.state.failed+record.state.active,tasks:record.state.tasks.map(t=>['running','queued'].includes(t.status)?{...t,status:'failed',message:'文件页已重新载入，请重新选择未完成的文件。'}:t)};report();}}record.loaded=true;access(record);};frames.append(frame);return frame;
  }
  function show(next){
    mode=next;browse.setAttribute('aria-pressed',String(next==='files'));transfers.setAttribute('aria-pressed',String(next==='tasks'));tasksPane.hidden=next!=='tasks';frames.hidden=next!=='files';nativePane.hidden=true;
    for(const [id,r] of records)if(r.frame)r.frame.hidden=id!==selected;
    if(next==='tasks'){note.textContent='文件任务独立于桌面标签。已暂停任务可继续；重开后先确认本机文件权限。Linux 使用原生文件工具。';renderTasks();return;}
    const record=records.get(selected);note.textContent=nativeProtocol?'文件直接落盘，校验后保存。收起中心继续传输，退出时暂停并保存任务。':'收起文件中心或关闭桌面标签不会取消传输。浏览器兼容任务在退出后需重新选择文件。';
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
    tasksPane.replaceChildren();const all=[...nativeTasks.map(task=>({record:records.get(task.machineId),task})),...[...records.values()].flatMap(r=>r.state.tasks.map(task=>({record:r,task})))],summary=counts();
    const heading=make('div','gm-files-task-head');heading.append(make('strong','',summary.active?summary.active+' 项待完成':summary.failed?summary.failed+' 项待处理':'传输任务'),button('取消全部待完成',cancelAll));tasksPane.append(heading);
    if(!all.length){tasksPane.append(make('p','gm-muted','还没有传输任务。选择设备上传或下载后，任务会出现在这里。'));return;}
    const rank={running:0,committing:0,failed:1,paused:1,queued:2,cancelled:3,done:4};all.sort((a,b)=>rank[a.task.status]-rank[b.task.status]);
    for(const {record,task} of all.slice(0,200)){const row=make('article','gm-files-task'),name=make('strong','',task.name),device=publicDevices().find(d=>d.id===(task.machineId||record?.device.machineId))?.name||task.device||record?.device.target||'已移除的设备';
      const labels={queued:'排队中',running:'传输中',committing:'正在保存',paused:'已暂停',done:'完成',failed:'未完成',cancelled:'已取消'};const detail=make('p','gm-muted',device+' · '+(task.machineId&&task.status==='done'?'已校验并保存':task.phase==='verifying'?'正在核对文件':labels[task.status])+' · '+(task.message||(task.needsGrant&&['paused','failed'].includes(task.status)?'需确认本机文件权限 · ':'')+bytes(task.bytes)+' / '+bytes(task.size)));row.dataset.state=task.status;
      const progress=make('progress');progress.max=100;progress.value=task.status==='done'?100:task.size>0?100*task.bytes/task.size:0;
      const locate=button('查看任务',()=>{selected=record?.device.machineId;selector.value=selected;show('files');send(record,'transfers');});locate.setAttribute('aria-label','查看 '+device+' 的任务 '+task.name);locate.disabled=!record||!!record.pending||record.removed;if(locate.disabled)locate.title='原连接配置已变化，请先核对文件通道。';row.append(name,detail,progress,locate);if(task.machineId&&['queued','running','paused','failed','cancelled'].includes(task.status)){const action=button(['queued','running'].includes(task.status)?'暂停':'继续',async()=>{action.disabled=true;try{const reply=await nativeInvoke(['queued','running'].includes(task.status)?'pause':'resume',task.machineId,{id:task.id});if(reply.status!=='ok')note.textContent='未能继续该任务（'+(reply.code||'TRANSFER_IO')+'），请进入设备任务核对文件或连接。';await pollNative();}finally{action.disabled=false;}});action.disabled=!record||!!record.pending||record.removed;row.append(action);}tasksPane.append(row);
    }
    if(summary.total>all.length)tasksPane.append(make('p','gm-muted','每台设备在总览中保留最多 100 项摘要，完整任务及重试请进入该设备。'));
  }
  function hide(){root.hidden=true;tab.classList.remove('active');tab.setAttribute('aria-selected','false');document.documentElement.removeAttribute('data-gmssh-files-active');}
  function open(id){if(disposed)return;for(const c of window.gmsshWindowsControllers?.values()||[])c.hide();document.documentElement.removeAttribute('data-windows-desktop-active');refreshSelector();if(id&&publicDevices().some(n=>n.id===id))selected=id;if(selected)selector.value=selected;root.hidden=false;tab.classList.add('active');tab.setAttribute('aria-selected','true');document.documentElement.setAttribute('data-gmssh-files-active','');mount();show('files');}
  selector.onchange=()=>{selected=selector.value;show('files');};
  function cancelAll(){for(const r of records.values())if(r.state.active)send(r,'cancel-all');if(nativeProtocol)for(const id of new Set(nativeTasks.filter(t=>['queued','running','paused','failed'].includes(t.status)).map(t=>t.machineId)))void nativeInvoke('cancel-all',id).then(pollNative);}
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
      if(event.data?.type==='gmssh-file-native'){
        const data=event.data;if(!Number.isSafeInteger(data.requestId)||data.requestId<1||!['hello','list','pick-upload','pick-download','resume','pause','cancel','clear','cancel-all'].includes(data.action)||!data.data||typeof data.data!=='object'||Array.isArray(data.data))return;
        void nativeReady.then(async ready=>{
          let reply=ready;
          if(nativeProtocol)reply=(record.pending||record.removed)&&!['hello','list'].includes(data.action)?{status:'error',code:'DEVICE_CONFIG_CHANGED'}:data.action==='hello'?{status:'ok',data:{protocol:2}}:await nativeInvoke(data.action,record.device.machineId,data.data);
          if(!disposed)record.frame?.contentWindow?.postMessage({type:'gmssh-file-native-result',requestId:data.requestId,reply},event.origin);
          void pollNative();
        });return;
      }
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
  const controller={open,hide,update,cancelAll,native:false,pending:()=>counts().active,remove(){disposed=true;clearInterval(nativePoll);if(!nativeProtocol)cancelAll();observer.disconnect();window.removeEventListener('resize',mount);window.removeEventListener('message',receive);document.removeEventListener('click',click,true);root.remove();tabSlot.remove();records.clear();leaseQueue.length=0;holder=undefined;document.documentElement.removeAttribute('data-gmssh-files-active');delete window.gmsshFilesController;void window.electronAPI?.invoke('render-to-main',{type:'gmssh-files-state',data:{active:0,failed:0}}).catch(()=>{});}};
  window.gmsshFilesController=controller;update(devices);return controller;
};
