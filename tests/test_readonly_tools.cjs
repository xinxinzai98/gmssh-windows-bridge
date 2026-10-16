const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const {optionsFor,linuxCommand,linuxResult,nativeScript,query,tcpProbe}=require('../gmssh_windows_bridge/readonly-tools.cjs');
const esbuild=require('../desktop-web/node_modules/esbuild');
const id='1'.repeat(32),processOptions={search:'',sort:'cpu',limit:50},serviceOptions={search:'',sort:'name',limit:50};
function shellFixture(commands,fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmssh-readonly-'));try{for(const [name,body] of Object.entries(commands))fs.writeFileSync(path.join(root,name),'#!/bin/sh\n'+body,{mode:0o700});return fn((tool,options)=>execFileSync('/bin/sh',['-c',linuxCommand(tool,options)],{env:{PATH:root+':/usr/bin:/bin'},encoding:'utf8',timeout:2000,maxBuffer:262144}));}finally{fs.rmSync(root,{recursive:true,force:true});}}
test('Linux processes sort/search real command output with RSS units and explicit sampling basis',()=>{
  shellFixture({ps:"printf ' 71 130.1 1024 worker\\n 8 0.0 50 中文进程\\n'"},run=>{
    const result=linuxResult('processes',processOptions,run('processes',processOptions));
    assert.equal(result.items[0].cpuPercent,130.1);assert.equal(result.items[0].memoryBytes,1048576);assert.equal(result.units.cpu,'ps-lifetime-average');
    const options={...processOptions,search:'中文'};assert.equal(linuxResult('processes',options,run('processes',options)).items[0].pid,8);
  });
});
test('Linux services return readable systemd units and distinguish a missing backend from zero services',()=>{
  shellFixture({systemctl:"printf 'sshd.service loaded active running OpenSSH server\\nbackup.service loaded inactive dead Backup\\n'"},run=>{
    const result=linuxResult('services',serviceOptions,run('services',serviceOptions));assert.equal(result.items.length,2);assert.equal(result.items[1].state,'active / running');assert.equal(result.items[1].startType,null);
  });
  shellFixture({systemctl:'exit 1'},run=>assert.equal(linuxResult('services',serviceOptions,run('services',serviceOptions)).code,'SERVICE_BACKEND_UNAVAILABLE'));
  shellFixture({systemctl:'exit 0'},run=>assert.deepEqual(linuxResult('services',serviceOptions,run('services',serviceOptions)).items,[]));
});
const cursor='s=abc;i=1;b=def;m=123;t=123;x=987',event={__CURSOR:cursor,__REALTIME_TIMESTAMP:'1700000000000000',PRIORITY:'3',SYSLOG_IDENTIFIER:'sshd',MESSAGE:'<script>window.secret="synthetic"</script>\n中文日志'};
test('journal queries limit time and rows, load detail by exact cursor, and preserve literal message text',()=>{
  const options={source:'journal',hours:6,limit:50};
  shellFixture({journalctl:'printf \'%s\\n\' '+"'"+JSON.stringify(event)+"'"},run=>{
    const result=linuxResult('logs',options,run('logs',options));assert.equal(result.items[0].provider,'sshd');assert.ok(result.items[0].preview.includes('<script>'));
    const detailOptions={source:'journal',recordId:cursor},detail=linuxResult('log-detail',detailOptions,run('log-detail',detailOptions));assert.equal(detail.items[0].message,event.MESSAGE);
    assert.match(linuxCommand('logs',options),/--since='-6 hours' --lines=51/);
  });
  shellFixture({journalctl:"printf 'Permission denied\\n';exit 1"},run=>assert.equal(linuxResult('logs',options,run('logs',options)).state,'failed'));
  shellFixture({journalctl:'exit 0'},run=>assert.equal(linuxResult('logs',options,run('logs',options)).items.length,0));
  const prefix='GMSSH_JOURNAL\n'+JSON.stringify(event)+'\n{"';
  const capped=linuxResult('logs',options,prefix+'x'.repeat(250000-Buffer.byteLength(prefix)));
  assert.equal(capped.items.length,1);assert.equal(capped.truncated,true);
});
test('all remote options are allowlisted and searches never become shell source',()=>{
  const injected="'; shutdown -h now; $(cat /secret)",safe=linuxCommand('processes',{...processOptions,search:injected});assert.ok(!safe.includes(injected));
  for(const [tool,options] of [['kill',{}],['processes',{...processOptions,limit:201}],['services',{...serviceOptions,sort:'restart'}],['logs',{source:'/etc/shadow',hours:1,limit:50}],['logs',{source:'journal',hours:48,limit:50}],['log-detail',{source:'journal',recordId:"'; touch /tmp/no"}],['capabilities',{cmd:'whoami'}]])assert.throws(()=>linuxCommand(tool,options));
  assert.throws(()=>optionsFor('diagnostics',{password:'synthetic'}));assert.throws(()=>linuxResult('logs',{source:'journal',hours:1,limit:50},'GMSSH_JOURNAL\n'+JSON.stringify({...event,__CURSOR:'bad\nvalue'})));
});
test('native queries use only the exact existing device webview and a fixed SDK command',async()=>{
  let commands=0;
  const view={getAttribute:()=> 'http://127.0.0.1:5555/newweb/index.html#/home?machineId='+id,executeJavaScript:async source=>{commands++;return vm.runInNewContext(source,{window:{$gm:{execShell:async value=>{assert.match(value.cmd,/GMSSH_CAPS/);assert.equal(value.timeout,15);return {code:200,data:'GMSSH_CAPS\nLinux 6\nps=yes\nsystemctl=yes\njournalctl=yes\n'};}}}});}};
  const script=nativeScript(id,'capabilities',{}),context={document:{querySelectorAll:()=>[view]},URL,URLSearchParams};
  assert.match((await vm.runInNewContext(script,context)).output,/GMSSH_CAPS/);assert.equal(commands,1);
  assert.equal((await vm.runInNewContext(nativeScript('2'.repeat(32),'capabilities',{}),context)).error,'NATIVE_SESSION_REQUIRED');assert.equal(commands,1);
});
test('native missing sessions stay unchecked and no provisioning/login endpoint is called',async()=>{
  const endpoints=[],api=async(endpoint)=>{endpoints.push(endpoint);return {code:200,data:{id,name:'合成 Linux',ip:'192.0.2.42',port:22,authValue:'synthetic-private'}};};
  const value=await query({api,pairing:{bindings:()=>[]},legacy:[],sender:{executeJavaScript:async()=>({error:'NATIVE_SESSION_REQUIRED'})}},{machineId:id,tool:'capabilities',options:{}});
  assert.deepEqual(endpoints,['/node/detail']);assert.equal(value.result.error,'NATIVE_SESSION_REQUIRED');assert.ok(!JSON.stringify(value).includes('synthetic-private'));
  assert.throws(()=>nativeScript('invalid','processes',processOptions));
});
test('TCP diagnostics use an actual local listener and distinguish refusal after it closes',async()=>{
  const net=require('node:net'),server=net.createServer(socket=>socket.end());await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
  const online=await tcpProbe('127.0.0.1',port);assert.equal(online.code,'TCP_REACHABLE');assert.ok(online.latencyMs>=0);await new Promise(resolve=>server.close(resolve));assert.equal((await tcpProbe('127.0.0.1',port)).code,'TCP_REFUSED');
});
const compiled=esbuild.buildSync({entryPoints:[path.join(__dirname,'../desktop-web/src/diagnostics.ts')],bundle:true,format:'cjs',platform:'node',write:false});
const scope={module:{exports:{}}};vm.runInNewContext(compiled.outputFiles[0].text,scope);const {DesktopDiagnostics}=scope.module.exports;
test('SSH-up / desktop-down, authentication timeout and first-frame timeout are separate states',()=>{
  let clock=1000;const tracker=new DesktopDiagnostics(()=>clock);tracker.begin();tracker.failed();assert.equal(tracker.snapshot().stages[0].state,'failed');assert.equal(tracker.snapshot().stages[1].state,'unchecked');
  tracker.begin();tracker.transport();tracker.failed('DESKTOP_LOGIN_TIMEOUT');assert.equal(tracker.snapshot().stages[1].code,'DESKTOP_HANDSHAKE_TIMEOUT');
  tracker.begin();tracker.transport();tracker.handshake();tracker.failed('DESKTOP_LOGIN_TIMEOUT');assert.equal(tracker.snapshot().stages[2].code,'DESKTOP_LOGIN_TIMEOUT');
  tracker.begin();tracker.transport();tracker.handshake();tracker.approved('1.5.0');clock+=15001;
  assert.equal(tracker.snapshot().stages[3].code,'FIRST_FRAME_TIMEOUT');assert.equal(tracker.snapshot().stages[2].state,'passed');
  tracker.received(20480);tracker.frame();assert.equal(tracker.snapshot().stages[3].code,'FIRST_FRAME_OK');assert.equal(tracker.snapshot().engineVersion,'1.5.0');
  clock+=1000;assert.equal(tracker.snapshot().metrics.lastFrameAgeSeconds,1);assert.ok(tracker.snapshot().metrics.kibPerSecond>0);assert.equal(tracker.snapshot().stages[4].state,'passed');
  tracker.disconnected();assert.equal(tracker.snapshot().stages[4].code,'DESKTOP_DISCONNECTED');tracker.begin();assert.equal(tracker.snapshot().engineVersion,null);assert.equal(tracker.snapshot().metrics.fps,0);
});
