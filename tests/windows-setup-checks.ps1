param([switch]$ChecksLoaded, [string]$SetupSource)
$ErrorActionPreference = 'Stop'
if (-not $ChecksLoaded) { . (Join-Path $PSScriptRoot '..\gmssh_windows_bridge\setup-checks.ps1') }
if (-not $SetupSource) { $SetupSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\gmssh_windows_bridge\setup-windows.ps1'), [Text.Encoding]::UTF8) }
function Assert($Value, [string]$Message) { if (-not $Value) { throw $Message } }
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('gmssh-checks-' + [Guid]::NewGuid().ToString('N'))
$script:program = Join-Path $fixture 'program'
$data = Join-Path $fixture 'data'
$ssh = Join-Path $fixture 'ssh'
$package = Join-Path $fixture 'package'
$script:sid = 'S-1-5-21-1-2-3-1001'
$script:accountPresent = $true
$script:ports = @(22,21118)
$script:rulePresent = $true
$script:taskValid = $true
$script:taskUserValid = $true
$script:desktopPresent = $true
$script:mutations = 0
function Get-LocalUser { param($Name,$ErrorAction); if ($script:accountPresent) { [pscustomobject]@{Enabled=$true;SID=[pscustomobject]@{Value=$script:sid}} } }
function Get-LocalGroup { param($SID); [pscustomobject]@{Name='Administrators'} }
function Get-LocalGroupMember { param($Group); [pscustomobject]@{SID=[pscustomobject]@{Value=$script:sid}} }
function Get-Service { param($Name,$ErrorAction); if ($Name -eq 'sshd' -or $script:desktopPresent) { [pscustomobject]@{Status='Running';StartType='Automatic'} } }
function Get-CimInstance { param($ClassName); [pscustomobject]@{Architecture=9} }
function Get-NetTCPConnection { param($State,$LocalPort,$ErrorAction); foreach ($port in $script:ports) { [pscustomobject]@{LocalPort=$port} } }
function Get-NetIPAddress { param($AddressFamily); [pscustomobject]@{AddressState='Preferred';IPAddress='10.10.10.2'} }
function Get-NetFirewallRule { param($Name,$ErrorAction); if ($script:rulePresent) { [pscustomobject]@{Enabled='True';Direction='Inbound';Action='Allow'} } }
function Get-NetFirewallAddressFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); [pscustomobject]@{RemoteAddress='LocalSubnet'} }
function Get-NetFirewallPortFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); [pscustomobject]@{LocalPort=22;Protocol='TCP'} }
function Get-NetFirewallProfile { param($PolicyStore); [pscustomobject]@{Enabled='True'} }
function Get-AuthenticodeSignature { param($FilePath); [pscustomobject]@{Status='Valid'} }
function Get-ScheduledTask { param($TaskName,$TaskPath,$ErrorAction)
    [pscustomobject]@{State='Running';Principal=[pscustomobject]@{UserId=$(if($script:taskUserValid){$script:sid}else{'S-1-5-21-1-2-3-9999'});LogonType='Interactive'};Triggers=@([pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='MSFT_TaskLogonTrigger'};UserId=$script:sid;Enabled=$true});Actions=@([pscustomobject]@{Execute=(Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe');
        Arguments=if ($script:taskValid) { '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $script:program 'gmssh-agent.ps1') + '"' } else { 'wrong-script' }})}
}
function New-LocalUser { $script:mutations++; throw 'Mutation forbidden' }
function Set-Service { $script:mutations++; throw 'Mutation forbidden' }
function Start-Process { $script:mutations++; throw 'Mutation forbidden' }
try {
    foreach ($directory in @($script:program,$data,$ssh,(Join-Path $package 'installers'))) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $keys=Join-Path $fixture 'retained-keys';New-Item -ItemType Directory $keys|Out-Null
    'fixture-private'|Set-Content (Join-Path $keys 'ssh_host_ed25519_key')
    Assert (-not (Test-GMSSHHostKeyDirectory $keys)) 'Incomplete host-key pair was accepted'
    'fixture-public'|Set-Content (Join-Path $keys 'ssh_host_ed25519_key.pub')
    Assert (Test-GMSSHHostKeyDirectory $keys) 'Complete OS host-key pair was rejected'
    'foreign'|Set-Content (Join-Path $keys 'foreign.conf')
    Assert (-not (Test-GMSSHHostKeyDirectory $keys)) 'Foreign SSH state was accepted'
    $public = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA fixture'
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $fingerprint = 'SHA256:' + [Convert]::ToBase64String($hash.ComputeHash([Convert]::FromBase64String($public.Split(' ')[1]))).TrimEnd('=') } finally { $hash.Dispose() }
    $connection = @{computer=[Environment]::MachineName;username='gmssh';controller='LocalSubnet';addresses=@('10.10.10.1');sshStatus='old';sshStartup='old';sshHostPublicKey=$public;sshHostFingerprint=$fingerprint}
    $connection | ConvertTo-Json | Set-Content (Join-Path $data 'connection.json') -Encoding UTF8
    @{computer=[Environment]::MachineName;username='gmssh';managedAccountSid=$script:sid;accountRole='Administrator';trayUserSid=$script:sid;version='fixture-version'} | ConvertTo-Json | Set-Content (Join-Path $data 'agent.json') -Encoding UTF8
    'fixture' | Set-Content (Join-Path $script:program 'gmssh-agent.ps1')
    $public | Set-Content (Join-Path $ssh 'ssh_host_ed25519_key.pub')
    'Subsystem sftp sftp-server.exe' | Set-Content (Join-Path $ssh 'sshd_config')
    $healthy = Get-GMSSHReadiness -DataRoot $data -ProgramRoot $script:program -SSHRoot $ssh
    Assert $healthy.readyToPair 'Healthy fixture was rejected'
    $export = Get-GMSSHConnectionInfo -DataRoot $data
    Assert ($export.addresses[0] -eq '10.10.10.2' -and $export.sshStatus -eq 'Running' -and $export.sshHostPublicKey -ceq $public) 'Live connection export changed identity or kept stale address'
    Assert ($export.desktopAuth -eq 'manual') 'Legacy export claimed shared desktop authentication'
    $agentPath=Join-Path $data 'agent.json';$agent=Get-Content $agentPath -Raw|ConvertFrom-Json
    $agent|Add-Member -NotePropertyName unifiedPassword -NotePropertyValue $true -Force
    $agent|ConvertTo-Json|Set-Content $agentPath -Encoding UTF8
    Assert ((Get-GMSSHConnectionInfo -DataRoot $data).desktopAuth -eq 'shared-ssh') 'Managed shared authentication was not exported'
    $agent.unifiedPassword=$false;$agent|ConvertTo-Json|Set-Content $agentPath -Encoding UTF8
    $script:taskValid = $false
    Assert (-not (Get-GMSSHReadiness -DataRoot $data -ProgramRoot $script:program -SSHRoot $ssh).readyToPair) 'Wrong tray target was accepted'
    $script:taskValid = $true
    $script:taskUserValid=$false
    Assert (-not (Get-GMSSHReadiness -DataRoot $data -ProgramRoot $script:program -SSHRoot $ssh).readyToPair) 'Wrong tray principal was accepted'
    $script:taskUserValid=$true
    Assert ((Get-GMSSHStartupStatus -DataRoot $data).servicesReady) 'Healthy startup service snapshot was rejected'
    'Subsystem sftp other-server.exe' | Set-Content (Join-Path $ssh 'sshd_config')
    Assert (-not (Get-GMSSHReadiness -DataRoot $data -ProgramRoot $script:program -SSHRoot $ssh).readyToPair) 'Missing SFTP was accepted'
    Assert ((Get-GMSSHInstallPlan -SetupRoot $package -Dedicated $true -DataRoot $data -ProgramRoot $script:program -SSHRoot $ssh) -eq 'Existing') 'Existing installation was not preserved'
    $blocked = $false
    try { Get-GMSSHInstallPlan -SetupRoot $package -Dedicated $true -DataRoot (Join-Path $fixture 'new-data') -ProgramRoot (Join-Path $fixture 'new-program') -SSHRoot (Join-Path $fixture 'new-ssh') | Out-Null } catch { $blocked=$true }
    Assert $blocked 'Foreign gmssh account was accepted'
    $script:accountPresent=$false;$script:ports=@();$script:rulePresent=$false;$script:desktopPresent=$false
    function Get-Service { param($Name,$ErrorAction) }
    $manifest=@{rustdesk=@{sha256=('a'*64)}}
    foreach ($name in @('openssh','vcredist')) {
        $file=Join-Path $package ('installers\'+$name+'.exe');'fixture'|Set-Content $file
        $manifest[$name]=@{filename=$name+'.exe';sha256=(Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    $manifest|ConvertTo-Json|Set-Content (Join-Path $package 'windows-installers.json') -Encoding UTF8
    'fixture'|Set-Content (Join-Path $package 'desktop-engine.zip')
    @{filename='desktop-engine.zip';sourceSha256=('a'*64);sha256=(Get-FileHash (Join-Path $package 'desktop-engine.zip') -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json|Set-Content (Join-Path $package 'desktop-payload.json') -Encoding UTF8
    Assert ((Get-GMSSHInstallPlan -SetupRoot $package -Dedicated $true -DataRoot (Join-Path $fixture 'new-data') -ProgramRoot (Join-Path $fixture 'new-program') -SSHRoot (Join-Path $fixture 'new-ssh')) -eq 'New') 'Fresh verified payload was rejected'
    Remove-Item (Join-Path $package 'installers\vcredist.exe')
    $manifest.vcredist.filename='VC_redist.x64.exe';$manifest.vcredist.version='14.51.36247.0'
    $manifest.vcredist.url='https://download.visualstudio.microsoft.com/download/pr/fixture/VC_redist.x64.exe'
    $manifest|ConvertTo-Json|Set-Content (Join-Path $package 'windows-installers.json') -Encoding UTF8
    @{runtimeSource='microsoft'}|ConvertTo-Json|Set-Content (Join-Path $package 'setup-config.json') -Encoding UTF8
    Assert ((Get-GMSSHInstallPlan -SetupRoot $package -Dedicated $true -DataRoot (Join-Path $fixture 'new-data') -ProgramRoot (Join-Path $fixture 'new-program') -SSHRoot (Join-Path $fixture 'new-ssh')) -eq 'New') 'Official runtime download plan was rejected'
    $manifest.vcredist.url='https://example.invalid/runtime.exe'
    $manifest|ConvertTo-Json|Set-Content (Join-Path $package 'windows-installers.json') -Encoding UTF8
    $blocked=$false;try { Get-GMSSHInstallPlan -SetupRoot $package -Dedicated $true -DataRoot (Join-Path $fixture 'new-data') -ProgramRoot (Join-Path $fixture 'new-program') -SSHRoot (Join-Path $fixture 'new-ssh')|Out-Null } catch { $blocked=$true }
    Assert $blocked 'Unofficial runtime source was accepted'
    $manifest.vcredist.url='https://download.visualstudio.microsoft.com/download/pr/fixture/VC_redist.x64.exe'
    $manifest|ConvertTo-Json|Set-Content (Join-Path $package 'windows-installers.json') -Encoding UTF8
    'damaged'|Set-Content (Join-Path $package 'installers\openssh.exe')
    $blocked=$false;try { Get-GMSSHInstallPlan -SetupRoot $package -Dedicated $true -DataRoot (Join-Path $fixture 'new-data') -ProgramRoot (Join-Path $fixture 'new-program') -SSHRoot (Join-Path $fixture 'new-ssh')|Out-Null } catch { $blocked=$true }
    Assert $blocked 'Damaged offline payload was accepted'
    $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($SetupSource,[ref]$tokens,[ref]$errors)
    Assert (-not $errors.Count) 'Setup script parse failed'
    $parameters=[scriptblock]::Create($ast.ParamBlock.Extent.Text+"`n'accepted'")
    Assert ((& $parameters -WindowsUser '测试用户' -ExpectedComputer '测试电脑' -TrayUserSid $script:sid) -eq 'accepted') 'Unicode Windows identity was rejected'
    $blocked=$false;try { & $parameters -TrayUserSid 'S-1-5-21-1-2-3-1001 -TrayOnly'|Out-Null } catch { $blocked=$true }
    Assert $blocked 'Injected tray identity was accepted'
    Assert ($script:mutations -eq 0) 'Read-only checks changed the system'
    'PASS: preflight, existing install, offline corruption, official runtime source, readiness, Unicode parameters and no mutations.'
} finally { if (Test-Path $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force } }
