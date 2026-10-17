type Reply = { id?: number; ok?: boolean; type?: string; message?: string; done?: boolean; bytes?: number; size?: number; name?: string; phase?: string; [key: string]: unknown };
export type FileEntry = { name: string; directory: boolean; size: number; modified: number };
export type DownloadProgress = (bytes: number, total: number, phase: 'preparing' | 'receiving') => void;
export class Operations {
  #socket?: WebSocket;
  #ready?: Promise<void>;
  #rejectReady?: (error: Error) => void;
  #readyTimer?: number;
  #id = 0;
  #pending = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void; timer: number }>();
  #download?: { id: number; chunks: BlobPart[]; bytes: number; size: number; name: string; progress: DownloadProgress; timer?: number; cleanup(): void; resolve(value: {blob:Blob;name:string}): void; reject(error:Error):void };
  constructor(private token: () => string) {}
  async ready(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = new Promise((resolve, reject) => {
      const socket = new WebSocket(new URL('/operations', location.origin.replace('http:', 'ws:')));
      socket.binaryType = 'arraybuffer'; this.#socket = socket; this.#rejectReady = reject;
      this.#readyTimer = window.setTimeout(() => this.close(Error('操作连接超时。')), 20_000);
      socket.onopen = () => socket.send(JSON.stringify({token:this.token()}));
      socket.onmessage = event => {
        if (this.#socket !== socket) return;
        if (typeof event.data !== 'string') {
          const file = this.#download;
          if (!file || file.size < 0 || event.data.byteLength > 65536 || file.bytes + event.data.byteLength > file.size) { this.close(Error('下载数据无效。')); return; }
          file.bytes += event.data.byteLength; file.chunks.push(event.data); this.#downloadActivity();
          file.progress(file.bytes, file.size, 'receiving'); return;
        }
        let data: Reply;
        try { data = JSON.parse(event.data); if (!data || typeof data !== 'object') throw Error(); }
        catch { this.close(Error('操作响应格式无效。')); return; }
        if (data.type === 'operations_ready') { clearTimeout(this.#readyTimer); this.#rejectReady = undefined; resolve(); return; }
        if (data.type === 'error') { this.close(Error(data.message || '操作连接失败。')); return; }
        const file = this.#download;
        if (file && data.id === file.id) {
          this.#downloadActivity();
          if (data.ok === false) { this.#finishDownload(Error(data.message || '下载失败。')); return; }
          if (data.phase === 'preparing') { file.progress(Number(data.bytes) || 0, 0, 'preparing'); return; }
          if (data.done) {
            if (file.size < 0 || file.bytes !== file.size) this.#finishDownload(Error('下载大小不一致。'));
            else this.#finishDownload(undefined, {blob:new Blob(file.chunks),name:file.name});
            return;
          }
          if (!Number.isInteger(data.size) || data.size! < 0 || data.size! > 512 * 1024 * 1024 || typeof data.name !== 'string' || !data.name || data.name.length > 1024) { this.close(Error('下载信息无效。')); return; }
          file.size = data.size!; file.name = data.name; file.progress(0, file.size, 'receiving'); return;
        }
        if (typeof data.id !== 'number') return;
        const pending = this.#pending.get(data.id); if (!pending) return;
        this.#pending.delete(data.id); clearTimeout(pending.timer);
        if (data.ok === false) pending.reject(Error(data.message || '操作失败。')); else pending.resolve(data);
      };
      socket.onclose = () => this.close(Error('操作连接已关闭。'));
      socket.onerror = () => this.close(Error('无法连接本机操作服务。'));
    });
    return this.#ready;
  }
  #wait(id: number, value: Record<string, unknown> | ArrayBuffer): Promise<Reply> {
    if (this.#socket?.readyState !== WebSocket.OPEN) return Promise.reject(Error('操作连接已关闭。'));
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { this.#pending.delete(id); reject(Error('文件或电源操作超时。')); }, 30_000);
      this.#pending.set(id, {resolve,reject,timer});
      this.#socket!.send(value instanceof ArrayBuffer ? value : JSON.stringify({...value,id}));
    });
  }
  #downloadActivity(): void {
    const file = this.#download; if (!file) return;
    clearTimeout(file.timer);
    file.timer = window.setTimeout(() => this.close(Error('下载长时间没有响应，请重试。')), 30_000);
  }
  #finishDownload(error?: Error, value?: {blob:Blob;name:string}): void {
    const file = this.#download; this.#download = undefined; if (!file) return;
    clearTimeout(file.timer); file.cleanup();
    if (error) file.reject(error); else file.resolve(value!);
  }
  async request(op: string, values: Record<string, unknown> = {}): Promise<Reply> { await this.ready(); return this.#wait(++this.#id,{op,...values}); }
  async list(path = ''): Promise<{path:string;entries:FileEntry[];truncated:boolean}> {
    const reply=await this.request('list',{path});
    if(typeof reply.path!=='string'||reply.path.length>1024||!(/^(?:\/|[A-Za-z]:\/[^\x00-\x1f]*)$/.test(reply.path))||typeof reply.truncated!=='boolean'||!Array.isArray(reply.entries)||reply.entries.length>2000||reply.entries.some(entry=>!entry||typeof entry.name!=='string'||!entry.name||entry.name.length>255||['.','..'].includes(entry.name)||/[\/\\\x00-\x1f]/.test(entry.name)||typeof entry.directory!=='boolean'||!Number.isSafeInteger(entry.size)||entry.size<0||!Number.isFinite(entry.modified)||entry.modified<0)||new Set(reply.entries.map(entry=>entry.name)).size!==reply.entries.length)throw Error('目录响应无效，已保留上次成功读取的目录。');
    return reply as unknown as {path:string;entries:FileEntry[];truncated:boolean};
  }
  async mkdir(path:string): Promise<{path:string;created:boolean}> {
    const reply=await this.request('mkdir',{path});
    if(reply.path!==path||typeof reply.created!=='boolean')throw Error('文件夹操作结果未确认，请刷新目录检查。');
    return {path,created:reply.created};
  }
  async upload(file: File, path: string, progress: (bytes:number) => void, cancelled: () => boolean, name=file.name): Promise<void> {
    if (file.size > 512 * 1024 * 1024) throw Error('单文件暂限 512 MiB。');
    await this.ready(); const id = ++this.#id;
    await this.#wait(id,{op:'upload-start',path,name,size:file.size});
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
  async download(path:string, options:{directory?:boolean;progress?:DownloadProgress;signal?:AbortSignal}={}): Promise<{blob:Blob;name:string}> {
    await this.ready(); if (this.#download) throw Error('请等待当前下载完成。');
    if (options.signal?.aborted) throw Error('已取消下载。');
    return new Promise((resolve,reject) => {
      const id=++this.#id,abort=()=>this.close(Error('已取消下载。'));
      this.#download={id,chunks:[],bytes:0,size:-1,name:'download',progress:options.progress||(()=>{}),cleanup:()=>options.signal?.removeEventListener('abort',abort),resolve,reject};
      options.signal?.addEventListener('abort',abort,{once:true}); this.#downloadActivity();
      this.#socket!.send(JSON.stringify({id,op:options.directory?'download-folder':'download',path}));
    });
  }
  close(error=Error('操作连接已关闭。')): void {
    const socket=this.#socket; this.#socket=undefined; this.#ready=undefined;
    clearTimeout(this.#readyTimer); this.#rejectReady?.(error); this.#rejectReady=undefined;
    if (socket) { socket.onopen=socket.onmessage=socket.onclose=socket.onerror=null; socket.close(); }
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.#pending.clear();
    this.#finishDownload(error);
  }
}
