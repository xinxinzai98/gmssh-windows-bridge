/* Private fixture page driver; never included in the application bundle. */
window.addEventListener('message',async event=>{
 if(event.source!==window.parent||event.data?.type!=='native-fixture')return;
 const {action,requestId}=event.data;let result,error;
 try{
  if(action==='prepare'){
   for(let i=0;i<200&&!document.querySelector('#file-list button');i++)await new Promise(r=>setTimeout(r,25));
   document.getElementById('file-path').value='C:/';document.getElementById('path-form').dispatchEvent(new Event('submit',{cancelable:true}));
   for(let i=0;i<200&&document.getElementById('upload').disabled;i++)await new Promise(r=>setTimeout(r,25));
   result={hint:[...document.querySelectorAll('.transfer-hint')].map(n=>n.textContent).join('\n')};
  }else if(action==='upload')document.getElementById('upload').click();
  else if(action==='tasks')document.getElementById('file-transfers-tab').click();
  else if(action==='state')result={text:document.getElementById('transfer-list').textContent,feedback:document.getElementById('file-feedback').textContent,overflow:document.documentElement.scrollWidth>innerWidth};
  else throw Error('Unknown fixture command');
 }catch(e){error=e.message;}
 window.parent.postMessage({type:'native-fixture-result',requestId,result,error},event.origin);
});

window.parent.postMessage({type:'native-fixture-ready'},'*');
