/* Local human setup UI. All secrets leave the form on preview/submit/close. */
window.installGMSSHAI=function({viewerUrl}){
  if(window.gmsshAIController)return window.gmsshAIController;
  const base=new URL(viewerUrl);if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw Error('Local AI assets required');
  const make=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls||'';if(text!==undefined)node.textContent=text;return node;};
  const icon=name=>{const node=make('img','gm-ui-icon');node.src=new URL('ui-icons/'+name+'.svg',base).href;node.alt='';return node;};
  const button=(text,fn,name)=>{const node=make('button','gm-ui-button',text);node.type='button';node.onclick=fn;if(name)node.prepend(icon(name));return node;};
  const labels={inspect:'设备信息',files_read:'文件读取',files:'文件读写',terminal:'执行命令',view:'查看桌面',input:'操作桌面'};
  const messages={AI_SETUP_BUSY:'有一项操作正在进行，请稍候。',AI_PREVIEW_REQUIRED:'请重新粘贴授权码并核对设备。',AI_RUNTIME_UNAVAILABLE:'本机运行环境不可用，请重新安装或修复 GMSSH。',AI_PREPARE_FAILED:'组件准备未完成，请检查网络后重试。',AI_SETUP_TIMEOUT:'操作等待超时，请检查结果后重试。',AI_CANCELLED:'已取消。',AI_DEPENDENCY_REQUIRED:'尚未准备 MCP 组件。',MCP_VERSION_MISMATCH:'运行环境与应用组件版本不一致，请重新准备组件。',MCP_CHECK_FAILED:'MCP 启动检查未通过，请重新准备组件。',DEVICE_EXISTS:'这个授权已经添加，请更新已有授权。',ACCESS_DENIED:'当前授权不允许此操作。',AUTH_FAILED:'连接凭据未通过验证，独立授权可能已撤销。',CONNECTION_FAILED:'未能连通设备，请检查网络和服务状态。',PEER_CHANGED:'设备身份与原记录不一致，已停止连接。',PERMISSIONS_REDUCED:'连接已验证，部分所选操作尚未获得服务端授权。',SERVER_UPGRADE_REQUIRED:'此能力需要 Windows 服务端 0.4a27 或更新版本。',DESKTOP_LOCKED:'授权已验证，Windows 桌面当前已锁定。',DESKTOP_WORKER_UNAVAILABLE:'授权已验证，Windows 桌面组件未运行。',NO_INTERACTIVE_SESSION:'授权已验证，Windows 当前没有可用桌面会话。',DESKTOP_BUSY:'桌面正被其他操作使用，请稍后重试。',AI_PAUSED:'授权已验证，Windows 用户已暂停 AI 桌面控制。',CREDENTIAL_REQUIRED:'请更新这台电脑的连接凭据。',CREDENTIAL_FROM_ENV:'请在提供凭据的运行环境中更新。',ENV_FORWARDING_REQUIRED:'此设备使用环境变量，请改为复制 Codex TOML 配置。',CONFIG_UNSAFE:'本机 AI 配置无法安全读取，请检查目录权限。'};
  Object.assign(messages,{INVALID_ARGUMENT:'输入内容无效，请重新核对授权信息。',INVALID_RESPONSE:'接入信息返回不完整，请先核对已有任务。',SETUP_FAILED:'本机配置操作未完成，请重试。',AI_SETUP_FAILED:'本机配置操作未完成，请重试。',NOT_FOUND:'这个任务或文件已不存在，请核对编号。',LOCAL_JOURNAL_FAILED:'本机任务记录未能保存，请检查磁盘空间和目录权限。',REMOTE_IO:'远端响应中断，请先查询原任务，不要重新执行命令。'});
  const message=(code,fallback)=>messages[code]||fallback||'操作未完成，请重试。';
  const invoke=async(action,data={})=>{const reply=await window.electronAPI?.invoke('render-to-main',{type:'gmssh-ai',data:{action,data}});if(!reply||reply.status!=='ok')throw Object.assign(Error(message(reply?.code,reply?.message)),{code:reply?.code});return reply.data;};
  const tools=make('div','gm-ai-tools'),entry=button('',open,'cpu');entry.append(make('span','gm-ai-label','AI 接入'));entry.title='AI 接入 · 配置与授权';entry.setAttribute('aria-label','AI 接入');tools.append(entry);
  const dialog=make('dialog','gm-ai-dialog');dialog.setAttribute('aria-label','AI 接入设置');
  const title=make('h2','','AI 接入'),closeButton=button('关闭',close,'x'),head=make('div','gm-ai-head');head.append(title,closeButton);
  const tabs=make('div','gm-ai-tabs');tabs.setAttribute('role','tablist');
  const content=make('div','gm-ai-content'),status=make('p','gm-ai-status'),footer=make('div','gm-ai-footer');status.setAttribute('role','status');status.setAttribute('aria-live','polite');footer.append(status,button('完成',close));dialog.append(head,tabs,content,footer);document.body.append(dialog);
  let epoch=0,active='devices',writing=false,busy=false,disposed=false,devices=[],preview=null,report=null,taskDevice=null;
  const tabButtons={};for(const [id,label]of [['devices','设备与权限'],['add','添加授权'],['tasks','任务记录'],['config','接入 AI 客户端']]){const node=button(label,()=>show(id));node.setAttribute('role','tab');node.dataset.tab=id;tabButtons[id]=node;tabs.append(node);}
  content.id='gmssh-ai-content';content.setAttribute('role','tabpanel');
  for(const node of Object.values(tabButtons))node.setAttribute('aria-controls',content.id);
  tabs.addEventListener('keydown',event=>{if(busy||!event.target.dataset.tab)return;const keys=Object.keys(tabButtons),index=keys.indexOf(event.target.dataset.tab);let next;if(event.key==='ArrowRight')next=(index+1)%keys.length;if(event.key==='ArrowLeft')next=(index+keys.length-1)%keys.length;if(event.key==='Home')next=0;if(event.key==='End')next=keys.length-1;if(next!==undefined){event.preventDefault();const node=tabButtons[keys[next]];node.click();node.focus();}});
  dialog.addEventListener('keydown',event=>event.stopPropagation());
  function attach(){const host=document.querySelector('.machine-manage .machine-head .head-right')||document.querySelector('[data-gmssh-ai-toolbar]');if(host&&!host.contains(tools))host.append(tools);}
  function say(text){status.textContent=text;}
  function secrets(){dialog.querySelectorAll('input[type=password]').forEach(node=>node.value='');}
  const disabledBefore=new WeakMap();
  function lock(value,write=false){busy=value;writing=value&&write;entry.disabled=value;dialog.querySelectorAll('button,input,select').forEach(node=>{if(node.getAttribute('role')==='tab'){node.setAttribute('aria-disabled',String(value));return;}if(value){disabledBefore.set(node,node.disabled);node.disabled=true;}else if(disabledBefore.has(node)){node.disabled=disabledBefore.get(node);disabledBefore.delete(node);}});closeButton.disabled=writing;footer.querySelector('button').disabled=writing;}
  function close(){if(writing)return;epoch++;secrets();preview=null;content.replaceChildren();dialog.close();void invoke('clear').catch(()=>{});lock(false);}
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  function field(text,input){const node=make('label','gm-ai-field');node.append(make('span','',text),input);return node;}
  function permissions(values=[]){
    const group=make('fieldset','gm-ai-permissions');group.append(make('legend','','允许 AI 使用的能力'));
    const presets=make('div','gm-ai-presets');group.append(presets);
    const boxes={};for(const key of Object.keys(labels)){const box=make('input');box.type='checkbox';box.checked=values.includes(key);box.setAttribute('aria-label','允许'+labels[key]);boxes[key]=box;const label=make('label');label.append(box,make('span','',labels[key]));group.append(label);}
    if(boxes.files.checked)boxes.files_read.checked=false;
    boxes.files.onchange=()=>{if(boxes.files.checked)boxes.files_read.checked=false;};boxes.files_read.onchange=()=>{if(boxes.files_read.checked)boxes.files.checked=false;};
    boxes.input.onchange=()=>{if(boxes.input.checked)boxes.view.checked=true;};boxes.view.onchange=()=>{if(!boxes.view.checked)boxes.input.checked=false;};
    presets.append(button('只读预设',()=>{if(busy)return;for(const [key,box]of Object.entries(boxes))box.checked=['inspect','files_read','view'].includes(key);group.dispatchEvent(new Event('change',{bubbles:true}));}),make('span','gm-muted','设备信息、文件读取、桌面查看；保存后生效。'));
    const note=make('p','gm-ai-permission-note gm-muted','文件读取允许搜索、查看和修改预览。执行命令或操作桌面还可修改系统，请按需选择。');group.append(note);
    return {node:group,value:()=>Object.keys(boxes).filter(key=>boxes[key].checked)};
  }
  async function work(fn,{write=false}={}){
    if(busy)return;const run=epoch;lock(true,write);
    try{return await fn(run);}catch(error){if(run===epoch)say(error.message);return null;}finally{if(run===epoch)lock(false);}
  }
  async function load(){const result=await invoke('list');devices=result.devices;}
  async function open(){if(disposed||busy)return;epoch++;preview=null;secrets();if(!dialog.open)dialog.showModal();await show('devices');}
  async function show(tab){
    if(busy||disposed)return;epoch++;secrets();preview=null;active=tab;say('');content.replaceChildren();
    for(const [key,node]of Object.entries(tabButtons)){node.setAttribute('aria-selected',String(key===tab));node.classList.toggle('selected',key===tab);node.tabIndex=key===tab?0:-1;}
    if(tab==='devices')await work(async run=>{say('正在读取本机 AI 配置…');await load();if(run!==epoch)return;renderDevices();say('只有明确启用的设备可由 AI 访问；连接状态以检查时间为准。');});
    if(tab==='add')renderAdd();
    if(tab==='tasks')await renderTasks();
    if(tab==='config')await renderConfig();
  }
  function renderDevices(){
    content.replaceChildren();const summary=make('div','gm-ai-summary');summary.append(make('strong','',devices.filter(device=>device.allow.length).length+' 台设备已启用'),button('添加授权',()=>show('add'),'plus'));content.append(summary);
    if(!devices.length){const empty=make('div','gm-ai-empty');empty.append(icon('cpu'),make('h3','','先添加一台电脑'),make('p','','在 Windows 的 GMSSH 托盘创建独立授权，复制后到这里粘贴。默认只允许读取设备信息。'),button('粘贴并添加',()=>show('add')));content.append(empty);return;}
    const list=make('div','gm-ai-devices');content.append(list);
    for(const device of devices){
      const row=make('section','gm-ai-device'),identity=make('div','gm-ai-identity'),detail=make('div'),name=make('strong','',device.name);detail.append(name,make('small','gm-muted',device.addresses.join(' · ')));identity.append(icon('windows'),detail);row.append(identity);list.append(row);
      const enabled=device.allow.length>0,check=device.lastCheck,stamp=check?.checkedAt?new Date(check.checkedAt).toLocaleString():'';
      const state=make('p','gm-ai-state '+(check?.state||''),!enabled?'本机入口已停用':!check?'尚未检查远端授权':check.state==='passed'?'上次授权检查通过 · '+stamp:'上次检查：'+message(check.code)+' · '+stamp);row.append(state);
      row.append(make('p','gm-muted',device.allow.filter(key=>key!=='files_read'||!device.allow.includes('files')).map(key=>labels[key]).join(' · ')||'不接受新的 AI 操作'));
      if(enabled)row.append(make('p','gm-ai-mode gm-muted','本机权限：'+(device.allow.some(key=>['files','terminal','input'].includes(key))?'自定义操作':'只读')));
      if(device.accessStored===false)row.append(make('p','gm-ai-state failed','本机未找到连接凭据，请更新授权或密码。'));
      if(check?.effective){const denied=device.allow.filter(key=>check.effective[key]===false);if(denied.length)row.append(make('p','gm-muted','服务端尚未允许：'+denied.map(key=>labels[key]).join('、')));}
      if(device.allow.includes('files_read')&&!device.allow.includes('files')){
        const access=check?.features?.serverFileAccess;
        if(access==='read-only')row.append(make('p','gm-muted','上次核对：服务端文件只读。'));
        if(access==='read-write')row.append(make('p','gm-muted','当前只读由本机限制；服务端仍允许文件读写，可在 Windows 托盘调整该授权。'));
        if(access==='ssh-account')row.append(make('p','gm-muted','当前只读由本机限制，SSH 文件权限仍由 Windows 账号决定。'));
      }
      const actions=make('div','gm-ai-actions');row.append(actions);
      const checkButton=button('检查接入',()=>work(async run=>{say('正在核对 '+device.name+' 的授权与桌面状态…');const result=await invoke('check',{device:device.id});if(run!==epoch)return;await load();if(run!==epoch)return;renderDevices();say(result.ok?(result.result.state==='passed'?'授权检查通过；未运行命令或截图。':message(result.result.code)):message(result.error.code,result.error.message));}),'arrow-clockwise');checkButton.disabled=!enabled;actions.append(checkButton,button(enabled?'调整权限':'启用入口',()=>edit(device),'gear'));
      if(enabled)actions.append(button('停用',()=>work(async run=>{await invoke('configure',{device:device.id,allow:[]});if(run!==epoch)return;await load();if(run!==epoch)return;renderDevices();say('已停止接受新的 AI 操作；正在执行的远端任务需单独取消。');},{write:true})));
      if(device.transport==='ssh'&&device.source==='keychain')actions.append(button('更新密码',()=>editPassword(device),'lock'));
    }
  }
  function edit(device){
    epoch++;secrets();content.replaceChildren();say('只调整这台管理端的允许范围，服务端授权仍会逐次核对。');
    const choice=permissions(device.allow);content.append(make('h3','',device.name),choice.node);
    const actions=make('div','gm-ai-actions');actions.append(button('返回设备列表',()=>show('devices')),button('保存本机权限',()=>work(async run=>{await invoke('configure',{device:device.id,allow:choice.value()});if(run!==epoch)return;await load();if(run!==epoch)return;renderDevices();say('权限已保存，远端状态需要重新检查。');},{write:true})));content.append(actions);
  }
  function editPassword(device){
    epoch++;secrets();content.replaceChildren();say('仅更新本机钥匙串保存的现有 SSH 密码，不修改 Windows 密码。');const input=make('input');input.type='password';input.autocomplete='current-password';input.setAttribute('aria-label','现有 SSH 密码');content.append(make('h3','',device.name),field('现有 SSH 密码',input));
    const actions=make('div','gm-ai-actions');actions.append(button('返回',()=>show('devices')),button('保存凭据',()=>work(async run=>{const value=input.value;input.value='';await invoke('credential',{device:device.id,value});if(run!==epoch)return;await load();if(run!==epoch)return;renderDevices();say('本机凭据已更新，请重新检查接入。');},{write:true})));content.append(actions);input.focus();
  }
  function renderAdd(){
    content.replaceChildren();const input=make('input');input.type='password';input.autocomplete='off';input.maxLength=32768;input.spellcheck=false;input.setAttribute('aria-label','Windows 独立授权码');input.placeholder='粘贴 GMSSH-AUTH2. 开头的授权码';
    content.append(make('h3','','添加一台 Windows 电脑'),make('p','gm-muted','在 Windows 托盘的“会话与独立授权”创建 AI 专用授权。先核对电脑，再选择本机允许的能力。'),field('独立授权码',input));
    const actions=make('div','gm-ai-actions'),next=async paste=>work(async run=>{const code=input.value;input.value='';say('正在核对授权信息…');const value=await invoke(paste?'paste-preview':'preview',paste?{}:{code});if(run!==epoch)return;preview=value;renderPreview(value);say(value.existing?'这个授权已经添加，将更新本机凭据和权限。':'主机信息已读取；保存后才启用本机 AI 入口。');});
    actions.append(button('从剪贴板粘贴',()=>next(true),'copy'),button('核对设备',()=>next(false)));content.append(actions);input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void next(false);}});input.focus();
  }
  function renderPreview(value){
    content.replaceChildren();const card=make('div','gm-ai-preview');card.append(icon('windows'),make('strong','',value.computer),make('p','gm-muted',value.addresses.join(' · ')),make('p','gm-muted','主机身份：'+value.fingerprint));content.append(card);
    const name=make('input');name.value=value.name;name.maxLength=128;name.setAttribute('aria-label','AI 设备名称');name.disabled=value.existing;content.append(field('设备名称',name));
    const choice=permissions(value.allow);content.append(choice.node,make('p','gm-muted','服务端仍需允许对应通道。启用后可在设备列表检查真实授权状态。'));
    const actions=make('div','gm-ai-actions');actions.append(button('重新粘贴',()=>{preview=null;void invoke('clear').catch(()=>{});renderAdd();}),button(value.existing?'更新已有授权':'启用 AI 访问',()=>work(async run=>{await invoke('enroll',{preview:value.preview,name:name.value,allow:choice.value()});preview=null;if(run!==epoch)return;await load();if(run!==epoch)return;active='devices';for(const [key,node]of Object.entries(tabButtons)){node.classList.toggle('selected',key===active);node.setAttribute('aria-selected',String(key===active));node.tabIndex=key===active?0:-1;}renderDevices();tabButtons.devices.focus();say('配置已保存。请检查接入，再复制 AI 客户端配置。');},{write:true})));content.append(actions);const submit=actions.lastChild;submit.classList.add('primary');submit.disabled=!choice.value().length;choice.node.addEventListener('change',()=>submit.disabled=!choice.value().length);
  }
  async function renderTasks(){
    await work(async run=>{
      await load();if(run!==epoch)return;
      content.replaceChildren();content.append(make('p','gm-muted','这里只保存本机提交或查询过的任务编号、请求键和上次观察结果，不保存命令正文或输出。刷新本地记录不会连接远端。'));
      if(!devices.length){content.append(make('p','gm-ai-state','添加授权后，可在这里查找 AI 命令的任务记录。'));say('还没有配置 AI 设备。');return;}
      const select=make('select');select.setAttribute('aria-label','任务设备');for(const device of devices){const option=make('option','',device.name);option.value=device.id;select.append(option);}
      select.value=devices.some(device=>device.id===taskDevice)?taskDevice:devices.find(device=>device.allow.includes('terminal'))?.id||devices[0].id;taskDevice=select.value;
      const actions=make('div','gm-ai-summary'),rows=make('div','gm-ai-tasks');actions.append(field('设备',select),button('刷新本地记录',()=>work(update),'arrow-clockwise'));content.append(actions,rows);
      const states={unconfirmed:'提交回执待确认',unknown:'提交结果未知',running:'上次观察：运行中',cancelling:'上次观察：正在取消',completed:'已完成',failed:'执行失败',cancelled:'已取消',interrupted:'执行中断，结果未知',forgotten:'服务端结果已清理'};
      async function update(current){
        taskDevice=select.value;select.disabled=true;say('正在读取本机任务记录…');let history;try{history=await invoke('history',{device:taskDevice});}finally{select.disabled=false;}if(current!==epoch)return;rows.replaceChildren();
        if(!history.tasks.length)rows.append(make('p','gm-ai-state','本机尚未记录这台设备的异步命令。SSH 同步命令不在此列表。'));
        for(const task of history.tasks){
          const row=make('section','gm-ai-device gm-ai-task');row.dataset.state=task.state;rows.append(row);
          row.append(make('strong','',states[task.state]||task.state),make('p','gm-muted','任务：'+(task.taskId||'尚未取得任务编号')),make('p','gm-muted','上次观察：'+new Date(task.observedAt).toLocaleString()));
          if(task.exitCode!==null)row.append(make('p','gm-ai-state','退出码：'+task.exitCode));
          const details=make('details','gm-ai-task-details');details.append(make('summary','','请求与恢复信息'),make('p','gm-muted','请求键：'+(task.requestKey||'本机未记录')+'\n状态码：'+task.code));row.append(details);
          if(!task.taskId)row.append(make('p','gm-muted','不要作为新命令重复执行；如需核对，使用相同请求键、原命令和超时。'));
          const query=button('查询远端状态',()=>work(async current=>{say('正在查询任务，不会重新执行命令…');const reply=await invoke('task',{device:taskDevice,taskId:task.taskId});if(current!==epoch)return;if(!reply.ok){say(message(reply.error.code,reply.error.message));return;}await update(current);if(current!==epoch)return;const result=reply.result;say('远端任务：'+(states[result.state]||result.state)+(result.exitCode===null?'':' · 退出码 '+result.exitCode)+(result.localJournal?' · 本地记录未能保存':''));if(result.output){const output=make('pre','gm-ai-output',result.output);output.setAttribute('aria-label','本次任务输出');rows.prepend(output);}if(result.more||result.truncated)rows.prepend(make('p','gm-muted',result.truncated?'服务端输出已达到上限；当前内容不完整。':'本次显示一页输出，更多内容可通过 CLI / MCP 沿 nextOffset 读取。'));}),'arrow-clockwise');
          query.disabled=!history.canQuery||!task.taskId||task.state==='forgotten';row.append(query);
        }
        say(history.pruned?'本机最多保留最近 '+history.retentionLimit+' 条记录，更早的记录已移出；未清理服务端结果。':'显示上次观察结果；点击“查询远端状态”才核对当前状态。');
      }
      select.onchange=()=>work(update);await update(run);
    });
  }
  async function renderConfig(){
    const summary=make('section','gm-ai-runtime'),runtime=make('p','','本机组件尚未检查'),actions=make('div','gm-ai-actions');summary.append(make('h3','','本机 AI 组件'),runtime,actions);content.append(summary);
    actions.append(button('检查组件',()=>work(async run=>{say('正在检查本机 MCP 启动…');report=await invoke('doctor');if(run!==epoch)return;runtime.textContent=report.ready?'本机组件可用 · MCP 启动检查通过':message(report.checks.find(check=>check.state==='failed')?.code);say('本次只检查本机组件，没有连接远端电脑。');}),'arrow-clockwise'),button('准备组件（需联网）',()=>work(async run=>{say('正在下载并准备本机 AI 组件…');report=await invoke('prepare');if(run!==epoch)return;runtime.textContent=report.ready?'本机组件已准备就绪':message(report.checks.find(check=>check.state==='failed')?.code);say(report.ready?'组件准备完成，可以复制下方配置。':'组件检查未通过，请检查运行环境。');},{write:true})));
    const format=make('select');format.setAttribute('aria-label','AI 客户端配置格式');for(const [value,label]of [['json','通用 MCP JSON'],['codex','Codex TOML'],['codex-cli','Codex 添加命令']]){const option=make('option','',label);option.value=value;format.append(option);}
    const output=make('textarea','gm-ai-config');output.readOnly=true;output.spellcheck=false;output.rows=9;output.setAttribute('aria-label','MCP 配置预览');content.append(field('配置格式',format),output,make('p','gm-muted','把配置粘贴到所用 AI 客户端后启用。这里只生成配置，不自动修改客户端；配置不包含密码或授权码。'));
    const copy=button('复制配置',()=>work(async run=>{await invoke('copy',{format:format.value});if(run===epoch)say('配置已复制，请在 AI 客户端中保存并启用。');}),'copy');copy.classList.add('primary');content.append(copy);
    const update=()=>work(async run=>{output.value='';const result=await invoke('config',{format:format.value});if(run===epoch)output.value=result.text;});format.onchange=update;await update();
  }
  const observer=new MutationObserver(attach);observer.observe(document.body,{childList:true,subtree:true});attach();
  const controller={open,remove(){if(writing)return;close();disposed=true;observer.disconnect();tools.remove();dialog.remove();delete window.gmsshAIController;}};window.gmsshAIController=controller;return controller;
};
