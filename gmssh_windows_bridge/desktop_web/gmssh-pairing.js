/* The trusted native home owns enrollment; no credential enters URLs or localStorage. */
window.installGMSSHPairing = function () {
  if(window.gmsshPairingController)return window.gmsshPairingController;
  const style=document.createElement('style');style.id='gmssh-pairing-style';
  style.textContent=`
    .gm-pair-dialog,.gm-pair-panel,.gm-pair-panel *{box-sizing:border-box}
    .gm-pair-dialog{position:fixed;inset:0;margin:auto;width:min(550px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;padding:24px;background:#242424;color:#ededf0;border:1px solid #ffffff24;border-radius:12px;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei UI',sans-serif;box-shadow:0 24px 90px #0008}
    .gm-pair-dialog::backdrop{background:#0008}
    .gm-pair-panel{display:flex;flex-direction:column;min-height:0}
    .gm-pair-dialog>.gm-pair-panel{max-height:calc(100vh - 90px)}
    .gm-pair-panel h2{font-size:18px;margin:0 0 18px}
    .gm-pair-body{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#666 transparent;padding:2px}
    .gm-pair-panel p{color:#a7a7b1;font-size:12px;line-height:1.7;margin:10px 0 16px}
    .gm-pair-panel label{display:grid;grid-template-columns:76px minmax(0,1fr);align-items:center;gap:12px;margin:14px 0;color:#c9c9d2;font-size:13px}
    .gm-pair-panel input,.gm-pair-panel select{font:inherit;font-size:13px;height:36px;padding:7px 10px;border:1px solid #ffffff20;border-radius:6px;color:#eee;background:#18181b;min-width:0;width:100%;transition:border-color .15s}
    .gm-pair-panel input::placeholder{color:#74747e}
    .gm-pair-panel input:hover{border-color:#ffffff38}
    .gm-pair-panel input:focus,.gm-pair-panel select:focus{outline:2px solid #818cf8;outline-offset:1px}
    .gm-pair-panel input[readonly]{color:#9b9ba7;background:#ffffff04}
    .gm-pair-panel button{font:inherit;font-size:13px;min-height:34px;padding:7px 14px;border:1px solid #ffffff24;border-radius:6px;background:#ffffff05;color:#eee;cursor:pointer}
    .gm-pair-panel button:hover:not(:disabled){background:#ffffff0d;border-color:#ffffff40}
    .gm-pair-panel button.primary{background:#5667ff;border-color:#5667ff}
    .gm-pair-panel button.primary:hover:not(:disabled){background:#6574ff;border-color:#6574ff}
    .gm-pair-panel button:focus-visible{outline:2px solid #a5b4fc;outline-offset:2px}
    .gm-pair-panel button:disabled{opacity:.5;cursor:default}
    .gm-pair-sources{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0 0 18px}
    .gm-pair-sources button{display:flex;align-items:center;justify-content:center;gap:7px;padding:9px 5px;white-space:nowrap}
    .gm-pair-sources button[aria-pressed=true]{color:#c8ceff;background:#5667ff18;border-color:#7d88ff80}
    .gm-pair-panel svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
    .gm-pair-intro{display:flex;align-items:flex-start;gap:14px;padding:18px;background:#ffffff03;border:1px dashed #ffffff24;border-radius:8px}
    .gm-pair-intro>svg{width:30px;height:30px;padding:5px;box-sizing:content-box;color:#a5b4fc;background:#5667ff20;border-radius:10px}
    .gm-pair-intro strong{display:block;margin:0 0 6px;font-size:14px;font-weight:600}
    .gm-pair-intro p{margin:0;font-size:12px}
    .gm-pair-intro small{display:block;color:#777782;font-size:11px;margin-top:10px}
    .gm-pair-address-row{display:grid;grid-template-columns:minmax(0,1fr) 102px;gap:12px}
    .gm-pair-address-row label{margin:0}
    .gm-pair-address-row .gm-pair-port{grid-template-columns:auto minmax(0,1fr);gap:8px}
    .gm-pair-panel [data-pair=manual-fields]>label:first-child{margin-top:0}
    .gm-pair-summary{padding:14px 16px;background:#5667ff0b;border:1px solid #7d88ff26;border-radius:8px;overflow-wrap:anywhere}
    .gm-pair-summary strong{display:block;font-size:14px;margin-bottom:5px}
    .gm-pair-summary span{font-size:12px;color:#aaaab6}
    .gm-pair-summary code{display:block;font-size:10px;line-height:1.6;color:#b9c1ff;margin-top:10px;padding-top:10px;border-top:1px solid #ffffff10}
    .gm-pair-panel .gm-pair-remember{display:flex;gap:8px;margin:14px 0 14px 88px;font-size:12px;line-height:1.6}
    .gm-pair-remember input{width:14px!important;height:14px;margin:0;accent-color:#6775ff;flex:none}
    .gm-pair-panel .gm-pair-note{margin-left:88px;font-size:12px}
    .gm-pair-footer{flex:none;margin-top:18px;padding-top:14px;border-top:1px solid #ffffff10}
    .gm-pair-actions{display:flex;gap:10px;justify-content:flex-end}
    .gm-pair-panel .gm-pair-status{color:#b9c1ff;margin:0 0 12px;overflow-wrap:anywhere}
    .gm-pair-status:empty{display:none}
    .gm-pair-panel [hidden]{display:none!important}
    @media(max-width:460px){.gm-pair-panel label{grid-template-columns:64px minmax(0,1fr);gap:8px}.gm-pair-sources{gap:5px}.gm-pair-sources button{font-size:12px;gap:4px}.gm-pair-address-row{gap:8px;grid-template-columns:minmax(0,1fr) 92px}.gm-pair-panel .gm-pair-remember,.gm-pair-panel .gm-pair-note{margin-left:72px}}
  `;
  style.textContent+=`.gm-add-title{display:flex;align-items:center;gap:16px;width:100%;min-width:0;padding-right:50px;box-sizing:border-box}.gm-add-platform{display:inline-flex;flex:none;align-items:center;gap:2px;margin-left:auto;padding:2px;border:1px solid #ffffff18;border-radius:6px;background:#18181b66;-webkit-app-region:no-drag}.gm-add-platform button{font:inherit;font-size:12px;font-weight:500;line-height:18px;min-width:56px;color:#b7b9c3;background:transparent;border:0;border-radius:4px;padding:2px 10px;cursor:pointer}.gm-add-platform button[aria-selected=true]{color:#fff;background:#5667ff;border-color:#5667ff}.gm-add-platform button:focus-visible{outline:2px solid #a5b4fc;outline-offset:2px}.gm-add-platform button:disabled{opacity:.5;cursor:default}.gm-add-windows .gm-add-native,.gm-add-windows .n-dialog__action{display:none!important}.gm-pair-embedded{color:#ededf0;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei UI',sans-serif;max-height:min(580px,calc(100vh - 180px));overflow:hidden;padding:18px 20px 16px}.gm-pair-embedded>h2{display:none}`;
  document.head.append(style);
  const dialog=document.createElement('dialog');dialog.className='gm-pair-dialog';dialog.setAttribute('aria-label','接入 Windows 电脑');
  const panel=document.createElement('section');panel.className='gm-pair-panel';panel.setAttribute('aria-label','Windows 连接设置');
  const icon=path=>'<svg viewBox="0 0 24 24" aria-hidden="true">'+path+'</svg>';
  const clipboard=icon('<rect x="6" y="5" width="14" height="16" rx="2"/><path d="M9 5V3h8v2M3 16V3h3"/>');
  panel.innerHTML=`
    <h2>接入 Windows 电脑</h2>
    <div class="gm-pair-body">
      <div class="gm-pair-sources" role="group" aria-label="接入方式">
        <button type="button" data-pair="paste" aria-pressed="true">${clipboard}粘贴连接码</button>
        <button type="button" data-pair="file" aria-pressed="false">${icon('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/>')}连接文件</button>
        <button type="button" data-pair="manual" aria-pressed="false">${icon('<path d="m16 3 5 5-12 12-6 1 1-6zM14 5l5 5"/>')}手动填写</button>
      </div>
      <div class="gm-pair-intro" data-pair="intro">
        ${clipboard}<div><strong>复制连接码，一步接入</strong><p>在 Windows 服务端点击“复制连接码”，<br>再点击上方“粘贴连接码”，自动填写连接信息。</p><small>也可导入连接文件，或手动填写 IPv4 / IPv6 地址。</small></div>
      </div>
      <section data-pair="manual-fields" hidden>
        <label><span>设备名称</span><input data-pair="manual-computer" value="Windows-PC" maxlength="63" autocomplete="off"></label>
        <div class="gm-pair-address-row">
          <label><span>连接地址</span><input data-pair="manual-target" autocomplete="off" placeholder="IPv4 / IPv6 地址"></label>
          <label class="gm-pair-port"><span>端口</span><input data-pair="manual-port" type="number" min="1" max="65535" value="22" aria-label="SSH 端口"></label>
        </div>
        <label><span>SSH 账号</span><input data-pair="manual-user" value="gmssh" maxlength="64" autocomplete="off"></label>
        <label class="gm-pair-remember"><input data-pair="manual-shared" type="checkbox">SSH 与桌面使用同一连接密码</label>
      </section>
      <section data-pair="preview" hidden>
        <div class="gm-pair-summary"><strong data-pair="computer"></strong><span data-pair="account"></span><code data-pair="fingerprint"></code></div>
        <p>请核对上方主机指纹与 Windows 服务端一致。</p>
        <label><span>设备名称</span><input data-pair="name" maxlength="128" autocomplete="off"></label>
        <div class="gm-pair-address-row">
          <label><span>连接地址</span><input data-pair="target" list="gm-pair-targets" autocomplete="off" placeholder="IPv4 / IPv6 地址"><datalist id="gm-pair-targets" data-pair="targets"></datalist></label>
          <label class="gm-pair-port"><span>端口</span><input data-pair="port" type="number" readonly aria-label="SSH 端口"></label>
        </div>
        <label class="gm-pair-remember" data-pair="refresh-label" hidden><input data-pair="refresh" type="checkbox">更新此设备的连接密码</label>
        <label data-pair="password-label"><span>连接密码</span><input data-pair="password" type="password" maxlength="1024" autocomplete="off" placeholder="Windows 安装时设置的密码"></label>
        <label class="gm-pair-remember" data-pair="remember-label" hidden><input data-pair="remember" type="checkbox" checked>记住桌面密码（本机钥匙串）</label>
        <p class="gm-pair-note" data-pair="existing" hidden>此电脑已接入，沿用原卡片。Windows 端改密后，可在这里更新连接密码。</p>
      </section>
    </div>
    <div class="gm-pair-footer">
      <p class="gm-pair-status" data-pair="status" role="status" aria-live="polite"></p>
      <div class="gm-pair-actions"><button type="button" data-pair="cancel">取消</button><button type="button" class="primary" data-pair="lookup" hidden>核对主机身份</button><button type="button" class="primary" data-pair="connect" disabled hidden>接入电脑</button></div>
    </div>`;
  dialog.append(panel);document.body.append(dialog);
  const field=name=>panel.querySelector('[data-pair="'+name+'"]');
  let preview,busy=false,disposed=false,nativeHost,nativeBody,platforms,pendingWindows=false;
  const status=text=>{field('status').textContent=text;};
  const update=()=>{
    const coded=preview?.fromCode===true,changed=!!preview?.existing&&field('target').value.trim()!==preview.existing.target;
    const refresh=!!preview?.existing&&(coded||field('refresh').checked||changed);
    field('refresh-label').hidden=!preview?.existing||coded;
    field('password-label').hidden=coded||(!!preview?.existing&&!refresh);
    field('remember-label').hidden=(!refresh&&!!preview?.existing)||preview?.desktopAuth!=='shared-ssh'||!preview?.canRememberDesktop;
    field('connect').textContent=changed?'更新地址并重连':preview?.existing?(refresh?'更新密码并重连':'打开已有设备'):'接入并打开桌面';
    field('connect').hidden=!preview;field('lookup').hidden=!!preview||field('manual-fields').hidden;
    field('connect').disabled=busy||!preview||!field('target').value.trim()||(!coded&&(!preview.existing||refresh)&&!field('password').value);
  };
  function lock(value){busy=value;for(const input of panel.querySelectorAll('input,select,button'))input.disabled=value;for(const button of platforms?.querySelectorAll('button')||[])button.disabled=value;update();}
  function selectSource(name){for(const source of ['paste','file','manual'])field(source).setAttribute('aria-pressed',String(source===name));field('intro').hidden=!!preview||name==='manual';}
  function clear(){field('password').value='';preview=undefined;field('preview').hidden=true;field('manual-fields').hidden=true;selectSource('paste');status('');update();void invoke('gmssh-pair-clear').catch(()=>{});}
  function close(){if(busy)return;clear();if(nativeHost?.classList.contains('gm-add-windows'))nativeHost.querySelector('.n-dialog__close').click();else dialog.close();}
  const invoke=(type,data)=>window.electronAPI.invoke('render-to-main',{type,data});
  function showPreview(reply){
    if(reply?.status!=='ok')throw Error(reply?.message||'连接信息读取失败。');
    preview=reply.data;field('refresh').checked=false;field('password').value='';field('computer').textContent=preview.computer;
    field('account').textContent='SSH 账号 '+preview.username+' · 端口 '+preview.sshPort;
    field('fingerprint').textContent=preview.sshHostFingerprint;field('name').value=preview.computer;
    field('targets').replaceChildren(...preview.addresses.map(address=>{const option=document.createElement('option');option.value=address;return option;}));
    field('target').value=preview.existing&&preview.addresses.includes(preview.existing.target)?preview.existing.target:preview.addresses[0];
    field('port').value=String(preview.sshPort);field('existing').hidden=!preview.existing;
    field('preview').hidden=false;field('manual-fields').hidden=true;
    selectSource(preview.fromManual?'manual':preview.fromCode?'paste':'file');
    status(preview.fromManual?'已读取主机身份，请与 Windows 端指纹核对一致后输入密码连接。':preview.fromCode?'连接码已识别，可直接接入；已有设备沿用原卡片。':preview.existing?'检测到同一设备；可以打开原连接，或填写新的 IPv4 / IPv6 地址。':'连接文件已检查，请核对电脑并输入连接密码。');
  }
  async function chooseSource(type,data){
    lock(true);status(type==='gmssh-pair-manual'?'正在读取主机公钥…':type==='gmssh-pair-edit'?'正在读取原设备连接…':type==='gmssh-pair-paste'?'正在识别连接码…':'正在读取连接文件…');
    try{
      const reply=await invoke(type,data);
      if(reply?.status==='cancelled'){status('');return;}
      showPreview(reply);
    }catch(error){preview=undefined;field('preview').hidden=true;field('password').value='';field('intro').hidden=!field('manual-fields').hidden;status(error.message||'连接信息未通过检查。');}
    finally{lock(false);if(preview&&!preview.existing&&!preview.fromCode)field('password').focus();}
  }
  async function connect(){
    if(!preview||busy)return;
    lock(true);status('正在核对主机身份并接入，请稍候…');
    try{
      const reply=await invoke('gmssh-pair-connect',{id:preview.id,target:field('target').value,name:field('name').value,password:field('password').value,refreshPassword:!!preview.existing&&(preview.fromCode===true||field('refresh').checked),rememberDesktop:preview.desktopAuth==='shared-ssh'&&preview.canRememberDesktop===true&&field('remember').checked});
      field('password').value='';
      if(reply?.status!=='ok')throw Error(reply?.message||'接入未完成，请重试。');
      const id=reply.data.machineId;
      document.querySelector('.machine-manage .action-btn .icon-shuaxin')?.closest('.action-btn')?.click();
      const deadline=Date.now()+10000;
      const select=()=>{
        if(disposed)return;
        if(document.querySelector('[data-machine-id="'+id+'"]'))window.gmsshHomeController?.select(id);
        else if(Date.now()<deadline)setTimeout(select,200);
      };
      select();
      lock(false);close();const controller=window.gmsshWindowsControllers?.get(id);if(reply.data.credentialsUpdated)controller?.close?.();controller?.open();
    }catch(error){field('password').value='';status(error.message||'接入未完成，请重试。');}
    finally{lock(false);}
  }
  field('paste').onclick=()=>chooseSource('gmssh-pair-paste');
  field('manual').onclick=()=>{preview=undefined;field('password').value='';field('preview').hidden=true;field('manual-fields').hidden=false;selectSource('manual');status('先核对主机身份，再输入密码连接。');update();field('manual-target').focus();void invoke('gmssh-pair-clear').catch(()=>{});};
  field('lookup').onclick=()=>chooseSource('gmssh-pair-manual',{computer:field('manual-computer').value,target:field('manual-target').value,port:Number(field('manual-port').value),username:field('manual-user').value,sharedPassword:field('manual-shared').checked});
  field('target').oninput=update;field('file').onclick=()=>chooseSource('gmssh-pair-file');field('connect').onclick=connect;field('cancel').onclick=close;
  field('password').oninput=update;field('refresh').onchange=()=>{field('password').value='';update();if(field('refresh').checked)field('password').focus();};
  field('password').onkeydown=event=>{if(event.key==='Enter'&&!field('connect').disabled){event.preventDefault();void connect();}};
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  function selectPlatform(windows){
    if(busy||!nativeHost)return;
    nativeHost.classList.toggle('gm-add-windows',windows);
    for(const button of platforms.children)button.setAttribute('aria-selected',String((button.dataset.platform==='windows')===windows));
    if(windows){panel.classList.add('gm-pair-embedded');nativeBody.parentElement.append(panel);field('paste').focus();}
    else{panel.classList.remove('gm-pair-embedded');dialog.append(panel);clear();}
  }
  function gateClose(event){
    if(!event.target.closest?.('.n-dialog__close')||!nativeHost?.classList.contains('gm-add-windows'))return;
    if(busy){event.preventDefault();event.stopImmediatePropagation();}else clear();
  }
  function releaseHost(){
    if(!nativeHost)return;
    nativeHost.classList.remove('gm-add-windows');nativeBody.classList.remove('gm-add-native');platforms.parentElement?.classList.remove('gm-add-title');platforms.remove();nativeHost.removeEventListener('click',gateClose,true);
    panel.classList.remove('gm-pair-embedded');dialog.append(panel);nativeHost=nativeBody=platforms=undefined;clear();
  }
  function mount(){
    if(disposed)return;
    if(nativeHost&&!nativeHost.isConnected)releaseHost();
    if(nativeHost||dialog.open)return;
    const host=[...document.querySelectorAll('.jm-default-modal.jm-fix-scroll-modal')].find(node=>/^(添加机器|Add machine)$/i.test(node.querySelector('.modal-header')?.textContent.trim()||''));
    const content=host?.querySelector('.n-dialog__content'),body=content?.querySelector('.modal-content');
    if(!body||!host.querySelector('.n-dialog__close'))return;
    nativeHost=host;nativeBody=body;body.classList.add('gm-add-native');
    platforms=document.createElement('div');platforms.className='gm-add-platform';platforms.setAttribute('role','tablist');platforms.setAttribute('aria-label','操作系统');
    for(const [value,name] of [['linux','Linux'],['windows','Windows']]){const button=document.createElement('button');button.type='button';button.dataset.platform=value;button.textContent=name;button.setAttribute('role','tab');button.setAttribute('aria-selected',String(value==='linux'));button.onclick=()=>selectPlatform(value==='windows');platforms.append(button);}
    const title=host.querySelector('.modal-header');title.classList.add('gm-add-title');title.append(platforms);host.addEventListener('click',gateClose,true);
    if(pendingWindows){pendingWindows=false;selectPlatform(true);}
  }
  function escape(event){if(event.key==='Escape'&&nativeHost?.classList.contains('gm-add-windows')){event.preventDefault();event.stopImmediatePropagation();close();}}
  function open(){
    if(busy)return;
    if(nativeHost){selectPlatform(true);return;}
    const add=document.querySelector('.machine-manage button.btn.add');
    if(add&&!add.disabled){pendingWindows=true;add.click();mount();}
    else if(!dialog.open)dialog.showModal();
  }
  document.addEventListener('keydown',escape,true);
  const observer=new MutationObserver(mount);observer.observe(document.body,{childList:true,subtree:true});mount();
  window.gmsshPairingController={open,edit:machineId=>{if(busy)return;if(nativeHost)selectPlatform(true);else if(!dialog.open)dialog.showModal();void chooseSource('gmssh-pair-edit',{machineId});},remove:()=>{disposed=true;observer.disconnect();document.removeEventListener('keydown',escape,true);releaseHost();dialog.remove();style.remove();delete window.gmsshPairingController;}};
  return window.gmsshPairingController;
};
