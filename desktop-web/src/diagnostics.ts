type State = 'unchecked'|'checking'|'passed'|'failed';
type Stage = {id:string;state:State;code:string;sampledAt:string};
export class DesktopDiagnostics {
  private stages:Stage[]=[];
  private started=0;
  private approvedAt=0;
  private lastFrame=0;
  private frames=0;
  private bytes=0;
  private engineVersion:string|null=null;
  constructor(private clock=()=>Date.now()){this.reset();}
  private set(id:string,state:State,code:string){const next={id,state,code,sampledAt:new Date(this.clock()).toISOString()};const index=this.stages.findIndex(s=>s.id===id);if(index<0)this.stages.push(next);else this.stages[index]=next;}
  private reset(){this.stages=[];for(const id of ['desktopTransport','desktopHandshake','desktopAuth','firstFrame','frames'])this.set(id,'unchecked','DESKTOP_NOT_OPEN');}
  begin(){this.reset();this.started=this.clock();this.approvedAt=this.lastFrame=this.frames=this.bytes=0;this.engineVersion=null;this.set('desktopTransport','checking','DESKTOP_CONNECTING');}
  transport(){this.set('desktopTransport','passed','DESKTOP_TRANSPORT_READY');this.set('desktopHandshake','checking','DESKTOP_HANDSHAKE_PENDING');}
  handshake(){this.set('desktopHandshake','passed','DESKTOP_HANDSHAKE_OK');this.set('desktopAuth','checking','DESKTOP_AUTH_PENDING');}
  approved(version:unknown){this.approvedAt=this.clock();this.engineVersion=typeof version==='string'&&/^\d+[\d.a-zA-Z+-]{0,63}$/.test(version)?version:null;this.set('desktopAuth','passed','DESKTOP_AUTH_OK');this.set('firstFrame','checking','FIRST_FRAME_PENDING');}
  received(size:number){if(Number.isFinite(size)&&size>0)this.bytes+=size;}
  frame(){this.frames++;this.lastFrame=this.clock();if(this.frames===1)this.set('firstFrame','passed','FIRST_FRAME_OK');this.set('frames','passed','FRAMES_RECEIVED');}
  failed(code='DESKTOP_TRANSPORT_FAILED'){
    const auth=this.stages.find(s=>s.id==='desktopAuth'),transport=this.stages.find(s=>s.id==='desktopTransport'),handshake=this.stages.find(s=>s.id==='desktopHandshake');
    if(auth?.state==='passed'){this.set('frames','failed','DESKTOP_DISCONNECTED');if(!this.frames)this.set('firstFrame','failed','DESKTOP_DISCONNECTED');}
    else if(handshake?.state==='passed')this.set('desktopAuth','failed',code==='DESKTOP_LOGIN_TIMEOUT'?code:'DESKTOP_AUTH_FAILED');
    else if(transport?.state==='passed')this.set('desktopHandshake','failed',code==='DESKTOP_LOGIN_TIMEOUT'?'DESKTOP_HANDSHAKE_TIMEOUT':'DESKTOP_HANDSHAKE_FAILED');
    else this.set('desktopTransport','failed','DESKTOP_TRANSPORT_FAILED');
  }
  disconnected(){if(this.started){this.set('desktopTransport','failed','DESKTOP_DISCONNECTED');this.set('frames','failed','DESKTOP_DISCONNECTED');for(const stage of this.stages)if(stage.state==='checking')this.set(stage.id,'failed','DESKTOP_DISCONNECTED');}}
  snapshot(){
    const now=this.clock(),seconds=Math.max(1,(now-this.started)/1000),stages=this.stages.map(s=>({...s}));
    const first=stages.find(s=>s.id==='firstFrame');if(first?.state==='checking'&&this.approvedAt&&now-this.approvedAt>=15000){first.state='failed';first.code='FIRST_FRAME_TIMEOUT';first.sampledAt=new Date(now).toISOString();}
    return {stages,engineVersion:this.engineVersion,metrics:{fps:this.started?Math.round(this.frames/seconds*10)/10:0,kibPerSecond:this.started?Math.round(this.bytes/1024/seconds*10)/10:0,lastFrameAgeSeconds:this.lastFrame?Math.round((now-this.lastFrame)/100)/10:null}};
  }
}
