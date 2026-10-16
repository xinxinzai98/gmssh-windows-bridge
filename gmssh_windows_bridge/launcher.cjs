/* Local startup wrapper. The installed GMSSH bundle is read-only. */
const { app, dialog, ipcMain, autoUpdater, clipboard } = require('electron');
const { isIP } = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { PairingManager, loopbackRequest } = require('./pairing.cjs');
const { DeviceBackup, writeBackup, MAX_FILE } = require('./device-backup.cjs');
const readonlyTools = require('./readonly-tools.cjs');
const config = require('./launcher-config.json');
const backends = [];
const stopBackends = () => backends.forEach(child => child.kill('SIGTERM'));

// This isolates browser state only; the vendor's machine database may be shared.
if (config.profile) app.setPath('userData', config.profile);
// Keep the original app as the handler for gmssh:// authentication callbacks.
app.setAsDefaultProtocolClient = () => false;
app.getAppPath = () => config.vendorAsar;
app.on('will-quit', stopBackends);
app.on('quit', stopBackends);

const entry = fs.readFileSync(path.join(__dirname, 'gmssh-entry.js'), 'utf8');
const home = fs.readFileSync(path.join(__dirname, 'gmssh-home.js'), 'utf8');
const pairingPage = fs.readFileSync(path.join(__dirname, 'gmssh-pairing.js'), 'utf8');
const backupPage = fs.readFileSync(path.join(__dirname, 'gmssh-backup.js'), 'utf8');
const toolsPage = fs.readFileSync(path.join(__dirname, 'gmssh-tools.js'), 'utf8');
const qrPage = fs.readFileSync(path.join(__dirname, 'gmssh-qr.js'), 'utf8');
const qrDecoder = fs.readFileSync(path.join(__dirname, 'jsQR.js'), 'utf8');
const theme = fs.readFileSync(path.join(__dirname, 'gmssh-theme.css'), 'utf8');
const viewerUrl = `http://127.0.0.1:${config.port}/`;
const legacyBindings = [], windows = new Set();
const backups = new WeakMap();
const toolQueries = new WeakSet();
let pairing, pairingAvailable = false, nativeApiPort;
let vendorUpdateNotice;
const indexUrl = pathToFileURL(path.join(config.vendorAsar, 'dist/index.html')).href;
const updateExplanation = '本增强版包含 Windows 桌面、监控和终端适配。官方更新包不包含这些功能，请通过验收后的增强版兼容包更新。';
// Vendor metadata checks remain active. Its installer must never replace our bundle.
autoUpdater.checkForUpdates = () => {};
autoUpdater.quitAndInstall = () => {};
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, channel === 'render-to-main' ? async (event, request, ...args) => {
  if(request?.type==='gmssh-tools-query'){
    if(event.sender?.getURL().split('#')[0]!==indexUrl)return {status:'error',code:'UNTRUSTED_PAGE'};
    if(toolQueries.has(event.sender))return {status:'error',code:'QUERY_BUSY'};
    toolQueries.add(event.sender);
    try{
      const ports=await listener(event,{type:'get-port'});nativeApiPort=ports?.multiPort;
      return {status:'ok',data:await readonlyTools.query({api:nativeRequest,pairing,legacy:legacyBindings,python:config.python,sender:event.sender},request.data)};
    }catch{return {status:'error',code:'QUERY_FAILED'};}
    finally{toolQueries.delete(event.sender);}
  }
  if(['gmssh-backup-list','gmssh-backup-export','gmssh-backup-open','gmssh-backup-preview','gmssh-backup-import','gmssh-backup-clear'].includes(request?.type)){
    if(event.sender?.getURL().split('#')[0]!==indexUrl||!pairingAvailable)return {status:'error',message:'配置备份暂不可用，请检查本地管理端。'};
    let backup;
    try{
      if(!backups.has(event.sender))backups.set(event.sender,new DeviceBackup({pairing,api:nativeRequest,changed:async()=>{for(const contents of windows)if(!contents.isDestroyed()&&contents.getURL().split('#')[0]===indexUrl)await inject(contents);}}));
      backup=backups.get(event.sender);
      if(request.type==='gmssh-backup-clear'){backup.clear();return {status:'ok'};}
      const ports=await listener(event,{type:'get-port'});nativeApiPort=ports?.multiPort;
      if(request.type==='gmssh-backup-list')return {status:'ok',data:await backup.list()};
      if(request.type==='gmssh-backup-open'){
        if(backup.busy)throw Error('正在导入，请等待操作结束。');
        const picked=await dialog.showOpenDialog({title:'导入设备配置',properties:['openFile'],filters:[{name:'GMSSH 配置备份',extensions:['gmsshbackup','json']}]});
        if(picked.canceled||!picked.filePaths.length)return {status:'cancelled'};
        const file=picked.filePaths[0],stat=fs.statSync(file);if(!stat.isFile()||stat.size>MAX_FILE)throw Error('请选择不超过 8 MiB 的 GMSSH 配置备份。');
        return {status:'ok',data:{...backup.open(fs.readFileSync(file)),filename:path.basename(file)}};
      }
      if(request.type==='gmssh-backup-preview')return {status:'ok',data:await backup.inspect(request.data?.password)};
      if(request.type==='gmssh-backup-import')return {status:'ok',data:await backup.import(request.data||{})};
      const saved=await dialog.showSaveDialog({title:'导出所选设备配置',defaultPath:'GMSSH-devices-'+new Date().toISOString().slice(0,10)+(request.data?.encrypted?'.gmsshbackup':'.json'),filters:[{name:'GMSSH 配置备份',extensions:request.data?.encrypted?['gmsshbackup']:['json']}]});
      if(saved.canceled||!saved.filePath)return {status:'cancelled'};
      const body=await backup.export(request.data?.ids,request.data?.encrypted,request.data?.password);
      try{writeBackup(saved.filePath,body);}finally{body.fill(0);}
      return {status:'ok',data:{count:request.data.ids.length,filename:path.basename(saved.filePath)}};
    }catch(error){return {status:'error',message:error instanceof Error?error.message:'配置转移未完成，请重新核对备份。'};}
    finally{if(request?.data&&typeof request.data==='object'){delete request.data.password;delete request.data.auth;}}
  }
  if (['gmssh-pair-file','gmssh-pair-paste','gmssh-pair-text','gmssh-pair-manual','gmssh-pair-edit','gmssh-pair-clear','gmssh-pair-connect','gmssh-pair-desktop-auth'].includes(request?.type)) {
    if (event.sender?.getURL().split('#')[0] !== indexUrl || !pairingAvailable) return {status:'error',message:'接入向导暂不可用，请检查本地连接配置。'};
    try {
      if(request.type==='gmssh-pair-desktop-auth')return {status:'ok',data:typeof request.data?.machineId==='string'?pairing.takeDesktopAuth(request.data.machineId):null};
      if(request.type==='gmssh-pair-clear'){pairing.clearPreview();return {status:'ok'};}
      if(request.type==='gmssh-pair-manual'){
        if(!request.data||typeof request.data!=='object'||Array.isArray(request.data))throw Error('请填写连接地址、端口和账号。');
        const {target,port,computer,username,sharedPassword}=request.data;
        return {status:'ok',data:await pairing.manual({target,port,computer,username,sharedPassword})};
      }
      if(request.type==='gmssh-pair-edit')return {status:'ok',data:await pairing.edit(request.data?.machineId)};
      if(request.type==='gmssh-pair-text'){
        const text=request.data?.text;
        if(pairing.busy)throw Error('正在接入，请等待当前操作完成。');
        if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>65536)throw Error('请粘贴有效连接码，或选择不超过 64 KB 的连接文件。');
        return {status:'ok',data:await pairing.inspect(text)};
      }
      if(request.type==='gmssh-pair-paste'){
        if(pairing.busy)throw Error('正在接入，请等待当前操作完成。');
        const text=clipboard.readText();
        if(!text||Buffer.byteLength(text)>65536)throw Error('剪贴板中没有有效的 GMSSH 连接码或连接信息。');
        return {status:'ok',data:await pairing.inspect(text)};
      }
      if (request.type==='gmssh-pair-file') {
        if(pairing.busy)throw Error('正在接入，请等待当前操作完成。');
        const result=await dialog.showOpenDialog({title:'导入 Windows 连接文件',properties:['openFile'],filters:[{name:'GMSSH 连接文件',extensions:['json']}]});
        if(result.canceled||!result.filePaths.length)return {status:'cancelled'};
        const file=result.filePaths[0],stat=fs.statSync(file);
        if(!stat.isFile()||stat.size>65536)throw Error('请选择 Windows 生成的 GMSSH-connection.json，文件不能超过 64 KB。');
        return {status:'ok',data:await pairing.inspect(fs.readFileSync(file,'utf8'))};
      }
      const ports=await listener(event,{type:'get-port'});
      nativeApiPort=ports?.multiPort;
      if(!Number.isInteger(nativeApiPort)||nativeApiPort<1||nativeApiPort>65535)throw Error('GMSSH 本地服务尚未就绪，请稍后重试。');
      if(!request.data||typeof request.data!=='object'||Array.isArray(request.data))throw Error('接入信息格式无效。');
      return {status:'ok',data:await pairing.connect(request.data)};
    } catch(error) {return {status:'error',message:error instanceof Error?error.message:'接入未完成，请重新核对连接信息。'};}
    finally {if(request?.data&&typeof request.data==='object'){delete request.data.password;delete request.data.text;}}
  }
  if (request?.type === 'gmssh-copy-address') {
    const address = request.data;
    if (event.sender?.getURL().split('#')[0] !== indexUrl || typeof address !== 'string' || address.length > 253 ||
        !(isIP(address) || /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(address))) return { status: 'error' };
    clipboard.writeText(address);
    return { status: 'ok' };
  }
  if (['update-download', 'install-update'].includes(request?.type)) {
    await dialog.showMessageBox({ type: 'info', message: '增强版更新需要兼容包', detail: updateExplanation });
    return { status: 'error', message: updateExplanation };
  }
  return listener(event, request, ...args);
} : listener);
app.on('browser-window-created', (_event, window) => {
  const contents = window.webContents;
  const send = contents.send.bind(contents);
  contents.send = (channel, payload, ...args) => {
    if (channel === 'main-to-render' && ['upgrade-prompt', 'update-downloaded'].includes(payload?.type)) {
      const version = payload.data?.version;
      vendorUpdateNotice = { version: typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) ? version : '' };
      contents.executeJavaScript('window.installWindowsUpdateNotice?.(' + JSON.stringify(vendorUpdateNotice) + ');void 0;').catch(() => {});
      return;
    }
    return send(channel, payload, ...args);
  };
  contents.on('did-finish-load', () => {
    if (contents.getURL().split('#')[0] !== indexUrl) return;
    windows.add(contents);contents.once('destroyed',()=>{windows.delete(contents);backups.get(contents)?.clear();});
    inject(contents).catch(error => {
      dialog.showMessageBox(window, { type: 'error', message: 'Windows 桌面入口加载失败',
        detail: error instanceof Error ? error.message : '请检查 GMSSH 版本和本地启动器配置。' });
    });
  });
});

async function inject(contents) {
  const bindings=[...legacyBindings.filter(value=>!pairing?.records.some(record=>record.machineId===value.machineId)),...(pairing?.bindings()||[])];
  const entries=bindings.map(value=>({machineId:value.machineId??undefined,viewerUrl:value.viewerUrl,label:value.label,
    card:value.machineId?undefined:{host:value.target,name:value.tailscaleName||value.target},autoConnect:true,accessToken:value.accessToken}));
  const devices=bindings.map(value=>({machineId:value.machineId,viewerUrl:value.viewerUrl,target:value.target,targetPort:value.monitor?.targetPort,accessToken:value.accessToken}));
  const policies=bindings.filter(value=>value.monitor).map(value=>({bridgePort:value.monitor.port,username:value.monitor.username}));
  const first=devices[0]||{viewerUrl};
  const bootstrap=entry+'\nif(typeof installWindowsDesktopEntries==="function")installWindowsDesktopEntries('+JSON.stringify(entries)+');else if('+entries.length+')installWindowsDesktopEntry('+JSON.stringify(entries[0]||{})+');\n'+home+'\ninstallWindowsMachinePolicy('+JSON.stringify(policies)+');\nglobalThis.gmsshHomeController=installGMSSHHome('+JSON.stringify({...first,viewerUrl,css:theme,devices})+');\n'+pairingPage+'\nif(typeof installGMSSHPairing==="function")installGMSSHPairing();\n'+backupPage+'\nif(typeof installGMSSHBackup==="function")installGMSSHBackup('+JSON.stringify({viewerUrl})+');\n'+(vendorUpdateNotice?'installWindowsUpdateNotice('+JSON.stringify(vendorUpdateNotice)+');\n':'')+'void 0;';
  await contents.executeJavaScript('(()=>{const module={exports:{}};const exports=module.exports;'+qrDecoder+'\nwindow.jsQR=module.exports;})();\n'+qrPage+'\n'+bootstrap+'\n'+toolsPage+'\nif(typeof installGMSSHTools==="function")installGMSSHTools('+JSON.stringify({viewerUrl})+');void 0;');
}

async function nativeRequest(endpoint,data) {
  return loopbackRequest(nativeApiPort,endpoint,data);
}

async function startService(args, label, isReady, target=config.target) {
  const environment = { ...process.env, PYTHONUNBUFFERED: '1' };
  delete environment.PYTHONPATH;
  delete environment.PYTHONHOME;
  const child = spawn(config.python, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  backends.push(child);
  let errors = '', lastUpstreamError;
  const upstreamErrors = {
    PermissionError: '系统拒绝了后台服务的访问，请检查本机应用权限。',
    BadHostKeyException: 'Windows 主机密钥与已核验的身份不一致，请先核对目标电脑。',
    FileNotFoundError: '已核验的 Windows 主机密钥文件不存在，请检查本机连接配置。',
  };
  child.stderr.on('data', data => {
    errors = (errors + data.toString()).slice(-4096);
    const lines = errors.split('\n'); errors = lines.pop();
    for (const line of lines) {
      const type = /^WARNING Upstream connection failed \((\w+)\)\r?$/.exec(line)?.[1];
      if (!Object.hasOwn(upstreamErrors, type) || type === lastUpstreamError) continue;
      lastUpstreamError = type;
      app.whenReady().then(() => dialog.showMessageBox({ type: 'error', message: '无法连接 Windows SSH',
        detail: `${target} · ${upstreamErrors[type]}（${type}）\n这类错误不能通过重新输入密码解决。` })).catch(() => {});
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`${label}启动超时。`)), 15000);
    let output = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true; output = ''; clearTimeout(timer); error ? reject(error) : resolve();
    };
    child.once('error', () => finish(new Error(`无法启动${label}，请检查本机运行环境。`)));
    child.once('exit', () => finish(new Error(`${label}未启动，请检查端口和连接配置。`)));
    child.stdout.on('data', data => {
      if (settled) return;
      output = (output + data.toString()).slice(-4096);
      try {
        if (output.split('\n').slice(0, -1).some(isReady)) finish();
      } catch { finish(new Error(`${label}未返回有效的启动信息。`)); }
    });
  });
}

async function startDevice(device) {
  const viewerUrl=`http://127.0.0.1:${device.port}/`;
  let accessToken;
  const firstChild=backends.length;
  const desktopReady = line => {
    if (!line.startsWith('RustDesk desktop preview: ')) return false;
    const address = new URL(line.slice('RustDesk desktop preview: '.length).trim());
    if (address.origin + address.pathname !== viewerUrl || address.search || address.username || address.password) throw new Error();
    const token = new URLSearchParams(address.hash.slice(1)).get('token');
    if ((device.keychain || device.monitor || device.wake) && (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token))) throw new Error();
    accessToken = token || undefined;
    return true;
  };
  try { if (device.monitor) {
    const m = device.monitor;
    const args = ['-m', 'gmssh_windows_bridge', '--target', device.target,
      '--target-port', String(m.targetPort), '--username', m.username,
      '--listen-port', String(m.port), '--known-hosts', m.knownHosts, '--host-key', m.hostKey,
      '--desktop-port', String(device.port), '--desktop-shared-auth'];
    if (m.forwardTerminal) args.push('--gmssh-terminal', '--shell', 'powershell');
    if (device.wake) args.push('--wake-mac', device.wake.mac, '--wake-broadcast', device.wake.broadcast);
    if (device.keychain) args.push('--desktop-keychain');
    for(const target of device.credentialAliases||[])args.push('--desktop-credential-alias',target);
    let monitorStarted = false, desktopStarted = false;
    await startService(args, '本地监控与桌面服务', line => {
      if (line.trim() === `Monitoring bridge ready: 127.0.0.1:${m.port}`) monitorStarted = true;
      if (desktopReady(line)) desktopStarted = true;
      return monitorStarted && desktopStarted;
    },device.target);
  } else {
    const args = ['-m', 'gmssh_windows_bridge.desktop', '--target', device.target,
      '--direct-tailscale', '--tailscale-name', device.tailscaleName,
      '--tailscale-cli', device.tailscaleCli, '--listen-port', String(device.port)];
    if (device.keychain) args.push('--keychain');
    if (device.wake) args.push('--wake-mac', device.wake.mac, '--wake-broadcast', device.wake.broadcast);
    await startService(args, '本地桌面服务', desktopReady,device.target);
  }
  }catch(error){await stopChildren(backends.slice(firstChild));throw error;}
  const children=backends.slice(firstChild);
  return {...device,viewerUrl,accessToken,stop:()=>stopChildren(children)};
}

async function stopChildren(children) {
  await Promise.all(children.map(child=>new Promise((resolve,reject)=>{
    if(child.exitCode!=null||child.signalCode!=null){resolve();return;}
    const timer=setTimeout(()=>reject(Error('原本机连接进程尚未退出，请重开客户端。')),5000);
    child.once('exit',()=>{clearTimeout(timer);resolve();});
    child.kill('SIGTERM');
  })));
}

async function start() {
  if (!app.requestSingleInstanceLock()) {
    await app.whenReady();
    await dialog.showMessageBox({ type: 'info', message: 'GMSSH 已在运行',detail: '首次切换请先正常退出原 GMSSH，再打开 Windows 桌面启动器。' });
    app.exit(0);return;
  }
  delete process.env.VITE_DEV_SERVER_URL;
  if(config.pairingOnly){
    await startService(['-m','gmssh_windows_bridge.pairing','--serve-assets','--port',String(config.port)],'本地界面服务',line=>line.trim()==='GMSSH local assets: '+viewerUrl);
  }else{
    const binding={...config};
    if(config.monitor){
      try{const endpoint=config.monitor.targetPort===22?config.target:`[${config.target}]:${config.monitor.targetPort}`;
        const key=fs.readFileSync(config.monitor.knownHosts,'utf8').split('\n').map(line=>line.trim().split(/\s+/)).find(parts=>parts[0]?.split(',').includes(endpoint)&&parts[1]==='ssh-ed25519');
        if(key){binding.fingerprint='SHA256:'+createHash('sha256').update(Buffer.from(key[2],'base64')).digest('base64').replace(/=+$/,'');binding.sshHostPublicKey='ssh-ed25519 '+key[2];}
      }catch{}
    }
    legacyBindings.push(binding);
  }
  pairing=new PairingManager({root:path.join(app.getPath('userData'),'windows-devices'),python:config.python,legacy:legacyBindings,reserved:[config.port],keychain:config.keychain===true,startDevice,api:nativeRequest,
    changed:async()=>{for(const contents of windows)if(!contents.isDestroyed()&&contents.getURL().split('#')[0]===indexUrl)await inject(contents);}});
  try{
    const warnings=await pairing.restore();pairingAvailable=true;
    if(warnings.length)app.whenReady().then(()=>dialog.showMessageBox({type:'warning',message:'部分 Windows 连接未启动',detail:warnings.join('\n')}));
  }catch{pairing.records=[];app.whenReady().then(()=>dialog.showMessageBox({type:'error',message:'无法读取已保存的 Windows 接入信息',detail:'新增接入暂不可用，现有配置已保留。请检查本机 windows-devices 目录。'}));}
  if(!config.pairingOnly&&!pairing.records.some(record=>record.legacyMachineId===config.machineId)){
    Object.assign(legacyBindings[0],await startDevice(config));
  }
  await import(pathToFileURL(path.join(config.vendorAsar, 'dist-electron/main.js')).href);
}
start().catch(async error => {
  stopBackends();
  await app.whenReady();
  await dialog.showMessageBox({ type: 'error', message: '启动失败',
    detail: error instanceof Error ? error.message : '请核对本机运行环境和连接配置。' });
  app.exit(1);
});
