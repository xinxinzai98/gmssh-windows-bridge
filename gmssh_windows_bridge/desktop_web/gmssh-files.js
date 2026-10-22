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
  const taskHead=make('div','gm-files-task-head'),taskCount=make('strong'),taskActions=make('div','gm-files-batch');
  const pauseFiltered=button('暂停筛选任务',()=>batch('pause-many')),clearFiltered=button('清除完成记录',()=>batch('clear'));
  pauseFiltered.title='暂停当前筛选中的主进程任务，保留已传部分';clearFiltered.title='只清除筛选中的完成或取消记录，不删除文件；待清理任务继续保留';
  taskActions.append(pauseFiltered,clearFiltered);taskHead.append(taskCount,taskActions);
  const filters=make('div','gm-files-filters'),taskDevice=make('select'),taskStatus=make('select'),taskSearch=make('input');
  taskDevice.setAttribute('aria-label','按设备筛选任务');taskStatus.setAttribute('aria-label','按状态筛选任务');taskSearch.type='search';taskSearch.placeholder='搜索文件名、设备或路径';taskSearch.maxLength=256;taskSearch.setAttribute('aria-label','搜索传输任务');
  for(const [value,label] of [['all','全部状态'],['active','进行中与排队'],['attention','需要处理'],['paused','已暂停'],['failed','未完成'],['done','已完成'],['cancelled','已取消']]){const option=make('option','',label);option.value=value;taskStatus.append(option);}
  filters.append(taskDevice,taskStatus,taskSearch);const taskFeedback=make('p','gm-files-feedback');taskFeedback.hidden=true;taskFeedback.setAttribute('role','status');
  const taskList=make('div','gm-files-task-list'),taskEmpty=make('p','gm-muted'),more=button('显示更多',()=>{taskLimit+=50;renderTasks();});more.classList.add('gm-files-more');
  tasksPane.append(taskHead,filters,taskFeedback,taskList,taskEmpty,more);
  content.append(frames,tasksPane,nativePane);root.append(head,note,content);document.body.append(root);
  const tab=button('文件中心',()=>open(),'arrows-left-right');tab.classList.add('gm-files-tab');tab.setAttribute('role','tab');tab.setAttribute('aria-controls',root.id);tab.setAttribute('aria-selected','false');
  const tabSlot=make('div','gm-files-tabs');tabSlot.setAttribute('role','tablist');tabSlot.setAttribute('aria-label','文件中心入口');tabSlot.append(tab);
  const badge=make('span','gm-files-badge');badge.hidden=true;tab.append(badge);
  const records=new Map(),leaseQueue=[];let holder,selected,mode='files',disposed=false,reported='',activityUpdate=Promise.resolve({status:'ok'}),nativeTasks=[],nativeProtocol=false,nativePoll,nativePolling=false;
  const taskRows=new Map(),busyTasks=new Set();let taskLimit=50,deviceOptions='',batchBusy=false;
  const active=task=>['queued','running','committing'].includes(task.status),finished=task=>['done','cancelled'].includes(task.status)&&!task.cleanupPending;
  const taskErrors={PAUSED:'已暂停，保留已传部分',REAUTHORIZE:'需要重新确认本机文件权限',CONFLICT:'目标已有同名文件，请另存或改名继续',DISK_FULL:'磁盘空间或配额不足，释放空间后可继续',ACCESS_DENIED:'读写权限不足，请检查文件或目录权限',VOLUME_UNAVAILABLE:'磁盘或网络盘暂不可用，请重新连接后确认保存位置',READ_ONLY_VOLUME:'目标磁盘为只读，请检查挂载方式',SOURCE_CHANGED:'源文件已变化，请重新创建任务',PARTIAL_CHANGED:'已传部分发生变化，请确认原位置后核对',PARTIAL_MISSING:'未找到已传部分，请确认原保存目录',PEER_CHANGED:'设备身份已变化，请核对连接',DEVICE_CONFIG_CHANGED:'设备配置已变化，请核对连接',DEVICE_CONFIG_UNAVAILABLE:'设备配置未就绪，请先连接设备',NEED_CONNECTION:'请先连接设备再继续',HASH_MISMATCH:'内容校验未通过，文件尚未提交',FILE_TOO_LARGE:'文件超过目标文件系统限制',JOURNAL_WRITE_FAILED:'任务记录无法保存，请检查本机空间和权限',CANCELLED:'已取消',CANCELLED_FILE_RETAINED:'已取消，完整大小的目标文件保留供核验',TRANSFER_IO:'传输中断，已传部分已保留',REMOTE_IO:'远端读写失败，请检查连接和权限',PICKER_BUSY:'请先完成已打开的系统文件窗口'};
  Object.assign(taskErrors,{LOCAL_SERVICE_UNAVAILABLE:'本机文件服务尚未启动，待服务就绪后继续',LOCAL_SERVICE_TIMEOUT:'本机文件服务启动或握手超时，请重开文件中心后继续',LOCAL_SERVICE_BUSY:'本机文件通道暂忙，请稍后继续',LOCAL_AUTH_FAILED:'本机操作授权已刷新，请重开管理端',CONNECTION_CLOSED:'文件连接已关闭，已传部分保留；核对连接后继续',WORKER_START_FAILED:'文件工作进程未能启动，请检查安装和权限',WORKER_EXITED:'文件工作进程提前退出，可复制诊断后继续',WORKER_NO_RESULT:'文件工作进程没有返回结果，请核对任务',DIAGNOSTIC_COPY_FAILED:'诊断未能复制，请重试'});
  const taskStages={'device-config':'正在核对设备配置','worker-start':'正在启动文件工作进程','local-connect':'正在等待本机文件服务','local-auth':'正在核对本机操作授权','peer-ready':'正在等待设备连接就绪','local-file':'正在核对本机文件权限','file-prepare':'正在打开并核对远端文件',transferring:'文件传输',verifying:'内容校验',saving:'最终保存'};
  const problem=code=>taskErrors[code]||'文件任务暂不可用，请进入设备任务核对后继续';
  const feedback=text=>{taskFeedback.textContent=text;taskFeedback.hidden=!text;};
  const deviceName=(record,task)=>publicDevices().find(d=>d.id===(task.machineId||record?.device.machineId))?.name||task.device||record?.device.target||'已移除的设备';
  function allTasks(){return [...nativeTasks.map(task=>({record:records.get(task.machineId),task,key:'native:'+task.id})),...[...records.values()].flatMap(r=>r.state.tasks.map(task=>({record:r,task,key:r.device.machineId+':'+task.id})))];}
  function matchingTasks(){const query=taskSearch.value.trim().toLocaleLowerCase();return allTasks().filter(({record,task})=>
    (!taskDevice.value||taskDevice.value===(task.machineId||record?.device.machineId))&&
    (taskStatus.value==='all'||taskStatus.value==='active'&&active(task)||taskStatus.value==='attention'&&(task.cleanupPending||['paused','failed'].includes(task.status))||task.status===taskStatus.value)&&
    (!query||[task.name,task.source,task.target,deviceName(record,task)].some(text=>String(text||'').toLocaleLowerCase().includes(query))));}
  for(const filter of [taskDevice,taskStatus])filter.onchange=()=>{taskLimit=50;feedback('');renderTasks();};
  taskSearch.oninput=()=>{taskLimit=50;renderTasks();};
  const nativeInvoke=(action,machineId=null,data={})=>Promise.resolve(window.electronAPI?.invoke('render-to-main',{type:'gmssh-transfer',data:{action,machineId,data}})).then(value=>value||{status:'error',code:'UNSUPPORTED'}).catch(()=>({status:'error',code:'UNSUPPORTED'}));
  const nativeReady=nativeInvoke('hello').then(async reply=>{if(disposed)return reply;if(reply.status==='ok'&&reply.data?.protocol===2){nativeProtocol=true;controller.native=true;controller.linux=reply.data.linuxFiles===true;await pollNative();if(!root.hidden)show(mode);nativePoll=setInterval(pollNative,700);}return reply;});
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
    for(const [id,record] of records){const node=native.find(n=>n.id===id);list.push({id,name:node?.name||record.device.label||record.device.target||'设备',windows:record.device.platform!=='posix',removed:record.removed});}
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
  function access(record){if(!record.frame)return;record.frame.contentWindow?.postMessage({type:'gmssh-file-access',token:record.device.accessToken,platform:record.device.platform,label:publicDevices().find(n=>n.id===record.device.machineId)?.name||record.device.label||record.device.target},new URL(record.device.viewerUrl).origin);if(record.pendingTool){const tool=record.pendingTool;delete record.pendingTool;record.frame.contentWindow?.postMessage({type:'gmssh-file-tool',tool},new URL(record.device.viewerUrl).origin);}}
  function frameFor(record){
    if(record.frame)return record.frame;
    const frame=make('iframe');frame.src=new URL('files.html',record.device.viewerUrl).href;frame.title=(record.device.label||record.device.target||'设备')+' · 文件互传';frame.referrerPolicy='no-referrer';record.frame=frame;record.loaded=false;frame.onload=()=>{if(record.loaded){releaseLease(record);if(record.state.active){record.state={...record.state,active:0,failed:record.state.failed+record.state.active,tasks:record.state.tasks.map(t=>['running','queued'].includes(t.status)?{...t,status:'failed',message:'文件页已重新载入，请重新选择未完成的文件。'}:t)};report();}}record.loaded=true;access(record);};frames.append(frame);return frame;
  }
  function show(next){
    mode=next;head.dataset.mode=next;selector.hidden=next==='tasks';browse.setAttribute('aria-pressed',String(next==='files'));transfers.setAttribute('aria-pressed',String(next==='tasks'));tasksPane.hidden=next!=='tasks';frames.hidden=next!=='files';nativePane.hidden=true;
    for(const [id,r] of records)if(r.frame)r.frame.hidden=id!==selected;
    if(next==='tasks'){note.textContent='文件任务独立于桌面标签。可筛选设备和状态；清除记录不删除文件，未清理的临时文件记录会保留。Linux 与 Windows 共用本机恢复队列。';renderTasks();return;}
    let record=records.get(selected);
    if(!record&&nativeProtocol&&publicDevices().some(n=>n.id===selected&&!n.windows)){record={device:{machineId:selected,viewerUrl:base.href,accessToken:'0'.repeat(43),platform:'posix',label:publicDevices().find(n=>n.id===selected)?.name},state:stateEmpty()};records.set(selected,record);}
    note.textContent=nativeProtocol?'文件直接落盘，校验后保存。收起中心继续传输，退出时暂停并保存任务。':'收起文件中心或关闭桌面标签不会取消传输。浏览器兼容任务在退出后需重新选择文件。';
    if(record){
      if(record.pending||record.removed){nativePane.hidden=false;frames.hidden=true;nativePane.replaceChildren(make('h3','','设备配置已变化'),make('p','gm-muted',record.state.active?'原通道的任务仍在处理，结束后可重新打开文件通道。不会把任务自动转给其他设备。':'原任务记录已保留；更新通道后需重新选择失败的文件。'));
        if(!record.state.active&&!record.removed)nativePane.append(button('更新文件通道',()=>{record.frame?.remove();record.frame=undefined;record.device=record.pending;record.pending=undefined;record.state=stateEmpty();report();show('files');}));
      }else frameFor(record).hidden=false;
      return;
    }
    frames.hidden=true;nativePane.hidden=false;nativePane.replaceChildren(make('h3','','使用原生文件工具'),make('p','gm-muted',selected?'此 Linux 设备继续使用 GMSSH 原生文件管理；其任务不计入本中心的 Windows 队列。':'请先添加一台设备，再打开文件中心。'));
    if(selected)nativePane.append(button('打开文件互传',()=>{hide();window.gmsshHomeController?.openNativeFiles?.(selected);},'arrows-left-right'));
  }
  async function taskAction(view,action){
    const {task,key}=view.item;if(busyTasks.has(key)||batchBusy)return;busyTasks.add(key);feedback('');renderTasks();
    try{const reply=await nativeInvoke(action,task.machineId,{id:task.id});if(reply.status!=='ok')feedback(problem(reply.code)+'（'+(reply.code||'TRANSFER_IO')+'）');else if(action==='copy-diagnostic')feedback('诊断已复制，可粘贴给维护者。');await pollNative();}
    finally{busyTasks.delete(key);renderTasks();}
  }
  async function batch(action){
    if(batchBusy)return;
    const snapshot=matchingTasks().filter(({task})=>task.machineId&&(action==='clear'?finished(task):active(task)));if(!snapshot.length)return;
    const groups=new Map();for(const {task} of snapshot){if(!groups.has(task.machineId))groups.set(task.machineId,[]);groups.get(task.machineId).push(task.id);}
    batchBusy=true;feedback('正在处理 '+snapshot.length+' 项任务…');renderTasks();let completed=0,failed=0;
    try{for(const [id,ids] of groups){const reply=await nativeInvoke(action,id,{ids});if(reply.status==='ok')completed+=reply.data?.[action==='clear'?'cleared':'paused']||0;else failed+=ids.length;}await pollNative();feedback((action==='clear'?'已清除 ':'已暂停 ')+completed+' 项'+(failed?'；'+failed+' 项未能处理，请逐项核对':'')+(action==='clear'?'；文件保留':'；已传部分保留'));}
    finally{batchBusy=false;renderTasks();}
  }
  function renderTasks(){
    const all=allTasks(),devices=new Map(publicDevices().map(d=>[d.id,d.name]));for(const {record,task} of all)if(!devices.has(task.machineId||record?.device.machineId))devices.set(task.machineId||record?.device.machineId,deviceName(record,task));
    const optionsKey=JSON.stringify([...devices]);if(optionsKey!==deviceOptions){deviceOptions=optionsKey;const chosen=taskDevice.value;taskDevice.replaceChildren(make('option','','全部设备'));taskDevice.firstChild.value='';for(const [id,label] of devices){const option=make('option','',label);option.value=id;taskDevice.append(option);}taskDevice.value=devices.has(chosen)?chosen:'';}
    const filtered=matchingTasks(),summary=counts(),rank={running:0,committing:0,failed:1,paused:1,queued:2,cancelled:3,done:4};
    filtered.sort((a,b)=>rank[a.task.status]-rank[b.task.status]||(active(a.task)?a.task.id-b.task.id:b.task.id-a.task.id));
    taskCount.textContent=filtered.length+' / '+all.length+' 项'+(summary.active?' · '+summary.active+' 项待完成':'');
    const pausable=filtered.filter(({task})=>task.machineId&&active(task)).length,clearable=filtered.filter(({task})=>task.machineId&&finished(task)).length;
    pauseFiltered.textContent='暂停筛选任务'+(pausable?'（'+pausable+'）':'');pauseFiltered.disabled=batchBusy||busyTasks.size>0||!pausable;
    clearFiltered.textContent='清除完成记录'+(clearable?'（'+clearable+'）':'');clearFiltered.disabled=batchBusy||busyTasks.size>0||!clearable;
    taskEmpty.hidden=!!filtered.length;taskEmpty.textContent=all.length?'没有符合筛选条件的任务。可更换设备、状态或搜索词。':'还没有传输任务。选择设备上传或下载后，任务会出现在这里。';
    more.hidden=filtered.length<=taskLimit;more.textContent='再显示 '+Math.min(50,filtered.length-taskLimit)+' 项（剩余 '+Math.max(0,filtered.length-taskLimit)+' 项）';
    const visible=filtered.slice(0,taskLimit),ids=new Set(visible.map(item=>item.key));for(const [key,view] of taskRows)if(!ids.has(key)){view.root.remove();taskRows.delete(key);}
    let position=0;
    for(const item of visible){
      const {record,task,key}=item;let view=taskRows.get(key);
      if(!view){
        const row=make('article','gm-files-task'),name=make('strong'),detail=make('p','gm-muted'),progress=make('progress');progress.max=100;
        const expanded=make('details','gm-files-detail'),description=make('p');expanded.append(make('summary','','详细信息'),description);
        const actions=make('div','gm-files-task-actions');view={root:row,name,detail,progress,description,item};
        view.locate=button('查看任务',()=>{const r=view.item.record;selected=r?.device.machineId;selector.value=selected;show('files');send(r,'transfers');});
        view.action=button('继续',()=>taskAction(view,active(view.item.task)?'pause':'resume'));view.cancel=button('取消',()=>taskAction(view,'cancel'));
        view.copy=button('复制诊断',()=>taskAction(view,'copy-diagnostic'));
        actions.append(view.locate,view.action,view.cancel,view.copy);row.append(name,detail,progress,expanded,actions);taskRows.set(key,view);
      }
      view.item=item;const device=deviceName(record,task),labels={queued:'排队中',running:'传输中',committing:'正在保存',paused:'已暂停',done:task.machineId?'已校验并保存':'完成',failed:'未完成',cancelled:'已取消'};
      const phase=active(task)&&task.phase==='verifying'&&!task.verifyTotal&&taskStages[task.stage]|| (task.phase==='copying'?'兼容保存中，完成前请勿打开目标文件':task.phase==='verifying'?'正在核对文件':labels[task.status]);
      const reason=task.message||(['failed','paused','cancelled'].includes(task.status)?problem(task.code||'PAUSED'):'');
      view.name.textContent=(task.kind==='download'?'↓ ':task.kind==='directory'?'↳ ':'↑ ')+task.name;view.name.title=task.name;view.root.dataset.state=task.status;
      view.detail.textContent=device+' · '+phase+' · '+bytes(task.phase==='copying'?(task.copyBytes||0):task.bytes)+' / '+bytes(task.size)+(reason?' · '+reason:'')+(task.needsGrant&&['paused','failed'].includes(task.status)?' · 需确认本机文件权限':'')+(task.cleanupPending?' · 临时文件待清理':'');
      view.progress.value=task.status==='done'?100:task.size>0?Math.min(100,100*(task.phase==='copying'?(task.copyBytes||0):task.bytes)/task.size):0;view.progress.setAttribute('aria-label',task.name+' 的进度');
      view.description.textContent=(task.source?'来源：'+task.source+'\n':'')+(task.target?'目标：'+task.target+'\n':'')+(task.createdAt?'创建时间：'+new Date(task.createdAt).toLocaleString()+'\n':'')+(task.code?'状态代码：'+task.code+'\n':'')+(task.sha256?'SHA-256：'+task.sha256+'\n':'')+(!task.machineId?'兼容任务的完整信息请进入设备查看。':'');
      if(task.diagnostic)view.description.textContent+='\n上次失败阶段：'+(taskStages[task.diagnostic.stage]||task.diagnostic.stage)+'\n上次错误：'+(task.diagnostic.code||'未知')+(task.diagnostic.at?'\n发生时间：'+new Date(task.diagnostic.at).toLocaleString():'');
      view.copy.hidden=!task.machineId||!task.diagnostic;view.copy.disabled=busyTasks.has(key)||batchBusy;view.copy.setAttribute('aria-label','复制诊断 · '+task.name);
      const disabled=busyTasks.has(key)||batchBusy;view.locate.disabled=disabled||!record||!!record.pending||record.removed;
      view.action.hidden=!task.machineId||task.status==='done';view.action.textContent=active(task)?'暂停':'继续';view.action.disabled=disabled;view.action.setAttribute('aria-label',view.action.textContent+' · '+task.name);
      view.cancel.hidden=!task.machineId||finished(task);view.cancel.textContent=task.cleanupPending?'清理临时文件':'取消';view.cancel.disabled=disabled;view.cancel.setAttribute('aria-label',view.cancel.textContent+' · '+task.name);
      if(taskList.children[position]!==view.root)taskList.insertBefore(view.root,taskList.children[position]||null);position++;
    }
    if(counts().total>all.length)taskEmpty.textContent+=' 旧版兼容通道的完整任务请进入对应设备。';
  }
  function hide(){root.hidden=true;tab.classList.remove('active');tab.setAttribute('aria-selected','false');document.documentElement.removeAttribute('data-gmssh-files-active');}
  function open(id){if(disposed)return;window.gmsshWorkspaceController?.hide();for(const c of window.gmsshWindowsControllers?.values()||[])c.hide();document.documentElement.removeAttribute('data-windows-desktop-active');refreshSelector();if(id&&publicDevices().some(n=>n.id===id))selected=id;if(selected)selector.value=selected;root.hidden=false;tab.classList.add('active');tab.setAttribute('aria-selected','true');document.documentElement.setAttribute('data-gmssh-files-active','');mount();show('files');}
  selector.onchange=()=>{selected=selector.value;show('files');};
  function cancelAll(){for(const r of records.values())if(r.state.active)send(r,'cancel-all');if(nativeProtocol)for(const id of new Set(nativeTasks.filter(t=>['queued','running','committing','paused','failed'].includes(t.status)).map(t=>t.machineId)))void nativeInvoke('cancel-all',id).then(pollNative);}
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
    for(const [id,record] of records)if(!ids.has(id)&&!(record.device.platform==='posix'&&(window.gmsshHomeController?.filesDevices?.()||[]).some(n=>n.id===id&&!n.windows))){if(record.frame||record.state.total)record.removed=true;else records.delete(id);}
    refreshSelector();if(!root.hidden)show(mode);report();
  }
  function receive(event){
    const record=[...records.values()].find(r=>r.frame?.contentWindow===event.source);
    if(record&&event.origin===new URL(record.device.viewerUrl).origin){
      if(event.data?.type==='gmssh-file-native'){
        const data=event.data;if(!Number.isSafeInteger(data.requestId)||data.requestId<1||!['hello','list','fs-list','fs-mkdir','places','pick-upload','pick-download','resume','pause','cancel','clear','cancel-all','copy-diagnostic'].includes(data.action)||!data.data||typeof data.data!=='object'||Array.isArray(data.data))return;
        void nativeReady.then(async ready=>{
          let reply=ready;
          if(nativeProtocol)reply=(record.pending||record.removed)&&!['hello','list'].includes(data.action)?{status:'error',code:'DEVICE_CONFIG_CHANGED'}:data.action==='hello'?{status:'ok',data:{protocol:2,places:ready?.data?.places===true,linuxFiles:ready?.data?.linuxFiles===true}}:await nativeInvoke(data.action,record.device.machineId,data.data);
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
  const controller={open,hide,update,cancelAll,native:false,linux:false,pending:()=>counts().active,remove(){disposed=true;clearInterval(nativePoll);if(!nativeProtocol)cancelAll();observer.disconnect();window.removeEventListener('resize',mount);window.removeEventListener('message',receive);document.removeEventListener('click',click,true);root.remove();tabSlot.remove();records.clear();leaseQueue.length=0;holder=undefined;document.documentElement.removeAttribute('data-gmssh-files-active');delete window.gmsshFilesController;void window.electronAPI?.invoke('render-to-main',{type:'gmssh-files-state',data:{active:0,failed:0}}).catch(()=>{});}};
  window.gmsshFilesController=controller;update(devices);return controller;
};
