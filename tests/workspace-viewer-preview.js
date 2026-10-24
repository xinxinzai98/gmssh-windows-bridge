// Visual-only fixture around the built viewer. Never opens a desktop socket.
function preview(){
  const get=id=>document.getElementById(id);
  get('login-wrap').hidden=true;
  get('session-label').textContent='设计工作站';
  get('connection-label').textContent='已连接（模拟）';
  get('connection-label').classList.add('online');
  get('empty').querySelector('h2').textContent='远程桌面区域';
  get('empty').querySelector('p').textContent='合成设备预览 · 不连接真实电脑。上方为实际构建的工具栏，可切换视图、缩放或打开菜单。';
  get('status').textContent='界面验收预览 · 未连接真实设备';
  for(const id of ['keyboard','clipboard','fullscreen','quality','display'])get(id).disabled=false;
  get('display').options[0].value='0';
  const second=document.createElement('option');second.value='1';second.textContent='显示器 2';get('display').append(second);
  parent.postMessage({type:'gmssh-workspace-desktop',instance:'synthetic-desktop',state:'connected'},'*');
  parent.postMessage({type:'fixture-ready'},'*');
}
window.addEventListener('load',()=>{
  const target=document.getElementById('target');
  if(target.textContent==='192.0.2.42')preview();
  else{const observer=new MutationObserver(()=>{if(target.textContent==='192.0.2.42'){observer.disconnect();preview();}});observer.observe(target,{childList:true});}
});
