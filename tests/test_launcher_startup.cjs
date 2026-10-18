// Run: node --experimental-vm-modules --test tests/test_launcher_startup.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../gmssh_windows_bridge/launcher.cjs'), 'utf8')
  .replace('start().catch(', 'globalThis.testStartDevice = startDevice;globalThis.completion = start().catch(');

async function launch({ monitoring = true, failure, terminal = false, keychain = true, wake = false, pairingOnly = false, clipboardText = '', adopted = false, fileQuitResponse=0, nativeTransfers=false, recordHistory=false } = {}) {
  const children = [], dialogs = [], copies = [], pickers = [], nativeCalls=[],history=[];let nativeActive=0,nativeShutdowns=0;
  const app = new EventEmitter();
  const handlers = new Map();
  const ipcMain = {handle:(channel,listener)=>handlers.set(channel,listener)};
  let nativeInstallCalls = 0;
  const autoUpdater = {checkForUpdates:()=>nativeInstallCalls++,quitAndInstall:()=>nativeInstallCalls++};
  let imported = false, exitCode, clipboardReads = 0,quits=0;
  Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: async () => {}, getPath:()=>'/synthetic/user-data', exit: value => { exitCode = value; },quit:()=>quits++ });
  const config = { python: '/synthetic/python', vendorAsar: '/synthetic/app.asar', target: '100.64.0.7',
    tailscaleName: 'synthetic-peer', tailscaleCli: '/synthetic/tailscale', port: 22256, keychain, pairingOnly,
    wake: wake ? { mac:'02:00:00:00:00:01', broadcast:'192.168.1.255' } : null,
    monitor: monitoring ? { port: 22255, targetPort: 22, username: 'synthetic-user', knownHosts: '/synthetic/known_hosts', hostKey: '/synthetic/host_key', forwardTerminal: terminal } : null };
  if(adopted)config.machineId='1'.repeat(32);
  const spawn = (program, args, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    Object.assign(child, { program, args, options, killed: false, kill: () => { child.killed = true;child.signalCode='SIGTERM';child.emit('exit',null,'SIGTERM'); } }); children.push(child);
    setImmediate(() => {
      const monitor = args[1] === 'gmssh_windows_bridge';
      const desktopLine = 'RustDesk desktop preview: http://127.0.0.1:22256/#token=' + (failure === 'token' ? 'bad' : 's'.repeat(43)) + '\n';
      const monitorLine = 'Monitoring bridge ready: 127.0.0.1:22255\n';
      const line = args[1]==='gmssh_windows_bridge.pairing'?'GMSSH local assets: http://127.0.0.1:22256/\n':monitor ? (failure === 'desktop' ? '' : desktopLine) + (failure === 'monitor' ? '' : monitorLine) : desktopLine;
      child.stdout.emit('data', Buffer.from(line.slice(0, 12)));
      child.stdout.emit('data', Buffer.from(line.slice(12)));
      if (failure === 'desktop' || failure === 'monitor') child.emit('exit', 1);
    });
    return child;
  };
  const context = { __dirname: '/synthetic', process: { env: { PYTHONPATH: '/must-not-inherit', PYTHONHOME: '/must-not-inherit' } },
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, URL, URLSearchParams, Buffer,
    require: name => {
      if (name === 'electron') return { app, ipcMain, autoUpdater, clipboard:{writeText:value=>copies.push(value),readText:()=>{clipboardReads++;return clipboardText;}}, dialog: { showMessageBox: async value => {dialogs.push(value);return {response:fileQuitResponse};},showOpenDialog:async value=>{pickers.push(value);return {canceled:true,filePaths:[]};} } };
      if (name === 'node:child_process') return { spawn };
      if (name === 'node:fs') return { readFileSync: () => '/* synthetic page entry */' };
      if (name === './launcher-config.json') return config;
      if (name === './device-backup.cjs') return require('../gmssh_windows_bridge/device-backup.cjs');
      if (name === './ai-manager.cjs') return require('../gmssh_windows_bridge/ai-manager.cjs');
      if (name === './file-tasks.cjs') return nativeTransfers?{FileTasks:class {activeCount(){return nativeActive;}async invoke(action,id,data){nativeCalls.push({action,id,data});if(action==='pick-upload')nativeActive=1;return action==='hello'?{protocol:2}:{};}async shutdown(){nativeShutdowns++;nativeActive=0;this.closed=true;}}}:require('../gmssh_windows_bridge/file-tasks.cjs');
      if (name === './linux-files.cjs') return require('../gmssh_windows_bridge/linux-files.cjs');
      if (name === './workspace.cjs') return recordHistory?{Workspace:class{event(owner,data){history.push({owner,data});}endOwner(owner){history.push({ended:owner});}heartbeat(){}}}:require('../gmssh_windows_bridge/workspace.cjs');
      if (name === './readonly-tools.cjs') return require('../gmssh_windows_bridge/readonly-tools.cjs');
      if (name === './pairing.cjs') {
        const module=require('../gmssh_windows_bridge/pairing.cjs');
        if(!adopted)return module;
        return {...module,PairingManager:class extends module.PairingManager{
          async restore(){
            this.records=[{id:'a'.repeat(32),machineId:config.machineId,legacyMachineId:config.machineId}];
            this.running.set(this.records[0].id,await this.startDevice({...this.legacy[0],target:'2001:db8::42'}));
            return [];
          }
        }};
      }
      return require(name);
    } };
  vm.runInNewContext(source, context, { importModuleDynamically: async () => { imported = true; return import('node:assert/strict'); } });
  await context.completion;
  return { children, app, dialogs, copies, pickers, imported, exitCode, ipcMain, autoUpdater, handlers, testStartDevice:context.testStartDevice,nativeInstallCalls:()=>nativeInstallCalls, clipboardReads:()=>clipboardReads,quits:()=>quits,nativeCalls,history,nativeShutdowns:()=>nativeShutdowns };
}
test('runtime route metadata updates file bindings only for supplied peers and contains no credential fields',async()=>{
 const result=await launch();const value={target:'2001:db8::42',addresses:['2001:db8::42','192.0.2.42'],autoAddresses:['2001:db8::42','192.0.2.42'],port:22256,monitor:{port:22255,targetPort:22,username:'synthetic-user',knownHosts:'/synthetic/known_hosts',hostKey:'/synthetic/host_key'}};
 const binding=await result.testStartDevice(value),child=result.children.at(-1);assert.equal(child.args.filter(v=>v==='--auto-address').length,2);
 child.stdout.emit('data',Buffer.from('GMSSH_ROUTE '+JSON.stringify({target:'192.0.2.42',scope:'lan',family:'IPv4'})+'\n'));assert.equal(binding.target,'192.0.2.42');assert.equal(binding.route.scope,'lan');
 for(const route of [{target:'198.51.100.42',scope:'remote',family:'IPv4'},{target:'2001:db8::42',scope:'lan',family:'IPv6',password:'must-not-be-used'}])child.stdout.emit('data',Buffer.from('GMSSH_ROUTE '+JSON.stringify(route)+'\n'));
 assert.equal(binding.target,'192.0.2.42');result.app.emit('will-quit');
});
test('route classification rejects untrusted pages and oversized input before spawning a helper',async()=>{
 const result=await launch();result.ipcMain.handle('render-to-main',async()=>({status:'vendor'}));const handler=result.handlers.get('render-to-main'),before=result.children.length;
 assert.equal((await handler({sender:{getURL:()=> 'https://example.com/'}},{type:'gmssh-route-info',data:{targets:['192.0.2.42']}})).status,'error');
 assert.equal((await handler({sender:{getURL:()=> 'file:///synthetic/app.asar/dist/index.html'}},{type:'gmssh-route-info',data:{targets:Array(201).fill('192.0.2.42')}})).status,'error');assert.equal(result.children.length,before);result.app.emit('will-quit');
});

test('AI setup rejects untrusted pages and caller-controlled commands before spawning',async()=>{
 const result=await launch();result.ipcMain.handle('render-to-main',async()=>({status:'vendor'}));const handler=result.handlers.get('render-to-main'),before=result.children.length;
 const denied=await handler({sender:{getURL:()=> 'https://example.com/'}},{type:'gmssh-ai',data:{action:'doctor',data:{}}});assert.equal(denied.code,'UNTRUSTED_PAGE');
 const invalid=await handler({sender:{getURL:()=> 'file:///synthetic/app.asar/dist/index.html'}},{type:'gmssh-ai',data:{action:'doctor',data:{command:'unexpected'}}});assert.equal(invalid.code,'INVALID_ARGUMENT');assert.equal(result.children.length,before);result.app.emit('will-quit');
});

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
test('reopening an adopted fixed-device configuration starts only the replacement IPv6 bridge',async()=>{
  const result=await launch({adopted:true});
  assert.equal(result.imported,true);assert.equal(result.children.length,1);
  const args=Array.from(result.children[0].args);
  assert.equal(args[args.indexOf('--target')+1],'2001:db8::42');
  assert.equal(args[args.indexOf('--listen-port')+1],'22255');
  assert.equal(args[args.indexOf('--host-key')+1],'/synthetic/host_key');
  result.app.emit('will-quit');
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
    value=vm.runInNewContext(code,{window:{},installWindowsDesktopEntry:()=>({open(){}}),installWindowsMachinePolicy:()=>{},installGMSSHHome:()=>({refresh(){}})});
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
test('ordinary offline retries stay non-modal while a host identity failure is still reported',async()=>{
  const result=await launch(),child=result.children[0];
  child.stderr.emit('data',Buffer.from('WARNING Upstream connection failed (TimeoutError)\nWARNING Upstream connection failed (NoValidConnectionsError)\n'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(result.dialogs.length,0);
  child.stderr.emit('data',Buffer.from('WARNING Upstream connection failed (BadHostKeyException)\n'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(result.dialogs.length,1);assert.match(result.dialogs[0].detail,/主机密钥/);
  assert.equal(child.killed,false);result.app.emit('will-quit');
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

test('read-only tool IPC rejects remote pages before querying any device',async()=>{
  const result=await launch();let delegated=0;
  result.ipcMain.handle('render-to-main',async()=>{delegated++;return {multiPort:5000};});
  const handler=result.handlers.get('render-to-main');
  const reply=await handler({sender:{getURL:()=> 'https://untrusted.invalid/'}},{type:'gmssh-tools-query',data:{machineId:'1'.repeat(32),tool:'services',options:{limit:50,search:'',sort:'name'}}});
  assert.equal(reply.status,'error');assert.equal(reply.code,'UNTRUSTED_PAGE');assert.equal(delegated,0);result.app.emit('will-quit');
});

test('file activity is accepted only from the trusted home and protects quit without silently cancelling',async()=>{
  const result=await launch();result.ipcMain.handle('render-to-main',async()=>{});const handler=result.handlers.get('render-to-main');
  const contents={getURL:()=> 'file:///synthetic/app.asar/dist/index.html#/home',isDestroyed:()=>false,executeJavaScript:async()=>{throw Error('must not cancel');}};
  for(const data of [{active:-1,failed:0},{active:1.2,failed:0},{active:1,failed:0,password:'synthetic'},{active:400001,failed:0}])assert.equal((await handler({sender:contents},{type:'gmssh-files-state',data})).status,'error');
  assert.equal((await handler({sender:{getURL:()=> 'https://untrusted.invalid/'}},{type:'gmssh-files-state',data:{active:2,failed:0}})).status,'error');
  assert.equal((await handler({sender:contents},{type:'gmssh-files-state',data:{active:2,failed:0}})).status,'ok');
  let blocked=0;result.app.emit('before-quit',{preventDefault:()=>blocked++});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(blocked,1);assert.equal(result.dialogs.length,1);assert.match(result.dialogs[0].message,/2/);assert.equal(result.dialogs[0].defaultId,0);assert.equal(result.quits(),0);assert.ok(!result.children.some(c=>c.killed));
  await handler({sender:contents},{type:'gmssh-files-state',data:{active:0,failed:1}});result.app.emit('before-quit',{preventDefault:()=>blocked++});assert.equal(blocked,1);result.app.emit('will-quit');
});
test('an explicit stop-and-quit cancels file workspaces, then exits without a second prompt',async()=>{
  const result=await launch({fileQuitResponse:1});result.ipcMain.handle('render-to-main',async()=>{});const scripts=[];
  const contents={getURL:()=> 'file:///synthetic/app.asar/dist/index.html#/home',isDestroyed:()=>false,executeJavaScript:async code=>scripts.push(code)};
  await result.handlers.get('render-to-main')({sender:contents},{type:'gmssh-files-state',data:{active:1,failed:0}});
  result.app.emit('before-quit',{preventDefault(){}});await new Promise(resolve=>setImmediate(()=>setImmediate(resolve)));
  assert.equal(result.quits(),1);assert.ok(scripts.some(s=>s.includes('gmsshFilesController?.cancelAll')));
  result.app.emit('before-quit',{preventDefault(){throw Error('should be approved');}});assert.equal(result.dialogs.length,1);result.app.emit('will-quit');
});

test('starts an empty controller without a remote target, and restricts enrollment IPC to its native home',async()=>{
  const result=await launch({monitoring:false,pairingOnly:true});
  assert.equal(result.imported,true);assert.equal(result.children.length,1);
  assert.deepEqual(Array.from(result.children[0].args),['-m','gmssh_windows_bridge.pairing','--serve-assets','--port','22256']);
  result.ipcMain.handle('render-to-main',async()=>({multiPort:5000}));
  const handler=result.handlers.get('render-to-main');
  assert.equal((await handler({sender:{getURL:()=> 'https://untrusted.invalid/'}},{type:'gmssh-pair-file'})).status,'error');
  assert.equal(result.pickers.length,0);
  assert.equal((await handler({sender:{getURL:()=> 'file:///synthetic/app.asar/dist/index.html#/home'}},{type:'gmssh-pair-file'})).status,'cancelled');
  assert.equal(result.pickers.length,1);result.app.emit('will-quit');
});

test('untrusted pages cannot read enrollment clipboard, and invalid clipboard contents never enter replies',async()=>{
  const secret='synthetic-clipboard-credential'.repeat(3000);
  const result=await launch({monitoring:false,pairingOnly:true,clipboardText:secret});
  result.ipcMain.handle('render-to-main',async()=>({multiPort:5000}));
  const handler=result.handlers.get('render-to-main');
  for(const url of ['https://untrusted.invalid/','http://127.0.0.1:22256/']) {
    assert.equal((await handler({sender:{getURL:()=>url}},{type:'gmssh-pair-paste'})).status,'error');
    for(const type of ['gmssh-backup-list','gmssh-backup-open','gmssh-backup-export','gmssh-backup-preview','gmssh-backup-import','gmssh-backup-clear'])assert.equal((await handler({sender:{getURL:()=>url}},{type,data:{ids:['1'.repeat(32)],password:'synthetic-only'}})).status,'error');
    for(const type of ['gmssh-pair-manual','gmssh-pair-edit','gmssh-pair-text'])assert.equal((await handler({sender:{getURL:()=>url}},{type,data:{target:'2001:db8::42',machineId:'1'.repeat(32),text:'synthetic-code'}})).status,'error');
  }
  assert.equal(result.clipboardReads(),0);
  const event={sender:{getURL:()=> 'file:///synthetic/app.asar/dist/index.html#/home'}};
  const reply=await handler(event,{type:'gmssh-pair-paste'});
  assert.equal(reply.status,'error');assert.equal(result.clipboardReads(),1);
  assert.ok(!JSON.stringify(reply).includes('synthetic-clipboard-credential'));
  const typed={type:'gmssh-pair-text',data:{text:secret}};
  const typedReply=await handler(event,typed);
  assert.equal(typedReply.status,'error');assert.equal(typed.data.text,undefined);
  assert.ok(!JSON.stringify(typedReply).includes('synthetic-clipboard-credential'));
  assert.equal((await handler(event,{type:'gmssh-pair-clear'})).status,'ok');
  result.app.emit('will-quit');
});

test('native transfer IPC rejects untrusted or malformed requests before choosing any local file',async()=>{
  const result=await launch({pairingOnly:true});result.ipcMain.handle('render-to-main',async()=>({multiPort:22200}));const invoke=result.handlers.get('render-to-main');
  for(const sender of [undefined,{getURL:()=> 'https://untrusted.invalid/'}])assert.equal((await invoke({sender},{type:'gmssh-transfer',data:{action:'hello',machineId:null,data:{}}})).code,'UNTRUSTED_PAGE');
  const event={sender:{getURL:()=> 'file:///synthetic/app.asar/dist/index.html'}};
  for(const data of [{action:'pick-upload',machineId:'invalid',data:{remote:'C:/'}},{action:'hello',machineId:null,data:{},path:'/private/arbitrary'}])assert.equal((await invoke(event,{type:'gmssh-transfer',data})).code,'INVALID_TRANSFER');
  assert.equal(result.pickers.length,0);result.app.emit('will-quit');
});


test('quitting a native transfer pauses and saves main-owned tasks instead of cancelling them',async()=>{
  const result=await launch({pairingOnly:true,nativeTransfers:true,fileQuitResponse:1});result.ipcMain.handle('render-to-main',async()=>({multiPort:22200}));const invoke=result.handlers.get('render-to-main'),event={sender:{getURL:()=> 'file:///synthetic/app.asar/dist/index.html'}};
  const request=action=>({type:'gmssh-transfer',data:{action,machineId:action==='hello'?null:'1'.repeat(32),data:action==='hello'?{}:{remote:'C:/'}}});
  assert.equal((await invoke(event,request('hello'))).data.protocol,2);assert.equal((await invoke(event,request('pick-upload'))).status,'ok');
  let prevented=false;result.app.emit('before-quit',{preventDefault(){prevented=true;}});await new Promise(r=>setImmediate(()=>setImmediate(r)));assert.equal(prevented,true);assert.equal(result.nativeShutdowns(),1);assert.equal(result.quits(),1);assert.ok(result.dialogs.at(-1).buttons.includes('暂停并退出'));assert.equal(result.nativeCalls.some(c=>c.action==='cancel-all'),false);result.app.emit('will-quit');
});

test('an idle native queue resumes quit after the cancelled quit event has returned',async()=>{
  const result=await launch({pairingOnly:true,nativeTransfers:true});
  result.ipcMain.handle('render-to-main',async()=>({multiPort:22200}));
  const event={sender:{getURL:()=> 'file:///synthetic/app.asar/dist/index.html'}};
  await result.handlers.get('render-to-main')(event,{type:'gmssh-transfer',data:{action:'hello',machineId:null,data:{}}});
  let prevented=0;
  result.app.emit('before-quit',{preventDefault(){prevented++;}});
  result.app.emit('before-quit',{preventDefault(){prevented++;}});
  await Promise.resolve();
  assert.equal(prevented,2);assert.equal(result.nativeShutdowns(),1);
  assert.equal(result.quits(),0,'do not re-enter the native quit cycle from a promise microtask');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(result.quits(),1);assert.equal(result.dialogs.length,0);
  result.app.emit('before-quit',{preventDefault(){throw Error('saved queue should allow quit');}});
  result.app.emit('will-quit');assert.ok(result.children.every(child=>child.killed));
});

test('backend terminal lifecycle is bounded metadata from the trusted child, with no command or credential fields',async()=>{
 const r=await launch({terminal:true,adopted:true,recordHistory:true}),child=r.children[0],instance='a'.repeat(32)+':1';
 child.stdout.emit('data',Buffer.from('GMSSH_SESSION '+JSON.stringify({channel:'terminal',instance,state:'connected'})+'\n'));
 child.stdout.emit('data',Buffer.from('GMSSH_SESSION '+JSON.stringify({channel:'terminal',instance,state:'connected',command:'forbidden input'})+'\n'));
 assert.equal(r.history.length,1);assert.equal(r.history[0].data.machineId,'1'.repeat(32));assert.equal(r.history[0].data.channel,'terminal');assert.equal(r.history[0].data.state,'connected');assert.ok(!JSON.stringify(r.history).includes('forbidden input'));r.app.emit('will-quit');assert.equal(r.history.length,2);
});
