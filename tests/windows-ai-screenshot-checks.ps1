#requires -Version 5.1
# Exercise production bounds, input and session guards with test doubles; no desktop access.
param([string]$SourcePath=(Join-Path $PSScriptRoot '../gmssh_windows_bridge/ai-desktop.ps1'))
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($SourcePath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'AI desktop source did not parse'}
$boundsFunctions=@($ast.FindAll({param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-AIBounds'
},$true))
if($boundsFunctions.Count -ne 1){throw 'Production bounds normalization not found'}
. ([scriptblock]::Create($boundsFunctions[0].Extent.Text))
foreach($invalid in @([double]::PositiveInfinity,[double]::NegativeInfinity,[double]::NaN)){
    foreach($field in @('X','Y','Width','Height')){
        $rectangle=@{X=-1920;Y=40;Width=1920;Height=1080};$rectangle[$field]=$invalid
        $bounds=Get-AIBounds ([pscustomobject]$rectangle)
        if(@($bounds.Values|Where-Object{$_ -ne 0}).Count){throw 'Non-finite UIA bounds were not made non-clickable'}
        if(($bounds|ConvertTo-Json -Compress) -match 'NaN|Infinity'){throw 'Non-finite value leaked to JSON'}
    }
}
$bounds=Get-AIBounds ([pscustomobject]@{X=-1920;Y=40;Width=1920;Height=1080})
if($bounds.x -ne -1920 -or $bounds.y -ne 40 -or $bounds.width -ne 1920 -or $bounds.height -ne 1080){throw 'Valid secondary-monitor coordinates changed'}
$bounds=Get-AIBounds ([pscustomobject]@{X=10;Y=20;Width=0;Height=100})
if($bounds.width -ne 0 -or $bounds.height -ne 0){throw 'Empty bounds were not made non-clickable'}
$source=[IO.File]::ReadAllText($SourcePath)
$textMethod=[regex]::Match($source,'(?s) public static void Text\(string text,long window\)\{.*?(?= public static void Key\()')
if(-not $textMethod.Success){throw 'Production Unicode input method not found'}
# Compile the production method with a Send recorder; never call native input APIs.
$fixture=@'
using System;
using System.Text;
public static class GMSSHTextInputCheck {
 struct KEY { public ushort vk,scan; public uint flags; }
 struct UNION { public KEY key; }
 struct INPUT { public uint type; public UNION data; }
 static StringBuilder captured;
 static void Send(INPUT[] input,long window){
  if(window!=123)throw new Exception("Input window was lost");
  foreach(var value in input){
   if(value.type!=1)throw new Exception("Unexpected mouse event");
   if((value.data.key.flags&2)!=0)continue;
   if((value.data.key.flags&4)!=0)captured.Append((char)value.data.key.scan);
   else if(value.data.key.vk==13)captured.Append('\n');
   else throw new Exception("Unexpected virtual key");
  }
 }
 public static string Capture(string text){captured=new StringBuilder();Text(text,123);return captured.ToString();}
'@
Add-Type -TypeDefinition ($fixture+$textMethod.Value+'}')
foreach($inputText in @("中文 Aa09`n下一行","CRLF`r`n中文","CR`r数字09",'',"双行`n`n结束")){
    $expected=$inputText.Replace("`r`n","`n").Replace("`r","`n")
    if([GMSSHTextInputCheck]::Capture($inputText) -cne $expected){throw 'Production key events lost Unicode or line breaks'}
}
$focusMethod=[regex]::Match($source,'(?s) public static bool Focus\(long h\)\{.*?(?= static void Send\()')
$sendMethod=[regex]::Match($source,'(?s) static void Send\(INPUT\[\] input,long window\)\{.*?(?= public static void Click\()')
if(-not $focusMethod.Success -or -not $sendMethod.Success){throw 'Production focus and dispatch guards not found'}
$focusFixture=@'
using System;
using System.Threading;
using System.Runtime.InteropServices;
public static class GMSSHFocusCheck {
 struct INPUT { public int type; public INPUT(int value){type=value;} }
 static string mode;
 static int reads,sent,activated;
 static bool Unlocked(){return mode!="locked";}
 static bool IsWindow(IntPtr window){return mode!="gone";}
 static IntPtr GetForegroundWindow(){reads++;return new IntPtr(mode=="wrong"||mode=="denied"||mode=="timeout"||(mode=="delayed"&&reads<4)?999:123);}
 static bool SetForegroundWindow(IntPtr window){activated++;return mode!="denied";}
 static uint SendInput(uint count,INPUT[] values,int size){sent++;return mode=="partial"?count-1:count;}
 static void Reset(string value){mode=value;reads=sent=activated=0;}
 static void Refused(string value,string code){Reset(value);try{Send(new INPUT[1],123);}catch(InvalidOperationException error){if(error.Message!=code)throw;if(value!="partial"&&sent!=0)throw new Exception("Input dispatched after guard refusal");return;}throw new Exception("Dispatch unexpectedly succeeded");}
 public static void Check(){
  Reset("delayed");if(!Focus(123)||reads<4||activated!=1)throw new Exception("Asynchronous activation was rejected");
  Reset("ready");if(!Focus(123)||activated!=0)throw new Exception("Existing foreground was needlessly reactivated");
  foreach(string value in new[]{"denied","locked","gone","timeout"}){Reset(value);if(Focus(123))throw new Exception("Focus restriction ignored: "+value);}
  Refused("wrong","FOCUS_DENIED");Refused("locked","DESKTOP_LOCKED");Refused("partial","DESKTOP_OUTCOME_UNKNOWN");
  Reset("ready");Send(new INPUT[1],123);if(sent!=1)throw new Exception("Confirmed foreground did not dispatch");
 }
'@
Add-Type -TypeDefinition ($focusFixture+$focusMethod.Value+$sendMethod.Value+'}')
[GMSSHFocusCheck]::Check()
$sessionMethod=[regex]::Match($source,'(?s) public static bool SessionUnlocked\(\)\{.*?(?= sealed class SessionWindow)')
if(-not $sessionMethod.Success){throw 'Production WTS lock-state method not found'}
$sessionFixture=@'
using System;
using System.Runtime.InteropServices;
public static class GMSSHSessionFlagCheck {
 static int sessionId=7,mode,freed;
 static bool WTSQuerySessionInformation(IntPtr server,int session,int info,out IntPtr buffer,out uint bytes){
  buffer=IntPtr.Zero;bytes=0;if(mode==7)return false;
  buffer=Marshal.AllocHGlobal(24);bytes=(uint)(mode==6?16:24);
  Marshal.WriteInt32(buffer,0,mode==5?2:1);Marshal.WriteInt32(buffer,8,mode==3?8:7);
  Marshal.WriteInt32(buffer,12,mode==4?4:0);Marshal.WriteInt32(buffer,16,mode==1?0:mode==2?-1:1);return true;
 }
 static void WTSFreeMemory(IntPtr buffer){freed++;Marshal.FreeHGlobal(buffer);}
 public static void Check(){for(mode=0;mode<8;mode++){if(SessionUnlocked()!=(mode==0))throw new Exception("WTS state accepted: "+mode);}if(freed!=7)throw new Exception("Session buffer leaked");}
'@
Add-Type -TypeDefinition ($sessionFixture+$sessionMethod.Value+'}')
[GMSSHSessionFlagCheck]::Check()
# Test the real ancestor selection, including owned dialogs and Pane roots.
Add-Type -TypeDefinition @'
namespace Windows.Automation {
 public static class ControlType {public static string Window="Window";}
 public sealed class TestCurrent {public string ControlType;public int NativeWindowHandle;public TestCurrent(string kind,int handle){ControlType=kind;NativeWindowHandle=handle;}}
 public sealed class TestElement {public TestCurrent Current;public TestElement Parent;public TestElement(string kind,int handle,TestElement parent){Current=new TestCurrent(kind,handle);Parent=parent;}}
 public sealed class TestWalker {public TestElement GetParent(TestElement element){return element.Parent;}}
 public static class TreeWalker {public static TestWalker ControlViewWalker=new TestWalker();}
}
'@
$inputFunctions=@($ast.FindAll({param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-AIInputWindow'
},$true))
if($inputFunctions.Count -ne 1){throw 'Production input-window selector not found'}
. ([scriptblock]::Create($inputFunctions[0].Extent.Text))
$owner=[Windows.Automation.TestElement]::new('Window',100,$null)
$dialog=[Windows.Automation.TestElement]::new('Window',200,$owner)
$edit=[Windows.Automation.TestElement]::new('Edit',0,$dialog)
if((Get-AIInputWindow $edit 100) -ne 200){throw 'Owned dialog used its disabled owner as input window'}
$pane=[Windows.Automation.TestElement]::new('Pane',300,$null)
$button=[Windows.Automation.TestElement]::new('Button',0,$pane)
if((Get-AIInputWindow $button 300) -ne 300){throw 'Native Pane root lost existing input support'}
$refused=$false
try{Get-AIInputWindow $button 999}catch{if($_.Exception.Message -cne 'FOCUS_DENIED'){throw};$refused=$true}
if(-not $refused){throw 'Unbound input window was accepted'}
# The real lock branch must discard snapshots before consulting any UI provider.
Add-Type -TypeDefinition 'public static class GMSSHAIDesktop { public static bool Allowed=false;public static long Epoch=0;public static long SessionEpoch{get{return Epoch;}}public static bool Unlocked(){return Allowed;} }'
$invokeFunctions=@($ast.FindAll({param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-AIDesktop'
},$true))
if($invokeFunctions.Count -ne 1){throw 'Production desktop entry not found'}
. ([scriptblock]::Create($invokeFunctions[0].Extent.Text))
$script:observations=@{old=@{}};$script:inputOwner='old';$script:inputUntil=[DateTime]::UtcNow.AddSeconds(5)
$locked=$false
try{Invoke-AIDesktop @{operation='context'} ('a'*32)}catch{if($_.Exception.Message -cne 'DESKTOP_LOCKED'){throw};$locked=$true}
if(-not $locked -or $script:observations.Count -ne 0 -or $script:inputOwner){throw 'Lock did not invalidate old targets and input owner'}
[GMSSHAIDesktop]::Allowed=$true;[GMSSHAIDesktop]::Epoch=2;$script:desktopEpoch=1
$script:observations=@{old=@{epoch=1}};$script:inputOwner='old'
try{Invoke-AIDesktop @{operation='invalid'} ('a'*32)}catch{if($_.Exception.Message -cne 'INVALID_QUERY'){throw}}
if($script:observations.Count -ne 0 -or $script:inputOwner -or $script:desktopEpoch -ne 2){throw 'Session epoch change did not invalidate snapshots without a locked request'}
$assignments=@($ast.FindAll({param($node)
    $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
    $node.Left.VariablePath.UserPath -ceq 'ratio'
},$true))
if($assignments.Count -ne 1){throw 'Production screenshot scaling expression not found'}
$scale=[scriptblock]::Create($assignments[0].Extent.Text)
foreach($size in @(@(2560,1440,1600,900),@(3840,1080,1600,450),@(1080,1920,562,1000),@(800,600,800,600))){
    $screen=[pscustomobject]@{Width=$size[0];Height=$size[1]}
    . $scale
    $width=[Math]::Max(1,[int]($screen.Width*$ratio))
    $height=[Math]::Max(1,[int]($screen.Height*$ratio))
    if($width -ne $size[2] -or $height -ne $size[3]){throw "Screenshot scaling failed for $($screen.Width)x$($screen.Height): $($width)x$($height)"}
}
$keyCalls=@($ast.FindAll({param($node)
    $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and
    $node.Member.Value -ceq 'Key' -and
    $node.Expression -is [Management.Automation.Language.TypeExpressionAst] -and
    $node.Expression.TypeName.FullName -ceq 'GMSSHAIDesktop'
},$true))
if($keyCalls.Count -ne 1 -or $keyCalls[0].Arguments.Count -ne 3){throw 'Production native-key arguments not found'}
$code=13;$modifier=17;$inputWindow=[long]123
$converted=@(foreach($argument in $keyCalls[0].Arguments){
    & ([scriptblock]::Create($argument.Extent.Text))
})
if($converted.Count -ne 3 -or $converted[0] -isnot [uint16] -or $converted[1] -isnot [uint16] -or
    $converted[0] -ne 13 -or $converted[1] -ne 17 -or $converted[2] -ne 123){throw 'Native key arguments lost their types or target window'}
'PASS: finite bounds, Unicode/newline events, bounded foreground activation, WTS/session epochs, dispatch/lock guards, screenshot scaling and native-key casts; no desktop accessed.'
