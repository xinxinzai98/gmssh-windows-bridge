import { frameBytes, utf8, wipe } from "../vendor/bytes";
import { CLIENT_VERSION, LIMITS } from "../vendor/limits";
import { Message, ImageQuality, ControlKey, KeyboardMode, ClipboardFormat, OptionMessage_BoolOption as Bool, SupportedDecoding_PreferCodec as Codec, type DisplayInfo, type KeyEvent, type MouseEvent } from "../vendor/generated/kessoku_wire";
import { boundedText, countAppVariants, topLevelFieldNumbers, validatePeerInfo, validateCursorMessage, validateDisabledSideChannel } from "../vendor/wire";
import { Vp9CanvasRenderer } from "../vendor/video";
import { clipboardText, multiClipboard } from './clipboard';
import { DesktopDiagnostics } from './diagnostics';
import { supportsWindowsUnlock, windowsUnlockFrame } from './windows-unlock';

export type DesktopPermissions=Record<'view'|'input'|'clipboard'|'files'|'terminal'|'power',boolean>&{files_read?:boolean};
type Events = { status(text: string): void; peer(name: string): void; frame(): void; stopped(): void; credential?(saved: boolean): void; clipboard?(text:string):void; displays?(items:DisplayInfo[],current:number):void; lifecycle?(state:'connecting'|'connected'|'disconnected'|'failed',code?:string):void;permissions?(value:DesktopPermissions):void };

export async function challengeResponse(password: Uint8Array, salt: string, challenge: string): Promise<Uint8Array> {
  if (!password.length) return new Uint8Array(); // Native RustDesk may request interactive confirmation.
  const salted = new Uint8Array(password.length + utf8.encode(salt).length);
  salted.set(password); salted.set(utf8.encode(salt), password.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", salted));
  wipe(salted);
  const second = new Uint8Array(hash.length + utf8.encode(challenge).length);
  second.set(hash); second.set(utf8.encode(challenge), hash.length);
  wipe(hash);
  const response = new Uint8Array(await crypto.subtle.digest("SHA-256", second));
  wipe(second);
  return response;
}

export class DirectClient {
  readonly diagnostics = new DesktopDiagnostics();
  #socket?: WebSocket;
  #password?: Uint8Array;
  #remember?: Uint8Array;
  #renderer?: Vp9CanvasRenderer;
  #stage: "hash" | "login" | "connected" = "hash";
  #display = 0;
  #displays:DisplayInfo[] = [];
  #generation = 0;
  #timer = 0;
  #windowsUnlock = false;
  #relayWindowsUnlock = true;
  #permissions:DesktopPermissions={view:true,input:true,clipboard:true,files:true,terminal:true,power:true};

  constructor(private canvas: HTMLCanvasElement, private events: Events) {}
  get connected(): boolean { return this.#stage === "connected" && this.#socket?.readyState === WebSocket.OPEN; }
  get windowsUnlockSupported():boolean { return this.connected && this.#windowsUnlock && this.#relayWindowsUnlock && this.#permissions.input; }
  get connectionGeneration():number { return this.#generation; }

  connect(sshPassword: string, desktopPassword: string, transport = "ssh", options: { saved: boolean; remember: boolean; token?: string } = { saved: false, remember: false }): void {
    this.disconnect();
    this.diagnostics.begin();
    this.events.lifecycle?.('connecting');
    const generation = this.#generation;
    this.#password = utf8.encode(desktopPassword);
    if (options.remember && desktopPassword) this.#remember = utf8.encode(desktopPassword);
    this.#stage = "hash";
    const socket = new WebSocket(new URL("/socket", location.origin.replace("http:", "ws:")));
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    let chain = Promise.resolve();
    const fail = (error: unknown, code?: string): void => {
      if (generation !== this.#generation) return;
      this.diagnostics.failed(code);this.events.lifecycle?.('failed',code||'DESKTOP_FAILED');this.disconnect(true);
      this.events.status(error instanceof Error ? error.message : "连接失败。");
    };
    socket.addEventListener("open", () => socket.send(JSON.stringify({ password: sshPassword,
      ...(options.saved && !desktopPassword ? { saved: true } : {}),
      ...(options.token ? { token: options.token } : {}) })), { once: true });
    socket.addEventListener("message", event => {
      chain = chain.then(async () => {
        if (generation !== this.#generation) return;
        if (typeof event.data === "string") {
          const result = JSON.parse(event.data);
          if(result.type==='controller_permissions'){
            const p=result.permissions;if(!p||!['clipboard,files,input,power,terminal,view','clipboard,files,files_read,input,power,terminal,view'].includes(Object.keys(p).sort().join())||Object.values(p).some(value=>typeof value!=='boolean'))throw Error('授权权限响应无效。');
            this.#relayWindowsUnlock=result.windows_unlock===true;
            this.#permissions={...p};this.events.permissions?.(this.#permissions);return;
          }
          if (result.type === "desktop_credential" && this.#stage === "hash" && typeof result.password === "string" && utf8.encode(result.password).length <= 4096) {
            wipe(this.#password); this.#password = utf8.encode(result.password); return;
          }
          if (result.type === "credential_saved" || result.type === "credential_error") {
            this.events.credential?.(result.type === "credential_saved"); return;
          }
          if (result.type === "ssh_ready") { this.diagnostics.transport();this.events.status("SSH 已验证，等待 RustDesk 握手；留空密码时请在 Windows 端确认。"); return; }
          if (result.type === "tailscale_ready") { this.diagnostics.transport();this.events.status("Tailscale 设备已核对，等待 RustDesk 握手；留空密码时请在 Windows 端确认。"); return; }
          throw new Error(result.type === "error" && typeof result.message === "string" ? result.message : "无效的传输响应。");
        }
        const bytes=await frameBytes(event.data);this.diagnostics.received(bytes.length);await this.#receive(bytes, generation);
      }).catch(fail);
    });
    socket.addEventListener("error", () => fail(new Error("本地桌面服务连接失败。")));
    socket.addEventListener("close", () => fail(new Error("桌面连接已关闭。")));
    this.#timer = window.setTimeout(() => fail(new Error("登录超时，请检查 RustDesk 密码或 Windows 端确认提示。"),'DESKTOP_LOGIN_TIMEOUT'), desktopPassword ? 60_000 : 300_000);
    this.events.status(transport === "monitor" ? "正在等待这台机器的监控认证…" : transport === "tailscale" ? "正在核对 Tailscale 设备…" : "正在验证 Windows SSH…");
  }

  async #receive(bytes: Uint8Array, generation: number): Promise<void> {
    if (bytes.length > LIMITS.websocketFrame) throw new Error("远端数据帧过大。");
    const fields = topLevelFieldNumbers(bytes);
    if(fields.includes(28)){
      try{for(const value of multiClipboard(bytes)){if(this.connected){const text=clipboardText(value);if(text!==undefined)this.events.clipboard?.(text);}}}
      catch{if(this.connected)this.events.status('此次剪贴板内容无法同步，桌面连接继续保持。');}
      return;
    }
    const message = Message.decode(bytes);
    if (countAppVariants(message) !== 1) throw new Error(`不支持的 RustDesk 消息：${fields.join(",")}`);
    if (message.testDelay) { if (!message.testDelay.fromClient) this.#send({ testDelay: message.testDelay }); return; }
    if (message.clipboard) {
      validateDisabledSideChannel(message);
      if (this.connected) { try{const text=clipboardText(message.clipboard); if (text!==undefined) this.events.clipboard?.(text);}catch{this.events.status('此次剪贴板内容无法同步，桌面连接继续保持。');} }
      return;
    }
    if (message.audioFrame || message.cliprdr) { validateDisabledSideChannel(message); return; }
    if (this.#stage === "hash") {
      if (!message.hash || !this.#password) throw new Error("未收到 RustDesk 直接连接的密码挑战。请检查远程版本和直接 IP 设置。");
      boundedText(message.hash.salt, "salt"); boundedText(message.hash.challenge, "challenge");
      this.diagnostics.handshake();
      const response = await challengeResponse(this.#password, message.hash.salt, message.hash.challenge);
      if (generation !== this.#generation) { wipe(response); return; }
      wipe(this.#password); this.#password = undefined;
      this.#send({ loginRequest: {
        username: "127.0.0.1", password: response,
        myId: String(100_000_000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900_000_000),
        myName: "GMSSH Web", myPlatform: "Web", version: CLIENT_VERSION, videoAckRequired: true,
        option: {
          imageQuality: ImageQuality.Balanced, showRemoteCursor: Bool.No,
          disableAudio: Bool.Yes, disableClipboard: Bool.No, disableKeyboard: Bool.No,
          supportedDecoding: { abilityVp9: 1, prefer: Codec.VP9 },
        },
      } });
      wipe(response); this.#stage = "login";
      this.events.status("已发送 RustDesk 登录请求；留空密码时请在 Windows 端确认（最多等待 5 分钟）。");
      return;
    }
    if (this.#stage === "login") {
      const reply = message.loginResponse;
      if (!reply || !reply.peerInfo || reply.error !== undefined) throw new Error(reply?.error ? boundedText(reply.error, "login error") : "RustDesk 未批准连接。");
      const display = validatePeerInfo(reply.peerInfo);
      this.#windowsUnlock = supportsWindowsUnlock(reply.peerInfo.platform, reply.peerInfo.version);
      this.diagnostics.approved(reply.peerInfo.version);
      const renderer = await Vp9CanvasRenderer.create(this.canvas, () => {
        if (generation !== this.#generation) return;
        this.diagnostics.frame();this.#send({ misc: { videoReceived: true } }); this.events.frame();
      }, error => { if (generation === this.#generation) { this.diagnostics.failed();this.disconnect(true); this.events.status(error.message); } });
      if (generation !== this.#generation) { renderer.close(); return; }
      this.#renderer = renderer;
      renderer.setDisplay(display.width, display.height);
      this.#display = reply.peerInfo.currentDisplay;
      this.#displays = reply.peerInfo.displays;
      this.events.displays?.(this.#displays,this.#display);
      this.#stage = "connected";
      this.events.lifecycle?.('connected');
      if (this.#remember) {
        this.#socket?.send(JSON.stringify({ remember: new TextDecoder().decode(this.#remember) }));
        wipe(this.#remember); this.#remember = undefined;
      }
      window.clearTimeout(this.#timer);
      this.events.peer(reply.peerInfo.hostname);
      return;
    }
    if (message.cursorData || message.cursorPosition || message.cursorId) { validateCursorMessage(message); return; }
    if (message.peerInfo) {
      const display = validatePeerInfo(message.peerInfo);
      this.#display = message.peerInfo.currentDisplay;
      this.#displays = message.peerInfo.displays;
      this.events.displays?.(this.#displays,this.#display);
      this.#renderer!.setDisplay(display.width, display.height);
    }
    if (message.misc?.switchDisplay) {
      const display=message.misc.switchDisplay;
      if (!this.#displays[display.display]) throw Error('远端显示器无效。');
      this.#display=display.display;
      this.#displays[this.#display]={...this.#displays[this.#display],x:display.x,y:display.y,width:display.width,height:display.height};
      this.#renderer!.setDisplay(display.width,display.height); this.events.displays?.(this.#displays,this.#display);
    }
    if (message.videoFrame) {
      if (message.videoFrame.display !== this.#display) { this.#send({misc:{videoReceived:true}});return; }
      if (!message.videoFrame.vp9s) throw new Error("暂不支持此视频格式。");
      this.#renderer!.decode(message.videoFrame.vp9s);
    }
    if (message.misc?.closeReason !== undefined) throw new Error(boundedText(message.misc.closeReason, "close reason") || "Windows 端已断开。");
  }

  #send(message: Parameters<typeof Message.fromPartial>[0]): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(Message.encode(Message.fromPartial(message)).finish());
  }
  mouse(event: MouseEvent): void { if (this.connected&&this.#permissions.input) { const display=this.#displays[this.#display]; this.#send({ mouseEvent: (event.mask&7)===3 ? event : {...event,x:event.x+(display?.x||0),y:event.y+(display?.y||0)} }); } }
  key(event: KeyEvent): void { if (this.connected&&this.#permissions.input) this.#send({ keyEvent: event }); }
  text(text:string):void { if(!this.#permissions.input)throw Error('此授权仅允许查看，未允许键盘输入。');if(new TextEncoder().encode(text).length>8192)throw Error('单次文本输入暂限 8 KiB。');if(this.connected)this.#send({keyEvent:{seq:text,mode:KeyboardMode.Legacy}}); }
  unlockWindows(password:string):void {
    if(!this.windowsUnlockSupported)throw Error('请连接允许键盘控制的桌面，并使用支持解锁的 GMSSH 服务端及 Windows 桌面引擎 1.5.1 或更新版本。');
    const frame=windowsUnlockFrame(password);
    try{this.#socket!.send(frame);}finally{frame.fill(0);}
  }
  clipboard(text:string):void { if(!this.#permissions.clipboard)throw Error('此授权未允许剪贴板同步。');const content=utf8.encode(text);if(content.length>8192)throw Error('单次发送剪贴板暂限 8 KiB。');if(this.connected)this.#send({clipboard:{content,format:ClipboardFormat.Text,compress:false}}); }
  shortcut(name:string):void {
    const base={down:false,press:true,modifiers:[] as ControlKey[],mode:KeyboardMode.Legacy};
    if(name==='ctrl-alt-del') this.key({...base,controlKey:ControlKey.CtrlAltDel});
    // Verified RustDesk 1.5 LockScreen value; the vendored enum is an older subset.
    else if(name==='lock') this.key({...base,controlKey:101 as ControlKey});
    else if(name==='windows') this.key({...base,controlKey:ControlKey.Meta});
    else if(name==='alt-tab') this.key({...base,controlKey:ControlKey.Tab,modifiers:[ControlKey.Alt]});
  }
  selectDisplay(index:number):void { if(this.connected&&this.#displays[index])this.#send({misc:{switchDisplay:{display:index}}}); }
  quality(value:string):void { if(this.connected)this.#send({misc:{option:{imageQuality:value==='low'?ImageQuality.Low:value==='best'?ImageQuality.Best:ImageQuality.Balanced}}}); }
  disconnect(preserveDiagnostics=false): void {
    if(!preserveDiagnostics&&this.#socket)this.events.lifecycle?.('disconnected','USER_DISCONNECTED');
    if(!preserveDiagnostics)this.diagnostics.disconnected();
    this.#generation++;
    this.#socket?.close(); this.#socket = undefined;
    this.#renderer?.close(); this.#renderer = undefined;
    wipe(this.#password); this.#password = undefined;
    wipe(this.#remember); this.#remember = undefined;
    window.clearTimeout(this.#timer);
    this.#stage = "hash";
    this.#windowsUnlock = false;
    this.#relayWindowsUnlock = true;
    this.events.stopped();
  }
}
