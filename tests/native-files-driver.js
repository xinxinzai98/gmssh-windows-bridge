/* Private fixture page driver; never included in the application bundle. */
window.addEventListener('message',async event=>{
 if(event.source!==window.parent||event.data?.type!=='native-fixture')return;
 const {action,requestId}=event.data;let result,error;
 try{
  if(action==='prepare'){
   for(let i=0;i<200&&!document.querySelector('#file-list button');i++)await new Promise(r=>setTimeout(r,25));
   document.getElementById('file-path').value='C:/';document.getElementById('path-form').dispatchEvent(new Event('submit',{cancelable:true}));
   for(let i=0;i<200&&document.getElementById('upload').disabled;i++)await new Promise(r=>setTimeout(r,25));
   if(document.getElementById('upload').disabled||document.getElementById('file-path').value!=='C:/')throw Error('Selected directory did not remain ready for upload');
   result={hint:[...document.querySelectorAll('.transfer-hint')].map(n=>n.textContent).join('\n')};
  }else if(action==='upload')document.getElementById('upload').click();
  else if(action==='tasks')document.getElementById('file-transfers-tab').click();
  else if(action==='state')result={text:document.getElementById('transfer-list').textContent,feedback:document.getElementById('file-feedback').textContent,overflow:document.documentElement.scrollWidth>innerWidth};
  else if(action==='mkdir-check'){
   document.getElementById('file-browse-tab').click();document.getElementById('file-path').value='C:/';document.getElementById('path-form').dispatchEvent(new Event('submit',{cancelable:true}));
   const wait=async check=>{for(let i=0;i<300;i++){if(check())return;await new Promise(r=>setTimeout(r,20));}throw Error('Folder operation timed out');};
   await wait(()=>document.getElementById('file-list').getAttribute('aria-busy')==='false');
   const open=()=>[...document.querySelectorAll('.file-upload-actions button')].find(b=>b.textContent==='新建文件夹').click(),submit=()=>{document.querySelector('[aria-label="新文件夹名称"]').value='新建验收';document.querySelector('.file-new-folder').dispatchEvent(new Event('submit',{cancelable:true}));};
   open();submit();await wait(()=>document.querySelector('.file-new-folder').hidden&&document.getElementById('file-list').getAttribute('aria-busy')==='false');const created=document.querySelector('.file-folder-result').textContent.includes('已创建');
   open();submit();await wait(()=>document.querySelector('.file-new-folder').hidden&&document.getElementById('file-list').getAttribute('aria-busy')==='false');result={created,existing:document.querySelector('.file-folder-result').textContent.includes('已存在')};
  }
  else if(action==='filter-check'){
   const input=document.querySelector('[aria-label="搜索此设备的任务"]'),status=document.querySelector('[aria-label="筛选此设备的任务状态"]');
   input.value='上传演示';input.dispatchEvent(new Event('input'));const search=document.querySelectorAll('.transfer-task').length===1&&document.querySelector('.transfer-task').textContent.includes('上传演示');
   const detail=document.querySelector('.transfer-task details');detail.open=true;await new Promise(r=>setTimeout(r,850));const retained=detail.isConnected&&detail.open;
   const description=detail.textContent;input.value='没有这个文件';input.dispatchEvent(new Event('input'));const empty=!document.querySelector('.transfer-task')&&!document.getElementById('transfer-empty').hidden;
   input.value='';input.dispatchEvent(new Event('input'));status.value='done';status.dispatchEvent(new Event('change'));const done=[...document.querySelectorAll('.transfer-task')].every(n=>n.dataset.state==='done');status.value='all';status.dispatchEvent(new Event('change'));result={search,retained,empty,done,details:description.includes('来源：')&&description.includes('目标：')&&description.includes('SHA-256')};
  }
  else throw Error('Unknown fixture command');
 }catch(e){error=e.message;}
 window.parent.postMessage({type:'native-fixture-result',requestId,result,error},event.origin);
});

window.parent.postMessage({type:'native-fixture-ready'},'*');
