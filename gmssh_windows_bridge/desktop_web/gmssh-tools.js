/* Read-only device tools. Rendering uses text nodes, including untrusted log text. */
window.installGMSSHTools=function({viewerUrl}){
  window.gmsshToolsController?.remove();
  const base=new URL(viewerUrl),make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};
  const icon=name=>{const n=make('img','gm-ui-icon');n.src=new URL('ui-icons/'+name+'.svg',base).href;n.alt='';return n;};
  const button=(text,fn,name)=>{const n=make('button','gm-ui-button',text);n.type='button';n.onclick=fn;if(name)n.prepend(icon(name));return n;};
  const names={diagnostics:'连接诊断',processes:'进程',services:'服务',logs:'日志'};
  const stateNames={unchecked:'未检查',checking:'检查中',passed:'通过',failed:'失败',unsupported:'不支持'};
  const stageNames={target:'连接配置',tcp:'连接端口',identity:'主机身份',auth:'会话认证',monitor:'监控查询',files:'文件通道',desktopTransport:'桌面通道',desktopHandshake:'桌面握手',desktopAuth:'桌面认证',firstFrame:'首帧画面',frames:'画面接收'};
  const codes={TLS_PIN_VERIFIED:'已核对授权服务的 TLS 证书',TLS_PIN_CHANGED:'授权服务证书已变化，请重新核对授权码',CONTROLLER_AUTHENTICATED:'独立授权已通过服务端认证',CONTROLLER_AUTH_FAILED:'独立授权已失效或被撤销，请重新获取授权码',CONTROLLER_SESSION_REQUIRED:'请先连接这台设备的授权通道',CONTROLLER_FILES_READY:'授权文件通道已就绪',OK:'查询完成',SAVED_TARGET:'已读取保存的连接配置',TCP_REACHABLE:'TCP 连接可达',TCP_TIMEOUT:'连接超时，请检查设备和网络',TCP_REFUSED:'目标拒绝连接，请检查 SSH 服务',TCP_UNREACHABLE:'设备或网络不可达',ADDRESS_UNRESOLVED:'地址无法解析',TARGET_UNKNOWN:'未取得真实目标地址',NON_DEVICE_TARGET:'当前配置为本机桥地址，未探测远端',SSH_PIN_VERIFIED:'已核对保存的 SSH 主机密钥',HOST_KEY_CHANGED:'主机密钥已变化，请先核实设备身份',IDENTITY_NOT_OBSERVED:'尚无本次主机身份核验记录',SSH_AUTHENTICATED:'已有通过认证的 SSH 会话',SSH_AUTH_FAILED:'SSH 认证失败，请核对账号或密码',SSH_SESSION_REQUIRED:'请先连接这台设备的监控',SSHPoolUnavailable:'当前没有可复用的 SSH 会话，请先连接监控',MONITOR_OK:'监控查询已返回有效数据',MONITOR_QUERY_FAILED:'监控查询失败',SFTP_READY:'SFTP 子系统已就绪',SFTP_UNAVAILABLE:'无法打开 SFTP，请检查服务或权限',ACCESS_DENIED:'当前账号没有读取权限',QUERY_FAILED:'查询失败，请检查连接和权限',QUERY_TIMEOUT:'查询超时，可以稍后重试',INVALID_RESPONSE:'返回内容不完整或不受支持',INVALID_QUERY:'查询选项无效',LOCAL_SERVICE_UNAVAILABLE:'本地桥服务未就绪，请检查启动器',LOCAL_ACCESS_DENIED:'本机授权已失效，请重新打开应用',QUERY_UNSUPPORTED:'此版本尚不支持该查询',TOOL_UNAVAILABLE:'远端缺少查询工具',EVENT_LOG_UNAVAILABLE:'远端不支持 Windows 事件日志',SERVICE_BACKEND_UNAVAILABLE:'远端未运行 systemd 服务管理器',NATIVE_SESSION_REQUIRED:'请先使用这台 Linux 设备的原生桌面入口建立会话，再刷新',NATIVE_SDK_UNAVAILABLE:'原生会话未提供只读查询接口',NATIVE_QUERY_FAILED:'原生会话查询失败，请检查连接或权限',NATIVE_SESSION_READY:'原生会话已完成查询',NATIVE_QUERY_OK:'原生只读查询已返回',NATIVE_IDENTITY_NOT_EXPOSED:'GMSSH 原生接口未提供主机密钥核验结果',NATIVE_SFTP_NOT_EXPOSED:'原生接口未提供独立 SFTP 探测，本项未检查',NATIVE_DESKTOP_NOT_EXPOSED:'Linux 桌面由 GMSSH 管理，本面板未探测画面',DEVICE_CONFIG_UNAVAILABLE:'设备配置不可读，请先解锁 GMSSH 机器仓库',QUERY_BUSY:'上一次查询尚未结束，请稍后刷新',LOG_RECORD_UNAVAILABLE:'该记录已轮转或不可读，请刷新列表',DESKTOP_NOT_OPEN:'尚未打开此设备的桌面',DESKTOP_STATE_UNAVAILABLE:'查看器未返回诊断状态',DESKTOP_CONNECTING:'正在建立桌面通道',DESKTOP_TRANSPORT_READY:'桌面通道已就绪',DESKTOP_TRANSPORT_FAILED:'桌面通道建立失败',DESKTOP_HANDSHAKE_PENDING:'SSH 隧道已打开，等待 RustDesk 协议响应',DESKTOP_HANDSHAKE_OK:'已收到有效 RustDesk 握手',DESKTOP_HANDSHAKE_FAILED:'未收到有效 RustDesk 协议响应',DESKTOP_HANDSHAKE_TIMEOUT:'等待 RustDesk 握手超时，请检查桌面引擎',DESKTOP_AUTH_PENDING:'正在等待桌面认证或远端确认',DESKTOP_AUTH_OK:'远端已批准桌面连接',DESKTOP_AUTH_FAILED:'远端未批准桌面连接',DESKTOP_LOGIN_TIMEOUT:'等待桌面登录超时',FIRST_FRAME_PENDING:'已认证，正在等待首帧',FIRST_FRAME_TIMEOUT:'桌面已认证，但 15 秒内没有收到首帧',FIRST_FRAME_OK:'已收到首帧画面',FRAMES_RECEIVED:'已接收并解码画面',DESKTOP_DISCONNECTED:'桌面连接已断开',UNKNOWN_STATUS:'未识别的状态'};
  const textCode=code=>codes[code]||codes.UNKNOWN_STATUS;
  const time=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():'—';
  const bytes=value=>Number.isFinite(value)?value>=1073741824?(value/1073741824).toFixed(2)+' GiB':(value/1048576).toFixed(1)+' MiB':'—';
  const dialog=make('dialog','gm-tools-dialog');dialog.setAttribute('aria-label','设备只读工具');
  const title=make('h2'),subtitle=make('p','gm-muted'),head=make('div','gm-tools-head'),heading=make('div');heading.append(title,subtitle);head.append(heading,button('关闭',close,'x'));
  const tabs=make('div','gm-tools-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','只读工具');
  for(const [key,label] of Object.entries(names)){const n=button(label,()=>select(key));n.dataset.tool=key;n.setAttribute('role','tab');tabs.append(n);}
  const filters=make('div','gm-tools-filters'),body=make('div','gm-tools-body'),status=make('p','gm-tools-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const refresh=button('刷新',()=>void load(),'arrow-clockwise'),report=button('导出诊断',exportReport,'download-simple'),footer=make('div','gm-tools-footer');footer.append(status,report,refresh);dialog.append(head,tabs,filters,body,footer);document.body.append(dialog);
  let deviceId,tool='diagnostics',kind='windows',epoch=0,busy=false,context,capabilities,versions={},snapshot,disposed=false;
  let search='',sort='cpu',limit=100,source='system',hours=6;
  const cache=new Map();
  function close(){epoch++;dialog.close();busy=false;cache.clear();context=undefined;capabilities=undefined;snapshot=undefined;body.replaceChildren();}
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  function say(value){status.textContent=value;}
  function lock(value){busy=value;refresh.disabled=value;filters.querySelectorAll('input,select,button').forEach(n=>n.disabled=value);tabs.querySelectorAll('button').forEach(n=>n.disabled=value);}
  async function invoke(next,options){const r=await window.electronAPI?.invoke('render-to-main',{type:'gmssh-tools-query',data:{machineId:deviceId,tool:next,options}});if(r?.status!=='ok')throw Error(r?.code||'QUERY_FAILED');if(!r.data?.context||!r.data.result)throw Error(r.data?.error||'INVALID_RESPONSE');return r.data;}
  function useResult(response){context=response.context;kind=context.kind;source=kind==='windows'?(source==='application'?'application':'system'):'journal';subtitle.textContent=(context.name||'设备')+' · '+context.address;if(response.result.error)throw Error(response.result.error);return response.result;}
  function options(){return tool==='diagnostics'?{}:tool==='processes'||tool==='services'?{search,sort,limit}:{source,limit,hours};}
  function labelled(label,input){const n=make('label','gm-tools-field');n.append(make('span','gm-muted',label),input);return n;}
  function selectBox(label,values,value,change){const n=make('select');n.setAttribute('aria-label',label);for(const [key,text] of values){const opt=make('option','',text);opt.value=key;n.append(opt);}n.value=String(value);n.onchange=()=>{change(n.value);};filters.append(labelled(label,n));return n;}
  function filterBar(){
    filters.replaceChildren();
    if(tool==='processes'||tool==='services'){
      const input=make('input');input.type='search';input.maxLength=64;input.placeholder=tool==='processes'?'搜索名称或 PID':'搜索服务名称';input.value=search;input.setAttribute('aria-label','搜索');input.oninput=()=>{search=input.value;};input.onkeydown=e=>{if(e.key==='Enter')void load();};filters.append(input);
      selectBox('排序',tool==='processes'?[['cpu','CPU 使用'],['memory','内存占用'],['pid','PID'],['name','名称']]:[['name','名称'],['state','状态']],sort,v=>{sort=v;void load();});
      filters.append(button('查询',()=>void load(),'magnifying-glass'));
    }else if(tool==='logs'){
      selectBox('日志源',kind==='windows'?[['system','系统'],['application','应用程序']]:[['journal','系统日志']],source,v=>{source=v;void load();});
      selectBox('范围',[['1','最近 1 小时'],['6','最近 6 小时'],['24','最近 24 小时']],hours,v=>{hours=Number(v);void load();});
    }
    if(tool!=='diagnostics')selectBox('条数',[['50','50 条'],['100','100 条'],['200','200 条']],limit,v=>{limit=Number(v);void load();});
  }
  function select(next){if(busy)return;tool=next;sort=next==='services'?'name':'cpu';search='';filterBar();for(const n of tabs.children)n.setAttribute('aria-selected',String(n.dataset.tool===tool));report.hidden=tool!=='diagnostics';void load();}
  async function desktopState(run){
    const frame=window.gmsshWindowsControllers?.get(deviceId)?.frame?.();
    if(!frame)return {stages:['desktopTransport','desktopHandshake','desktopAuth','firstFrame','frames'].map(id=>({id,state:'unchecked',code:'DESKTOP_NOT_OPEN'}))};
    let origin;try{origin=new URL(frame.src).origin;if(!['127.0.0.1','localhost'].includes(new URL(frame.src).hostname))throw Error();}catch{return {stages:[]};}
    return new Promise(resolve=>{
      const requestId=String(run)+'-'+Date.now();let timer;
      const done=value=>{clearTimeout(timer);window.removeEventListener('message',receive);resolve(value);};
      const receive=event=>{if(event.source!==frame.contentWindow||event.origin!==origin||event.data?.type!=='gmssh-desktop-state'||event.data.requestId!==requestId)return;const value=event.data.data;if(!value||!Array.isArray(value.stages))return;done(value);};
      window.addEventListener('message',receive);timer=setTimeout(()=>done({stages:['desktopTransport','desktopHandshake','desktopAuth','firstFrame','frames'].map(id=>({id,state:'unchecked',code:'DESKTOP_STATE_UNAVAILABLE'}))}),1800);
      frame.contentWindow?.postMessage({type:'gmssh-desktop-state-request',requestId},origin);
    });
  }
  async function load(){
    if(busy||disposed||!dialog.open)return;
    const run=++epoch,selectedTool=tool;lock(true);say('正在查询，只读取设备信息…');
    if(!cache.has(tool))body.replaceChildren(make('p','gm-muted','正在读取…'));
    try{
      const result=await invoke(tool,options());if(run!==epoch||!dialog.open)return;
      useResult(result);versions={...versions,...result.result.versions};
      if(result.result.state==='failed')throw Error(result.result.code);
      if(tool==='diagnostics'&&kind==='windows'){const state=await desktopState(run);if(run!==epoch||!dialog.open)return;result.result.stages.push(...state.stages);if(typeof state.engineVersion==='string')versions.engine=state.engineVersion;result.result.metrics=state.metrics;}
      if(run!==epoch||!dialog.open)return;
      if(!result.result.state||result.result.state==='passed')cache.set(tool,result.result);if(tool==='diagnostics')snapshot=result.result;render(result.result);say('采样时间：'+time(result.result.sampledAt)+(result.result.truncated?' · 仅显示限量结果':''));
    }catch(error){if(run!==epoch||!dialog.open)return;const previous=cache.get(selectedTool);if(previous){render(previous);say(textCode(error.message)+' · 保留上次数据，采样于 '+time(previous.sampledAt)+'，不代表当前筛选结果');}else{body.replaceChildren(make('div','gm-tools-empty',textCode(error.message)));say('未取得数据 · '+textCode(error.message));}}
    finally{if(run===epoch&&dialog.open)lock(false);}
  }
  function render(value){
    body.replaceChildren();
    if(value.state&&value.state!=='passed'){body.append(make('div','gm-tools-empty',textCode(value.code)));return;}
    if(tool==='diagnostics'){
      const intro=make('p','gm-muted','本次检查不会重新登录或修改远端设置。TCP 延迟是 SSH 端口建连耗时。');body.append(intro);
      const list=make('div','gm-diagnostic-stages');
      for(const stage of value.stages||[]){const row=make('div','gm-diagnostic-stage'),badge=make('span','gm-stage-state '+(stage.state||'unchecked'),stateNames[stage.state]||'未检查'),detail=make('div');detail.append(make('strong','',stageNames[stage.id]||stage.id),make('p','gm-muted',textCode(stage.code)+(Number.isFinite(stage.latencyMs)?' · '+stage.latencyMs+' ms':'')),make('small','gm-muted',time(stage.sampledAt||value.sampledAt)));row.append(badge,detail);list.append(row);}body.append(list);
      const version=make('p','gm-tools-versions');version.textContent='管理端 '+(versions.controller||'未知')+' · 桥 '+(versions.bridge||'未知')+' · 服务端 '+(versions.server||'未知')+' · 桌面引擎 '+(versions.engine||'未知');body.append(version);
      body.append(make('p','gm-muted','只读工具：'+['processes','services','logs'].map(key=>names[key]+' '+(capabilities?.[key]===true?'可查询':capabilities?.[key]===false?'不支持':'未知')).join(' · ')));
      if(value.metrics){const m=value.metrics;body.append(make('p','gm-muted','本次会话平均解码 '+(Number.isFinite(m.fps)?m.fps+' FPS':'—')+' · 接收负载 '+(Number.isFinite(m.kibPerSecond)?m.kibPerSecond+' KiB/s':'—')+' · 距上一帧 '+(Number.isFinite(m.lastFrameAgeSeconds)?m.lastFrameAgeSeconds+' 秒':'—')+'。静止画面可能不产生新帧；这些数值不代表端到端延迟。'));}
      return;
    }
    const items=value.items||[];
    if(tool==='processes')body.append(make('p','gm-muted',value.units?.cpu==='ps-lifetime-average'?'CPU 为 ps 报告的进程生存期平均值，可超过 100%；内存为常驻集 RSS。':'CPU 为约 '+(value.units?.sampleSeconds||1)+' 秒采样并按逻辑处理器数归一；内存为工作集。无法读取的字段显示 —。'));
    if(tool==='services'&&kind==='linux')body.append(make('p','gm-muted','读取 systemd 服务状态；本页不启动、停止或修改服务。启动方式未查询的字段显示 —。'));
    if(tool==='logs'&&kind==='linux')body.append(make('p','gm-muted','仅显示当前账号可读的 journal 记录；没有记录不代表整个系统没有日志。'));
    if(!items.length){body.append(make('div','gm-tools-empty','查询成功，当前筛选条件下没有记录。'));return;}
    const table=make('table','gm-tools-table'),thead=make('thead'),headRow=make('tr');
    const labels=tool==='processes'?['PID','名称','CPU','内存']:tool==='services'?['名称','说明','状态','启动方式']:['时间','级别','来源','摘要',''];for(const label of labels)headRow.append(make('th','',label));thead.append(headRow);table.append(thead);const tbody=make('tbody');
    for(const item of items){const row=make('tr');
      const readable=value=>({Running:'运行中',Stopped:'已停止',Paused:'已暂停',Auto:'自动',Manual:'手动',Disabled:'已禁用'}[value]||value||'—');
      const cells=tool==='processes'?[item.pid,item.name,Number.isFinite(item.cpuPercent)?item.cpuPercent+'%':'—',bytes(item.memoryBytes)]:tool==='services'?[item.name,item.displayName,readable(item.state),readable(item.startType)]:[time(item.time),item.level||'—',item.provider,item.preview];
      for(const value of cells){const cell=make('td','',value);cell.title=String(value);row.append(cell);}
      if(tool==='logs'){const cell=make('td');cell.append(button('详情',()=>void logDetail(item)));row.append(cell);}tbody.append(row);
    }table.append(tbody);body.append(table);
  }
  async function logDetail(item){
    if(busy)return;const run=++epoch;lock(true);say('正在读取此条日志…');
    try{const {result}=await invoke('log-detail',{source:item.source,recordId:item.recordId});if(run!==epoch||!dialog.open)return;if(result.state!=='passed')throw Error(result.code);const entry=result.items?.[0];if(!entry)throw Error('LOG_RECORD_UNAVAILABLE');const box=make('section','gm-log-detail'),bar=make('div','gm-tools-head');bar.append(make('strong','',time(entry.time)+' · '+entry.provider),button('收起',()=>box.remove(),'x'));box.append(bar,make('pre','',entry.message||'此记录没有可读取的正文。'));if(entry.messageTruncated)box.append(make('p','gm-muted','正文仅显示前 4096 个字符。'));body.querySelector('.gm-log-detail')?.remove();body.prepend(box);body.scrollTop=0;say('已读取单条日志正文；诊断报告不包含日志。');}
    catch(error){if(run===epoch)say(textCode(error.message));}finally{if(run===epoch&&dialog.open)lock(false);}
  }
  function exportReport(){
    if(!snapshot){say('请先完成一次连接诊断。');return;}
    const safeTime=value=>Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
    const report={schema:1,createdAt:new Date().toISOString(),kind,versions:Object.fromEntries(['controller','bridge','server','engine'].map(key=>[key,typeof versions[key]==='string'&&/^\d+[\d.a-zA-Z+-]{0,63}$/.test(versions[key])?versions[key]:null])),stages:(snapshot.stages||[]).filter(stage=>stageNames[stage.id]).map(stage=>({id:stage.id,state:stateNames[stage.state]?stage.state:'unchecked',code:codes[stage.code]?stage.code:'UNKNOWN_STATUS',sampledAt:safeTime(stage.sampledAt||snapshot.sampledAt)}))};
    const blob=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),a=make('a');a.href=blob;a.download='GMSSH-diagnostics-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(blob),1000);say('已导出诊断结果，不含地址、设备名、凭据或日志正文。');
  }
  async function open(id,next='diagnostics'){
    if(!/^[a-f0-9]{32}$/i.test(id))return;epoch++;deviceId=id;cache.clear();context=undefined;snapshot=undefined;versions={};capabilities=undefined;busy=false;title.textContent='设备工具';subtitle.textContent='正在读取设备信息';if(!dialog.open)dialog.showModal();
    const run=++epoch;lock(true);say('正在读取设备能力…');body.replaceChildren();
    try{const result=await invoke('capabilities',{});if(run!==epoch||!dialog.open)return;useResult(result);capabilities=result.result.capabilities;versions=result.result.versions||{};}
    catch(error){if(run!==epoch||!dialog.open)return;say(textCode(error.message));}
    finally{if(run===epoch&&dialog.open){lock(false);select(next);}}
  }
  const controller={open,remove(){disposed=true;epoch++;dialog.remove();}};window.gmsshToolsController=controller;return controller;
};
