import { frameBytes, utf8, wipe } from "../vendor/bytes";
import { CLIENT_VERSION, LIMITS } from "../vendor/limits";
import { Message, ImageQuality, OptionMessage_BoolOption as Bool, SupportedDecoding_PreferCodec as Codec, type KeyEvent, type MouseEvent } from "../vendor/generated/kessoku_wire";
import { boundedText, countAppVariants, topLevelFieldNumbers, validatePeerInfo, validateCursorMessage, validateDisabledSideChannel } from "../vendor/wire";
import { Vp9CanvasRenderer } from "../vendor/video";

type Events = { status(text: string): void; peer(name: string): void; frame(): void; stopped(): void };

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
  #socket?: WebSocket;
  #password?: Uint8Array;
  #renderer?: Vp9CanvasRenderer;
  #stage: "hash" | "login" | "connected" = "hash";
  #display = 0;
  #generation = 0;
  #timer = 0;

  constructor(private canvas: HTMLCanvasElement, private events: Events) {}
  get connected(): boolean { return this.#stage === "connected" && this.#socket?.readyState === WebSocket.OPEN; }

  connect(sshPassword: string, desktopPassword: string): void {
    this.disconnect();
    const generation = this.#generation;
    this.#password = utf8.encode(desktopPassword);
    this.#stage = "hash";
    const socket = new WebSocket(new URL("/socket", location.origin.replace("http:", "ws:")));
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    let chain = Promise.resolve();
    const fail = (error: unknown): void => {
      if (generation !== this.#generation) return;
      this.disconnect();
      this.events.status(error instanceof Error ? error.message : "连接失败。");
    };
    socket.addEventListener("open", () => socket.send(JSON.stringify({ password: sshPassword })), { once: true });
    socket.addEventListener("message", event => {
      chain = chain.then(async () => {
        if (generation !== this.#generation) return;
        if (typeof event.data === "string") {
          const result = JSON.parse(event.data);
          if (result.type === "ssh_ready") { this.events.status("SSH 已验证，等待 RustDesk 握手；留空密码时请在 Windows 端确认。"); return; }
          throw new Error(result.type === "error" && typeof result.message === "string" ? result.message : "无效的传输响应。");
        }
        await this.#receive(await frameBytes(event.data), generation);
      }).catch(fail);
    });
    socket.addEventListener("error", () => fail(new Error("本地桌面服务连接失败。")));
    socket.addEventListener("close", () => fail(new Error("桌面连接已关闭。")));
    this.#timer = window.setTimeout(() => fail(new Error("登录超时，请检查 RustDesk 密码或 Windows 端确认提示。")), 60_000);
    this.events.status("正在验证 Windows SSH…");
  }

  async #receive(bytes: Uint8Array, generation: number): Promise<void> {
    if (bytes.length > LIMITS.websocketFrame) throw new Error("远端数据帧过大。");
    const fields = topLevelFieldNumbers(bytes);
    const message = Message.decode(bytes);
    if (countAppVariants(message) !== 1) throw new Error(`不支持的 RustDesk 消息：${fields.join(",")}`);
    if (message.testDelay) { if (!message.testDelay.fromClient) this.#send({ testDelay: message.testDelay }); return; }
    if (message.audioFrame || message.clipboard || message.cliprdr) { validateDisabledSideChannel(message); return; }
    if (this.#stage === "hash") {
      if (!message.hash || !this.#password) throw new Error("未收到 RustDesk 直接连接的密码挑战。此入口仅支持经 SSH 保护的直接连接。");
      boundedText(message.hash.salt, "salt"); boundedText(message.hash.challenge, "challenge");
      const response = await challengeResponse(this.#password, message.hash.salt, message.hash.challenge);
      if (generation !== this.#generation) { wipe(response); return; }
      wipe(this.#password); this.#password = undefined;
      this.#send({ loginRequest: {
        username: "127.0.0.1", password: response,
        myId: String(100_000_000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900_000_000),
        myName: "GMSSH Web", myPlatform: "Web", version: CLIENT_VERSION, videoAckRequired: true,
        option: {
          imageQuality: ImageQuality.Balanced, showRemoteCursor: Bool.No,
          disableAudio: Bool.Yes, disableClipboard: Bool.Yes, disableKeyboard: Bool.No,
          supportedDecoding: { abilityVp9: 1, prefer: Codec.VP9 },
        },
      } });
      wipe(response); this.#stage = "login";
      return;
    }
    if (this.#stage === "login") {
      const reply = message.loginResponse;
      if (!reply || !reply.peerInfo || reply.error !== undefined) throw new Error(reply?.error ? boundedText(reply.error, "login error") : "RustDesk 未批准连接。");
      const display = validatePeerInfo(reply.peerInfo);
      const renderer = await Vp9CanvasRenderer.create(this.canvas, () => {
        if (generation !== this.#generation) return;
        this.#send({ misc: { videoReceived: true } }); this.events.frame();
      }, error => { if (generation === this.#generation) { this.disconnect(); this.events.status(error.message); } });
      if (generation !== this.#generation) { renderer.close(); return; }
      this.#renderer = renderer;
      renderer.setDisplay(display.width, display.height);
      this.#display = reply.peerInfo.currentDisplay;
      this.#stage = "connected";
      window.clearTimeout(this.#timer);
      this.events.peer(reply.peerInfo.hostname);
      return;
    }
    if (message.cursorData || message.cursorPosition || message.cursorId) { validateCursorMessage(message); return; }
    if (message.peerInfo) {
      const display = validatePeerInfo(message.peerInfo);
      this.#display = message.peerInfo.currentDisplay;
      this.#renderer!.setDisplay(display.width, display.height);
    }
    if (message.videoFrame) {
      if (!message.videoFrame.vp9s || message.videoFrame.display !== this.#display) throw new Error("暂不支持此视频格式或显示器。");
      this.#renderer!.decode(message.videoFrame.vp9s);
    }
    if (message.misc?.closeReason !== undefined) throw new Error(boundedText(message.misc.closeReason, "close reason") || "Windows 端已断开。");
  }

  #send(message: Parameters<typeof Message.fromPartial>[0]): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(Message.encode(Message.fromPartial(message)).finish());
  }
  mouse(event: MouseEvent): void { if (this.connected) this.#send({ mouseEvent: event }); }
  key(event: KeyEvent): void { if (this.connected) this.#send({ keyEvent: event }); }
  disconnect(): void {
    this.#generation++;
    this.#socket?.close(); this.#socket = undefined;
    this.#renderer?.close(); this.#renderer = undefined;
    wipe(this.#password); this.#password = undefined;
    window.clearTimeout(this.#timer);
    this.#stage = "hash";
    this.events.stopped();
  }
}
