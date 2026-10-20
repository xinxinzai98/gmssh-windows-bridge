import { BinaryWriter } from '@bufbuild/protobuf/wire';

// RustDesk #16520: older peers ignore field 34. Never fall back to typing a
// password as ordinary keyboard events on an unknown or unlocked desktop.
export function supportsWindowsUnlock(platform:string, version:string):boolean {
  const match=/^1\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
  return platform==='Windows' && match!==null && (Number(match[1])>5 || Number(match[1])===5 && Number(match[2])>=1);
}

export function windowsUnlockFrame(password:string):Uint8Array {
  const length=new TextEncoder().encode(password).length;
  if(!length || length>1024 || /[\x00-\x1f\x7f]/.test(password))throw Error('请输入 Windows 账户密码，最多 1024 字节。');
  const login=new BinaryWriter().uint32(18).string(password).finish();
  try{return new BinaryWriter().uint32(274).bytes(login).finish();}
  finally{login.fill(0);}
}
