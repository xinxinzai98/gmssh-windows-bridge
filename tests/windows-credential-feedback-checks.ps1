# No dialogs, credentials, services, tasks or firewall changes: all UI and IO are synthetic.
param([string]$ProgramRoot=(Join-Path $PSScriptRoot '..\gmssh_windows_bridge'))
$ErrorActionPreference='Stop'
. ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path $ProgramRoot 'setup-connect.ps1'),[Text.Encoding]::UTF8)))
$originalSetter=${function:Set-GMSSHConnectPassword}
function Assert($Value,[string]$Message){if(-not $Value){throw $Message}}
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('gmssh-feedback-check-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture|Out-Null
$mock=@'
function Read-GMSSHPassword {
    $script:reads++
    if($script:mode -eq 'cancel' -and $script:reads -eq 2){throw [OperationCanceledException]::new('synthetic cancellation')}
    $secret=ConvertTo-SecureString 'synthetic-existing-password' -AsPlainText -Force
    $script:secrets+=$secret
    return $secret
}
function Show-GMSSHCredentialProgress {
    $script:progress=[pscustomobject]@{Text='pending';UseWaitCursor=$true;closed=$false;disposed=$false}
    $script:progress|Add-Member ScriptMethod Close {$this.closed=$true}
    $script:progress|Add-Member ScriptMethod Dispose {$this.disposed=$true}
    return $script:progress
}
function Show-GMSSHNotice {
    param($Title,$Message,$Icon,$Owner)
    $script:notices+=@{title=$Title;message=$Message;icon=$Icon;owner=$Owner}
}
'@
[IO.File]::WriteAllText((Join-Path $fixture 'credential-dialog.ps1'),$mock,[Text.UTF8Encoding]::new($true))
function Get-GMSSHConnectState{[pscustomobject]@{installationMode='preserve-existing';username='Synthetic User';trayUserSid='S-1-5-21-1000'}}
function Set-GMSSHConnectPassword{
    $script:saves++
    if($script:mode -eq 'rejected'){throw 'synthetic desktop credential rejected'}
}
function Get-GMSSHConnectHealth{[pscustomobject]@{ready=($script:mode -ne 'service')}}
try {
    foreach($case in @('success','rejected','service','cancel')){
        $script:mode=$case;$script:reads=0;$script:saves=0;$script:progress=$null;$script:notices=@();$script:secrets=@();$caught=$null
        try{Enable-GMSSHExistingCredentials $fixture $fixture}catch{$caught=$_.Exception}
        if($case -eq 'success'){
            Assert ($null -eq $caught -and $script:notices.Count -eq 1) 'Successful save has no explicit confirmation'
            Assert ($script:notices[0].title -match '已更新' -and $script:notices[0].icon -eq 'Information') 'Successful result is unclear'
        } else {
            Assert ($null -ne $caught -and $script:notices.Count -eq 0) 'Failed or cancelled action falsely announced success'
            if($case -eq 'service'){Assert ($caught.Message -match '凭据已经保存' -and $caught.Message -match '无需重新输入密码') 'Saved-but-not-ready result was lost'}
            if($case -eq 'cancel'){Assert ($caught -is [OperationCanceledException] -and $script:saves -eq 0 -and $null -eq $script:progress) 'Cancellation was treated as a credential update'}
        }
        if($script:progress){Assert ($script:progress.closed -and $script:progress.disposed) 'Progress window survived the operation'}
        foreach($secret in $script:secrets){$disposed=$false;try{$copy=$secret.Copy();$copy.Dispose()}catch [ObjectDisposedException]{$disposed=$true};Assert $disposed 'A completed dialog retained its SecureString'}
    }
    # Exercise the actual setter's post-save service failure separately.
    function Register-GMSSHConnectTask{param($ProgramRoot,$DataRoot,[switch]$ValidateOnly);if(-not $ValidateOnly){throw 'synthetic restart failure'}}
    function Stop-GMSSHConnectTask{}
    function Set-GMSSHConnectPrivateAccess{}
    function Invoke-GMSSHConnectHelper{$script:helperCalls++;return 'ok'}
    $script:helperCalls=0;$secret=ConvertTo-SecureString 'synthetic-existing-password' -AsPlainText -Force;$caught=$null
    try{& $originalSetter $fixture $fixture $secret $secret}catch{$caught=$_.Exception}finally{$secret.Dispose()}
    Assert ($caught -and $caught.Message -match '凭据已经保存' -and $script:helperCalls -eq 1) 'Service failure hid a successful save or repeated initialization'
    Write-Output 'PASS: credential success, rejection, saved-but-not-ready and cancellation are distinct; no system changes'
} finally {Remove-Item -LiteralPath $fixture -Recurse -Force}
