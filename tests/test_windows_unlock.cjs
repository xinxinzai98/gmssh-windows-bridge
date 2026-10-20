const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),path=require('node:path');
const esbuild=require('../desktop-web/node_modules/esbuild');
const compiled=esbuild.buildSync({entryPoints:[path.join(__dirname,'../desktop-web/src/windows-unlock.ts')],bundle:true,platform:'node',format:'cjs',write:false});
const scope={module:{exports:{}},exports:{},TextEncoder,TextDecoder};vm.runInNewContext(compiled.outputFiles[0].text,scope);
const {supportsWindowsUnlock,windowsUnlockFrame}=scope.module.exports;
test('Windows OSLogin is opt-in compatible only from 1.5.1, never an older keyboard fallback',()=>{
  for(const [p,v,expected] of [['Windows','1.4.9',false],['Windows','1.5.0',false],['Windows','1.5.1',true],['Windows','1.6.0',true],['Windows','unknown',false],['Linux','1.5.1',false],['Windows','2.0.0',false]])assert.equal(supportsWindowsUnlock(p,v),expected);
});
test('a Windows password is encoded only as Message.os_login=34 / OSLogin.password=2',()=>{
  const data=windowsUnlockFrame('synthetic-中文-password');
  const {BinaryReader}=require('node:module').createRequire(path.join(__dirname,'../desktop-web/package.json'))('@bufbuild/protobuf/wire');
  const top=new BinaryReader(data);assert.equal(top.uint32(),274);
  const login=new BinaryReader(top.bytes());assert.equal(top.pos,top.len);assert.equal(login.uint32(),18);
  assert.equal(login.string(),'synthetic-中文-password');assert.equal(login.pos,login.len);
});
test('empty, oversized and key-control passwords are rejected before sending',()=>{
  for(const text of ['', 'x'.repeat(1025), '中'.repeat(342), 'synthetic\npassword', 'synthetic\0password'])assert.throws(()=>windowsUnlockFrame(text));
  assert.ok(windowsUnlockFrame('x'.repeat(1024)).length>1024);
});
