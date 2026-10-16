/* The focused textarea lets the OS input method commit text before it reaches the wire. */
export function installTextInput(canvas:HTMLCanvasElement,input:HTMLTextAreaElement,options:{enabled:()=>boolean;release:()=>void;send:(text:string)=>void;error:(error:unknown)=>void;hint:(text:string)=>void}) {
  let composing=false,focused=false,ignoreInput=false,resetTimer:number|undefined;
  const clear=()=>{input.value='';};
  const commit=(text:string)=>{
    clear();if(!options.enabled()||!focused||!text||typeof document!=='undefined'&&document.hasFocus?.()===false)return;
    try{if(new TextEncoder().encode(text).length>8192)throw Error('单次文本输入暂限 8 KiB，请分段粘贴。');options.release();options.send(text);}catch(error){options.error(error);}
  };
  const suppress=(event:KeyboardEvent)=>{
    if(!options.enabled())return;
    if(composing||event.isComposing||event.keyCode===229||event.key==='Process'||event.key==='Dead'){event.stopImmediatePropagation();return;}
    if(event.type==='keydown'){ignoreInput=false;clearTimeout(resetTimer);}
    if(event.type==='keydown'&&(event.metaKey||event.ctrlKey&&event.shiftKey)&&!event.altKey&&(event.code==='KeyV'||event.key.toLowerCase()==='v')){
      // Plain Ctrl+V retains the remote clipboard; local paste is explicit.
      event.stopImmediatePropagation();options.release();
    }
  };
  for(const target of [canvas,input]){target.addEventListener('keydown',suppress as EventListener,true);target.addEventListener('keyup',suppress as EventListener,true);}
  input.addEventListener('focus',()=>{focused=true;options.hint('键盘控制中 · ⌘/Ctrl+Shift+V 粘贴本机文本');});
  input.addEventListener('blur',()=>{focused=false;composing=ignoreInput=false;clearTimeout(resetTimer);clear();options.release();options.hint('点击桌面后输入，点击工具栏退出键盘控制');});
  input.addEventListener('compositionstart',()=>{composing=true;ignoreInput=false;clearTimeout(resetTimer);options.release();});
  input.addEventListener('compositionend',event=>{
    composing=false;ignoreInput=true;clearTimeout(resetTimer);
    commit(typeof event.data==='string'?event.data:input.value);
    // Chromium and WebKit differ on whether the final input event precedes compositionend.
    resetTimer=window.setTimeout(()=>{ignoreInput=false;clear();},0);
  });
  input.addEventListener('input',event=>{
    const value=event as InputEvent;if(composing||value.isComposing)return;
    if(ignoreInput||value.inputType?.includes('Composition')){clear();return;}
    commit(value.data??input.value);
  });
  input.addEventListener('paste',event=>{if(!options.enabled())return;event.preventDefault();commit(event.clipboardData?.getData('text/plain')||'');});
  const focus=(point?:{x:number;y:number})=>{
    if(!options.enabled())return;
    if(point){input.style.left=Math.max(0,Math.min(innerWidth-24,point.x))+'px';input.style.top=Math.max(0,Math.min(innerHeight-30,point.y))+'px';}
    input.disabled=false;input.focus({preventScroll:true});
  };
  canvas.addEventListener('focus',()=>focus());
  return {focus};
}
