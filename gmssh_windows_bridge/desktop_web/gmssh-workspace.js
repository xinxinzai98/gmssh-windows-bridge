/* Reuse live native views in place. Reparenting a webview would destroy its guest. */
window.installGMSSHWorkspace=function({viewerUrl}){
  if(window.gmsshWorkspaceController)return window.gmsshWorkspaceController;
  const base=new URL(viewerUrl),make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};
  const call=(action,data={})=>window.electronAPI.invoke('render-to-main',{type:'gmssh-workspace',data:{action,data}}).then(reply=>{if(reply?.status!=='ok')throw Error(reply?.code||'WORKSPACE_UNAVAILABLE');return reply.data;});
  const defaults=()=>({layout:'desktop',ratio:.6,zoom:'fit',quality:'balanced',display:0});
  let saved={tabs:[],selected:null,devices:{}},selected=null,visible=false,disposed=false,paint=0,restoreTimer,historyTimer,paneMode='desktop';
  const pinned=new Map(),nativeSessions=new Map(),desktopInstances=new Map();
  const nodes=()=>window.gmsshHomeController?.filesDevices?.()||[],device=id=>nodes().find(n=>n.id===id),prefs=id=>saved.devices[id]||defaults();
  const root=make('section','gm-workspace');root.hidden=true;root.setAttribute('aria-label','设备工作区');
  const head=make('header','gm-workspace-head'),selector=make('select'),nav=make('nav','gm-workspace-modes'),tools=make('nav','gm-workspace-tools'),exits=make('div','gm-workspace-exits'),body=make('div','gm-workspace-body'),note=make('p','gm-workspace-note');selector.setAttribute('aria-label','切换设备工作区');nav.setAttribute('aria-label','工作区视图');tools.setAttribute('aria-label','设备工具');note.setAttribute('role','status');
  const button=(text,fn)=>{const b=make('button','gm-ui-button',text);b.type='button';b.onclick=fn;return b;};
  const icon=name=>{const img=make('img','gm-ui-icon');img.src=new URL('ui-icons/'+name+'.svg',base).href;img.alt='';return img;};
  const toolButton=(label,name,fn)=>{const b=button('',fn);b.append(icon(name),make('span','gm-workspace-button-label',label));b.setAttribute('aria-label',label);b.title=label;return b;};
  const deviceControl=make('div','gm-workspace-device'),deviceIcon=icon('monitor');deviceIcon.classList.add('gm-workspace-device-icon');deviceControl.append(deviceIcon,selector,icon('caret-down'));
  const modes=new Map();for(const [key,label,name] of [['overview','概览','grid-four'],['desktop','桌面','monitor'],['terminal','终端','terminal-window'],['split','分屏','list']]){const b=toolButton(label,name,()=>open(selected,key));modes.set(key,b);nav.append(b);}
  const filesButton=toolButton('文件','folder',()=>window.gmsshFilesController?.open(selected)),toolsButton=toolButton('工具','gear',()=>window.gmsshToolsController?.open(selected,'processes')),historyButton=toolButton('记录','arrows-clockwise',()=>showHistory());modes.set('history',historyButton);tools.append(filesButton,toolsButton,historyButton);
  const ratio=make('input');ratio.type='range';ratio.min='25';ratio.max='75';ratio.setAttribute('aria-label','桌面区域比例');ratio.title='调整桌面与终端的宽度比例';ratio.oninput=()=>{saved.devices[selected]={...prefs(selected),ratio:Number(ratio.value)/100};layout();};ratio.onchange=persist;
  const minimize=toolButton('首页','arrow-left',()=>{hide();document.querySelector('.tabs-home .tab-chip,.tab-chip--home')?.click();}),close=toolButton('关闭工作区','x',()=>closeWorkspace(selected));minimize.setAttribute('aria-label','返回首页');close.classList.add('gm-workspace-icon-only');
  close.title='关闭工作区视图；已打开的连接保留，可在各自桌面或终端标签中断开';exits.append(minimize,close);head.append(deviceControl,nav,ratio,tools,exits);root.append(head,note,body);document.body.append(root);
  const style=make('style');style.textContent=`
    .gm-workspace{position:fixed;inset:48px 0 0;z-index:2147482999;background:var(--gm-bg,#141414);color:var(--gm-text,#eee);font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;flex-direction:column;pointer-events:none}
    .gm-workspace[hidden]{display:none}.gm-workspace *{box-sizing:border-box}
    .gm-workspace-head{display:flex;align-items:center;gap:14px;min-height:54px;padding:8px 16px;background:var(--gm-surface,#202020);border-bottom:1px solid var(--gm-line,#ffffff12);pointer-events:auto;flex:none}
    .gm-workspace-device{position:relative;flex:0 1 228px;min-width:120px}.gm-workspace-device select{appearance:none;-webkit-appearance:none;color-scheme:dark;width:100%;height:34px;padding:0 30px 0 34px;border:1px solid #ffffff14;border-radius:7px;background:#ffffff05;color:#eee;font:inherit;font-weight:550;text-overflow:ellipsis;cursor:pointer}
    .gm-workspace-device>.gm-ui-icon{position:absolute;width:16px;height:16px;right:10px;top:9px;pointer-events:none}.gm-workspace-device>.gm-workspace-device-icon{left:10px;right:auto}.gm-workspace-device select:hover{background:#ffffff09}
    .gm-workspace-head nav,.gm-workspace-exits{display:flex;align-items:center;gap:3px;flex:none}.gm-workspace-modes{padding:3px;background:#14141480;border:1px solid #ffffff08;border-radius:8px}
    .gm-workspace-head .gm-ui-button{min-height:30px;height:30px;padding:0 10px;gap:6px;background:transparent;border:1px solid transparent;border-radius:5px;font-size:12px;color:#a9a9b4;box-shadow:none;flex:none}
    .gm-workspace-head .gm-ui-icon{width:16px;height:16px;opacity:.75}.gm-workspace-head .gm-ui-button:hover:not(:disabled){background:#ffffff09;color:#eee}.gm-workspace-head button[aria-pressed=true]{background:#5667ff24;border-color:#818cf82b;color:#c2c7ff}.gm-workspace-head button[aria-pressed=true] .gm-ui-icon{filter:brightness(0) saturate(100%) invert(79%) sepia(20%) saturate(1392%) hue-rotate(193deg);opacity:1}
    .gm-workspace-tools{margin-left:auto}.gm-workspace-exits{padding-left:12px;border-left:1px solid #ffffff12}.gm-workspace-icon-only{width:30px;padding:0!important}.gm-workspace-icon-only .gm-workspace-button-label{display:none}
    .gm-workspace-head input[type=range]{width:78px;accent-color:#818cf8;flex:none}.gm-workspace-head select:focus-visible,.gm-workspace-head input:focus-visible{outline:2px solid #818cf8;outline-offset:2px}
    .gm-workspace-note{margin:0;padding:6px 16px;font-size:12px;background:#242429;pointer-events:auto}.gm-workspace-note:empty{display:none}.gm-workspace-body{flex:1;min-height:0;overflow:auto}.gm-workspace-body:not(:empty){pointer-events:auto;padding:20px}.gm-workspace-body .gm-device-details{max-width:720px;overflow:visible;height:auto}
    .gm-workspace-history{display:grid;gap:10px;max-width:1100px;margin:auto}.gm-workspace-history article{padding:10px 12px;border:1px solid #ffffff15;border-radius:8px;font-size:13px}.gm-workspace-history article p{margin:5px 0;color:#aaa}
    @media(max-width:1000px){.gm-workspace-head{gap:10px;padding:8px 12px}.gm-workspace-device{flex-basis:190px}.gm-workspace-tools .gm-workspace-button-label,.gm-workspace-exits .gm-workspace-button-label{display:none}.gm-workspace-tools .gm-ui-button,.gm-workspace-exits .gm-ui-button{width:32px;padding:0}.gm-workspace-head input[type=range]{display:none}}
    @media(max-width:640px){.gm-workspace-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:8px 10px}.gm-workspace-device{grid-area:1/1;min-width:0}.gm-workspace-exits{grid-area:1/2;border-left:0;padding-left:0;justify-self:end}.gm-workspace-modes{grid-area:2/1;overflow-x:auto;min-width:0;scrollbar-width:thin}.gm-workspace-head .gm-workspace-modes .gm-ui-button{padding:0 8px}.gm-workspace-tools{grid-area:2/2;justify-self:end}}
  `;
  document.head.append(style);
  function mount(){const host=document.querySelector('.tabs-container');if(visible){const bottom=host?.getBoundingClientRect().bottom||48;root.style.top=Math.max(40,bottom)+'px';layout();}}
  async function persist(){if(disposed)return;try{await call('layout',{tabs:saved.tabs,selected:saved.selected,devices:saved.devices});}catch{note.textContent='工作区布局未能保存，请检查本机存储空间和权限。';}}
  function restorePins(){for(const [node,props] of pinned){for(const [key,[value,priority]] of props){if(value)node.style.setProperty(key,value,priority);else node.style.removeProperty(key);}node.removeAttribute('data-gmssh-workspace-view');}pinned.clear();}
  function pin(node,rect){
    if(!node||!node.isConnected)return;
    const changes={position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',right:'auto',bottom:'auto',opacity:'1',visibility:'visible',display:'block','z-index':'2147483000','pointer-events':'auto'};
    if(!pinned.has(node))pinned.set(node,new Map(Object.keys(changes).map(key=>[key,[node.style.getPropertyValue(key),node.style.getPropertyPriority(key)]])));
    node.setAttribute('data-gmssh-workspace-view',selected);for(const [key,value] of Object.entries(changes))if(node.style.getPropertyValue(key)!==value||node.style.getPropertyPriority(key)!=='important')node.style.setProperty(key,value,'important');
  }
  function nativeView(id,terminal){
    return [...document.querySelectorAll('webview.home-container-view')].find(n=>{try{const u=new URL(n.getAttribute('src')||'');const p=new URLSearchParams(u.hash.slice(u.hash.indexOf('?')+1));return u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)&&/^\/(?:newweb|web)\/?$/.test(u.pathname)&&p.get('machineId')===id&&(p.get('onlyTerm')==='1')===terminal;}catch{return false;}});
  }
  function trackNative(node,id,channel){
    if(!node||nativeSessions.has(node)||device(id)?.windows)return;
    const instance='native-'+crypto.randomUUID(),name=device(id)?.name||'设备';nativeSessions.set(node,{id,channel,instance,name});
    const event=(state,reason)=>call('session',{machineId:id,name,channel,instance,state,...(reason?{reason}:{})}).catch(()=>{note.textContent='连接历史未能保存。';});
    event('opened'); // A mounted native view is observable; its SSH status stays in the native UI.
    node.addEventListener('did-fail-load',()=>event('failed','NATIVE_VIEW_FAILED'),{once:true});
    node.addEventListener('render-process-gone',()=>event('failed','NATIVE_VIEW_CLOSED'),{once:true});
  }
  function layout(){
    if(!visible||!selected||paneMode==='history')return;
    const p=prefs(selected),area=body.getBoundingClientRect(),split=p.layout==='split'&&area.width>=900;
    ratio.hidden=p.layout!=='split';ratio.value=String(Math.round(p.ratio*100));
    if(p.layout==='split'&&!split)note.textContent='窗口较窄，先显示桌面；可切到终端，放大窗口后恢复并排。';
    const desired=new Set(),current=device(selected);
    if(['desktop','split'].includes(p.layout)){
      const node=current?.windows?window.gmsshWindowsControllers?.get(selected)?.frame()?.closest('section'):nativeView(selected,false);
      if(node){desired.add(node);pin(node,{left:area.left,top:area.top,width:split?Math.floor(area.width*p.ratio)-3:area.width,height:area.height});if(!current?.windows)trackNative(node,selected,'desktop');}
    }
    if(p.layout==='terminal'||split){const node=nativeView(selected,true);if(node){desired.add(node);pin(node,{left:split?area.left+Math.floor(area.width*p.ratio)+3:area.left,top:area.top,width:split?area.width-Math.floor(area.width*p.ratio)-3:area.width,height:area.height});trackNative(node,selected,'terminal');}}
    for(const [node,props] of pinned)if(!desired.has(node)){for(const [key,[value,priority]] of props){if(value)node.style.setProperty(key,value,priority);else node.style.removeProperty(key);}node.removeAttribute('data-gmssh-workspace-view');pinned.delete(node);}
  }
  function sendPreferences(id){const frame=window.gmsshWindowsControllers?.get(id)?.frame();if(frame)frame.contentWindow?.postMessage({type:'gmssh-workspace-preferences',preferences:prefs(id)},new URL(frame.src).origin);}
  async function open(id,mode){
    if(disposed||!device(id)||!/^[a-f0-9]{32}$/i.test(id))return;
    if(mode&&!['overview','desktop','terminal','split'].includes(mode))return;
    const permissions=device(id).permissions,wanted=mode||prefs(id).layout;if(permissions&&(wanted==='terminal'&&!permissions.terminal||wanted==='desktop'&&!permissions.view||wanted==='split'&&(!permissions.view||!permissions.terminal)))mode=permissions.view?'desktop':'overview';
    const current=device(id);window.gmsshFilesController?.hide();restorePins();for(const [other,controller] of window.gmsshWindowsControllers||[])if(other!==id)controller.hide();
    clearInterval(historyTimer);paint++;paneMode=mode||prefs(id).layout;selected=saved.selected=id;if(!saved.tabs.includes(id)){if(saved.tabs.length>=50){note.textContent='最多打开 50 台设备工作区，请先关闭不使用的工作区。';return;}saved.tabs.push(id);}
    saved.devices[id]={...prefs(id),...(mode?{layout:mode}:{})};visible=true;root.hidden=false;body.replaceChildren();note.textContent='';
    selector.replaceChildren(...saved.tabs.map(value=>{const option=make('option','',device(value)?.name||'已移除的设备');option.value=value;return option;}));selector.value=id;
    selector.title=current.name;deviceIcon.src=new URL('ui-icons/'+(current.windows?'windows':'monitor')+'.svg',base).href;deviceIcon.style.filter=current.windows?'none':'';filesButton.disabled=!!permissions&&!permissions.files&&!permissions.files_read;
    for(const [key,b] of modes){b.setAttribute('aria-pressed',String(key===prefs(id).layout));b.disabled=!!permissions&&(key==='desktop'&&!permissions.view||key==='terminal'&&!permissions.terminal||key==='split'&&(!permissions.view||!permissions.terminal));}
    if(prefs(id).layout==='overview'){const pane=window.gmsshHomeController?.workspaceOverview?.(id);if(pane)body.append(pane);}
    if(['desktop','split'].includes(prefs(id).layout)){if(current.windows)window.gmsshWindowsControllers?.get(id)?.show?.();else window.gmsshHomeController?.openNative?.(id,'desktop');}
    if(['terminal','split'].includes(prefs(id).layout))window.gmsshHomeController?.openNative?.(id,'terminal');
    mount();sendPreferences(id);await persist();
  }
  function hide(){visible=false;root.hidden=true;restorePins();clearInterval(historyTimer);}
  function closed(id){saved.tabs=saved.tabs.filter(value=>value!==id);if(saved.selected===id)saved.selected=saved.tabs.at(-1)||null;if(selected===id){selected=saved.selected;hide();}void persist();}
  function closeWorkspace(id){closed(id);}
  async function showHistory(){
    if(!selected)return;paneMode='history';restorePins();for(const c of window.gmsshWindowsControllers?.values()||[])c.hide();body.replaceChildren();ratio.hidden=true;const epoch=++paint,container=make('div','gm-workspace-history');body.append(container);for(const [key,b] of modes)b.setAttribute('aria-pressed',String(key==='history'));
    const filter=make('select'),retention=make('select'),exportButton=button('导出连接历史',()=>call('export').then(()=>{note.textContent='连接历史已导出；设备配置和凭据请使用配置备份。';}).catch(()=>{note.textContent='历史导出未完成。';})),rows=make('div');filter.setAttribute('aria-label','筛选历史设备');retention.setAttribute('aria-label','连接历史保留时间');
    for(const [id,name] of [['','全部设备'],...nodes().map(n=>[n.id,n.name])]){const o=make('option','',name);o.value=id;filter.append(o);}filter.value=selected;for(const days of [7,30,90,365]){const o=make('option','',days+' 天');o.value=String(days);retention.append(o);}container.append(make('p','gm-muted','仅记录连接时间、结果和原因；原生终端的“已打开”表示窗口已打开，SSH 状态以终端内显示为准。'),filter,retention,exportButton,rows);
    const labels={connecting:'连接中',connected:'已连接',opened:'已打开原生窗口',failed:'连接失败',interrupted:'应用异常退出',completed:'已完成',disconnected:'已断开'},channels={desktop:'桌面',terminal:'终端',files:'文件',tools:'系统工具'};let limit=100,data;
    function render(){rows.replaceChildren();const list=data.sessions.filter(s=>!filter.value||s.machineId===filter.value).reverse();for(const s of list.slice(0,limit)){const row=make('article');row.append(make('strong','',s.name+' · '+channels[s.channel]+' · '+labels[s.state]),make('p','',new Date(s.started).toLocaleString()+' → '+(s.ended===null?'进行中':new Date(s.ended).toLocaleString())),make('p','',Math.round(s.duration/1000)+' 秒'+(s.reason?' · '+s.reason:'')));rows.append(row);}if(!list.length)rows.append(make('p','gm-muted','尚无连接记录'));if(list.length>limit)rows.append(button('显示更多',()=>{limit+=100;render();}));}
    async function refresh(){try{data=await call('get');if(epoch!==paint||!visible||disposed)return;retention.value=String(data.retention);render();}catch{note.textContent='历史记录无法读取，原文件已保留。';}}
    filter.onchange=()=>{limit=100;render();};retention.onchange=()=>call('retention',{days:Number(retention.value)}).then(refresh).catch(()=>{note.textContent='保留时间未能保存。';});await refresh();clearInterval(historyTimer);historyTimer=setInterval(refresh,2000);
  }
  selector.onchange=()=>open(selector.value);
  function receive(event){
    if(event.data?.type!=='gmssh-workspace-desktop')return;
    for(const [id,c] of window.gmsshWindowsControllers||[]){const frame=c.frame();if(!frame||event.source!==frame.contentWindow||event.origin!==new URL(frame.src).origin)continue;
      const d=event.data,current=device(id);if(!current)return;
      if(d.permissions){const p=d.permissions;if(['clipboard,files,input,power,terminal,view','clipboard,files,files_read,input,power,terminal,view'].includes(Object.keys(p).sort().join())&&Object.values(p).every(value=>typeof value==='boolean'))window.gmsshHomeController?.permissions?.(id,p);return;}
      if(d.preferences){const p=d.preferences;if(['fit','100'].includes(p.zoom)&&['low','balanced','best'].includes(p.quality)&&Number.isInteger(p.display)&&p.display>=0&&p.display<=31){saved.devices[id]={...prefs(id),zoom:p.zoom,quality:p.quality,display:p.display};void persist();}return;}
      if(typeof d.instance!=='string'||!/^[\w-]{1,100}$/.test(d.instance)||!['connecting','connected','disconnected','failed'].includes(d.state))return;
      desktopInstances.set(id,d.instance);void call('session',{machineId:id,name:current.name,channel:'desktop',instance:d.instance,state:d.state,...(typeof d.reason==='string'&&/^[A-Z_]{1,48}$/.test(d.reason)?{reason:d.reason}:{})}).catch(()=>{note.textContent='连接历史未能保存。';});sendPreferences(id);return;
    }
  }
  const observer=new MutationObserver(()=>{mount();for(const [node,s] of nativeSessions)if(!node.isConnected){nativeSessions.delete(node);void call('session',{machineId:s.id,name:s.name,channel:s.channel,instance:s.instance,state:'disconnected',reason:'NATIVE_VIEW_CLOSED'}).catch(()=>{});}for(const [id,instance] of desktopInstances)if(!window.gmsshWindowsControllers?.get(id)?.frame()?.isConnected){desktopInstances.delete(id);void call('session',{machineId:id,name:device(id)?.name||'设备',channel:'desktop',instance,state:'disconnected',reason:'TAB_CLOSED'}).catch(()=>{});}});
  observer.observe(document.body,{childList:true,subtree:true});window.addEventListener('resize',mount);window.addEventListener('message',receive);document.addEventListener('click',click,true);
  function click(event){if(event.target instanceof Element&&event.target.closest('.tabs-container .tab-chip'))hide();}
  const controller={open,hide,closed,remove(){disposed=true;hide();clearInterval(restoreTimer);observer.disconnect();window.removeEventListener('resize',mount);window.removeEventListener('message',receive);document.removeEventListener('click',click,true);root.remove();style.remove();delete window.gmsshWorkspaceController;}};window.gmsshWorkspaceController=controller;mount();
  void call('get').then(value=>{if(disposed)return;saved={tabs:value.tabs,selected:value.selected,devices:value.devices};for(const id of saved.tabs)window.gmsshWindowsControllers?.get(id)?.reserve?.();let attempts=0;restoreTimer=setInterval(()=>{if(disposed||++attempts>40){clearInterval(restoreTimer);return;}if(saved.selected&&device(saved.selected)){clearInterval(restoreTimer);void open(saved.selected);}},500);}).catch(()=>{note.textContent='本机工作区记录暂不可用；仍可手动打开设备。';});return controller;
};
