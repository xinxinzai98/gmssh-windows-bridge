import { Decompress } from 'fzstd';
import { ClipboardFormat, Clipboard, type Clipboard as ClipboardValue } from '../vendor/generated/kessoku_wire';
import { BinaryReader } from '@bufbuild/protobuf/wire';
const MAX_TEXT = 128 * 1024;
// Bound both the native zstd window and output before decoding peer-controlled data.
export function clipboardText(value: ClipboardValue): string | undefined {
  if (value.format !== ClipboardFormat.Text) return;
  if (value.content.length > MAX_TEXT) throw Error('远端剪贴板文本过大。');
  let bytes = value.content;
  if (value.compress) {
    const data=bytes, reader=new DataView(data.buffer,data.byteOffset,data.byteLength);
    if (data.length < 6 || reader.getUint32(0,true) !== 0xfd2fb528) throw Error('无效的剪贴板压缩格式。');
    const flags=data[4], single=Boolean(flags&32), sizeFlag=flags>>>6;
    if (flags & 24 || flags & 3) throw Error('不支持的剪贴板压缩头。');
    let offset=5, window=0;
    if (!single) { const descriptor=data[offset++], log=10+(descriptor>>>3); window=2**log+(2**log/8)*(descriptor&7); }
    const sizeBytes = sizeFlag === 0 ? single ? 1 : 0 : 2 ** sizeFlag;
    if (offset+sizeBytes > data.length) throw Error('剪贴板压缩头不完整。');
    let size=0n;
    for(let i=0;i<sizeBytes;i++) size |= BigInt(data[offset+i]) << BigInt(i*8);
    if(sizeFlag===1) size+=256n;
    offset+=sizeBytes;
    if (sizeBytes && size>BigInt(MAX_TEXT) || (single ? Number(size) : window)>1024*1024) throw Error('剪贴板解压大小超过限制。');
    let last=false;
    while(!last) {
      if(offset+3>data.length) throw Error('剪贴板压缩块不完整。');
      const header=data[offset]|data[offset+1]<<8|data[offset+2]<<16; offset+=3; last=Boolean(header&1);
      const type=(header>>>1)&3; if(type===3) throw Error('无效的剪贴板压缩块。'); offset+=type===1?1:header>>>3;
      if(offset>data.length) throw Error('剪贴板压缩块越界。');
    }
    if(flags&4) offset+=4;
    if(offset!==data.length) throw Error('剪贴板压缩帧不唯一。');
    const chunks:Uint8Array[]=[];let total=0;
    const decoder=new Decompress(chunk=>{total+=chunk.length;if(total>MAX_TEXT)throw Error('远端剪贴板文本过大。');chunks.push(chunk);});
    decoder.push(data,true); bytes=new Uint8Array(total);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  }
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}

// RustDesk 1.5 field 28, documented in the pinned upstream message.proto.
export function multiClipboard(bytes:Uint8Array):ClipboardValue[]{
  if(bytes.length>1024*1024)throw Error('远端剪贴板消息过大。');
  const envelope=new BinaryReader(bytes);const tag=envelope.uint32();
  if(tag!==(28<<3|2))throw Error('无效的多格式剪贴板消息。');
  const payload=envelope.bytes();if(envelope.pos!==envelope.len)throw Error('剪贴板消息不唯一。');
  const reader=new BinaryReader(payload),items:ClipboardValue[]=[];
  while(reader.pos<reader.len){const tag=reader.uint32();if(tag===(1<<3|2)){if(items.length>=32)throw Error('剪贴板格式数量过多。');items.push(Clipboard.decode(reader.bytes()));}else reader.skip(tag&7);}
  return items;
}
