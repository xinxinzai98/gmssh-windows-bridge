const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('skips Linux sudo only for the configured Windows bridge and restores native requests', () => {
  class Request {
    open(method, url) { this.method = method; this.url = url; }
    send(body) { this.body = body; return 'native result'; }
  }
  const originalOpen = Request.prototype.open, originalSend = Request.prototype.send;
  const window = { XMLHttpRequest: Request, location: { href: 'file:///synthetic/index.html' } };
  const canonical = fs.readFileSync(path.join(__dirname, '../desktop-web/public/gmssh-home.js'), 'utf8');
  assert.equal(fs.readFileSync(path.join(__dirname, '../gmssh_windows_bridge/desktop_web/gmssh-home.js'), 'utf8'),canonical,'frontend build must preserve the Windows policy');
  vm.runInNewContext(canonical, {window, URL});
  window.installWindowsMachinePolicy({bridgePort:22252, username:'synthetic-user'});
  const account = {ip:'127.0.0.1',port:22252,userName:'synthetic-user',authValue:'synthetic-secret'};
  const send = (url, data, method='POST') => {
    const request = new Request(); request.open(method, url);
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    assert.equal(request.send(body), 'native result');
    return request.body;
  };
  for (const endpoint of ['add','edit']) {
    const result = JSON.parse(send('http://127.0.0.1:5000/node/'+endpoint, {...account,sudoPassword:'unused synthetic value'}));
    assert.equal(result.sudoPolicy,'skip'); assert.equal(result.authValue,account.authValue);
    assert.equal(result.sudoPassword,undefined);
  }
  for (const [url,data,method] of [
    ['http://127.0.0.1:5000/node/add',{...account,ip:'192.168.1.10'}],
    ['http://127.0.0.1:5000/node/add',{...account,port:22229}],
    ['http://127.0.0.1:5000/node/add',{...account,userName:'root'}],
    ['https://127.0.0.1:5000/node/add',account],
    ['http://remote.invalid/node/add',account],
    ['http://127.0.0.1:5000/node/test',account],
    ['http://127.0.0.1:5000/node/add',account,'GET'],
    ['http://127.0.0.1:5000/node/add','not JSON'],
  ]) {
    assert.equal(send(url,data,method),typeof data==='string'?data:JSON.stringify(data));
  }
  window.installWindowsMachinePolicy({bridgePort:22253, username:'other-user'});
  assert.equal(send('http://127.0.0.1:5000/node/add',account),JSON.stringify(account));
  window.installWindowsMachinePolicy([{bridgePort:22252,username:'synthetic-user'},{bridgePort:22253,username:'other-user'}]);
  assert.equal(JSON.parse(send('http://127.0.0.1:5000/node/add',account)).sudoPolicy,'skip');
  assert.equal(JSON.parse(send('http://127.0.0.1:5000/node/edit',{...account,port:22253,userName:'other-user'})).sudoPolicy,'skip');
  window.removeWindowsMachinePolicy();
  assert.equal(Request.prototype.open,originalOpen); assert.equal(Request.prototype.send,originalSend);
});
