import "./style.css";
import { DirectClient } from "./direct";
import { keyboardModifiers, keyEvent } from "../vendor/input";

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
const keys = new Map<string, KeyboardEvent>();
const buttons = new Map<number, PointerEvent>();
const client = new DirectClient(canvas, {
  status,
  peer(name) { peer = name; status(`${name} 已批准连接，等待画面…`); },
  frame() { frames++; canvas.hidden = false; empty.hidden = true; fullscreen.disabled = false; status(`${peer} · 已收到画面（${frames} 帧）`); },
  stopped() { keys.clear(); buttons.clear(); frames = 0; viewport.classList.remove("expanded"); canvas.hidden = true; empty.hidden = false; connect.disabled = false; disconnect.disabled = fullscreen.disabled = true; },
});

fetch("/config.json").then(response => {
  if (!response.ok) throw new Error();
  return response.json();
}).then(config => { get("target").textContent = `${config.target} · ${config.username} · SSH ${config.target_port}`; connect.disabled = false; })
  .catch(() => { connect.disabled = true; status("无法读取本地服务配置，请用桌面服务提供的地址打开。 "); });

get<HTMLFormElement>("login").addEventListener("submit", event => {
  event.preventDefault();
  const sshPassword = ssh.value;
  const desktopPassword = password.value;
  ssh.value = password.value = "";
  client.connect(sshPassword, desktopPassword);
  connect.disabled = true; disconnect.disabled = false;
});

function releaseInputs(): void {
  for (const event of keys.values()) { const wire = keyEvent(event, false); if (wire) { wire.modifiers = []; client.key(wire); } }
  for (const [button, event] of buttons) client.mouse({ mask: (button << 3) | 2, ...position(event), modifiers: [] });
  keys.clear(); buttons.clear();
}
disconnect.addEventListener("click", () => { releaseInputs(); client.disconnect(); status("已断开。Windows 上的 RustDesk 继续运行。"); });
window.addEventListener("blur", releaseInputs);
window.addEventListener("pagehide", () => { releaseInputs(); client.disconnect(); });

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
// ponytail: one pointer-move per animation frame; add relative-pointer support only if required by a real task.
let move: PointerEvent | undefined;
let moveFrame = 0;
canvas.addEventListener("pointermove", event => {
  move = event;
  if (!moveFrame) moveFrame = requestAnimationFrame(() => {
    moveFrame = 0;
    if (move) client.mouse({ mask: move.buttons << 3, ...position(move), modifiers: modifiers(move) });
    move = undefined;
  });
});
canvas.addEventListener("pointerdown", event => {
  canvas.focus(); canvas.setPointerCapture(event.pointerId);
  const button = buttonCode(event.button);
  if (button) { buttons.set(button, event); client.mouse({ mask: (button << 3) | 1, ...position(event), modifiers: modifiers(event) }); }
  event.preventDefault();
});
canvas.addEventListener("pointerup", event => {
  const button = buttonCode(event.button);
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
