/* Selected-device transfer UI; backup contents and saved credentials stay in main. */
window.installGMSSHBackup=function({viewerUrl}){
  if(window.gmsshBackupController)return window.gmsshBackupController;
  const base=new URL(viewerUrl);if(base.protocol!=='http:'||!['127.0.0.1','localhost'].includes(base.hostname))throw Error('Local backup assets required');
  const make=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls||'';if(text!==undefined)node.textContent=text;return node;};
  const icon=name=>{const node=make('img','gm-ui-icon');node.src=new URL('ui-icons/'+name+'.svg',base).href;node.alt='';return node;};
  const button=(label,fn,name)=>{const node=make('button','gm-ui-button',label);node.type='button';node.title=label;node.onclick=fn;if(name)node.prepend(icon(name));return node;};
  const invoke=async(type,data)=>{const reply=await window.electronAPI?.invoke('render-to-main',{type,data});if(reply?.status==='error'||!reply)throw Error(reply?.message||'配置备份服务不可用。');return reply;};
  const tools=make('div','gm-backup-tools');tools.id='gmssh-backup-tools';
  const dialog=make('dialog','gm-backup-dialog');dialog.setAttribute('aria-label','设备配置转移');
  const title=make('h2'),closeButton=button('关闭',close,'x'),head=make('div','gm-backup-head');head.append(title,closeButton);
  const hint=make('p','gm-muted'),settings=make('div','gm-backup-settings'),selection=make('div','gm-backup-selection'),search=make('input');search.type='search';search.placeholder='搜索设备名称、地址或分组';search.setAttribute('aria-label','搜索备份设备');
  const list=make('div','gm-backup-list'),status=make('p','gm-backup-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const cancel=button('取消',close),submit=button('导出所选',save);submit.classList.add('primary');const footer=make('div','gm-backup-footer');footer.append(status,cancel,submit);
  const content=make('div','gm-backup-content');content.append(hint,settings,selection,list);dialog.append(head,content,footer);document.body.append(dialog);
  let mode='export',rows=[],preview,reading=false,writing=false,disposed=false,epoch=0,encrypted,password,confirm,remember;
  const say=value=>{status.textContent=value;};
  const lock=(value,write=false)=>{reading=value;writing=value&&write;closeButton.disabled=cancel.disabled=writing;tools.querySelectorAll('button').forEach(node=>node.disabled=value);update();};
  function attach(){const host=document.querySelector('.machine-manage .machine-head .head-right')||document.querySelector('.machine-head,[data-gmssh-backup-toolbar]');if(host&&!host.contains(tools))host.append(tools);}
  function clearSecrets(){dialog.querySelectorAll('input[type=password],textarea').forEach(node=>node.value='');}
  function close(){if(writing)return;epoch++;clearSecrets();dialog.close();rows=[];preview=undefined;settings.replaceChildren();list.replaceChildren();void invoke('gmssh-backup-clear').catch(()=>{});lock(false);}
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  function labelled(label,input){const node=make('label','gm-backup-field');node.append(make('span','',label),input);return node;}
  function secret(label){const node=make('input');node.type='password';node.autocomplete='new-password';node.setAttribute('aria-label',label);node.oninput=update;return node;}
  function prepare(next){
    epoch++;mode=next;clearSecrets();preview=undefined;rows=[];encrypted=password=confirm=remember=undefined;settings.replaceChildren();list.replaceChildren();selection.replaceChildren();say('');
    title.textContent=mode==='export'?'导出设备配置':'导入设备配置';hint.textContent=mode==='export'?'勾选需要转移或备份的电脑。Windows 桌面与监控绑定会一起保存。':'先核对并勾选设备。只新增所选连接，已有设备保留；不会安装软件或执行远端命令。';
    const all=button('选中搜索结果',()=>{for(const row of rows)if(!row.node.hidden&&!row.box.disabled){row.box.checked=true;dependencies(row);}update();});
    const none=button('取消选择',()=>{for(const row of rows){row.box.checked=false;row.auth?.forEach(input=>input.value='');}update();});
    search.value='';selection.append(search,all,none);if(!dialog.open)dialog.showModal();lock(false);return epoch;
  }
  function dependencies(row,seen=new Set()){
    const id=row.device.ref||row.device.id;if(!row.box.checked||!row.device.bastion||seen.has(id))return;seen.add(id);
    const parent=rows.find(item=>(item.device.ref||item.device.id)===row.device.bastion);if(parent&&parent.device.status!=='conflict'){parent.box.checked=true;dependencies(parent,seen);}
  }
  function update(){
    const chosen=rows.filter(row=>row.box.checked);let valid=!!chosen.length;
    for(const row of rows){row.node.classList.toggle('selected',row.box.checked);row.fields&&(row.fields.hidden=!row.box.checked);if(row.box.checked&&row.device.bastion&&!chosen.some(item=>(item.device.ref||item.device.id)===row.device.bastion))valid=false;if(row.box.checked&&row.auth&&!row.auth[0].value)valid=false;}
    if(mode==='export'&&encrypted?.checked&&(!password?.value||password.value.length<8||password.value!==confirm?.value))valid=false;
    submit.textContent=(mode==='export'?'导出所选':'导入所选')+(chosen.length?'（'+chosen.length+'）':'');submit.disabled=reading||!valid||chosen.length>200;
    selection.hidden=!rows.length;
  }
  function showRows(devices){
    list.replaceChildren();rows=devices.map(original=>{const device={...original,bastion:original.bastion||original.dependsOn||''};
      const node=make('section','gm-backup-device'),box=make('input');box.type='checkbox';box.setAttribute('aria-label','选择 '+device.name);box.checked=mode==='import'&&device.status==='new';box.disabled=mode==='import'&&device.status!=='new';
      const label=make('label','gm-backup-identity'),image=icon(device.kind==='windows'?'windows':'terminal-window'),detail=make('span'),name=make('strong','',device.name),meta=make('small','gm-muted',device.address+' · '+device.port+' · '+device.username+(device.group?' · '+device.group:''));if(device.kind==='windows')image.style.filter='none';detail.append(name,meta);label.append(box,image,detail);
      const badge=make('span','gm-backup-badge',device.status==='existing'?'已存在，保留':device.status==='conflict'?'身份冲突':device.kind==='windows'?'桌面与监控':'SSH 连接');node.append(label,badge);
      const row={device,node,box,badge};
      if(mode==='import'&&!device.hasCredentials&&device.status==='new'){
        const fields=make('div','gm-backup-login'),login=device.authType==='ca'?make('textarea'):secret(device.name+' SSH 密码');login.setAttribute('aria-label',device.name+(device.authType==='ca'?' SSH 私钥':' SSH 密码'));if(device.authType==='ca'){login.rows=3;login.spellcheck=false;login.oninput=update;}
        fields.append(labelled(device.authType==='ca'?'SSH 私钥':'SSH 密码',login));row.auth=[login];
        if(device.authType==='ca'){const pass=secret(device.name+' 私钥口令（可选）');fields.append(labelled('私钥口令（可选）',pass));row.auth.push(pass);}node.append(fields);row.fields=fields;
      }
      box.onchange=()=>{if(!box.checked)row.auth?.forEach(input=>input.value='');dependencies(row);update();};list.append(node);return row;
    });
    for(const row of rows)dependencies(row);update();
    if(!rows.length)list.append(make('p','gm-muted','没有可导出的设备。先添加电脑，或使用“导入配置”恢复备份。'));
  }
  search.oninput=()=>{const term=search.value.trim().toLowerCase();for(const row of rows)row.node.hidden=![row.device.name,row.device.address,row.device.group,row.device.username].some(value=>(value||'').toLowerCase().includes(term));};
  async function exportDevices(){
    const run=prepare('export');lock(true);say('正在读取设备列表…');
    try{const reply=await invoke('gmssh-backup-list');if(run!==epoch||disposed)return;
      encrypted=make('input');encrypted.type='checkbox';encrypted.setAttribute('aria-label','加密备份（含 SSH 密码和私钥）');const choice=make('label','gm-backup-check');choice.append(encrypted,make('span','','加密备份（含 SSH 密码和私钥）'));
      password=secret('备份口令'),confirm=secret('再次输入备份口令');const inputs=make('div','gm-backup-passwords');inputs.append(labelled('备份口令（至少 8 字符）',password),labelled('再次输入',confirm));inputs.hidden=true;
      const note=make('p','gm-muted','普通配置不含登录凭据，恢复时需补充。');encrypted.onchange=()=>{password.value=confirm.value='';inputs.hidden=!encrypted.checked;note.textContent=encrypted.checked?'请牢记备份口令。独立设置的桌面密码需在新管理端重新填写。':'普通配置不含登录凭据，恢复时需补充。';update();};settings.append(choice,inputs,note);showRows(reply.data);say('请选择设备，最多 200 台；依赖的跳板机需一并选择。');
    }catch(error){if(run===epoch)say(error.message);}finally{if(run===epoch)lock(false);}
  }
  async function importDevices(){
    const run=prepare('import');lock(true);say('请选择备份文件…');
    try{const reply=await invoke('gmssh-backup-open');if(run!==epoch||disposed)return;if(reply.status==='cancelled'){close();return;}
      if(reply.data.encrypted){password=secret('解锁备份口令');const unlock=button('解锁并预览',()=>readPreview());settings.append(make('p','gm-muted',reply.data.filename),labelled('备份口令',password),unlock);password.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void readPreview();}});say('请输入创建备份时设置的口令。');password.focus();}
      else await readPreview();
    }catch(error){if(run===epoch)say(error.message);}finally{if(run===epoch)lock(false);}
  }
  async function readPreview(){
    const run=epoch;lock(true);say('正在核对备份…');const value=password?.value||'';
    try{const reply=await invoke('gmssh-backup-preview',{password:value});if(run!==epoch||disposed)return;clearSecrets();preview=reply.data;settings.replaceChildren();showRows(preview.devices);
      const note=make('p','gm-muted','已存在的设备自动保留；身份冲突不会覆盖。缺少凭据的所选设备需在下方补充。');settings.append(note);
      if(preview.canRememberDesktop&&preview.devices.some(item=>item.kind==='windows')){remember=make('input');remember.type='checkbox';const label=make('label','gm-backup-check');label.append(remember,make('span','','记住 Windows 桌面密码（本机钥匙串）'));settings.append(label);}
      say('备份时间：'+new Date(preview.createdAt).toLocaleString());
    }catch(error){if(run===epoch){clearSecrets();say(error.message);}}finally{if(run===epoch)lock(false);}
  }
  async function save(){
    if(submit.disabled)return;const run=epoch,chosen=rows.filter(row=>row.box.checked);lock(true,true);say(mode==='export'?'正在生成备份…':'正在保存所选设备配置…');
    try{
      if(mode==='export'){
        const reply=await invoke('gmssh-backup-export',{ids:chosen.map(row=>row.device.id),encrypted:!!encrypted.checked,password:password.value});clearSecrets();
        if(reply.status==='cancelled'){say('已取消保存，选择仍保留。');return;}say('已导出 '+reply.data.count+' 台设备：'+reply.data.filename);
      }else{
        const auth={};for(const row of chosen)if(row.auth)auth[row.device.ref]={authValue:row.auth[0].value,...(row.auth[1]?.value?{keyPass:row.auth[1].value}:{})};
        const reply=await invoke('gmssh-backup-import',{id:preview.id,ids:chosen.map(row=>row.device.ref),auth,rememberDesktop:!!remember?.checked});clearSecrets();
        let imported=0,skipped=0,failed=0;
        for(const result of reply.data.results){const row=rows.find(row=>row.device.ref===result.ref);if(!row)continue;if(result.status==='failed'){failed++;row.badge.textContent=result.message;row.node.classList.add('failed');}else{result.status==='imported'?imported++:skipped++;row.box.checked=false;row.box.disabled=true;row.device.status=result.status;row.badge.textContent=result.status==='imported'?'已导入':'已存在，保留';}}
        say('导入完成：新增 '+imported+' 台，保留 '+skipped+' 台'+(failed?'，失败 '+failed+' 台。可修正后重试。':'。'));
        document.querySelector('.machine-manage .action-btn .icon-shuaxin')?.closest('.action-btn')?.click();window.gmsshHomeController?.refresh();
      }
    }catch(error){clearSecrets();if(run===epoch)say(error.message);}finally{if(run===epoch)lock(false);}
  }
  tools.append(button('导出配置',exportDevices,'upload-simple'),button('导入配置',importDevices,'download-simple'));
  const observer=new MutationObserver(attach);observer.observe(document.body,{childList:true,subtree:true});attach();
  const controller={openExport:exportDevices,openImport:importDevices,remove(){if(writing)return;close();disposed=true;observer.disconnect();tools.remove();dialog.remove();delete window.gmsshBackupController;}};
  window.gmsshBackupController=controller;return controller;
};
