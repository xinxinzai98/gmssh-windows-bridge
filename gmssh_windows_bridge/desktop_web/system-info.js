/* Keep the operation socket on its existing trusted loopback origin. */
let busy = false;
window.addEventListener('message', event => {
  const request = event.data;
  if (event.source !== window.parent || request?.type !== 'gmssh-system-info-request' || busy ||
      !Number.isSafeInteger(request.requestId) || request.requestId < 1 ||
      typeof request.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(request.token)) return;
  busy = true;
  const socket = new WebSocket(location.origin.replace(/^http:/, 'ws:') + '/operations');
  const timer = setTimeout(() => finish(false), 12000);
  let finished = false;
  function finish(ok, info) {
    if (finished) return;
    finished = true; clearTimeout(timer); busy = false; socket.close();
    event.source.postMessage({type:'gmssh-system-info', requestId:request.requestId, ok, info}, event.origin === 'null' || event.origin === 'file://' ? '*' : event.origin);
  }
  socket.onopen = () => socket.send(JSON.stringify({token:request.token}));
  socket.onerror = socket.onclose = () => finish(false);
  socket.onmessage = event => {
    try {
      const reply = JSON.parse(event.data);
      if (reply.type === 'operations_ready') socket.send(JSON.stringify({id:1,op:'system-info'}));
      else if (reply.id === 1 && reply.ok && reply.info && typeof reply.info === 'object') finish(true,reply.info);
      else if (reply.ok === false) finish(false);
    } catch { finish(false); }
  };
});
