import "./style.css";
import { DirectClient } from "./direct";
import { keyboardModifiers, keyEvent } from "../vendor/input";
import { Operations } from './operations';

const get = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = get<HTMLCanvasElement>("screen");
const empty = get("empty");
const ssh = get<HTMLInputElement>("ssh-password");
const password = get<HTMLInputElement>("desktop-password");
const connect = get<HTMLButtonElement>("connect");
const disconnect = get<HTMLButtonElement>("disconnect");
const fullscreen = get<HTMLButtonElement>("fullscreen");
const viewport = get("viewport");
const embedded = window.parent !== window;
if (embedded) {
  fullscreen.textContent = "放大画面";
  get("leave-fullscreen").textContent = "恢复面板";
}
const status = (text: string): void => { get("status").textContent = text; };
let frames = 0;
let peer = "";
let transport = "ssh";
let keychain = false;
let savedPasswordAvailable = false;
let initialAuth: {password:string;remember:boolean}|undefined;
let accessToken = new URLSearchParams(location.hash.slice(1)).get("token") || "";
const operations=new Operations(()=>accessToken);
let filesAvailable=false,powerAvailable=false,wakeAvailable=false;
if (accessToken) history.replaceState(null, "", location.pathname + location.search);
const tokenReady = new Promise<void>(resolve => {
  if (accessToken) resolve();
  window.addEventListener("message", event => {
    if (event.source !== window.parent || event.data?.type !== "gmssh-desktop-access" ||
        typeof event.data.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(event.data.token)) return;
    accessToken = event.data.token;
    if(typeof event.data.password==='string'&&event.data.password&&new TextEncoder().encode(event.data.password).length<=1024){
      initialAuth={password:event.data.password,remember:event.data.remember===true};delete event.data.password;
    }
    resolve();
  });
});
const keys = new Map<string, KeyboardEvent>();
const buttons = new Map<number, PointerEvent>();
const client = new DirectClient(canvas, {
  status,
  credential(saved) { savedPasswordAvailable = saved; get("credential-note").textContent = saved ? "已保存至本机钥匙串，后续启动自动连接此设备。" : "钥匙串操作未完成，可使用 RustDesk 密码或 Windows 端确认连接。"; },
  peer(name) { peer = name;get('session-label').textContent=name; status(`${name} 已批准连接，等待画面…`); },
  frame() { frames++; canvas.hidden = false; empty.hidden = true; fullscreen.disabled = false;get('connection-label').textContent='已连接';get('connection-label').classList.add('online');get<HTMLButtonElement>('keyboard').disabled=get<HTMLButtonElement>('clipboard').disabled=get<HTMLSelectElement>('quality').disabled=false;get('screen-size').textContent=`${canvas.width} × ${canvas.height}`; if(frames===1){get('login-wrap').hidden=true;status(`${peer} · 桌面连接正常`);} },
  stopped() { keys.clear(); buttons.clear(); frames = 0; viewport.classList.remove("expanded"); canvas.hidden = true; empty.hidden = false;get('login-wrap').hidden=false;get('connection-label').textContent='未连接';get('connection-label').classList.remove('online');get<HTMLButtonElement>('keyboard').disabled=get<HTMLButtonElement>('clipboard').disabled=get<HTMLSelectElement>('quality').disabled=true; connect.disabled = false; disconnect.disabled = fullscreen.disabled = true; },
  clipboard(text){get<HTMLTextAreaElement>('clipboard-text').value=text;get('clipboard-note').textContent='已收到 Windows 复制的文本。';},
  displays(items,current){const select=get<HTMLSelectElement>('display');select.replaceChildren(...items.map((item,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=`显示器 ${index+1}`;return option;}));select.value=String(current);select.disabled=items.length<2;},
});

fetch("/config.json").then(response => {
  if (!response.ok) throw new Error();
  return response.json();
}).then(async config => {
  transport = config.transport;
  keychain = config.keychain === true;
  savedPasswordAvailable = config.has_saved_password === true;
  filesAvailable=config.capabilities?.files===true;powerAvailable=config.capabilities?.power===true;
  wakeAvailable=config.capabilities?.wake===true;
  get<HTMLButtonElement>('wake').disabled=!wakeAvailable;
  get("remember-label").hidden = !keychain;
  const direct = transport === "tailscale";
  const shared = transport === "monitor";
  ssh.required = !direct && !shared;
  get("ssh-label").hidden = direct || shared;
  get("target").textContent = config.target;
  get('power-target').textContent=`目标电脑：${config.target}`;
  get("transport-note").textContent = shared ? '监控、桌面和文件复用这台电脑的 SSH 连接。' : '画面通过现有加密连接传输。';
  if (config.requires_token && !accessToken) {
    status("正在建立本机授权，请从桌面启动器打开此页面。 ");
    await tokenReady;
  }
  connect.disabled = false;
  if (keychain && !config.has_saved_password) status("首次连接：输入安装时设置的固定密码，验证成功后记住。");
  if ((direct || shared) && (initialAuth || !keychain || config.has_saved_password) && new URL(location.href).searchParams.get("autoconnect") === "1") {
    const first=initialAuth;initialAuth=undefined;
    client.connect("",first?.password||"",transport,{saved:first?false:keychain,remember:keychain&&first?.remember===true,token:accessToken});
    connect.disabled = true; disconnect.disabled = false;
  }
})
  .catch(() => { connect.disabled = true; status("无法读取本地服务配置，请用桌面服务提供的地址打开。 "); });

get<HTMLFormElement>("login").addEventListener("submit", event => {
  event.preventDefault();
  const sshPassword = ssh.value;
  const desktopPassword = password.value;
  ssh.value = password.value = "";
  client.connect(sshPassword, desktopPassword, transport, { saved: keychain, remember: keychain && get<HTMLInputElement>("remember-password").checked, token: accessToken });
  connect.disabled = true; disconnect.disabled = false;
});

function releaseInputs(): void {
  for (const event of keys.values()) { const wire = keyEvent(event, false); if (wire) { wire.modifiers = []; client.key(wire); } }
  for (const [button, event] of buttons) client.mouse({ mask: (button << 3) | 2, ...position(event), modifiers: [] });
  keys.clear(); buttons.clear();
}
disconnect.addEventListener("click", () => { releaseInputs(); client.disconnect(); status("已断开。Windows 上的 RustDesk 继续运行。"); });
window.addEventListener("blur", releaseInputs);
window.addEventListener("pagehide", () => { releaseInputs(); client.disconnect(); operations.close();cancelPower(); });

function position(event: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  const left = rect.left + (rect.width - canvas.width * scale) / 2;
  const top = rect.top + (rect.height - canvas.height * scale) / 2;
  return {
    x: Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - left) / scale))),
    y: Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - top) / scale))),
  };
}
const buttonCode = (button: number): number => button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0;
const modifiers = (event: MouseEvent): ReturnType<typeof keyboardModifiers> => keyboardModifiers(event as unknown as KeyboardEvent);
canvas.addEventListener("pointermove", event => {
  client.mouse({ mask: event.buttons << 3, ...position(event), modifiers: modifiers(event) });
});
canvas.addEventListener("pointerdown", event => {
  canvas.focus(); canvas.setPointerCapture(event.pointerId);
  const button = buttonCode(event.button);
  // Synchronize the remote pointer before the button, including immediate clicks.
  client.mouse({ mask: 0, ...position(event), modifiers: modifiers(event) });
  if (button) { buttons.set(button, event); client.mouse({ mask: (button << 3) | 1, ...position(event), modifiers: modifiers(event) }); }
  event.preventDefault();
});
canvas.addEventListener("pointerup", event => {
  const button = buttonCode(event.button);
  client.mouse({ mask: 0, ...position(event), modifiers: modifiers(event) });
  if (button) { buttons.delete(button); client.mouse({ mask: (button << 3) | 2, ...position(event), modifiers: modifiers(event) }); }
  event.preventDefault();
});
canvas.addEventListener("pointercancel", releaseInputs);
canvas.addEventListener("contextmenu", event => event.preventDefault());
canvas.addEventListener("wheel", event => {
  const clamp = (value: number): number => Math.max(-8192, Math.min(8192, Math.round(value)));
  client.mouse({ mask: 3, x: clamp(event.deltaX), y: clamp(event.deltaY), modifiers: modifiers(event) });
  event.preventDefault();
}, { passive: false });
canvas.addEventListener("keydown", event => {
  const wire = keyEvent(event, true);
  if (wire) { keys.set(event.code, event); client.key(wire); event.preventDefault(); }
});
canvas.addEventListener("keyup", event => {
  const wire = keyEvent(event, false);
  keys.delete(event.code);
  if (wire) { client.key(wire); event.preventDefault(); }
});
fullscreen.addEventListener("click", () => {
  if (embedded) { viewport.classList.add("expanded"); canvas.focus(); }
  else viewport.requestFullscreen().catch(() => status("此容器未允许全屏，请最大化窗口。"));
});
get("leave-fullscreen").addEventListener("click", () => {
  if (embedded) { viewport.classList.remove("expanded"); canvas.focus(); }
  else document.exitFullscreen().catch(() => status("请尝试 Esc 退出全屏。"));
});

get<HTMLSelectElement>('zoom').onchange=event=>{viewport.classList.toggle('actual-size',(event.target as HTMLSelectElement).value==='100');};
get<HTMLSelectElement>('display').onchange=event=>{releaseInputs();client.selectDisplay(Number((event.target as HTMLSelectElement).value));};
get<HTMLSelectElement>('quality').onchange=event=>client.quality((event.target as HTMLSelectElement).value);
get('reconnect').onclick=()=>{get('login-wrap').hidden=!get('login-wrap').hidden;};
const dialog=(id:string)=>{releaseInputs();get<HTMLDialogElement>(id).showModal();};
get('keyboard').onclick=()=>dialog('keyboard-dialog');get('clipboard').onclick=()=>dialog('clipboard-dialog');
const desktopMenu=get<HTMLDetailsElement>('desktop-menu');
get('about').onclick=()=>{desktopMenu.open=false;dialog('about-dialog');};
document.addEventListener('click',event=>{if(!desktopMenu.contains(event.target as Node))desktopMenu.open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape')desktopMenu.open=false;});
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-close]'))button.onclick=()=>get<HTMLDialogElement>(button.dataset.close!).close();
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-shortcut]'))button.onclick=()=>{releaseInputs();client.shortcut(button.dataset.shortcut!);get<HTMLDialogElement>('keyboard-dialog').close();canvas.focus();};
const showError=(error:unknown)=>status(error instanceof Error?error.message:'操作未完成。');
get('send-text').onclick=()=>{try{client.text(get<HTMLTextAreaElement>('input-text').value);get<HTMLDialogElement>('keyboard-dialog').close();canvas.focus();}catch(error){showError(error);}};
get('send-clipboard').onclick=()=>{try{client.clipboard(get<HTMLTextAreaElement>('clipboard-text').value);get('clipboard-note').textContent='已发送到 Windows 剪贴板，请在目标程序粘贴。';}catch(error){showError(error);}};
get('copy-local').onclick=async()=>{try{await navigator.clipboard.writeText(get<HTMLTextAreaElement>('clipboard-text').value);get('clipboard-note').textContent='已复制到本机。';}catch{get('clipboard-note').textContent='当前容器未允许写入剪贴板，请选中文字手动复制。';}};
get('read-local').onclick=async()=>{try{get<HTMLTextAreaElement>('clipboard-text').value=await navigator.clipboard.readText();get('clipboard-note').textContent='已读取本机文本，点击发送后传到 Windows。';}catch{get('clipboard-note').textContent='当前容器未允许读取剪贴板，请直接粘贴到文本框。';}};

let currentPath='/',transferBusy=false,uploadCancelled=false;
const fileNote=(text:string)=>{get('file-note').textContent=text;};
const sizeText=(size:number):string=>size>=1024*1024?`${(size/1024/1024).toFixed(1)} MB`:size>=1024?`${(size/1024).toFixed(1)} KB`:`${size} B`;
const joinPath=(name:string)=>currentPath==='/'?name+'/':currentPath.replace(/\/$/,'')+'/'+name;
async function refreshFiles(path=currentPath):Promise<void>{
  if(!filesAvailable){get<HTMLButtonElement>('upload').disabled=true;fileNote('请先接通这台电脑的监控 SSH，才能使用文件互传。');return;}
  fileNote('正在读取目录…');
  try{
    const reply=await operations.list(path);currentPath=reply.path;get<HTMLInputElement>('file-path').value=currentPath;
    get<HTMLButtonElement>('upload').disabled=currentPath==='/'||transferBusy;get('file-list').replaceChildren();
    for(const entry of [...reply.entries].sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name))){
      const row=document.createElement('div');row.className='file-row';const open=document.createElement('button');open.className='file-open';
      const icon=document.createElement('img');icon.src='/ui-icons/'+(entry.directory?'folder':'file')+'.svg';icon.alt='';const name=document.createElement('span');name.textContent=entry.name;open.append(icon,name);open.title=entry.name;
      open.onclick=()=>{if(entry.directory)void refreshFiles(joinPath(entry.name));};row.append(open);
      if(!entry.directory){const size=document.createElement('small');size.textContent=sizeText(entry.size);const download=document.createElement('button');download.className='file-download';download.title='下载到本机 · '+entry.name;download.setAttribute('aria-label','下载到本机 · '+entry.name);const image=document.createElement('img');image.src='/ui-icons/download-simple.svg';image.alt='';download.append(image);download.onclick=()=>void downloadFile(joinPath(entry.name));row.append(size,download);}get('file-list').append(row);
    }
    fileNote(reply.truncated?'目录较大，当前显示前 2000 项。':reply.entries.length?`${reply.entries.length} 项`:'此目录为空。');
  }catch(error){fileNote(error instanceof Error?error.message:'目录读取失败。');}
}
function openFiles():void{get('file-panel').hidden=false;releaseInputs();void refreshFiles();}
get('files').onclick=openFiles;get('close-files').onclick=()=>{get('file-panel').hidden=true;};
window.addEventListener('message',event=>{
  if(event.source!==window.parent||event.data?.type!=='gmssh-desktop-tool')return;
  if(event.data.tool==='files')openFiles();
  else if(event.data.tool==='power')get('power').click();
  else if(event.data.tool==='reconnect'&&!client.connected&&!connect.disabled&&keychain&&savedPasswordAvailable&&!password.value&&!ssh.value&&(transport==='monitor'||transport==='tailscale')){
    client.connect('','',transport,{saved:true,remember:false,token:accessToken});
    connect.disabled=true;disconnect.disabled=false;
  }
});
get<HTMLFormElement>('path-form').onsubmit=event=>{event.preventDefault();void refreshFiles(get<HTMLInputElement>('file-path').value);};
get('parent-folder').onclick=()=>{const parts=currentPath.replace(/\/$/,'').split('/');parts.pop();void refreshFiles(parts.length>1?parts.join('/')+'/':'/');};
get('upload').onclick=()=>get<HTMLInputElement>('upload-input').click();
function transfer(name:string):void{get('transfer-box').hidden=false;get('transfer-name').textContent=name;get<HTMLProgressElement>('transfer-progress').value=0;get('cancel-transfer').hidden=false;transferBusy=true;uploadCancelled=false;get<HTMLButtonElement>('upload').disabled=true;}
get('cancel-transfer').onclick=()=>{uploadCancelled=true;get('transfer-status').textContent='正在取消…';};
get<HTMLInputElement>('upload-input').onchange=async()=>{const input=get<HTMLInputElement>('upload-input'),file=input.files?.[0];input.value='';if(!file||transferBusy)return;transfer(file.name);try{await operations.upload(file,currentPath,bytes=>{get<HTMLProgressElement>('transfer-progress').value=file.size?100*bytes/file.size:100;get('transfer-status').textContent=`${sizeText(bytes)} / ${sizeText(file.size)}`;},()=>uploadCancelled);get('transfer-status').textContent='上传完成';get<HTMLProgressElement>('transfer-progress').value=100;}catch(error){get('transfer-status').textContent=error instanceof Error?error.message:'上传失败';}finally{transferBusy=false;get('cancel-transfer').hidden=true;await refreshFiles();}};
async function downloadFile(path:string):Promise<void>{if(transferBusy)return;transfer(path.split('/').pop()||'下载');get('cancel-transfer').hidden=true;get('transfer-status').textContent='正在下载…';try{const file=await operations.download(path);const url=URL.createObjectURL(file.blob);const link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60_000);get<HTMLProgressElement>('transfer-progress').value=100;get('transfer-status').textContent='已交给本机浏览器保存';}catch(error){get('transfer-status').textContent=error instanceof Error?error.message:'下载失败';}finally{transferBusy=false;get<HTMLButtonElement>('upload').disabled=currentPath==='/';}}

let powerTimer=0;
function cancelPower():void{clearInterval(powerTimer);powerTimer=0;get('cancel-power').hidden=true;get('power-note').textContent='倒计时已取消，未发送电源命令。';}
get('power').onclick=()=>{dialog('power-dialog');if(!powerAvailable)get('power-note').textContent='请先接通这台电脑的监控 SSH，才能发送电源命令。';};
get('cancel-power').onclick=cancelPower;
get('wake').onclick=async()=>{try{const reply=await operations.request('wake');get('power-note').textContent=String(reply.message);}catch(error){get('power-note').textContent=error instanceof Error?error.message:'唤醒请求未完成。';}};
get<HTMLDialogElement>('power-dialog').addEventListener('close',()=>{if(powerTimer)cancelPower();});
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-power]'))button.onclick=async()=>{
  if(!powerAvailable){get('power-note').textContent='监控 SSH 未接通。';return;}
  const action=button.dataset.power!;
  if(action==='cancel'){cancelPower();try{const reply=await operations.request('power',{action});get('power-note').textContent=String(reply.message||'请求已发送。');}catch(error){get('power-note').textContent=error instanceof Error?error.message:'请求失败。';}return;}
  if(powerTimer)return;
  if(!window.confirm(`确认${action==='restart'?'重启':'关闭'} ${peer||get('target').textContent}？桌面、终端和文件传输将断开。`))return;
  let remaining=30;get('cancel-power').hidden=false;get('power-note').textContent=`${remaining} 秒后发送${action==='restart'?'重启':'关机'}命令，可取消。`;
  powerTimer=window.setInterval(()=>{remaining--;get('power-note').textContent=`${remaining} 秒后发送命令，可取消。`;if(remaining===0){clearInterval(powerTimer);powerTimer=0;get('cancel-power').hidden=true;void operations.request('power',{action}).then(reply=>{get('power-note').textContent=String(reply.message||'电源请求已发送。');},error=>{get('power-note').textContent=error instanceof Error?error.message:'请求失败。';});}},1000);
};
