#requires -Version 5.1
# Only this user's temporary files and captured ACL objects are real.
# Scheduled tasks, firewall rules and account queries are in-memory fixtures.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\gmssh_windows_bridge\setup-checks.ps1')
. (Join-Path $PSScriptRoot '..\gmssh_windows_bridge\setup-connect.ps1')
function Assert($Value,[string]$Message) { if (-not $Value) { throw $Message } }
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('gmssh-connect-check-' + [Guid]::NewGuid().ToString('N'))
$program = Join-Path $fixture 'program'
$data = Join-Path $fixture 'data'
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:task = $null; $script:rule = $null; $script:changes = 0; $script:acls = @{}
$script:accountSid = 'S-1-5-21-1-2-3-1004'
function Get-LocalUser { param($Name,$ErrorAction); [pscustomobject]@{Enabled=$true;SID=[pscustomobject]@{Value=$script:accountSid}} }
function Set-Acl { param($LiteralPath,$AclObject); $script:acls[$LiteralPath]=$AclObject }
function Get-NetFirewallProfile { param($PolicyStore); [pscustomobject]@{Enabled='True'} }
function Get-NetFirewallRule { param($Name,$ErrorAction); $script:rule }
function Get-NetFirewallPortFilter { process { [pscustomobject]@{Protocol='TCP';LocalPort='22257'} } }
function Get-NetFirewallAddressFilter { process { [pscustomobject]@{RemoteAddress='LocalSubnet'} } }
function Get-NetFirewallApplicationFilter { process { [pscustomobject]@{Program=(Join-Path $program 'gmssh-connect.exe')} } }
function Get-ScheduledTask { param($TaskName,$TaskPath,$ErrorAction); $script:task }
function New-NetFirewallRule { param($Name,$DisplayName,$Enabled,$Direction,$Action,$Protocol,$LocalPort,$RemoteAddress,$Program,$Profile)
    $script:changes++; $script:rule=[pscustomobject]@{Direction=$Direction;Action=$Action;Enabled=$Enabled}
}
function Enable-NetFirewallRule { param($Name); $script:changes++;$script:rule.Enabled='True' }
function New-ScheduledTaskAction { param($Execute,$Argument); [pscustomobject]@{Execute=$Execute;Arguments=$Argument} }
function New-ScheduledTaskTrigger { param([switch]$AtStartup); [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel); [pscustomobject]@{UserId=$UserId;LogonType=$LogonType} }
function New-ScheduledTaskSettingsSet { param($MultipleInstances,$ExecutionTimeLimit,[switch]$StartWhenAvailable,$RestartCount,$RestartInterval,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries); [pscustomobject]@{} }
function Register-ScheduledTask { param($TaskName,$TaskPath,$Action,$Trigger,$Principal,$Settings,$Description,[switch]$Force)
    $script:changes++;$script:task=[pscustomobject]@{State='Ready';Actions=@($Action);Principal=$Principal}
}
function Start-ScheduledTask { param($TaskName,$TaskPath); $script:changes++;$script:task.State='Running' }
function Stop-ScheduledTask { param($TaskName,$TaskPath); $script:changes++;$script:task.State='Ready' }
function Expect-Blocked([scriptblock]$Action,[string]$Message) {
    $before=$script:changes;$blocked=$false
    try { & $Action | Out-Null } catch { $blocked=$true }
    Assert ($blocked -and $script:changes -eq $before) $Message
}
try {
    New-Item -ItemType Directory -Path $program,$data | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $program 'gmssh-connect.exe'),[byte[]](77,90,1,2,3))
    @{filename='gmssh-connect.exe';protocol=1;sha256=(Get-FileHash (Join-Path $program 'gmssh-connect.exe')).Hash.ToLowerInvariant()} |
        ConvertTo-Json | Set-Content (Join-Path $program 'connect-payload.json') -Encoding UTF8
    @{computer=[Environment]::MachineName;username='gmssh';managedAccountSid=$script:accountSid;trayUserSid=$owner;unifiedPassword=$true} |
        ConvertTo-Json | Set-Content (Join-Path $data 'agent.json') -Encoding UTF8
    Assert ((Get-GMSSHConnectState $data).username -ceq 'gmssh') 'Managed account was not checked'
    $script:accountSid='S-1-5-21-1-2-3-9999'
    Expect-Blocked { Get-GMSSHConnectState $data } 'Changed account identity accepted'
    $script:accountSid='S-1-5-21-1-2-3-1004'
    Register-GMSSHConnectTask -ProgramRoot $program -DataRoot $data -ValidateOnly | Out-Null
    Assert ($script:changes -eq 0) 'Validation changed system state'
    Register-GMSSHConnectTask -ProgramRoot $program -DataRoot $data
    Assert ($script:task.Principal.UserId -ceq 'S-1-5-18' -and $script:task.State -eq 'Running') 'Service-account task registration was incorrect'
    Stop-GMSSHConnectTask $program $data
    Assert ($script:task.State -eq 'Ready') 'Owned task did not stop'
    # Task Scheduler may report Ready before Windows releases the executable image.
    $file=(Join-Path $program 'gmssh-connect.exe').Replace("'","''")
    $lockSource="`$handle=[IO.File]::Open('$file',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('locked'); Start-Sleep -Milliseconds 1500; `$handle.Dispose()"
    $lockInfo=New-Object Diagnostics.ProcessStartInfo
    $lockInfo.FileName=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $lockInfo.Arguments='-NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($lockSource))
    $lockInfo.UseShellExecute=$false;$lockInfo.CreateNoWindow=$true;$lockInfo.RedirectStandardOutput=$true
    $holder=[Diagnostics.Process]::Start($lockInfo)
    try {
        Assert ($holder.StandardOutput.ReadLine() -ceq 'locked') 'Executable lock fixture did not start'
        Stop-GMSSHConnectTask $program $data
        $released=[IO.File]::Open((Join-Path $program 'gmssh-connect.exe'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        $released.Dispose()
    } finally {
        if (-not $holder.HasExited) { $holder.Kill();$holder.WaitForExit() }
        $holder.Dispose()
    }
    $script:task.Actions[0].Arguments='foreign-command'
    Expect-Blocked { Register-GMSSHConnectTask $program $data } 'Foreign task was overwritten'
    $script:task=$null;$script:rule.Action='Block'
    Expect-Blocked { Register-GMSSHConnectTask $program $data } 'Foreign firewall rule was overwritten'
    $script:rule=$null
    foreach ($name in @('connect-meta.dat','connect-password.dat','connect-identity.dat')) {
        New-Item -ItemType Directory -Path (Join-Path $data 'private') -Force | Out-Null
        'synthetic-encrypted-fixture' | Set-Content (Join-Path $data ('private\'+$name))
    }
    Set-GMSSHConnectPrivateAccess $data $owner
    foreach ($name in @('connect-meta.dat','connect-password.dat','connect-identity.dat')) {
        $acl=$script:acls[(Join-Path $data ('private\'+$name))]
        Assert $acl.AreAccessRulesProtected 'Private file inherits public permissions'
        $entries=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
        $allowed=@($entries | Where-Object { $_.IdentityReference.Value -eq $owner })
        if ($name -eq 'connect-meta.dat') { Assert ($allowed.Count -eq 1 -and ($allowed[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::Read) -eq [Security.AccessControl.FileSystemRights]::Read -and ($allowed[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -eq 0) 'Owner cannot read code metadata safely' }
        else { Assert ($allowed.Count -eq 0) 'Owner can read the password or TLS private key file' }
        Assert (@($entries | Where-Object { $_.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544',$owner) }).Count -eq 0) 'Unrelated principal can read private state'
    }
    $script:healthStatus = 'ready'
    function Invoke-GMSSHConnectHelper { param($ProgramRoot,$DataRoot,$Operation,$InputJson); Assert ($Operation -eq 'status') 'Health attempted a mutating helper operation'; $script:healthStatus }
    $before = $script:changes
    Assert (Get-GMSSHConnectHealth $program $data).ready 'Healthy connection service was not reported'
    $script:healthStatus = 'unavailable'
    Assert (-not (Get-GMSSHConnectHealth $program $data).ready) 'Unavailable connection service was reported ready'
    Assert ($script:changes -eq $before) 'Health checking changed system configuration'
    Add-Content (Join-Path $program 'gmssh-connect.exe') 'tampered'
    Expect-Blocked { Register-GMSSHConnectTask $program $data } 'Tampered helper was registered'
    function Get-GMSSHConnectionInfo { param($DataRoot); [pscustomobject]@{computer='LAB-PC';addresses=@('192.168.250.2')} }
    function Invoke-GMSSHConnectHelper { param($ProgramRoot,$DataRoot,$Operation,$InputJson); $script:export=$InputJson | ConvertFrom-Json; 'GMSSH-CONNECT1.synthetic' }
    $before=$script:changes
    Get-GMSSHConnectCode $program $data -Address '2001:0db8:0:0::42' | Out-Null
    Assert (@($script:export.addresses).Count -eq 1 -and $script:export.addresses[0] -ceq '2001:db8::42') 'Supplied IPv6 was not normalized for this export'
    Assert ($script:changes -eq $before) 'Address export changed system configuration'
    $blocked=$false
    try { Get-GMSSHConnectCode $program $data -Address 'invalid-address' | Out-Null } catch { $blocked=$true }
    Assert $blocked 'Invalid supplied address was accepted'
    'PASS: helper hash, account binding, owned task and LAN rule guards, private ACL construction; no accounts, tasks or firewall rules changed.'
} finally { if (Test-Path $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force } }
