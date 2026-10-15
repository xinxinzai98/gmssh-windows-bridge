#requires -Version 5.1
# Only temporary files are real. All service and task operations are in-memory mocks.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\gmssh_windows_bridge\setup-maintenance.ps1')
function Assert($Value, [string]$Message) { if (-not $Value) { throw $Message } }
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('gmssh-maintenance-' + [Guid]::NewGuid().ToString('N'))
$script:program = Join-Path $fixture 'program'
$package = Join-Path $fixture 'package'
$data = Join-Path $fixture 'data'
$script:sid = 'S-1-5-21-1-2-3-1001'
$script:engine = Join-Path $script:program 'desktop-engine\rustdesk.exe'
$script:sshBinary = Join-Path $fixture 'sshd.exe'
$script:task = $null
$script:failRegistration = $false
$script:registrations = 0
$script:services = @{}
$script:stopPolls = 0
$script:connectTask = $null
$script:connectRule = $null
$resourceLock = $null
$script:realCopy = Get-Command 'Microsoft.PowerShell.Management\Copy-Item'
function Copy-Item {
    param([string]$LiteralPath,[string]$Destination,[switch]$Recurse,[switch]$Force)
    if ($Destination.StartsWith($script:program,[StringComparison]::OrdinalIgnoreCase)) {
        Assert ($script:stopPolls -eq 0) 'Program files were replaced before the tray stopped'
    }
    & $script:realCopy -LiteralPath $LiteralPath -Destination $Destination -Recurse:$Recurse -Force:$Force
}
function Get-GMSSHInstallPlan { param($SetupRoot,$Dedicated,$DataRoot,$ProgramRoot); 'Existing' }
function Get-GMSSHReadiness { param($DataRoot,$ProgramRoot); @{readyToPair=$true} }
function Get-AuthenticodeSignature { param($LiteralPath); [pscustomobject]@{Status='Valid'} }
function Get-CimInstance { param($ClassName,$Filter)
    [pscustomobject]@{PathName=$(if($Filter -eq "Name='sshd'"){$script:sshBinary}else{'"'+$script:engine+'" --service'})}
}
function Get-Service { param($Name); $script:services[$Name] }
function Set-Service { param($Name,$StartupType); $script:services[$Name].StartType=$StartupType }
function Start-Service { param($Name); $script:services[$Name].Status='Running' }
function Stop-Service { param($Name,$ErrorAction); $script:services[$Name].Status='Stopped' }
function Get-ScheduledTask { param($TaskName,$TaskPath,$ErrorAction)
    if ($TaskName -eq 'GMSSH Windows Connect') { return $script:connectTask }
    if ($script:stopPolls -gt 0) { $script:stopPolls--; [pscustomobject]@{State='Running'} }
    else { $script:task }
}
function Stop-ScheduledTask { param($TaskName,$TaskPath,$ErrorAction); if ($TaskName -eq 'GMSSH Windows Connect') { $script:connectTask.State='Ready';return }; $script:task.State='Ready'; $script:stopPolls=2 }
function Start-ScheduledTask { param($TaskName,$TaskPath); if ($TaskName -eq 'GMSSH Windows Connect') { $script:connectTask.State='Running';return }; $script:task.State='Running' }
function Export-ScheduledTask { param($TaskName,$TaskPath); '<Task>synthetic-owned-task</Task>' }
function New-ScheduledTaskAction { param($Execute,$Argument); [pscustomobject]@{Execute=$Execute;Arguments=$Argument} }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User); [pscustomobject]@{UserId=$User} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel); [pscustomobject]@{UserId=$UserId;LogonType=$LogonType} }
function New-ScheduledTaskSettingsSet {
    param($MultipleInstances,$ExecutionTimeLimit,[switch]$StartWhenAvailable,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries)
    [pscustomobject]@{}
}
function Register-ScheduledTask {
    param($TaskName,$TaskPath,$Action,$Trigger,$Principal,$Settings,$Description,[switch]$Force,$Xml)
    $script:registrations++
    if ($TaskName -eq 'GMSSH Windows Connect') { $script:connectTask=[pscustomobject]@{State='Ready';Owned=$true};return }
    if ($script:failRegistration -and -not $Xml) { $script:failRegistration=$false; throw 'Injected registration failure' }
    if ($Xml) { $script:task=New-FixtureTask; $script:task.State='Ready' }
    else { $script:task=[pscustomobject]@{State='Ready';Actions=@($Action);Principal=$Principal;Triggers=@($Trigger)} }
}
function Unregister-ScheduledTask { param($TaskName,$TaskPath,$Confirm,$ErrorAction); if ($TaskName -eq 'GMSSH Windows Connect') { $script:connectTask=$null } else { $script:task=$null } }
function Remove-NetFirewallRule { param($Name,$ErrorAction); $script:connectRule=$null }
function Disable-NetFirewallRule { param($Name); $script:connectRule.Enabled='False' }
function New-FixtureTask {
    [pscustomobject]@{State='Running';Actions=@([pscustomobject]@{
        Execute=(Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe');
        Arguments=('-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $script:program 'gmssh-agent.ps1')+'"')
    });Principal=[pscustomobject]@{UserId=$script:sid};Triggers=@()}
}
function Reset-Fixture {
    if (Test-Path $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
    foreach ($directory in @($script:program,$package,$data,(Join-Path $script:program 'desktop-engine'))) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    foreach ($name in @('gmssh-agent.ps1','setup-desktop.ps1','credential-dialog.ps1','setup-checks.ps1')) {
        ('old-'+$name) | Set-Content (Join-Path $script:program $name)
        ('new-'+$name) | Set-Content (Join-Path $package $name)
    }
    'new-maintenance' | Set-Content (Join-Path $package 'setup-maintenance.ps1')
    foreach ($name in @('brand','third-party-licenses')) {
        foreach ($root in @($script:program,$package)) { New-Item -ItemType Directory -Path (Join-Path $root $name) | Out-Null }
        'old-resource' | Set-Content (Join-Path $script:program ($name+'\resource.txt'))
        'new-resource' | Set-Content (Join-Path $package ($name+'\resource.txt'))
    }
    'synthetic-engine' | Set-Content $script:engine
    @{version='old-version';trayUserSid=$script:sid;engine=$script:engine;managedAccountSid=$script:sid;unifiedPassword=$true} |
        ConvertTo-Json | Set-Content (Join-Path $data 'agent.json') -Encoding UTF8
    @{sshBinary=$script:sshBinary;sshHostPublicKey='synthetic-public-identity'} |
        ConvertTo-Json | Set-Content (Join-Path $data 'connection.json') -Encoding UTF8
    $script:services=@{sshd=[pscustomobject]@{StartType='Manual';Status='Stopped'};RustDesk=[pscustomobject]@{StartType='Automatic';Status='Running'}}
    $script:task=New-FixtureTask
    $script:registrations=0
    $script:stopPolls=0
    $script:connectTask=$null;$script:connectRule=$null
}
function Add-ConnectFixture([bool]$Existing) {
    # Only the component operations are mocked; the updater and rollback are real.
    @'
function Get-GMSSHConnectHelper { param($ProgramRoot); Join-Path $ProgramRoot 'gmssh-connect.exe' }
function Get-GMSSHConnectTask { param($ProgramRoot,$DataRoot); if ($script:connectTask -and -not $script:connectTask.Owned) { throw 'Foreign connect task' }; $script:connectTask }
function Get-GMSSHConnectRule { param($ProgramRoot); $script:connectRule }
function Stop-GMSSHConnectTask { param($ProgramRoot,$DataRoot); if ($script:connectTask) { $script:connectTask.State='Ready' } }
function Register-GMSSHConnectTask { param($ProgramRoot,$DataRoot); $script:connectTask=[pscustomobject]@{State='Running';Owned=$true};$script:connectRule=[pscustomobject]@{Enabled='True'} }
'@ | Set-Content (Join-Path $package 'setup-connect.ps1') -Encoding UTF8
    foreach ($name in @('gmssh-connect.exe','connect-payload.json')) { ('new-'+$name) | Set-Content (Join-Path $package $name) }
    New-Item -ItemType Directory -Path (Join-Path $data 'private') | Out-Null
    'private-fixture-must-survive' | Set-Content (Join-Path $data 'private\connect-password.dat')
    if ($Existing) {
        foreach ($name in @('setup-connect.ps1','gmssh-connect.exe','connect-payload.json')) { ('old-'+$name) | Set-Content (Join-Path $script:program $name) }
        $script:connectTask=[pscustomobject]@{State='Running';Owned=$true};$script:connectRule=[pscustomobject]@{Enabled='False'}
    }
}
try {
    Reset-Fixture
    $resourceLock=[IO.File]::Open((Join-Path $script:program 'brand\resource.txt'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $identity=(Get-FileHash (Join-Path $data 'connection.json')).Hash
    $result=Update-GMSSHInstallation -SetupRoot $package -ProgramRoot $script:program -DataRoot $data -Version '0.4.0a9'
    Assert ($result.version -eq '0.4.0a9' -and $result.readiness.readyToPair) 'Successful update was not reported'
    Assert ((Get-Content (Join-Path $script:program 'gmssh-agent.ps1') -Raw).Trim() -eq 'new-gmssh-agent.ps1') 'Managed program was not replaced'
    Assert ((Get-Content (Join-Path $result.backup 'gmssh-agent.ps1') -Raw).Trim() -eq 'old-gmssh-agent.ps1') 'Original program backup missing'
    Assert ((Get-Content (Join-Path $script:program 'brand\resource.txt') -Raw).Trim() -eq 'old-resource') 'Locked, unchanged brand resource was touched'
    Assert (-not (Test-Path (Join-Path $result.backup 'brand'))) 'Unchanged resources were included in script replacement'
    Assert (-not (Test-Path (Join-Path $script:program 'brand\brand'))) 'Resource directory was incorrectly nested'
    Assert ((Get-FileHash (Join-Path $data 'connection.json')).Hash -ceq $identity) 'Public SSH identity changed'
    Assert ($script:services.sshd.StartType -eq 'Automatic' -and $script:services.sshd.Status -eq 'Running') 'SSH startup was not repaired'
    Assert ($script:task.State -eq 'Running' -and $script:task.Principal.UserId -ceq $script:sid) 'Original tray user was not retained'
    $resourceLock.Dispose();$resourceLock=$null

    Reset-Fixture
    $script:task.Actions[0].Arguments='foreign-script'
    $blocked=$false
    try { Update-GMSSHInstallation -SetupRoot $package -ProgramRoot $script:program -DataRoot $data -Version '0.4.0a9' | Out-Null } catch { $blocked=$true }
    Assert ($blocked -and $script:registrations -eq 0 -and -not (Test-Path (Join-Path $data 'backups'))) 'Foreign task was overwritten'

    Reset-Fixture
    $agentHash=(Get-FileHash (Join-Path $data 'agent.json')).Hash
    $script:failRegistration=$true
    $blocked=$false
    try { Update-GMSSHInstallation -SetupRoot $package -ProgramRoot $script:program -DataRoot $data -Version '0.4.0a9' | Out-Null } catch { $blocked=$true }
    Assert $blocked 'Injected failure reported success'
    Assert ((Get-FileHash (Join-Path $data 'agent.json')).Hash -ceq $agentHash) 'Agent state did not roll back'
    Assert ((Get-Content (Join-Path $script:program 'gmssh-agent.ps1') -Raw).Trim() -eq 'old-gmssh-agent.ps1') 'Managed file did not roll back'
    Assert ((Get-Content (Join-Path $script:program 'brand\resource.txt') -Raw).Trim() -eq 'old-resource') 'Resource did not roll back'
    Assert (-not (Test-Path (Join-Path $script:program 'setup-maintenance.ps1'))) 'New file was left after rollback'
    Assert ($script:services.sshd.StartType -eq 'Manual' -and $script:services.sshd.Status -eq 'Stopped') 'Service state did not roll back'
    Assert ($script:services.RustDesk.Status -eq 'Running' -and $script:task.State -eq 'Running') 'Original running desktop or tray did not recover'
    Reset-Fixture
    Add-ConnectFixture $false
    $privateHash=(Get-FileHash (Join-Path $data 'private\connect-password.dat')).Hash
    Update-GMSSHInstallation -SetupRoot $package -ProgramRoot $script:program -DataRoot $data -Version '0.4.0a10' | Out-Null
    Assert ($script:connectTask.State -eq 'Running' -and $script:connectRule.Enabled -eq 'True') 'New connection-code component was not registered'
    Assert ((Get-FileHash (Join-Path $data 'private\connect-password.dat')).Hash -ceq $privateHash) 'Upgrade changed private credentials'
    Reset-Fixture
    Add-ConnectFixture $true
    $script:failRegistration=$true
    $blocked=$false
    try { Update-GMSSHInstallation -SetupRoot $package -ProgramRoot $script:program -DataRoot $data -Version '0.4.0a10' | Out-Null } catch { $blocked=$true }
    Assert ($blocked -and $script:connectTask.State -eq 'Running' -and $script:connectRule.Enabled -eq 'False') 'Existing connect task and rule did not roll back'
    Assert ((Get-Content (Join-Path $script:program 'gmssh-connect.exe') -Raw).Trim() -ceq 'old-gmssh-connect.exe') 'Connect executable did not roll back'
    Reset-Fixture
    Add-ConnectFixture $false
    $script:failRegistration=$true
    try { Update-GMSSHInstallation -SetupRoot $package -ProgramRoot $script:program -DataRoot $data -Version '0.4.0a10' | Out-Null } catch { }
    Assert (-not $script:connectTask -and -not $script:connectRule -and -not (Test-Path (Join-Path $script:program 'gmssh-connect.exe'))) 'New connect task/rule or executable remained after rollback'
    Reset-Fixture
    Add-ConnectFixture $true
    $script:connectTask.Owned=$false
    $blocked=$false
    try { Update-GMSSHInstallation -SetupRoot $package -ProgramRoot $script:program -DataRoot $data -Version '0.4.0a10' | Out-Null } catch { $blocked=$true }
    Assert ($blocked -and -not (Test-Path (Join-Path $data 'backups'))) 'Foreign connect task was changed'
    'PASS: program update, locked resources retained, tray stop wait, unchanged identity, connect component add/update/rollback, foreign task guards; no real services or tasks changed.'
} finally {
    if ($resourceLock) { $resourceLock.Dispose() }
    if (Test-Path $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
