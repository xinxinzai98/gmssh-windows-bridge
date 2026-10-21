#requires -Version 5.1
# Runs as the signed-in tray user, never as the SYSTEM connection service.
[CmdletBinding()]
param([switch]$Worker,[int]$ParentProcessId=0,[long]$ParentStartTicks=0)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.dll,System.Core.dll,System.Windows.Forms.dll,System.Drawing.dll -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Threading;
using System.IO.Pipes;
using Microsoft.Win32.SafeHandles;
public static class GMSSHAIDesktop {
 static Timer watchdog;
 static Timer parentGuard;
 static long budget;
 static readonly int sessionId=System.Diagnostics.Process.GetCurrentProcess().SessionId;
 static long sessionEpoch;
 static volatile bool sessionWatching;
 static readonly ManualResetEvent sessionReady=new ManualResetEvent(false);
 public static long SessionEpoch {get{return Interlocked.Read(ref sessionEpoch);}}
 [DllImport("wtsapi32.dll",CharSet=CharSet.Unicode)] static extern bool WTSQuerySessionInformation(IntPtr server,int session,int info,out IntPtr buffer,out uint bytes);
 [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
 [DllImport("wtsapi32.dll",SetLastError=true)] static extern bool WTSRegisterSessionNotification(IntPtr window,int flags);
 [DllImport("wtsapi32.dll")] static extern bool WTSUnRegisterSessionNotification(IntPtr window);
 public static bool SessionUnlocked(){
  IntPtr buffer=IntPtr.Zero;uint bytes=0;
  try{
   if(!WTSQuerySessionInformation(IntPtr.Zero,sessionId,25,out buffer,out bytes)||buffer==IntPtr.Zero||bytes<20)return false;
   // WTSINFOEX's union is 8-byte aligned. Read only Level and the Level1 header.
   return Marshal.ReadInt32(buffer,0)==1&&Marshal.ReadInt32(buffer,8)==sessionId&&Marshal.ReadInt32(buffer,12)==0&&Marshal.ReadInt32(buffer,16)==1;
  }finally{if(buffer!=IntPtr.Zero)WTSFreeMemory(buffer);}
 }
 sealed class SessionWindow:System.Windows.Forms.NativeWindow,IDisposable {
  public SessionWindow(){
   CreateHandle(new System.Windows.Forms.CreateParams{Caption="GMSSH AI session state",Parent=new IntPtr(-3)});
   if(!WTSRegisterSessionNotification(Handle,0)){DestroyHandle();throw new InvalidOperationException("SESSION_WATCH_UNAVAILABLE");}
  }
  protected override void WndProc(ref System.Windows.Forms.Message message){
   if(message.Msg==0x02B1&&message.LParam.ToInt32()==sessionId)Interlocked.Increment(ref sessionEpoch);
   base.WndProc(ref message);
  }
  public void Dispose(){WTSUnRegisterSessionNotification(Handle);DestroyHandle();}
 }
 public static void StartSessionWatch(){
  var thread=new Thread(()=>{
   SessionWindow window=null;
   try{window=new SessionWindow();sessionWatching=true;sessionReady.Set();System.Windows.Forms.Application.Run();}
   catch{sessionReady.Set();}
   finally{sessionWatching=false;if(window!=null)window.Dispose();}
  });
  thread.IsBackground=true;thread.SetApartmentState(ApartmentState.STA);thread.Start();
  if(!sessionReady.WaitOne(2000)||!sessionWatching)throw new InvalidOperationException("SESSION_WATCH_UNAVAILABLE");
 }
 public static void GuardParent(int pid,long ticks,int session){
  if(parentGuard!=null)parentGuard.Dispose();
  parentGuard=new Timer(_=>{if(!sessionWatching)Environment.Exit(2);try{using(var p=System.Diagnostics.Process.GetProcessById(pid)){if(p.HasExited||p.StartTime.ToUniversalTime().Ticks!=ticks||p.SessionId!=session)Environment.Exit(0);}}catch{Environment.Exit(0);}},null,0,2000);
 }
 public static void ArmWatchdog(){long serial=Interlocked.Increment(ref budget);watchdog=new Timer(_=>{if(Interlocked.Read(ref budget)==serial)Environment.Exit(2);},null,7500,Timeout.Infinite);}
 public static void StopWatchdog(){Interlocked.Increment(ref budget);if(watchdog!=null){watchdog.Dispose();watchdog=null;}}
 [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint f,bool i,uint a);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h,int n,StringBuilder s,int l,out int r);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h,int command);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern uint SendInput(uint n,INPUT[] a,int s);
 [StructLayout(LayoutKind.Sequential)] struct SECURITY {public int size;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafePipeHandle CreateNamedPipe(string name,uint access,uint mode,uint max,uint output,uint input,uint timeout,ref SECURITY security);
 public static NamedPipeServerStream Pipe(string name,byte[] descriptor){
  var pinned=GCHandle.Alloc(descriptor,GCHandleType.Pinned);
  try{
   var security=new SECURITY{size=Marshal.SizeOf(typeof(SECURITY)),descriptor=pinned.AddrOfPinnedObject(),inherit=false};
   // OVERLAPPED | FIRST_PIPE_INSTANCE, and PIPE_REJECT_REMOTE_CLIENTS.
   var handle=CreateNamedPipe(@"\\.\pipe\"+name,3|0x40000000|0x00080000,8,1,65536,65536,3000,ref security);
   if(handle.IsInvalid){handle.Dispose();throw new IOException("PIPE_UNAVAILABLE");}
   try{return new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);}catch{handle.Dispose();throw;}
  }finally{pinned.Free();}
 }
 [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int x,y;public uint data,flags,time;public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] struct KEY {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)] struct UNION {[FieldOffset(0)] public MOUSE mouse;[FieldOffset(0)] public KEY key;}
 [StructLayout(LayoutKind.Sequential)] struct INPUT {public uint type;public UNION data;}
 public static bool Unlocked(){if(!sessionWatching||!SessionUnlocked())return false;IntPtr h=OpenInputDesktop(0,false,1);if(h==IntPtr.Zero)return false;try{var s=new StringBuilder(128);int r;return GetUserObjectInformation(h,2,s,256,out r)&&s.ToString()=="Default";}finally{CloseDesktop(h);}}
 public static bool Focus(long h){
  if(!Unlocked()||!IsWindow(new IntPtr(h)))return false;
  if(GetForegroundWindow().ToInt64()==h&&!IsIconic(new IntPtr(h)))return true;
  if(IsIconic(new IntPtr(h)))ShowWindowAsync(new IntPtr(h),9);
  SetForegroundWindow(new IntPtr(h));
  // Activation across input queues completes asynchronously; never force it.
  var deadline=DateTime.UtcNow.AddMilliseconds(500);
  do{if(!Unlocked()||!IsWindow(new IntPtr(h)))return false;if(GetForegroundWindow().ToInt64()==h&&!IsIconic(new IntPtr(h)))return true;Thread.Sleep(10);}while(DateTime.UtcNow<deadline);
  return false;
 }
 static void Send(INPUT[] input,long window){
  if(!Unlocked())throw new InvalidOperationException("DESKTOP_LOCKED");
  if(GetForegroundWindow().ToInt64()!=window)throw new InvalidOperationException("FOCUS_DENIED");
  if(SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(INPUT)))!=input.Length)throw new InvalidOperationException("DESKTOP_OUTCOME_UNKNOWN");
 }
 public static void Click(int x,int y,long window){if(!Unlocked()||GetForegroundWindow().ToInt64()!=window||!SetCursorPos(x,y))throw new InvalidOperationException("FOCUS_DENIED");var a=new INPUT[2];a[0].data.mouse.flags=2;a[1].data.mouse.flags=4;Send(a,window);}
 public static void Text(string text,long window){
  var a=new INPUT[text.Length*2];int count=0;
  for(int i=0;i<text.Length;i++){
   a[count].type=a[count+1].type=1;
   if(text[i]=='\r'||text[i]=='\n'){
    if(text[i]=='\r'&&i+1<text.Length&&text[i+1]=='\n')i++;
    a[count].data.key.vk=a[count+1].data.key.vk=13;
    a[count+1].data.key.flags=2;
   }else{
    a[count].data.key.scan=a[count+1].data.key.scan=text[i];
    a[count].data.key.flags=4;a[count+1].data.key.flags=6;
   }
   count+=2;
  }
  Array.Resize(ref a,count);Send(a,window);
 }
 public static void Key(ushort key,ushort modifier,long window){var a=new INPUT[modifier==0?2:4];int i=0;if(modifier!=0){a[i].type=1;a[i++].data.key.vk=modifier;}a[i].type=1;a[i++].data.key.vk=key;a[i].type=1;a[i].data.key.vk=key;a[i++].data.key.flags=2;if(modifier!=0){a[i].type=1;a[i].data.key.vk=modifier;a[i].data.key.flags=2;}Send(a,window);}
 public static string ReadLine(Stream stream){var bytes=new byte[32769];int count=0;DateTime end=DateTime.UtcNow.AddSeconds(3);while(count<bytes.Length){var t=stream.ReadAsync(bytes,count,1);int ms=(int)(end-DateTime.UtcNow).TotalMilliseconds;if(ms<=0||!t.Wait(ms)||t.Result!=1)throw new IOException("INVALID_QUERY");if(bytes[count++]==10)return new UTF8Encoding(false,true).GetString(bytes,0,count-1);}throw new IOException("INVALID_QUERY");}
}
'@
$script:observations=@{}
$script:desktopEpoch=0
$script:inputOwner='';$script:inputUntil=[DateTime]::MinValue
$pauseFile=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'GMSSHWindowsBridge\ai-paused'
function Short-AIText($text,[int]$length=256) { $s=[string]$text;if($s.Length -gt $length){$s=$s.Substring(0,$length)};return $s }
function Get-AIBounds($rectangle) {
    $bounds=@{x=[double]$rectangle.X;y=[double]$rectangle.Y;width=[double]$rectangle.Width;height=[double]$rectangle.Height}
    foreach($value in $bounds.Values){
        if([double]::IsNaN($value) -or [double]::IsInfinity($value)){return @{x=0;y=0;width=0;height=0}}
    }
    if($bounds.width -le 0 -or $bounds.height -le 0){return @{x=0;y=0;width=0;height=0}}
    return $bounds
}
function Get-AIWindow([string]$handle) {
    if($handle -notmatch '^[1-9][0-9]{0,18}$'){throw 'INVALID_QUERY'}
    if(-not [GMSSHAIDesktop]::IsWindow([IntPtr][long]$handle)){throw 'TARGET_NOT_FOUND'}
    $element=[Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$handle)
    if(-not $element -or [string]$element.Current.NativeWindowHandle -ne $handle){throw 'TARGET_NOT_FOUND'}
    return $element
}
function Get-AINode($element,[string]$id) {
    $c=$element.Current;$bounds=Get-AIBounds $c.BoundingRectangle
    $value=$null;$pattern=$null
    if(-not $c.IsPassword -and $element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){
        $value=Short-AIText $pattern.Current.Value 1024
    }
    if(-not $c.IsPassword -and $null -eq $value -and $element.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$pattern)){
        $value=Short-AIText ($pattern.DocumentRange.GetText(1024)) 1024
    }
    $node=@{id=$id;name=(Short-AIText $c.Name);automationId=(Short-AIText $c.AutomationId);
        controlType=$c.ControlType.ProgrammaticName.Replace('ControlType.','');className=(Short-AIText $c.ClassName);
        enabled=[bool]$c.IsEnabled;offscreen=([bool]$c.IsOffscreen -or $bounds.width -le 0 -or $bounds.height -le 0);password=[bool]$c.IsPassword;value=$value;
        bounds=$bounds}
    if($c.ControlType -eq [Windows.Automation.ControlType]::Window -and $c.NativeWindowHandle -gt 0){
        $node.window=[string]$c.NativeWindowHandle;$node.processId=$c.ProcessId
    }
    return $node
}
function Get-AIInputWindow($element,[long]$observedWindow) {
    $parent=$element
    for($depth=0;$parent -and $depth -lt 16;$depth++){
        $current=$parent.Current
        if($current.ControlType -eq [Windows.Automation.ControlType]::Window -and $current.NativeWindowHandle -gt 0){
            return [long]$current.NativeWindowHandle
        }
        # The taskbar and some UIA providers expose their native root as Pane.
        if($current.NativeWindowHandle -eq $observedWindow){return $observedWindow}
        $parent=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)
    }
    throw 'FOCUS_DENIED'
}
function Get-AIObservation($request,[string]$owner) {
    $now=[DateTime]::UtcNow
    foreach($id in @($script:observations.Keys)){if($script:observations[$id].expires -lt $now){$script:observations.Remove($id)}}
    if($script:observations.Count -ge 16){$script:observations.Clear()}
    $snapshot=[guid]::NewGuid().ToString('N');$targets=@{};$rows=New-Object Collections.Generic.List[object]
    if(-not $request.window){
        $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
        foreach($window in $windows){
            if($rows.Count -ge 100){break}
            try{$node=Get-AINode $window ([guid]::NewGuid().ToString('N'));$node.window=[string]$window.Current.NativeWindowHandle;$node.processId=$window.Current.ProcessId;$rows.Add($node)}catch{}
        }
        return @{windows=@($rows.ToArray());truncated=$windows.Count -gt 100;sampledAt=$now.ToString('o')}
    }
    $root=Get-AIWindow $request.window
    $queue=New-Object Collections.Generic.Queue[object];$queue.Enqueue(@{element=$root;depth=0})
    $walker=[Windows.Automation.TreeWalker]::ControlViewWalker;$scanned=0
    while($queue.Count -gt 0 -and $scanned -lt 250){
        $current=$queue.Dequeue();$element=$current.element;$scanned++
        try{
            $id=[guid]::NewGuid().ToString('N');$node=Get-AINode $element $id
            $matches=(!$request.name -or $node.name -eq $request.name) -and (!$request.controlType -or $node.controlType -eq $request.controlType) -and (!$request.automationId -or $node.automationId -eq $request.automationId)
            if($matches){
                $processStart=$null
                try{$processStart=(Get-Process -Id $element.Current.ProcessId).StartTime.ToUniversalTime().Ticks}catch{}
                $node.actionable=$null -ne $processStart
                $rows.Add($node)
                $targets[$id]=@{element=$element;runtime=($element.GetRuntimeId() -join ',');node=$node;processId=$element.Current.ProcessId;
                    processStart=$processStart}
            }
            if($current.depth -lt 5){
                $child=$walker.GetFirstChild($element)
                while($child -and $queue.Count -lt 500){$queue.Enqueue(@{element=$child;depth=$current.depth+1});$child=$walker.GetNextSibling($child)}
            }
        }catch{}
    }
    $script:observations[$snapshot]=@{owner=$owner;window=$request.window;expires=$now.AddSeconds(30);targets=$targets;epoch=[GMSSHAIDesktop]::SessionEpoch}
    return @{snapshot=$snapshot;window=$request.window;expiresInSeconds=30;nodes=@($rows.ToArray());truncated=$queue.Count -gt 0;sampledAt=$now.ToString('o')}
}
function Invoke-AIDesktop($request,[string]$owner) {
    $epoch=[GMSSHAIDesktop]::SessionEpoch
    if($script:desktopEpoch -ne $epoch){
        $script:observations.Clear();$script:inputOwner='';$script:inputUntil=[DateTime]::MinValue;$script:desktopEpoch=$epoch
    }
    if(-not [GMSSHAIDesktop]::Unlocked()){
        $script:observations.Clear();$script:inputOwner='';$script:inputUntil=[DateTime]::MinValue
        throw 'DESKTOP_LOCKED'
    }
    if($request.operation -eq 'context'){
        return @{schema=1;user=[Security.Principal.WindowsIdentity]::GetCurrent().Name;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;
            unlocked=$true;paused=(Test-Path -LiteralPath $pauseFile);foregroundWindow=[GMSSHAIDesktop]::GetForegroundWindow().ToInt64().ToString();sessionEpoch=$epoch;
            capabilities=@('observe','find','screenshot','focus','invoke','set-value','click','type-text','key')}
    }
    if($request.operation -in @('observe','find')){return Get-AIObservation $request $owner}
    if($request.operation -eq 'screenshot'){
        $screen=[Windows.Forms.SystemInformation]::VirtualScreen
        if($screen.Width -le 0 -or $screen.Height -le 0 -or [long]$screen.Width*$screen.Height -gt 80000000){throw 'QUERY_FAILED'}
        $capture=New-Object Drawing.Bitmap($screen.Width,$screen.Height)
        try{
            $graphics=[Drawing.Graphics]::FromImage($capture)
            try{$graphics.CopyFromScreen($screen.Location,[Drawing.Point]::Empty,$screen.Size)}finally{$graphics.Dispose()}
            $ratio=[Math]::Min(1.0,[Math]::Min(1600/$screen.Width,1000/$screen.Height))
            $small=New-Object Drawing.Bitmap($capture,[Drawing.Size]::new([Math]::Max(1,[int]($screen.Width*$ratio)),[Math]::Max(1,[int]($screen.Height*$ratio))))
            $stream=New-Object IO.MemoryStream
            try{
                $small.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
                if($stream.Length -gt 2500000){throw 'QUERY_FAILED'}
                return @{mimeType='image/png';data=[Convert]::ToBase64String($stream.ToArray());width=$small.Width;height=$small.Height;desktopBounds=@{x=$screen.X;y=$screen.Y;width=$screen.Width;height=$screen.Height}}
            }finally{$stream.Dispose();$small.Dispose()}
        }finally{$capture.Dispose()}
    }
    if($request.operation -notin @('focus','invoke','set-value','click','type-text','key')){throw 'INVALID_QUERY'}
    if(Test-Path -LiteralPath $pauseFile){throw 'AI_PAUSED'}
    $now=[DateTime]::UtcNow
    if($script:inputOwner -and $script:inputOwner -ne $owner -and $script:inputUntil -gt $now){throw 'DESKTOP_BUSY'}
    $observation=$script:observations[[string]$request.snapshot]
    if(-not $observation -or $observation.owner -ne $owner -or $observation.expires -lt $now -or $observation.epoch -ne [GMSSHAIDesktop]::SessionEpoch){throw 'STALE_TARGET'}
    $saved=$observation.targets[[string]$request.target]
    if(-not $saved -or $null -eq $saved.processStart){throw 'STALE_TARGET'}
    try{
        $element=$saved.element;$node=Get-AINode $element $request.target
        if(($element.GetRuntimeId() -join ',') -ne $saved.runtime -or $element.Current.ProcessId -ne $saved.processId -or
            (Get-Process -Id $saved.processId).StartTime.ToUniversalTime().Ticks -ne $saved.processStart -or
            $node.name -ne $saved.node.name -or $node.controlType -ne $saved.node.controlType -or $node.automationId -ne $saved.node.automationId){throw 'STALE_TARGET'}
    }catch{throw 'STALE_TARGET'}
    if($node.password){throw 'PASSWORD_FIELD'}
    if(-not $node.enabled){throw 'UNSUPPORTED_PATTERN'}
    $script:inputOwner=$owner;$script:inputUntil=$now.AddSeconds(5)
    if(Test-Path -LiteralPath $pauseFile){throw 'AI_PAUSED'}
    # Consume before dispatch: provider errors may occur after accepting input.
    $script:observations.Remove([string]$request.snapshot)
    if(-not [GMSSHAIDesktop]::Unlocked()){$script:observations.Clear();throw 'DESKTOP_LOCKED'}
    if($observation.epoch -ne [GMSSHAIDesktop]::SessionEpoch){throw 'STALE_TARGET'}
    $pattern=$null
    switch($request.operation){
        focus {
            # Only activate the observed native root; never click a taskbar proxy.
            $handle=[long]$element.Current.NativeWindowHandle
            if($handle -le 0 -or $handle -ne [long]$observation.window){throw 'INVALID_QUERY'}
            if(-not [GMSSHAIDesktop]::Focus($handle)){throw 'FOCUS_DENIED'}
        }
        invoke {
            if(-not $element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){throw 'UNSUPPORTED_PATTERN'}
            $pattern.Invoke()
        }
        set-value {
            if(-not $element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern) -or $pattern.Current.IsReadOnly){throw 'UNSUPPORTED_PATTERN'}
            $pattern.SetValue([string]$request.text)
        }
        default {
            if($node.offscreen -or $node.bounds.width -le 0 -or $node.bounds.height -le 0){throw 'STALE_TARGET'}
            foreach($property in @('x','y','width','height')){if([Math]::Abs($node.bounds[$property]-$saved.node.bounds[$property]) -gt 2){throw 'STALE_TARGET'}}
            $inputWindow=Get-AIInputWindow $element ([long]$observation.window)
            if(-not [GMSSHAIDesktop]::Focus($inputWindow)){throw 'FOCUS_DENIED'}
            if($request.operation -eq 'click'){
                [GMSSHAIDesktop]::Click([int]($node.bounds.x+$node.bounds.width/2),[int]($node.bounds.y+$node.bounds.height/2),$inputWindow)
            }else{
                $element.SetFocus()
                $focusDeadline=[DateTime]::UtcNow.AddMilliseconds(250)
                while(-not $element.Current.HasKeyboardFocus -and [DateTime]::UtcNow -lt $focusDeadline){Start-Sleep -Milliseconds 10}
                if(-not $element.Current.HasKeyboardFocus){throw 'FOCUS_DENIED'}
                if($request.operation -eq 'type-text'){[GMSSHAIDesktop]::Text([string]$request.text,$inputWindow)}else{
                    $keys=@{ENTER=13;TAB=9;ESC=27;BACKSPACE=8;DELETE=46;LEFT=37;UP=38;RIGHT=39;DOWN=40;HOME=36;END=35;PAGEUP=33;PAGEDOWN=34;F5=116}
                    $key=[string]$request.key;$modifier=0
                    if($key -match '^(CTRL|ALT)\+([A-Z0-9]|F4)$'){$modifier=if($Matches[1] -eq 'CTRL'){17}else{18};$code=if($Matches[2] -eq 'F4'){115}else{[int][char]$Matches[2]}}
                    elseif($keys.ContainsKey($key)){$code=$keys[$key]}else{throw 'INVALID_QUERY'}
                    [GMSSHAIDesktop]::Key([uint16]$code,[uint16]$modifier,$inputWindow)
                }
            }
        }
    }
    # Acknowledgement is not a success assertion. Observe/wait to verify effects.
    return @{acknowledged=$true;verificationRequired=$true;operation=$request.operation}
}
if(-not $Worker){return}
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
if($session -eq 0){throw 'NO_INTERACTIVE_SESSION'}
if($ParentProcessId -le 0 -or $ParentStartTicks -le 0){throw 'NO_TRAY_PARENT'}
[GMSSHAIDesktop]::StartSessionWatch()
[GMSSHAIDesktop]::GuardParent($ParentProcessId,$ParentStartTicks,$session)
$security=New-Object IO.Pipes.PipeSecurity
$security.SetAccessRuleProtection($true,$false)
foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
    $security.AddAccessRule([IO.Pipes.PipeAccessRule]::new($sid,[IO.Pipes.PipeAccessRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
}
$pipe=[GMSSHAIDesktop]::Pipe("GMSSH.AI.$session",$security.GetSecurityDescriptorBinaryForm())
try { while($true){
    try{
        $pipe.WaitForConnection();$reply=$null
        [GMSSHAIDesktop]::ArmWatchdog()
        try{
            $envelope=[GMSSHAIDesktop]::ReadLine($pipe) | ConvertFrom-Json
            if([string]$envelope.owner -notmatch '^[a-f0-9]{32}$' -or -not $envelope.request){throw 'INVALID_QUERY'}
            if(([string]$envelope.request.text).Length -gt 4096){throw 'INVALID_QUERY'}
            $reply=@{ok=$true;result=(Invoke-AIDesktop $envelope.request ([string]$envelope.owner))}
        }catch{
            $code=[string]$_.Exception.GetBaseException().Message
            if($code -notin @('DESKTOP_LOCKED','AI_PAUSED','STALE_TARGET','TARGET_NOT_FOUND','AMBIGUOUS_TARGET','UNSUPPORTED_PATTERN','FOCUS_DENIED','DESKTOP_OUTCOME_UNKNOWN','DESKTOP_BUSY','INVALID_QUERY','PASSWORD_FIELD')){$code='QUERY_FAILED'}
            $reply=@{ok=$false;code=$code}
        }
        $raw=[Text.UTF8Encoding]::new($false).GetBytes(($reply | ConvertTo-Json -Depth 10 -Compress)+"`n")
        $write=$pipe.WriteAsync($raw,0,$raw.Length);if(-not $write.Wait(3000)){throw 'WRITE_TIMEOUT'}
        $pipe.WaitForPipeDrain()
    }catch{}finally{
        [GMSSHAIDesktop]::StopWatchdog()
        if($pipe.IsConnected){$pipe.Disconnect()}
    }
}}finally{$pipe.Dispose()}
