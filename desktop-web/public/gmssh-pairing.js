/* The trusted native home owns enrollment; no credential enters URLs or localStorage. */
window.installGMSSHPairing = function () {
  if(window.gmsshPairingController)return window.gmsshPairingController;
  const style=document.createElement('style');style.id='gmssh-pairing-style';
  style.textContent=`.gm-pair-dialog,.gm-pair-dialog *{box-sizing:border-box}.gm-pair-open{margin-left:auto;flex:none;padding:7px 13px!important;min-height:34px}.gm-pair-dialog{position:fixed;inset:0;margin:auto;width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;padding:24px;background:#202023;color:#ededf0;border:1px solid #ffffff24;border-radius:12px;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei UI',sans-serif;box-shadow:0 24px 90px #0008}.gm-pair-dialog::backdrop{background:#0008}.gm-pair-dialog h2{font-size:20px;margin:0 0 10px}.gm-pair-dialog p{color:#a7a7b1;line-height:1.65;margin:10px 0 18px}.gm-pair-dialog label{display:flex;flex-direction:column;gap:8px;margin:16px 0;color:#c9c9d2}.gm-pair-dialog input,.gm-pair-dialog select{font:inherit;padding:10px 12px;border:1px solid #ffffff24;border-radius:7px;color:#eee;background:#141416;min-width:0;width:100%}.gm-pair-dialog input:focus,.gm-pair-dialog select:focus{outline:2px solid #818cf8;outline-offset:1px}.gm-pair-dialog button{font:inherit;padding:9px 14px;border:1px solid #ffffff24;border-radius:7px;background:#ffffff08;color:#eee;cursor:pointer}.gm-pair-dialog button.primary{background:#5667ff;border-color:#5667ff}.gm-pair-dialog button:disabled{opacity:.5;cursor:default}.gm-pair-summary{padding:14px;background:#171719;border:1px solid #ffffff12;border-radius:8px;overflow-wrap:anywhere}.gm-pair-summary strong{display:block;margin-bottom:8px}.gm-pair-summary code{display:block;font-size:11px;color:#b9c1ff;margin-top:7px}.gm-pair-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:22px}.gm-pair-status{min-height:24px;color:#b9c1ff!important;margin-bottom:0!important}.gm-pair-remember{flex-direction:row!important;align-items:center;font-size:12px}.gm-pair-remember input{width:auto!important}.gm-pair-dialog [hidden]{display:none!important}`;
  document.head.append(style);
  const trigger=document.createElement('button');trigger.type='button';trigger.className='gm-ui-button gm-pair-open';trigger.textContent='接入 Windows';
  const dialog=document.createElement('dialog');dialog.className='gm-pair-dialog';dialog.setAttribute('aria-label','接入 Windows 电脑');
  dialog.innerHTML='<h2>接入 Windows 电脑</h2><p>先在 Windows 安装 GMSSH，将生成的 <strong>GMSSH-connection.json</strong> 传到这台 Mac，再导入连接文件。</p><button type="button" data-pair="file">选择连接文件</button><section data-pair="preview" hidden><div class="gm-pair-summary"><strong data-pair="computer"></strong><span data-pair="account"></span><code data-pair="fingerprint"></code></div><p>请与 Windows 端的主机指纹核对。接入时会再次检查 SSH 身份。</p><label>设备名称<input data-pair="name" maxlength="128" autocomplete="off"></label><label>连接地址<select data-pair="target"></select></label><label data-pair="password-label">连接密码<input data-pair="password" type="password" maxlength="1024" autocomplete="off" placeholder="Windows 安装时设置的 GMSSH 连接密码"></label><label class="gm-pair-remember" data-pair="remember-label" hidden><input data-pair="remember" type="checkbox" checked>记住桌面密码（本机钥匙串）</label><p data-pair="existing" hidden>此电脑已接入，将打开已有设备，不重复添加。</p></section><p class="gm-pair-status" data-pair="status" role="status" aria-live="polite"></p><div class="gm-pair-actions"><button type="button" data-pair="cancel">取消</button><button type="button" class="primary" data-pair="connect" disabled>接入电脑</button></div>';
  document.body.append(dialog);
  const field=name=>dialog.querySelector('[data-pair="'+name+'"]');
  let preview,busy=false,disposed=false;
  const status=text=>{field('status').textContent=text;};
  const update=()=>{field('connect').disabled=busy||!preview||(!preview.existing&&!field('password').value);};
  function lock(value){busy=value;for(const input of dialog.querySelectorAll('input,select,button'))input.disabled=value;update();}
  function close(){if(busy)return;field('password').value='';preview=undefined;field('preview').hidden=true;status('');dialog.close();update();}
  const invoke=(type,data)=>window.electronAPI.invoke('render-to-main',{type,data});
  async function chooseFile(){
    lock(true);status('正在读取连接文件…');
    try{
      const reply=await invoke('gmssh-pair-file');
      if(reply?.status==='cancelled'){status('');return;}
      if(reply?.status!=='ok')throw Error(reply?.message||'连接文件读取失败。');
      preview=reply.data;field('password').value='';field('computer').textContent=preview.computer;
      field('account').textContent='SSH 账号 '+preview.username+' · 端口 '+preview.sshPort;
      field('fingerprint').textContent=preview.sshHostFingerprint;field('name').value=preview.computer;
      field('target').replaceChildren(...preview.addresses.map(address=>{const option=document.createElement('option');option.value=address;option.textContent=address;return option;}));
      if(preview.existing&&preview.addresses.includes(preview.existing.target))field('target').value=preview.existing.target;
      field('remember-label').hidden=!!preview.existing||preview.desktopAuth!=='shared-ssh'||!preview.canRememberDesktop;
      field('password-label').hidden=!!preview.existing;field('existing').hidden=!preview.existing;
      field('connect').textContent=preview.existing?'打开已有设备':'接入并打开桌面';
      field('preview').hidden=false;status(preview.existing?'检测到同一主机身份的已有连接。':'连接文件已检查，请核对电脑并输入连接密码。');
    }catch(error){preview=undefined;field('preview').hidden=true;field('password').value='';status(error.message||'连接文件未通过检查。');}
    finally{lock(false);if(preview&&!preview.existing)field('password').focus();}
  }
  async function connect(){
    if(!preview||busy)return;
    lock(true);status('正在核对主机身份并接入，请稍候…');
    try{
      const reply=await invoke('gmssh-pair-connect',{id:preview.id,target:field('target').value,name:field('name').value,password:field('password').value,rememberDesktop:preview.desktopAuth==='shared-ssh'&&preview.canRememberDesktop===true&&field('remember').checked});
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
      lock(false);close();window.gmsshWindowsControllers?.get(id)?.open();
    }catch(error){field('password').value='';status(error.message||'接入未完成，请重试。');}
    finally{lock(false);}
  }
  trigger.onclick=()=>{if(!dialog.open)dialog.showModal();};
  field('file').onclick=chooseFile;field('connect').onclick=connect;field('cancel').onclick=close;
  field('password').oninput=update;
  field('password').onkeydown=event=>{if(event.key==='Enter'&&!field('connect').disabled){event.preventDefault();void connect();}};
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  function mount(){const parent=document.querySelector('.machine-manage .sub-nav');if(parent&&trigger.parentElement!==parent)parent.append(trigger);}
  const observer=new MutationObserver(mount);observer.observe(document.body,{childList:true,subtree:true});mount();
  window.gmsshPairingController={open:()=>trigger.click(),remove:()=>{disposed=true;observer.disconnect();trigger.remove();dialog.remove();style.remove();delete window.gmsshPairingController;}};
  return window.gmsshPairingController;
};
