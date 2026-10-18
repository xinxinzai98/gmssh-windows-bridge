/* All pixels are decoded locally. Reading a code only opens the normal identity preview. */
window.gmsshReadConnectionQR=function({onResult}){
  window.gmsshQRReader?.close();
  const make=(tag,text)=>{const node=document.createElement(tag);if(text)node.textContent=text;return node;};
  const dialog=make('dialog');dialog.className='gm-qr-dialog';dialog.setAttribute('aria-label','扫描连接二维码');
  const heading=make('h2','扫描连接二维码'),hint=make('p','对准 Windows 分享窗口中的二维码，或选择保存的二维码图片。识别后先核对设备信息。');
  const controls=make('div');controls.className='gm-qr-actions';const camera=make('button','开始摄像头'),pick=make('button','选择二维码图片'),done=make('button','取消');
  for(const button of [camera,pick,done]){button.type='button';button.className='gm-ui-button';}controls.append(camera,pick,done);
  const file=make('input');file.type='file';file.accept='image/png,image/jpeg,image/webp,image/bmp';file.hidden=true;file.setAttribute('aria-label','二维码图片');
  const video=make('video');video.muted=true;video.playsInline=true;video.hidden=true;video.setAttribute('aria-label','二维码摄像头预览');
  const canvas=make('canvas');canvas.hidden=true;canvas.setAttribute('aria-label','二维码图片预览');
  const status=make('p','摄像头仅在点击后开启。图片和画面只在本机识别。');status.setAttribute('role','status');
  dialog.append(heading,hint,controls,file,video,canvas,status);document.body.append(dialog);dialog.showModal();
  let disposed=false,stream,timer,imageUrl,cameraBusy=false,generation=0;
  function stop(){generation++;clearTimeout(timer);stream?.getTracks().forEach(track=>track.stop());stream=undefined;video.srcObject=null;video.hidden=true;}
  function close(){if(disposed)return;disposed=true;stop();if(imageUrl)URL.revokeObjectURL(imageUrl);file.value='';canvas.width=canvas.height=0;dialog.close();dialog.remove();if(window.gmsshQRReader===controller)delete window.gmsshQRReader;}
  function accept(text){
    if(disposed)return;let valid=false;
    if(typeof text==='string'&&text.length<=65536){text=text.trim();valid=text.startsWith('GMSSH-CONNECT1.')||text.startsWith('GMSSH-AUTH2.');if(!valid)try{const value=JSON.parse(text);valid=value?.schema===1&&typeof value.sshHostPublicKey==='string'&&typeof value.username==='string';}catch{}}
    if(!valid){status.textContent='识别到的不是 GMSSH 连接二维码，请重新选择。';return false;}
    close();onResult(text);return true;
  }
  function scan(source,width,height){
    if(typeof window.jsQR!=='function')throw Error('二维码组件不可用，请使用复制连接码或运行新版管理端。');
    const scale=Math.min(1,1600/Math.max(width,height));canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(source,0,0,canvas.width,canvas.height);
    const pixels=context.getImageData(0,0,canvas.width,canvas.height);return window.jsQR(pixels.data,pixels.width,pixels.height,{inversionAttempts:'attemptBoth'})?.data;
  }
  async function startCamera(){
    if(disposed||cameraBusy)return;stop();const run=generation;cameraBusy=true;camera.disabled=true;
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw Error('此环境不支持摄像头，请选择二维码图片。');
      const opened=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
      if(disposed||run!==generation){opened.getTracks().forEach(track=>track.stop());return;}
      stream=opened;video.srcObject=stream;video.hidden=false;canvas.hidden=true;await video.play();if(disposed)return;
      status.textContent='请将二维码放入画面中。';
      const frame=()=>{if(disposed||!stream)return;try{if(video.readyState>=2&&video.videoWidth){const value=scan(video,video.videoWidth,video.videoHeight);if(value&&accept(value))return;}}catch(error){status.textContent=error.message;stop();return;}timer=setTimeout(frame,250);};frame();
    }catch(error){if(!disposed){stop();status.textContent=['NotAllowedError','PermissionDeniedError'].includes(error.name)?'摄像头未获授权，可改用二维码图片。':error.message||'无法开启摄像头，请选择二维码图片。';}}
    finally{cameraBusy=false;if(!disposed)camera.disabled=false;}
  }
  file.onchange=async()=>{
    const selected=file.files?.[0];file.value='';if(!selected)return;stop();const run=generation;let url;
    if(!['image/png','image/jpeg','image/webp','image/bmp'].includes(selected.type)||selected.size>8*1024*1024){status.textContent='请选择不超过 8 MiB 的 PNG、JPEG、WebP 或 BMP 图片。';return;}
    try{
      if(imageUrl)URL.revokeObjectURL(imageUrl);url=imageUrl=URL.createObjectURL(selected);const image=new Image();
      await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('无法读取这张图片。'));image.src=url;});
      if(disposed||run!==generation)return;
      if(!image.naturalWidth||image.naturalWidth*image.naturalHeight>16000000)throw Error('图片尺寸过大，请裁剪到二维码区域后重试。');
      const value=scan(image,image.naturalWidth,image.naturalHeight);canvas.hidden=false;
      if(!value)status.textContent='未识别到二维码，请使用清晰完整的二维码图片。';else accept(value);
    }catch(error){if(!disposed)status.textContent=error.message||'识别未完成，请重试。';}
    finally{if(url)URL.revokeObjectURL(url);if(imageUrl===url)imageUrl=undefined;}
  };
  camera.onclick=startCamera;pick.onclick=()=>file.click();done.onclick=close;
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  const controller={close};window.gmsshQRReader=controller;return controller;
};
