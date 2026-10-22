/* Keep the operation socket on its existing trusted loopback origin. */
let busy = false;
window.addEventListener('message', event => {
  const request = event.data;
  if (event.source !== window.parent || request?.type !== 'gmssh-system-info-request' || busy ||
      !Number.isSafeInteger(request.requestId) || request.requestId < 1 ||
      typeof request.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(request.token)) return;
  busy = true;
  const started = Date.now();
  let stage = 'connect';
  const socket = new WebSocket(location.origin.replace(/^http:/, 'ws:') + '/operations');
  const timer = setTimeout(() => finish(false, undefined, 'SYSTEM_INFO_TIMEOUT'), 12000);
  let finished = false;
  const codes = {OPERATION_TIMEOUT:'OPERATION_TIMEOUT',QUERY_FAILED:'QUERY_FAILED',REMOTE_IO:'REMOTE_IO',
    ACCESS_DENIED:'ACCESS_DENIED',AUTH_FAILED:'AUTH_FAILED',PEER_CHANGED:'PEER_CHANGED',INVALID_RESPONSE:'INVALID_RESPONSE',
    SSHPoolUnavailable:'MONITOR_UNAVAILABLE',OperationsUnavailable:'OPERATIONS_UNAVAILABLE',DesktopAccessError:'LOCAL_AUTH_FAILED'};
  function finish(ok, info, code = 'QUERY_FAILED') {
    if (finished) return;
    finished = true; clearTimeout(timer); busy = false; socket.close();
    event.source.postMessage({type:'gmssh-system-info', requestId:request.requestId, ok, info,
      ...(!ok ? {code,stage,elapsedMs:Math.min(60000,Math.max(0,Date.now()-started))} : {})}, event.origin === 'null' || event.origin === 'file://' ? '*' : event.origin);
  }
  socket.onopen = () => { if (finished) return; stage = 'authorize'; socket.send(JSON.stringify({token:request.token})); };
  socket.onerror = socket.onclose = () => finish(false, undefined, 'SYSTEM_INFO_CHANNEL_CLOSED');
  socket.onmessage = event => {
    if (finished) return;
    try {
      const reply = JSON.parse(event.data);
      if (reply.type === 'operations_ready') { stage = 'query'; socket.send(JSON.stringify({id:1,op:'system-info'})); }
      else if (reply.id === 1 && reply.ok && reply.info && typeof reply.info === 'object') finish(true,reply.info);
      else if (reply.type === 'error' || reply.ok === false) finish(false, undefined,
        typeof reply.code === 'string' && Object.hasOwn(codes, reply.code) ? codes[reply.code] : 'QUERY_FAILED');
    } catch { finish(false, undefined, 'INVALID_RESPONSE'); }
  };
});
