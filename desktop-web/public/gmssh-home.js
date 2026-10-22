/* Present the native GMSSH machine DOM; credentials and records stay in GMSSH. */
window.installWindowsUpdateNotice = function ({ version }) {
  const anchor = document.querySelector('.tabs-home');
  if (!anchor?.parentElement) return;
  let notice = document.getElementById('gmssh-vendor-update');
  if (!notice) {
    notice = document.createElement('a'); notice.id = 'gmssh-vendor-update';
    notice.href = 'https://www.gmssh.com/changelog'; notice.target = '_blank'; notice.rel = 'noopener';
    notice.style.cssText = 'margin-left:auto;margin-right:12px;padding:5px 9px;flex-shrink:0;color:#b6bdd6;font-size:11px;text-decoration:none;border:1px solid #ffffff20;border-radius:6px;';
    anchor.parentElement.append(notice);
  }
  notice.textContent = `GMSSH ${version || '新版本'} · 待兼容验证`;
  notice.title = '官方更新包不包含 Windows 增强功能，请使用验收后的兼容包更新。点击查看官方更新说明。';
};

window.installWindowsMachinePolicy = function (options) {
  window.removeWindowsMachinePolicy?.();
  const bridges=Array.isArray(options)?options:[options];
  if (bridges.some(({bridgePort,username})=>!Number.isInteger(bridgePort)||bridgePort<1||bridgePort>65535||typeof username!=='string'||!username)) throw Error('Verified Windows bridge required');
  const prototype = window.XMLHttpRequest.prototype;
  const open = prototype.open, send = prototype.send, requests = new WeakMap();
  const wrappedOpen = function (method, url, ...options) {
    let windowsEndpoint = false;
    try {
      const address = new URL(url, window.location.href);
      windowsEndpoint = String(method).toUpperCase() === 'POST' && address.protocol === 'http:' &&
        ['127.0.0.1', 'localhost'].includes(address.hostname) && !address.username && !address.password &&
        ['/node/add', '/node/edit'].includes(address.pathname);
    } catch {}
    requests.set(this, windowsEndpoint);
    return open.call(this, method, url, ...options);
  };
  const wrappedSend = function (body) {
    if (requests.get(this) && typeof body === 'string') {
      try {
        const data = JSON.parse(body);
        if (data && !Array.isArray(data) && ['127.0.0.1', 'localhost'].includes(data.ip) &&
            bridges.some(({bridgePort,username})=>Number(data.port)===bridgePort&&data.userName===username)) {
          data.sudoPolicy = 'skip';
          delete data.sudoPassword;
          body = JSON.stringify(data);
        }
      } catch {}
    }
    return send.call(this, body);
  };
  prototype.open = wrappedOpen; prototype.send = wrappedSend;
  window.removeWindowsMachinePolicy = () => {
    if (prototype.open === wrappedOpen) prototype.open = open;
    if (prototype.send === wrappedSend) prototype.send = send;
  };
};

window.installGMSSHHome = function ({ viewerUrl, machineId, target, targetPort = 22, css = '', accessToken, devices }) {
  window.removeGMSSHHome?.();
  const base = new URL(viewerUrl);
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname)) throw Error('Local assets required');
  const connections=devices||[{viewerUrl,machineId,target,targetPort,accessToken}];
  for(const device of connections){const url=new URL(device.viewerUrl);if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.username||url.password||url.hash||url.search)throw Error('Local device required');}
  const byId=new Map(connections.filter(device=>device.machineId).map(device=>[device.machineId,device]));
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  let root, host, selected, fingerprint = '', timer, noticeTimer, disposed = false, infoBusy = false, infoFrame, infoReady, infoOrigin, infoRequestId = 0, cancelInfo, filesTimer, contextMenu;
  const metadata = new Map(), systemInfo = new Map(), currentRecords = new Map(), routeInfo = new Map(), scrollPositions = {list:{top:0,left:0},card:{top:0,left:0}};
  const infoCodes = new Set(['OPERATION_TIMEOUT','QUERY_FAILED','REMOTE_IO','ACCESS_DENIED','AUTH_FAILED','PEER_CHANGED','INVALID_RESPONSE','MONITOR_UNAVAILABLE','OPERATIONS_UNAVAILABLE','LOCAL_AUTH_FAILED','SYSTEM_INFO_TIMEOUT','SYSTEM_INFO_CHANNEL_CLOSED']);
  const infoStages = new Set(['frame','connect','authorize','query']);
  let routeQuery='',routeSampled=0,routeBusy=false;
  const fitWorkspace = () => { if (root?.getClientRects().length) root.style.height = Math.max(0, window.innerHeight - Math.max(0, root.getBoundingClientRect().top)) + 'px'; };
  const make = (tag, className, text) => { const node = document.createElement(tag); node.className = className || ''; if (text !== undefined) node.textContent = text; return node; };
  const icon = name => { const node = make('img', 'gm-ui-icon'); node.src = new URL('ui-icons/' + name + '.svg', base).href; node.alt = ''; return node; };
  const labelled = (tag, text, name) => { const node = make(tag, 'gm-labelled', text); node.prepend(icon(name)); return node; };
  const action = (text, name, callback, primary = false, disabled = false) => {
    const button = make('button', 'gm-ui-button' + (primary ? ' primary' : ''), text);
    button.type = 'button'; button.prepend(icon(name)); button.disabled = disabled; button.onclick = callback; return button;
  };
  const detailsDialog=make('dialog','gm-device-dialog');detailsDialog.setAttribute('aria-label','设备详情');
  const dialogHeader=make('div','gm-device-dialog-head');dialogHeader.append(make('strong','','设备详情'),action('关闭','x',()=>detailsDialog.close()));
  detailsDialog.append(dialogHeader);document.body.append(detailsDialog);let dialogDeviceId;
  detailsDialog.addEventListener('close',()=>{detailsDialog.querySelector('.gm-device-details')?.remove();detailsDialog.querySelector('.gm-home-status')?.remove();});
  function refreshDetailsDialog() {
    if(!detailsDialog.open)return;
    const record=currentRecords.get(dialogDeviceId);if(!record){detailsDialog.close();return;}
    const previous=detailsDialog.querySelector('.gm-device-details'),scroll=previous?.scrollTop||0,active=document.activeElement;
    const label=previous?.contains(active)?active.getAttribute('aria-label')||active.textContent:null;
    const pane=detailPane(record);if(previous)previous.replaceWith(pane);else detailsDialog.append(pane);pane.scrollTop=scroll;
    if(label)[...pane.querySelectorAll('button')].find(button=>(button.getAttribute('aria-label')||button.textContent)===label)?.focus({preventScroll:true});
  }
  function openDetails(id) {dialogDeviceId=selected=id;fingerprint='';render();if(!detailsDialog.open)detailsDialog.showModal();refreshDetailsDialog();}
  function notify(text) {
    if (!root) return;
    root.querySelector('.gm-home-status')?.remove();detailsDialog.querySelector('.gm-home-status')?.remove();
    const notice = make('div', 'gm-home-status'); notice.setAttribute('role', 'status'); (detailsDialog.open?detailsDialog:root).append(notice);
    clearTimeout(noticeTimer); notice.textContent = text; notice.hidden = false;
    noticeTimer = setTimeout(() => { notice.hidden = true; }, 3000);
  }
  const size = value => {
    if (!Number.isFinite(value) || value < 0) return '—';
    const power = Math.min(4, Math.floor(Math.log(Math.max(1,value)) / Math.log(1024)));
    return (value / 1024 ** power).toFixed(power ? 1 : 0) + ' ' + ['B','KB','MB','GB','TB'][power];
  };
  const capacity = value => value?.split('/').pop()?.trim() || '—';
  const nativeCards = () => [...document.querySelectorAll('.machine-card-scroll [data-machine-id], .list-item-group[data-machine-id], [data-windows-desktop-card]')].filter(node => !node.closest('#gmssh-machine-workspace') && !node.hidden);
  const publicFields = ['osName','cpuCores','memoryTotal','diskTotal','publicIp','port','runTime','processNum','activeProcessNum','lastUpdateTime'];
  const publicInfo = value => {
    const info=Object.fromEntries(publicFields.filter(key => typeof value?.[key] === 'string' || Number.isFinite(value?.[key])).map(key => [key,value[key]]));
    const bytes=value=>typeof value==='number'?value:typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)?Number(value):NaN;
    if(Array.isArray(value?.disks))info.disks=value.disks.slice(0,128).filter(disk=>typeof disk?.device==='string')
      .map(disk=>({name:disk.device.slice(0,512),total:bytes(disk.total),used:bytes(disk.used)}))
      .filter(disk=>Number.isFinite(disk.total)&&disk.total>=0&&Number.isFinite(disk.used)&&disk.used>=0&&disk.used<=disk.total);
    return info;
  };
  function nativeModels(cards) {
    const wanted=new Set(cards.map(node=>node.dataset.machineId)),models=new Map(),seen=new Set(),pending=[document.getElementById('app')?._vnode];
    // Production Vue keeps the root vnode, but omits DOM __vueParentComponent links.
    // ponytail: pinned GMSSH/Vue tree; replace with a public snapshot API when available.
    for(let count=0;pending.length&&count<20000;count++){
      const node=pending.pop();if(!node||typeof node!=='object'||seen.has(node))continue;seen.add(node);
      const component=node.component;
      for(const value of [component?.props?.item,component?.props?.record,node.props?.item,node.props?.record])if(typeof value?.id==='string'&&wanted.has(value.id))models.set(value.id,{...models.get(value.id),...publicInfo(value)});
      if(component?.subTree)pending.push(component.subTree);
      if(node.suspense?.activeBranch)pending.push(node.suspense.activeBranch);
      if(Array.isArray(node.children))pending.push(...node.children.slice(0,1000));
    }
    return models;
  }
  const details = (node,models) => {
    const get = selector => node.querySelector(selector)?.textContent.trim() || '';
    const id = node.dataset.machineId, binding=byId.get(id)||(node.hasAttribute('data-windows-desktop-card')?connections[0]:undefined), windows=!!binding;
    const name = get('.machine-name .name-txt') || get('.windows-card-name') || get('.machine-name') || id;
    const shownAddress = get('.machine-ip') || get('.windows-card-host').split(' · ')[0];
    const configuredAddress = windows && binding.target ? binding.target : shownAddress || '—';
    const metrics = [...node.querySelectorAll('.machine-progress')].map(metric => metric.querySelector('.label-value')?.textContent.trim() || metric.querySelector('.label')?.textContent.trim().replace(/^[^:：]+[:：]/, '') || '—');
    const cpuText = node.querySelector('.machine-progress')?.textContent || '';
    const cores = cpuText.match(/(\d+)\s*核/)?.[1];
    if (metrics[0]?.includes('核')) metrics[0] = metrics[0].match(/[\d.]+\s*%/)?.[0] || '—';
    const nativeLatency = get('[class~="h-[22px]"][class~="rounded-full"]') || get('.machine-latency-badge') || get('.windows-card-badge');
    const desktop = node.querySelector('[data-machine-action="desktop"]'), terminal = node.querySelector('[data-machine-action="terminal"]');
    // Read only public configuration fields; never copy native connection credentials.
    const info = {...metadata.get(id), ...models.get(id), ...systemInfo.get(id)};
    const connection=info.connection;
    const address=windows&&connection?.state==='connected'&&typeof info.route?.target==='string'?info.route.target:configuredAddress;
    const route=windows&&connection?.state==='connected'?info.route:routeInfo.get(address)||binding?.route;
    const latency=!windows?nativeLatency:info.unavailable?'采集异常':connection?.state==='disconnected'?'连接已断开':connection?.state==='connected'?
      Number.isFinite(connection.latencyMs)?(connection.latencyMs<1?'＜1ms':Math.round(connection.latencyMs)+'ms'):'已连接 · 延迟待测':'状态待确认';
    return { node, id, windows, binding, name, address, route, metrics, latency, desktop, terminal, info, cores:info.cores || info.cpuCores || cores,
      image: node.querySelector('.machine-icon-img')?.getAttribute('src'), note: get('.machine-note') || get('.windows-card-note') };
  };
  function status(record) {
    const delay = record.latency.match(/([\d.]+)\s*ms/i), offline = /离线|重启|已断开/.test(record.latency);
    const tone = offline ? 'offline' : /异常/.test(record.latency)?'medium':delay ? Number(delay[1]) <= 100 ? 'good' : Number(delay[1]) <= 300 ? 'medium' : 'high' : /在线|已连接/.test(record.latency) ? 'good' : 'unknown';
    const text = record.latency || '状态未知', dot = make('span', 'gm-status-dot ' + tone);
    dot.title = (record.windows && delay ? '到设备 SSH 端口的 TCP 延迟 · ' : '') + text;
    dot.setAttribute('role','img'); dot.setAttribute('aria-label',dot.title); return dot;
  }
  function configuration(record) {
    const info = record.info;
    return ['系统：' + (info.os || info.osName || '未提供系统名称'),
      '处理器：' + (info.cpu || (record.cores ? record.cores + ' 逻辑核' : '未提供型号')),
      '内存：' + (info.memory ? size(info.memory) : info.memoryTotal ? size(Number(info.memoryTotal)) : capacity(record.metrics[1])),
      '磁盘：' + (info.diskTotal ? size(Number(info.diskTotal)) : capacity(record.metrics[2]))].join('\n');
  }
  function identity(record) {
    const box = make('div','gm-device-identity'); box.title = configuration(record);
    if (record.windows || record.image) { const image=make('img','gm-os-icon'); image.src=record.windows ? new URL('ui-icons/windows.svg',base).href : record.image; image.alt=record.windows ? 'Windows' : ''; box.append(image); } else box.append(icon('desktop'));
    const text=make('div','gm-identity-text'), name=make('strong','gm-device-name'); name.append(status(record),make('span','',record.name));
    const label=make('small','gm-connection-label',connectionLabel(record));label.title=label.textContent;text.append(name,label); box.append(text); return box;
  }
  function connectionLabel(record){
    if(/离线|断开|异常|待确认|未知/.test(record.latency||''))return record.latency||'状态未知';
    const scope=record.route?.scope==='lan'?'局域网':record.route?.scope==='remote'?'远端':null;
    const family=['IPv4','IPv6'].includes(record.route?.family)?record.route.family:record.address.includes(':')?'IPv6':/^\d+\.\d+\.\d+\.\d+$/.test(record.address)?'IPv4':null;
    return [scope,family,record.latency||'状态未知'].filter(Boolean).join(' · ');
  }
  function openLinuxFiles(record) {
    clearTimeout(filesTimer);
    const deadline = Date.now() + 20000;
    const open = async () => {
      if (disposed) return;
      const view = [...document.querySelectorAll('webview.home-container-view')].find(node => {
        try { const url = new URL(node.getAttribute('src')); const query = new URLSearchParams(url.hash.split('?')[1]);
          return url.protocol==='http:' && ['127.0.0.1','localhost'].includes(url.hostname) && ['/newweb/','/web/'].includes(url.pathname) && query.get('machineId')===record.id && !query.has('onlyTerm'); } catch { return false; }
      });
      try {
        // Fixed native SDK operation. No session token or arbitrary script leaves the webview.
        if (view && await view.executeJavaScript('(()=>{if(typeof window.$gm?.openFolder!=="function")return false;window.$gm.openFolder("/");return true;})()') === true) return;
      } catch {}
      if (Date.now() < deadline) filesTimer=setTimeout(open,350);
      else notify('原生文件管理器尚未就绪，请在已打开的桌面中选择“文件”。');
    };
    void open();
  }
  const allowed=(record,type)=>type==='files'?(record.binding?.permissions?.files!==false||record.binding?.permissions?.files_read===true):record.binding?.permissions?.[type==='desktop'?'view':type]!==false;
  function invoke(record, type) {
    const current=currentRecords.get(record.id);if(!current){notify('设备列表已变化，请重新选择这台设备。');return;}record=current;if(!allowed(record,type)){notify('当前独立授权未允许此操作，请联系服务端调整权限。');return;}
    if(['desktop','terminal'].includes(type)&&window.gmsshWorkspaceController){window.gmsshWorkspaceController.open(record.id,type);return;}
    if(type==='files'&&window.gmsshFilesController&&(record.windows||window.gmsshFilesController.linux)){window.gmsshFilesController.open(record.id);return;}
    if (type === 'terminal') { record.terminal?.click(); return; }
    if(type==='power'&&record.binding?.permissions?.view===false){window.gmsshWorkspaceController?.hide();window.gmsshWindowsControllers?.get(record.id)?.show?.();}else record.desktop?.click();
    if (type === 'files' && !record.windows) { openLinuxFiles(record); return; }
    if (['files','power'].includes(type) && record.windows) {
      const send = () => { const frame=window.gmsshWindowsControllers?.get(record.id)?.frame()||[...document.querySelectorAll('[data-windows-machine]')].find(node=>node.dataset.windowsMachine===record.id)?.querySelector('iframe');frame?.contentWindow.postMessage({type:'gmssh-desktop-tool',tool:type},new URL(record.binding.viewerUrl).origin); };
      send(); setTimeout(send, 800);
    }
  }
  async function copyAddress(address) {
    try {
      if (window.electronAPI?.invoke) {
        const reply = await window.electronAPI.invoke('render-to-main',{type:'gmssh-copy-address',data:address});
        if (reply?.status !== 'ok') throw Error();
      } else await navigator.clipboard.writeText(address);
      notify('IP 地址已复制');
    } catch { notify('复制失败，请选中 IP 地址手动复制。'); }
  }
  function meter(value, index) {
    const box = make('div', 'gm-meter'); box.title=value||'—'; box.append(make('span', '', value || '—'));
    const bar = make('div', 'gm-meter-track'), fill = make('div', 'gm-meter-fill tone-' + index);
    const numeric = value?.match(/^(\d+(?:\.\d+)?)%$/);
    const fraction = value?.match(/(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?\s*\/\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?/i);
    const unit = text => 1024 ** Math.max(0,['B','KB','MB','GB','TB'].indexOf((text||'B').toUpperCase()));
    const percent = numeric ? Number(numeric[1]) : fraction && Number(fraction[3]) ? 100 * Number(fraction[1]) * unit(fraction[2]||fraction[4]) / (Number(fraction[3])*unit(fraction[4]||fraction[2])) : 0;
    fill.style.width = Math.max(0, Math.min(100, percent)) + '%'; bar.append(fill); box.append(bar); return box;
  }
  function controls(record) {
    const controls=make('div','gm-device-actions');
    for (const [kind,name,title] of [['desktop','monitor','打开桌面'],['terminal','terminal-window','终端'],['files','arrows-left-right','文件互传']]) {
      const disabled=(kind==='terminal' ? !record.terminal || record.terminal.disabled : kind==='files'&&window.gmsshFilesController&&(record.windows||window.gmsshFilesController.linux) ? false : !record.desktop || record.desktop.disabled)||!allowed(record,kind);
      const button=action('',name,event=>{event.stopPropagation();selected=record.id;invoke(record,kind);},kind==='desktop',disabled);
      button.title=title;button.setAttribute('aria-label',record.name+' · '+title);controls.append(button);
    }
    const more=action('','dots-three',event=>{event.stopPropagation();const box=event.currentTarget.getBoundingClientRect();showDeviceMenu(record,box.right,box.bottom);});
    more.title='更多操作';more.setAttribute('aria-label',record.name+' · 更多操作');controls.append(more);
    return controls;
  }
  function showDeviceMenu(record,x,y) {
    record=currentRecords.get(record.id)||record;
    const nativeMenu=()=>{const current=currentRecords.get(record.id);if(!current){notify('设备列表已变化，请重新选择这台设备。');return;}current.node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:x,clientY:y}));};
    contextMenu?.remove();contextMenu=make('div','gm-device-context');contextMenu.setAttribute('popover','auto');
    contextMenu.style.cssText='position:fixed;inset:auto;margin:0;padding:6px;background:#252528;color:#eee;border:1px solid #ffffff24;border-radius:8px;box-shadow:0 8px 32px #0008;';
    const item=(text,iconName,callback,disabled=false)=>action(text,iconName,()=>{contextMenu.hidePopover();callback();},false,disabled);
    contextMenu.append(item('设备详情','monitor',()=>openDetails(record.id)),item('复制 IP 地址','copy',()=>void copyAddress(record.address),record.address==='—'||/[＊*]/.test(record.address)));
    contextMenu.append(item('连接诊断','activity',()=>window.gmsshToolsController?.open(record.id,'diagnostics')),item('系统工具','gear',()=>window.gmsshToolsController?.open(record.id,'processes')));
    if(record.windows){
      contextMenu.append(item('电源操作','power',()=>invoke(record,'power'),!record.desktop||record.desktop.disabled||!allowed(record,'power')));
      if(window.gmsshPairingController?.edit)contextMenu.append(item('编辑连接地址','gear',()=>window.gmsshPairingController.edit(record.id)));
    }
    contextMenu.append(item('机器设置和其他操作','dots-three',nativeMenu));
    for(const button of contextMenu.children)button.style.cssText='display:flex;width:100%;margin:2px 0;justify-content:flex-start;';
    document.body.append(contextMenu);contextMenu.showPopover();
    contextMenu.style.left=Math.max(8,Math.min(x,innerWidth-contextMenu.offsetWidth-8))+'px';
    contextMenu.style.top=Math.max(8,Math.min(y,innerHeight-contextMenu.offsetHeight-8))+'px';
    contextMenu.querySelector('button')?.focus();
  }
  function selectRecord(row, record) {
    row.dataset.gmsshRow=record.id;row.tabIndex=0;row.classList.toggle('selected',record.id===selected);
    const select=()=>{selected=record.id;fingerprint='';render();if(!systemInfo.has(record.id))void refreshSystemInfo();};row.onclick=select;
    const context=event=>{event.preventDefault();event.stopPropagation?.();selected=record.id;fingerprint='';render();
      const nativeMenu=()=>record.node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:event.clientX,clientY:event.clientY}));
      if(!record.windows||!window.gmsshPairingController?.edit){nativeMenu();return;}
      showDeviceMenu(record,event.clientX,event.clientY);};
    row.oncontextmenu=context;
    row.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select();}
      else if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){const box=row.getBoundingClientRect();context({preventDefault:()=>event.preventDefault(),clientX:box.left+20,clientY:box.top+20});}};
  }
  function detailPane(record) {
    const pane=make('aside','gm-device-details');
    const logo=make('img','gm-brand');logo.src=new URL(record.windows?'ui-icons/windows.svg':'brand/gmssh.png',base).href;logo.alt=record.windows?'Windows':'GMSSH';pane.append(logo);
    const title=make('h2','');title.append(status(record),make('span','',record.name));title.title=configuration(record);pane.append(title);
    const address=action('','copy',()=>void copyAddress(record.address),false,record.address==='—'||/[＊*]/.test(record.address));address.append(make('span','gm-address-value',record.address));address.classList.add('gm-copy-address');address.title=record.address+' · 点击复制 IP 地址';address.setAttribute('aria-label','复制 IP 地址 '+record.address);pane.append(address);
    pane.append(action('打开桌面','monitor',()=>invoke(record,'desktop'),true,!record.desktop||record.desktop.disabled||!allowed(record,'desktop')));
    const pair=make('div','gm-detail-actions');pair.append(action('终端','terminal-window',()=>invoke(record,'terminal'),false,!record.terminal||record.terminal.disabled||!allowed(record,'terminal')),action('文件互传','arrows-left-right',()=>invoke(record,'files'),false,!allowed(record,'files')||!(window.gmsshFilesController&&(record.windows||window.gmsshFilesController.linux))&&(!record.desktop||record.desktop.disabled)));pane.append(pair);
    if(record.windows)pane.append(action('电源','power',()=>invoke(record,'power'),false,!record.desktop||record.desktop.disabled||!allowed(record,'power')));
    const tools=make('div','gm-detail-actions');tools.append(action('连接诊断','activity',()=>window.gmsshToolsController?.open(record.id,'diagnostics')),action('系统工具','gear',()=>window.gmsshToolsController?.open(record.id,'processes')));pane.append(tools);
    pane.append(make('h3','','连接信息'),make('p','gm-muted',connectionLabel(record)),make('p','gm-muted',record.note||'—'));
    const alternatives=[...new Set(record.binding?.addresses||[])].filter(value=>typeof value==='string'&&value!==record.address);
    if(alternatives.length){pane.append(make('h3','','其他已保存地址'));for(const value of alternatives){const copy=action('','copy',()=>void copyAddress(value));copy.classList.add('gm-copy-address');copy.append(make('span','gm-address-value',value));copy.title=value+' · 点击复制 IP 地址';copy.setAttribute('aria-label','复制 IP 地址 '+value);pane.append(copy);}}
    pane.append(make('h3','','资源使用'));
    ['CPU','内存','磁盘'].forEach((name,index)=>{const line=make('div','gm-detail-metric');line.append(labelled('span',name,['cpu','memory','hard-drive'][index]),meter(record.metrics[index],index));pane.append(line);});
    pane.append(make('h3','','网络与设备'));
    const info=record.info;
    const item=(name,value)=>{const line=make('p','gm-info-row');line.append(make('span','gm-muted',name),make('span','',String(value)));pane.append(line);};
    item('SSH 端口',record.windows?record.binding.targetPort||22:info.port||'—');
    if(info.publicIp&&info.publicIp!=='UnKnown')item('公网地址',info.publicIp);
    if(info.os||info.osName)item('系统',info.os||info.osName);
    if(info.cpu||record.cores)item('处理器',info.cpu||record.cores+' 逻辑核');
    if(Number.isFinite(info.uptime))item('运行时间',Math.floor(info.uptime/86400)+' 天 '+Math.floor(info.uptime%86400/3600)+' 小时');
    else if(info.runTime&&info.runTime!=='-')item('运行时间',info.runTime);
    if(Number.isFinite(info.processes))item('进程',info.processes);
    else if(Number.isFinite(info.processNum))item(Number.isFinite(info.activeProcessNum)?'活动 / 总进程':'进程',Number.isFinite(info.activeProcessNum)?info.activeProcessNum+' / '+info.processNum:info.processNum);
    for(const network of Array.isArray(info.network)?info.network:[]){const box=make('div','gm-network');box.append(make('strong','',network.name),make('small','gm-muted',(network.addresses||[]).join(' · ')),make('small','gm-muted','链路 '+(Number(network.speed)>0?(network.speed/1e9>=1?(network.speed/1e9).toFixed(1)+' Gbps':Math.round(network.speed/1e6)+' Mbps'):'—')));
      const previous=info.previous?.network?.find(value=>value.name===network.name),seconds=(info.sampledAt-(info.previous?.sampledAt||info.sampledAt))/1000;
      const rate=previous&&seconds>0&&network.received>=previous.received&&network.sent>=previous.sent;
      const traffic=make('small','',rate?'↓ '+size((network.received-previous.received)/seconds)+'/s  ↑ '+size((network.sent-previous.sent)/seconds)+'/s':'已接收 '+size(network.received)+' · 已发送 '+size(network.sent));traffic.title=rate?'最近 '+Math.round(seconds)+' 秒的平均速率':'网卡启动以来的累计流量';box.append(traffic);pane.append(box);}
    if(record.windows&&!info.network)pane.append(make('p','gm-muted',info.unavailable?'配置与网络信息暂不可用，会自动重试。':'正在读取配置与网络信息…'));
    if(info.sampledAt||info.unavailable){
      const reason=['OPERATION_TIMEOUT','SYSTEM_INFO_TIMEOUT'].includes(info.failure?.code)?'本次采集超时':info.failure?.code==='MONITOR_UNAVAILABLE'?'等待监控连接':['ACCESS_DENIED','AUTH_FAILED','LOCAL_AUTH_FAILED'].includes(info.failure?.code)?'请检查设备信息读取授权':'本次采集失败';
      const note=make('small','gm-muted',info.unavailable?reason+'，'+(info.sampledAt?'保留上次数据，更新于 '+new Date(info.sampledAt).toLocaleTimeString():'尚无成功采样'):'更新于 '+new Date(info.sampledAt).toLocaleTimeString());
      if(info.failure)note.title='采集诊断：'+info.failure.code+' · '+info.failure.stage+' · '+info.failure.elapsedMs+' ms';pane.append(note);
    }
    else if(Number.isFinite(info.lastUpdateTime)&&info.lastUpdateTime>0)pane.append(make('small','gm-muted','更新于 '+new Date(info.lastUpdateTime*1000).toLocaleTimeString()));
    if(Array.isArray(info.disks)&&info.disks.length&&(!record.windows||info.disks.length>1)){
      pane.append(make('h3','','磁盘分区'));
      for(const disk of info.disks)item(disk.name+(disk.filesystem?' '+disk.filesystem:''),size(Number.isFinite(disk.used)?disk.used:disk.total-disk.free)+' / '+size(disk.total));
    }
    return pane;
  }
  function render() {
    if (disposed) return;
    fitWorkspace();
    const nativeLogo=document.querySelector('.tabs-home img');
    if(nativeLogo && !nativeLogo.hasAttribute('data-gmssh-brand')){nativeLogo.src=new URL('brand/gmssh.png',base).href;nativeLogo.setAttribute('data-gmssh-brand','');}
    const cards=nativeCards(), source=document.querySelector('.machine-body') || document.querySelector('.machine-card-scroll') || cards.find(node=>node.classList.contains('list-item-group'))?.parentElement?.parentElement;
    if(!source||!cards.length){currentRecords.clear();if(detailsDialog.open)detailsDialog.close();root?.remove();host?.classList.remove('gm-native-source');root=host=undefined;return;}
    const models=nativeModels(cards),records=cards.map(node=>details(node,models)),mode=localStorage.getItem('GmsshMachineView')==='card'?'card':'list';
    currentRecords.clear();for(const record of records)currentRecords.set(record.id,record);
    const next=JSON.stringify([mode,records.map(({id,windows,image,name,address,route,metrics,latency,note,desktop,terminal,info,cores})=>[id,windows,image,name,address,route,metrics,latency,note,desktop?.disabled,terminal?.disabled,info,cores]),selected]);
    if(next===fingerprint&&root?.isConnected)return;
    observer.disconnect();
    try {
      fingerprint=next;
      const oldList=root?.querySelector('.gm-device-list');
      if(oldList)scrollPositions[oldList.dataset.view]={top:oldList.scrollTop,left:oldList.scrollLeft};
      if(!root?.isConnected||host!==source){root?.remove();host?.classList.remove('gm-native-source');host=source;host.classList.add('gm-native-source');root=make('section','gm-machine-workspace');root.id='gmssh-machine-workspace';root.setAttribute('aria-label','设备列表与详情');host.after(root);}
      const list=root.querySelector('.gm-device-list')||make('div','gm-device-list'), previousPane=root.querySelector('.gm-device-details'), paneScroll=previousPane?.scrollTop||0;
      list.dataset.view=mode;list.tabIndex=0;list.setAttribute('aria-label',mode==='card'?'设备卡片':'设备列表');
      list.onscroll=()=>{
        if(list.scrollHeight-list.scrollTop-list.clientHeight>180)return;
        const nativeScroll=cards[0]?.closest('.n-scrollbar-container')||source.querySelector('.n-scrollbar-container');
        if(nativeScroll){nativeScroll.scrollTop=nativeScroll.scrollHeight;nativeScroll.dispatchEvent(new Event('scroll'));}
      };
      if(!records.some(record=>record.id===selected))selected=records.find(record=>record.windows)?.id||records[0].id;
      if(mode==='list'){
        const table=make('table','gm-device-table'),head=make('thead'),header=make('tr');
        for(const [text,name] of [['设备'],['CPU','cpu'],['内存','memory'],['磁盘','hard-drive'],['操作']]){const cell=make('th');cell.append(name?labelled('span',text,name):text);header.append(cell);}
        head.append(header);table.append(head);const body=make('tbody');
        for(const record of records){const row=make('tr');selectRecord(row,record);const cell=make('td');cell.append(identity(record));row.append(cell);
          for(let i=0;i<3;i++){const cell=make('td');cell.append(meter(record.metrics[i],i));row.append(cell);}const actions=make('td','gm-row-actions');actions.append(controls(record));row.append(actions);body.append(row);}
        table.append(body);list.replaceChildren(table);
      }else{
        const grid=make('div','gm-device-grid');
        for(const record of records){const card=make('article','gm-device-card');selectRecord(card,record);card.append(identity(record));
          const metrics=make('div','gm-card-metrics');['CPU','内存','磁盘'].forEach((name,index)=>{const cell=make('div');cell.append(labelled('small',name,['cpu','memory','hard-drive'][index]),meter(record.metrics[index],index));metrics.append(cell);});card.append(metrics,controls(record));grid.append(card);}
        list.replaceChildren(grid);
      }
      if(!list.isConnected)root.append(list);
      const pane=detailPane(records.find(record=>record.id===selected));
      if(previousPane)previousPane.replaceWith(pane);else root.append(pane);
      fitWorkspace();list.scrollTop=scrollPositions[mode].top;list.scrollLeft=scrollPositions[mode].left;pane.scrollTop=paneScroll;
      refreshDetailsDialog();
    } finally {observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','class','disabled','src']});}
    if(byId.has(selected)&&!systemInfo.has(selected))void refreshSystemInfo();
    void refreshRoutes();
  }
  async function refreshRoutes(){
    const targets=[...new Set([...currentRecords.values()].map(record=>record.address))].slice(0,200),key=JSON.stringify(targets);
    if(disposed||routeBusy||!window.electronAPI?.invoke||key===routeQuery&&Date.now()-routeSampled<30000)return;
    routeBusy=true;routeQuery=key;routeSampled=Date.now();
    try{const described=await window.electronAPI.invoke('render-to-main',{type:'gmssh-route-info',data:{targets}});if(disposed)return;
      if(described?.status==='ok'&&Array.isArray(described.data?.routes)){for(const route of described.data.routes)if(targets.includes(route.address)&&['lan','remote','unknown'].includes(route.scope)&&['IPv4','IPv6'].includes(route.family))routeInfo.set(route.address,route);fingerprint='';render();}
    }catch{}finally{routeBusy=false;}
  }
  async function loadNativeMetadata() {
    try {
      const service=await window.electronAPI?.invoke('render-to-main',{type:'get-port'}),port=service?.multiPort;
      if(!Number.isInteger(port)||port<1||port>65535)return;
      const response=await fetch('http://127.0.0.1:'+port+'/node/list',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cond:'',groupId:'',pageNum:1,pageSize:200})});
      const data=await response.json();if(disposed||data.code!==0||!Array.isArray(data.data?.list))return;
      for(const record of data.data.list)if(typeof record.id==='string')metadata.set(record.id,publicInfo(record));
      fingerprint='';render();
    }catch{}
  }
  async function refreshSystemInfo() {
    const binding=byId.get(selected),sampledId=selected;
    if(disposed||infoBusy||!binding?.accessToken||!root?.getClientRects().length)return;
    const source=new URL(binding.viewerUrl);
    infoBusy=true;
    try {
      const info=await new Promise((resolve,reject)=>{
        if(!infoFrame||infoOrigin!==source.origin){
          infoFrame?.remove();infoOrigin=source.origin;
          infoFrame=make('iframe');infoFrame.hidden=true;infoFrame.title='设备信息';infoFrame.referrerPolicy='no-referrer';
          infoReady=new Promise(done=>{infoFrame.onload=done;});infoFrame.src=new URL('system-info.html',source).href;document.body.append(infoFrame);
        }
        const requestId=++infoRequestId;
        const done=(error,value)=>{clearTimeout(timeout);cancelInfo=undefined;window.removeEventListener('message',receive);error?reject(error):resolve(value);};
        const receive=event=>{if(event.source!==infoFrame?.contentWindow||event.origin!==source.origin||event.data?.type!=='gmssh-system-info'||event.data.requestId!==requestId)return;
          const reply=event.data;if(reply.ok&&reply.info&&typeof reply.info==='object')done(null,reply.info);else done(Object.assign(Error('设备信息查询未完成'),{code:infoCodes.has(reply.code)?reply.code:'QUERY_FAILED',stage:infoStages.has(reply.stage)?reply.stage:'query',elapsedMs:Number.isFinite(reply.elapsedMs)?Math.min(60000,Math.max(0,reply.elapsedMs)):0}));};
        const timeout=setTimeout(()=>done(Object.assign(Error('设备信息页面响应超时'),{code:'SYSTEM_INFO_TIMEOUT',stage:'frame',elapsedMs:15000})),15000);cancelInfo=()=>done(Error());window.addEventListener('message',receive);
        infoReady.then(()=>{if(!disposed&&infoBusy&&requestId===infoRequestId)infoFrame.contentWindow.postMessage({type:'gmssh-system-info-request',token:binding.accessToken,requestId},source.origin);});
      });
      if(disposed)return;
      const previous=systemInfo.get(sampledId);systemInfo.set(sampledId,{...info,sampledAt:Date.now(),previous:previous?{sampledAt:previous.sampledAt,network:previous.network}:undefined});fingerprint='';render();
    }catch(error){if(!disposed){systemInfo.set(sampledId,{...systemInfo.get(sampledId),unavailable:true,failure:{code:infoCodes.has(error?.code)?error.code:'QUERY_FAILED',stage:infoStages.has(error?.stage)?error.stage:'query',elapsedMs:Number.isFinite(error?.elapsedMs)?Math.min(60000,Math.max(0,error.elapsedMs)):0}});fingerprint='';render();}}finally{infoBusy=false;if(!disposed&&selected!==sampledId)void refreshSystemInfo();}
  }
  const observer=new MutationObserver(records=>{if(records.every(record=>root?.contains(record.target)))return;clearTimeout(timer);timer=setTimeout(render,100);});
  observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','class','disabled','src']});render();
  window.addEventListener('resize',fitWorkspace);void loadNativeMetadata();void refreshSystemInfo();
  const infoInterval=setInterval(()=>{void refreshSystemInfo();void refreshRoutes();},30000);
  window.removeGMSSHHome=()=>{disposed=true;observer.disconnect();clearTimeout(timer);clearTimeout(noticeTimer);clearTimeout(filesTimer);clearInterval(infoInterval);cancelInfo?.();infoFrame?.remove();contextMenu?.remove();detailsDialog.remove();window.removeEventListener('resize',fitWorkspace);root?.remove();host?.classList.remove('gm-native-source');style.remove();};
  return {refresh:render,select(id){selected=id;fingerprint='';render();},filesDevices:()=>[...currentRecords.values()].map(record=>({id:record.id,name:record.name,windows:record.windows,...(record.binding?.permissions?{permissions:record.binding.permissions}:{})})),permissions(id,value){const binding=byId.get(id);if(binding){binding.permissions={...value};fingerprint='';render();}},workspaceOverview(id){const record=currentRecords.get(id);return record?detailPane(record):null;},openNative(id,channel){const record=currentRecords.get(id);if(!record)return;if(channel==='terminal')record.terminal?.click();else if(!record.windows)record.desktop?.click();},openNativeFiles(id){const record=currentRecords.get(id);if(record&&!record.windows){record.desktop?.click();openLinuxFiles(record);}},remove:window.removeGMSSHHome};
};
