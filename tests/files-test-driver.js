/* Test-only driver injected by file_center_fixture.py into its private fixture copy. */
(()=>{
 const saved={},grants=[],blobs=new Map(),original=HTMLAnchorElement.prototype.click,create=URL.createObjectURL;
 URL.createObjectURL=blob=>{const url=create(blob);blobs.set(url,blob);return url;};
 HTMLAnchorElement.prototype.click=function(){if(!this.download)return original.call(this);const name=this.download,blob=blobs.get(this.href);void blob.arrayBuffer().then(async bytes=>{saved[name]=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');});};
 const wait=async predicate=>{for(let i=0;i<800;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('fixture timeout');};
 window.addEventListener('message',async event=>{
  if(event.source!==window.parent)return;
  if(event.data?.type==='gmssh-file-lease')grants.push(event.data.requestId);
  if(event.data?.type!=='gmssh-fixture')return;
  const {requestId,action,text='中文传输内容',name='互传-中文.txt'}=event.data;
  try{
   if(action==='prepare'){
    await wait(()=>document.querySelector('#file-list button')&&typeof document.getElementById('path-form').onsubmit==='function');
    const input=document.getElementById('file-path');input.value='C:/传输测试';document.getElementById('path-form').dispatchEvent(new Event('submit',{cancelable:true}));await wait(()=>!document.getElementById('upload').disabled);
   }else if(action==='download-large')document.querySelector('[aria-label="下载到本机 · 大文件.bin"]').click();
   else if(action==='upload'){
    const input=document.getElementById('upload-input');Object.defineProperty(input,'files',{configurable:true,value:[new File([text],name,{type:'text/plain'})]});input.dispatchEvent(new Event('change'));
   }else if(action==='cancel')document.getElementById('cancel-transfers').click();
   else if(action!=='state')throw Error('Unknown fixture action');
   window.parent.postMessage({type:'gmssh-fixture-result',requestId,result:{saved:{...saved},grants:[...grants],feedback:document.getElementById('file-feedback').textContent}},event.origin);
  }catch(error){window.parent.postMessage({type:'gmssh-fixture-result',requestId,error:error.message},event.origin);}
 });
 window.parent.postMessage({type:'gmssh-fixture-ready'},'*');
})();
