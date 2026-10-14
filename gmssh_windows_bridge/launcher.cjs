/* Local startup wrapper. The installed GMSSH bundle is read-only. */
const { app, dialog, ipcMain, autoUpdater, clipboard } = require('electron');
const { isIP } = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
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
const theme = fs.readFileSync(path.join(__dirname, 'gmssh-theme.css'), 'utf8');
const viewerUrl = `http://127.0.0.1:${config.port}/`;
let accessToken;
let vendorUpdateNotice;
const indexUrl = pathToFileURL(path.join(config.vendorAsar, 'dist/index.html')).href;
const updateExplanation = '本增强版包含 Windows 桌面、监控和终端适配。官方更新包不包含这些功能，请通过验收后的增强版兼容包更新。';
// Vendor metadata checks remain active. Its installer must never replace our bundle.
autoUpdater.checkForUpdates = () => {};
autoUpdater.quitAndInstall = () => {};
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, channel === 'render-to-main' ? async (event, request, ...args) => {
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
    const bootstrap = entry + '\ninstallWindowsDesktopEntry(' + JSON.stringify({
      machineId: config.machineId ?? undefined, viewerUrl, label: config.label,
      card: config.machineId ? undefined : { host: config.target, name: config.tailscaleName || config.target },
      autoConnect: true, accessToken,
    }) + ');\n' + home + '\n' + (config.monitor ? 'installWindowsMachinePolicy(' + JSON.stringify({
      bridgePort: config.monitor.port, username: config.monitor.username,
    }) + ');\n' : '') + 'installGMSSHHome(' + JSON.stringify({
      viewerUrl, machineId:config.machineId ?? undefined, target:config.target,targetPort:config.monitor?.targetPort,css:theme,accessToken,
    }) + ');\n' + (vendorUpdateNotice ? 'installWindowsUpdateNotice(' + JSON.stringify(vendorUpdateNotice) + ');\n' : '') + 'void 0;';
    contents.executeJavaScript(bootstrap).catch(error => {
      dialog.showMessageBox(window, { type: 'error', message: 'Windows 桌面入口加载失败',
        detail: error instanceof Error ? error.message : '请检查 GMSSH 版本和本地启动器配置。' });
    });
  });
});

async function startService(args, label, isReady) {
  const environment = { ...process.env, PYTHONUNBUFFERED: '1' };
  delete environment.PYTHONPATH;
  delete environment.PYTHONHOME;
  const child = spawn(config.python, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  backends.push(child);
  let errors = '', lastUpstreamError;
  const upstreamErrors = {
    PermissionError: '系统拒绝了后台服务的访问，请检查本机应用权限。',
    BadHostKeyException: 'Windows 主机密钥与已核验的身份不一致，请先核对目标电脑。',
    NoValidConnectionsError: '无法到达 Windows SSH 服务，请检查地址、端口和服务状态。',
    TimeoutError: '连接 Windows SSH 超时，请检查网络和服务状态。',
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
        detail: `${config.target} · ${upstreamErrors[type]}（${type}）\n这类错误不能通过重新输入密码解决。` })).catch(() => {});
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

async function start() {
  if (!app.requestSingleInstanceLock()) {
    await app.whenReady();
    await dialog.showMessageBox({ type: 'info', message: 'GMSSH 已在运行',
      detail: '首次切换请先正常退出原 GMSSH，再打开 Windows 桌面启动器。' });
    app.exit(0);
    return;
  }
  // There is no inspector port, developer-server origin, or shell command.
  delete process.env.VITE_DEV_SERVER_URL;
  const desktopReady = line => {
    if (!line.startsWith('RustDesk desktop preview: ')) return false;
    const address = new URL(line.slice('RustDesk desktop preview: '.length).trim());
    if (address.origin + address.pathname !== viewerUrl || address.search || address.username || address.password) throw new Error();
    const token = new URLSearchParams(address.hash.slice(1)).get('token');
    if ((config.keychain || config.monitor || config.wake) && (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token))) throw new Error();
    accessToken = token || undefined;
    return true;
  };
  if (config.monitor) {
    const m = config.monitor;
    const args = ['-m', 'gmssh_windows_bridge', '--target', config.target,
      '--target-port', String(m.targetPort), '--username', m.username,
      '--listen-port', String(m.port), '--known-hosts', m.knownHosts, '--host-key', m.hostKey,
      '--desktop-port', String(config.port), '--desktop-shared-auth'];
    if (m.forwardTerminal) args.push('--gmssh-terminal', '--shell', 'powershell');
    if (config.wake) args.push('--wake-mac', config.wake.mac, '--wake-broadcast', config.wake.broadcast);
    if (config.keychain) args.push('--desktop-keychain');
    let monitorStarted = false, desktopStarted = false;
    await startService(args, '本地监控与桌面服务', line => {
      if (line.trim() === `Monitoring bridge ready: 127.0.0.1:${m.port}`) monitorStarted = true;
      if (desktopReady(line)) desktopStarted = true;
      return monitorStarted && desktopStarted;
    });
  } else {
    const args = ['-m', 'gmssh_windows_bridge.desktop', '--target', config.target,
      '--direct-tailscale', '--tailscale-name', config.tailscaleName,
      '--tailscale-cli', config.tailscaleCli, '--listen-port', String(config.port)];
    if (config.keychain) args.push('--keychain');
    if (config.wake) args.push('--wake-mac', config.wake.mac, '--wake-broadcast', config.wake.broadcast);
    await startService(args, '本地桌面服务', desktopReady);
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
