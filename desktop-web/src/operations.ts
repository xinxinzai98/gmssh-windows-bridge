type Reply = { id?: number; ok?: boolean; type?: string; message?: string; done?: boolean; bytes?: number; size?: number; name?: string; [key: string]: unknown };
export type FileEntry = { name: string; directory: boolean; size: number; modified: number };
export class Operations {
  #socket?: WebSocket;
  #ready?: Promise<void>;
  #id = 0;
  #pending = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void; timer: number }>();
  #download?: { id: number; chunks: BlobPart[]; bytes: number; size: number; name: string; resolve(value: {blob:Blob;name:string}): void; reject(error:Error):void };
  constructor(private token: () => string) {}
  async ready(): Promise<void> {
    if (this.#socket?.readyState === WebSocket.OPEN && this.#ready) return this.#ready;
    if (this.#ready) return this.#ready;
    this.#ready = new Promise((resolve, reject) => {
      const socket = new WebSocket(new URL('/operations', location.origin.replace('http:', 'ws:')));
      socket.binaryType = 'arraybuffer'; this.#socket = socket;
      const timer = window.setTimeout(() => { reject(Error('操作连接超时。')); socket.close(); }, 20_000);
      socket.onopen = () => socket.send(JSON.stringify({token:this.token()}));
      socket.onmessage = event => {
        if (typeof event.data !== 'string') {
          const file = this.#download;
          if (!file || event.data.byteLength > 65536 || file.bytes + event.data.byteLength > file.size) { this.close(); return; }
          file.bytes += event.data.byteLength; file.chunks.push(event.data); return;
        }
        const data: Reply = JSON.parse(event.data);
        if (data.type === 'operations_ready') { clearTimeout(timer); resolve(); return; }
        if (data.type === 'error') { clearTimeout(timer); reject(Error(data.message || '操作连接失败。')); this.close(); return; }
        const file = this.#download;
        if (file && data.id === file.id) {
          if (data.ok === false) { file.reject(Error(data.message || '下载失败。')); this.#download = undefined; return; }
          if (data.done) {
            if (file.bytes !== file.size) file.reject(Error('下载大小不一致。'));
            else file.resolve({blob:new Blob(file.chunks),name:file.name});
            this.#download = undefined; return;
          }
          if (typeof data.size === 'number' && data.size >= 0 && data.size <= 512 * 1024 * 1024 && typeof data.name === 'string') { file.size = data.size; file.name = data.name; }
          return;
        }
        if (typeof data.id !== 'number') return;
        const pending = this.#pending.get(data.id); if (!pending) return;
        this.#pending.delete(data.id); clearTimeout(pending.timer);
        if (data.ok === false) pending.reject(Error(data.message || '操作失败。')); else pending.resolve(data);
      };
      socket.onclose = () => { clearTimeout(timer); reject(Error('操作连接已关闭。')); this.close(); };
      socket.onerror = () => { clearTimeout(timer); reject(Error('无法连接本机操作服务。')); this.close(); };
    });
    return this.#ready;
  }
  #wait(id: number, value: Record<string, unknown> | ArrayBuffer): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { this.#pending.delete(id); reject(Error('文件或电源操作超时。')); }, 30_000);
      this.#pending.set(id, {resolve,reject,timer});
      this.#socket!.send(value instanceof ArrayBuffer ? value : JSON.stringify({...value,id}));
    });
  }
  async request(op: string, values: Record<string, unknown> = {}): Promise<Reply> { await this.ready(); return this.#wait(++this.#id,{op,...values}); }
  async list(path = ''): Promise<{path:string;entries:FileEntry[];truncated:boolean}> { return await this.request('list',{path}) as unknown as {path:string;entries:FileEntry[];truncated:boolean}; }
  async upload(file: File, path: string, progress: (bytes:number) => void, cancelled: () => boolean): Promise<void> {
    if (file.size > 512 * 1024 * 1024) throw Error('单文件暂限 512 MB。');
    await this.ready(); const id = ++this.#id;
    await this.#wait(id,{op:'upload-start',path,name:file.name,size:file.size});
    try {
      for (let offset = 0; offset < file.size; offset += 65536) {
        if (cancelled()) throw Error('已取消上传。');
        const data = await file.slice(offset,offset+65536).arrayBuffer();
        const reply = await this.#wait(id,data); progress(Number(reply.bytes));
      }
      if (cancelled()) throw Error('已取消上传。');
      await this.#wait(id,{op:'upload-finish'});
    } catch (error) { try { await this.#wait(id,{op:'upload-cancel'}); } catch {} throw error; }
  }
  async download(path:string): Promise<{blob:Blob;name:string}> {
    await this.ready(); if (this.#download) throw Error('请等待当前下载完成。');
    return new Promise((resolve,reject) => { const id=++this.#id; this.#download={id,chunks:[],bytes:0,size:0,name:'download',resolve,reject}; this.#socket!.send(JSON.stringify({id,op:'download',path})); });
  }
  close(): void {
    const socket=this.#socket; this.#socket=undefined; this.#ready=undefined;
    if (socket) { socket.onclose=socket.onerror=null; socket.close(); }
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(Error('操作连接已关闭。')); } this.#pending.clear();
    this.#download?.reject(Error('下载已断开。')); this.#download=undefined;
  }
}
