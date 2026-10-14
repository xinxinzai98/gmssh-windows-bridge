// Run: node --experimental-vm-modules --test tests/test_launcher_startup.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../gmssh_windows_bridge/launcher.cjs'), 'utf8')
  .replace('start().catch(', 'globalThis.completion = start().catch(');

async function launch({ monitoring = true, failure, terminal = false, keychain = true, wake = false } = {}) {
  const children = [], dialogs = [], copies = [];
  const app = new EventEmitter();
  const handlers = new Map();
  const ipcMain = {handle:(channel,listener)=>handlers.set(channel,listener)};
  let nativeInstallCalls = 0;
  const autoUpdater = {checkForUpdates:()=>nativeInstallCalls++,quitAndInstall:()=>nativeInstallCalls++};
  let imported = false, exitCode;
  Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: async () => {}, exit: value => { exitCode = value; } });
  const config = { python: '/synthetic/python', vendorAsar: '/synthetic/app.asar', target: '100.64.0.7',
    tailscaleName: 'synthetic-peer', tailscaleCli: '/synthetic/tailscale', port: 22256, keychain,
    wake: wake ? { mac:'02:00:00:00:00:01', broadcast:'192.168.1.255' } : null,
    monitor: monitoring ? { port: 22255, targetPort: 22, username: 'synthetic-user', knownHosts: '/synthetic/known_hosts', hostKey: '/synthetic/host_key', forwardTerminal: terminal } : null };
  const spawn = (program, args, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    Object.assign(child, { program, args, options, killed: false, kill: () => { child.killed = true; } }); children.push(child);
    setImmediate(() => {
      const monitor = args[1] === 'gmssh_windows_bridge';
      const desktopLine = 'RustDesk desktop preview: http://127.0.0.1:22256/#token=' + (failure === 'token' ? 'bad' : 's'.repeat(43)) + '\n';
      const monitorLine = 'Monitoring bridge ready: 127.0.0.1:22255\n';
      const line = monitor ? (failure === 'desktop' ? '' : desktopLine) + (failure === 'monitor' ? '' : monitorLine) : desktopLine;
      child.stdout.emit('data', Buffer.from(line.slice(0, 12)));
      child.stdout.emit('data', Buffer.from(line.slice(12)));
      if (failure === 'desktop' || failure === 'monitor') child.emit('exit', 1);
    });
    return child;
  };
  const context = { __dirname: '/synthetic', process: { env: { PYTHONPATH: '/must-not-inherit', PYTHONHOME: '/must-not-inherit' } },
    setTimeout, clearTimeout, URL, URLSearchParams,
    require: name => {
      if (name === 'electron') return { app, ipcMain, autoUpdater, clipboard:{writeText:value=>copies.push(value)}, dialog: { showMessageBox: async value => dialogs.push(value) } };
      if (name === 'node:child_process') return { spawn };
      if (name === 'node:fs') return { readFileSync: () => '/* synthetic page entry */' };
      if (name === './launcher-config.json') return config;
      return require(name);
    } };
  vm.runInNewContext(source, context, { importModuleDynamically: async () => { imported = true; return import('node:assert/strict'); } });
  await context.completion;
  return { children, app, dialogs, copies, imported, exitCode, ipcMain, autoUpdater, handlers, nativeInstallCalls:()=>nativeInstallCalls };
}

test('starts one shared SSH bridge, waits for both listeners and keeps monitoring read-only', async () => {
  const result = await launch();
  assert.equal(result.imported, true);
  assert.equal(result.children.length, 1);
  const monitor = result.children[0];
  assert.deepEqual(Array.from(monitor.args), ['-m', 'gmssh_windows_bridge', '--target', '100.64.0.7', '--target-port', '22',
    '--username', 'synthetic-user', '--listen-port', '22255', '--known-hosts', '/synthetic/known_hosts', '--host-key', '/synthetic/host_key',
    '--desktop-port', '22256', '--desktop-shared-auth', '--desktop-keychain']);
  for (const child of result.children) {
    assert.equal(child.options.env.PYTHONPATH, undefined); assert.equal(child.options.env.PYTHONHOME, undefined);
    assert.equal(child.options.shell, undefined);
  }
  result.app.emit('will-quit'); assert.ok(result.children.every(child => child.killed));
});
test('preserves desktop-only startup and rejects failed services or an invalid desktop capability', async () => {
  const legacy = await launch({ monitoring: false });
  assert.equal(legacy.imported, true); assert.equal(legacy.children.length, 1); legacy.app.emit('will-quit');
  for (const failure of ['monitor', 'desktop', 'token']) {
    const result = await launch({ failure });
    assert.equal(result.imported, false); assert.equal(result.exitCode, 1);
    assert.ok(result.children.every(child => child.killed)); assert.equal(result.dialogs.length, 1);
  }
});
test('uses the GMSSH PowerShell compatibility switch and protects wake-only startup', async () => {
  const shell = await launch({terminal:true});
  assert.ok(shell.children[0].args.includes('--gmssh-terminal'));
  assert.ok(shell.children[0].args.includes('powershell'));
  shell.app.emit('will-quit');
  const invalid = await launch({monitoring:false,keychain:false,wake:true,failure:'token'});
  assert.equal(invalid.imported,false); assert.equal(invalid.exitCode,1);
  assert.ok(invalid.children.every(child=>child.killed));
});
test('page injection returns a value Electron can clone across processes', async () => {
  const result=await launch(); const contents=new EventEmitter(); let value='not evaluated';
  contents.getURL=()=> 'file:///synthetic/app.asar/dist/index.html#/home';
  contents.send=()=>{};
  contents.executeJavaScript=async code=>{
    value=vm.runInNewContext(code,{installWindowsDesktopEntry:()=>({open(){}}),installWindowsMachinePolicy:()=>{},installGMSSHHome:()=>({refresh(){}})});
    structuredClone(value);
  };
  result.app.emit('browser-window-created',{}, {webContents:contents}); contents.emit('did-finish-load');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(value,undefined); assert.equal(result.dialogs.length,0);
  result.app.emit('will-quit');
});
test('reports upstream access failures without displaying arbitrary stderr or repeating dialogs', async () => {
  const result = await launch(); const child = result.children[0];
  child.stderr.emit('data', Buffer.from('untrusted diagnostic text\nWARNING Upstream connection failed (Perm'));
  child.stderr.emit('data', Buffer.from('issionError)\nWARNING Upstream connection failed (PermissionError)\n'));
  child.stderr.emit('data', Buffer.from('WARNING Upstream connection failed (AuthenticationException)\n'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.dialogs.length, 1);
  assert.equal(result.dialogs[0].message, '无法连接 Windows SSH');
  assert.match(result.dialogs[0].detail, /PermissionError/);
  assert.doesNotMatch(result.dialogs[0].detail, /untrusted diagnostic/);
  result.app.emit('will-quit');
});
test('blocks vendor bundle replacement while preserving ordinary IPC and metadata notices', async () => {
  const result = await launch(); let delegated = 0;
  result.ipcMain.handle('render-to-main', async (_event, request) => {delegated++; return request.type;});
  const handler = result.handlers.get('render-to-main');
  for (const type of ['update-download','install-update']) assert.equal((await handler({}, {type})).status,'error');
  assert.equal(delegated,0); assert.equal(await handler({}, {type:'get-port'}),'get-port');
  assert.equal(delegated,1);
  result.autoUpdater.checkForUpdates(); result.autoUpdater.quitAndInstall();
  assert.equal(result.nativeInstallCalls(),0);
  const contents = new EventEmitter(), sent = [], scripts = [];
  contents.send=(...args)=>sent.push(args); contents.executeJavaScript=async code=>scripts.push(code);
  result.app.emit('browser-window-created', {}, {webContents:contents});
  contents.send('main-to-render',{type:'upgrade-prompt',data:{version:'2.0.5'}});
  contents.send('main-to-render',{type:'ordinary-message',data:'synthetic'});
  assert.equal(sent.length,1); assert.equal(sent[0][1].type,'ordinary-message');
  assert.ok(scripts.some(code=>code.includes('installWindowsUpdateNotice')&&code.includes('2.0.5')));
  result.app.emit('will-quit');
});
test('copies only an address requested by the trusted native home page', async () => {
  const result=await launch();let delegated=0;
  result.ipcMain.handle('render-to-main',async()=>{delegated++;});
  const handler=result.handlers.get('render-to-main');
  const event={sender:{getURL:()=> 'file:///synthetic/app.asar/dist/index.html#/home'}};
  for(const address of ['192.0.2.42','2001:db8::42','lab-pc.local'])assert.equal((await handler(event,{type:'gmssh-copy-address',data:address})).status,'ok');
  for(const address of ['', '—', '***.***.***.***', '192.0.2.42\ncommand', 'https://example.com', 'a'.repeat(254), 7])assert.equal((await handler(event,{type:'gmssh-copy-address',data:address})).status,'error');
  assert.equal((await handler({sender:{getURL:()=> 'https://example.com/'}},{type:'gmssh-copy-address',data:'192.0.2.42'})).status,'error');
  assert.deepEqual(result.copies,['192.0.2.42','2001:db8::42','lab-pc.local']);assert.equal(delegated,0);
  result.app.emit('will-quit');
});
