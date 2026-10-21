#requires -Version 5.1
# Production transactions with real temporary files; every system mutation is mocked.
param([string]$SourceRoot=(Join-Path $PSScriptRoot '../gmssh_windows_bridge'))
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding
if($env:OS -ne 'Windows_NT'){'SKIP: Windows native removal fixtures required.';return}
foreach($name in @('setup-checks.ps1','setup-connect.ps1','setup-network.ps1','setup-maintenance.ps1','setup-uninstall.ps1')){. (Join-Path $SourceRoot $name)}
$registerUninstaller=${function:Register-GMSSHUninstaller}
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('gmssh-uninstall-'+[guid]::NewGuid().ToString('N'))
$script:program=Join-Path $fixture 'program';$script:data=Join-Path $fixture 'data';$package=Join-Path $fixture 'package'
$script:sid='S-1-5-21-1-2-3-1004';$script:traySid='S-1-5-21-1-2-3-1001';$script:username='Existing User'
$script:failMove=$false;$script:failRegistry=$false;$script:failUpdate=$false;$script:accountEnabled=$true;$script:ownEngine=$false;$script:enginePresent=$false
$script:changes=0;$script:registryPresent=$true;$script:tasks=@{};$script:rules=@{}
function Assert($Value,[string]$Message){if(-not $Value){throw $Message}}
function ConvertTo-GMSSHUserSid($User){if($User -is [string]){return $User};return [string]$User.Value}
function Get-LocalUser{param($Name,$ErrorAction);[pscustomobject]@{Name=$script:username;Enabled=$script:accountEnabled;SID=[pscustomobject]@{Value=$script:sid}}}
function Disable-LocalUser{param($SID);Assert ($script:username -ceq 'gmssh' -and $SID.Value -ceq $script:sid) 'External account was disabled';$script:changes++;$script:accountEnabled=$false}
function Enable-LocalUser{param($SID);Assert ($script:username -ceq 'gmssh' -and $SID.Value -ceq $script:sid) 'External account was enabled';$script:changes++;$script:accountEnabled=$true}
function Get-GMSSHUninstallRegistry{param($ProgramRoot);if($script:registryPresent){[pscustomobject]@{InstallLocation=$ProgramRoot;DisplayName='GMSSH Windows'}}}
function Register-GMSSHUninstaller{param($ProgramRoot,$Version,[switch]$ValidateOnly);if(-not $ValidateOnly){$script:changes++;$script:registryPresent=$true}}
function Remove-GMSSHUninstallRegistry{param($ProgramRoot);$script:changes++;if($script:failRegistry){$script:failRegistry=$false;throw 'Injected registry failure'};$script:registryPresent=$false}
function Get-ScheduledTask{param($TaskName,$TaskPath,$ErrorAction);$script:tasks[$TaskName]}
function Register-GMSSHTrayTask{param($ProgramRoot,$TrayUserSid,[switch]$ValidateOnly);Assert $ValidateOnly 'Unexpected production tray registration';$script:tasks['GMSSH Windows Tray']}
function Get-GMSSHConnectTask{param($ProgramRoot,$DataRoot);$script:tasks['GMSSH Windows Connect']}
function Export-ScheduledTask{param($TaskName,$TaskPath);'<Task>'+ $TaskName+'</Task>'}
function Register-ScheduledTask{param($TaskName,$TaskPath,$Xml,[switch]$Force);Assert ($TaskName -in @('GMSSH Windows Tray','GMSSH Windows Connect')) 'Foreign task';$script:changes++;$script:tasks[$TaskName]=[pscustomobject]@{State='Ready';Principal=[pscustomobject]@{UserId=$script:traySid}}}
function Start-ScheduledTask{param($TaskName,$TaskPath);$script:changes++;$script:tasks[$TaskName].State='Running'}
function Unregister-ScheduledTask{param($TaskName,$TaskPath,$Confirm,$ErrorAction);Assert ($TaskName -in @('GMSSH Windows Tray','GMSSH Windows Connect')) 'Foreign task removal';$script:changes++;[void]$script:tasks.Remove($TaskName)}
function Stop-GMSSHTrayTask{$script:changes++;if($script:tasks['GMSSH Windows Tray']){$script:tasks['GMSSH Windows Tray'].State='Ready'}}
function Stop-GMSSHConnectTask{param($ProgramRoot,$DataRoot);$script:changes++;if($script:tasks['GMSSH Windows Connect']){$script:tasks['GMSSH Windows Connect'].State='Ready'}}
function Get-NetFirewallRule{param($PolicyStore,$Name,$ErrorAction);$script:rules[$Name]}
function Get-NetFirewallPortFilter{param([Parameter(ValueFromPipeline=$true)]$Rule);process{[pscustomobject]@{Protocol='TCP';LocalPort='22257';RemotePort='Any';IcmpType='Any'}}}
function Get-NetFirewallAddressFilter{param([Parameter(ValueFromPipeline=$true)]$Rule);process{[pscustomobject]@{LocalAddress=@('Any');RemoteAddress=@('LocalSubnet')}}}
function Get-NetFirewallApplicationFilter{param([Parameter(ValueFromPipeline=$true)]$Rule);process{[pscustomobject]@{Program=$Rule.Program}}}
function Get-NetFirewallServiceFilter{param([Parameter(ValueFromPipeline=$true)]$Rule);process{[pscustomobject]@{Service='Any'}}}
function New-NetFirewallRule{param($PolicyStore,$Name,$DisplayName,$Enabled,$Direction,$Action,$Profile,$Protocol,$LocalAddress,$RemoteAddress,$Program,$Service,$Group,$LocalPort,$RemotePort,$IcmpType)
    Assert ($Name -ceq 'GMSSH-Windows-Connect') 'Foreign firewall creation';$script:changes++;$script:rules[$Name]=[pscustomobject]@{Name=$Name;DisplayName=$DisplayName;Group=$Group;Enabled=$Enabled;Direction=$Direction;Action=$Action;Profile=$Profile;Program=$Program}
}
function Remove-NetFirewallRule{param($PolicyStore,$Name,$ErrorAction);Assert ($Name -ceq 'GMSSH-Windows-Connect') 'Foreign firewall removal';$script:changes++;[void]$script:rules.Remove($Name)}
function Get-CimInstance{param($ClassName,$Filter,$ErrorAction);Assert ($script:ownEngine -and $Filter -ceq "Name='RustDesk'") 'External service queried for mutation';[pscustomobject]@{PathName=('"'+(Join-Path $script:program 'desktop-engine/rustdesk.exe')+'" --service');DisplayName='GMSSH Windows Desktop Engine';StartName='LocalSystem';StartMode='Auto';State='Running';Description='Synthetic own engine'}}
function Get-AuthenticodeSignature{param($LiteralPath);[pscustomobject]@{Status='Valid'}}
function Get-Service{param($Name,$ErrorAction);Assert ($Name -ceq 'RustDesk' -and $script:ownEngine) 'External service queried for mutation';if($script:enginePresent){[pscustomobject]@{Status='Running'}}}
function Start-Service{param($Name);Assert ($script:ownEngine -and $Name -ceq 'RustDesk') 'External service start';$script:changes++}
function New-Service{param($Name,$DisplayName,$BinaryPathName,$StartupType,$Description);Assert ($script:ownEngine -and $Name -ceq 'RustDesk' -and $BinaryPathName.Contains($script:program)) 'External service creation';$script:changes++;$script:enginePresent=$true}
function Remove-GMSSHOwnedEngineService{param($Engine);Assert ($script:ownEngine -and $Engine.path.Contains($script:program)) 'External service removal';$script:changes++;$script:enginePresent=$false}
function Move-GMSSHProgramDirectory{param($Source,$Destination);if($script:failMove){$script:failMove=$false;throw 'Injected directory busy'};[IO.Directory]::Move($Source,$Destination)}
function Update-GMSSHInstallation{param($SetupRoot,$ProgramRoot,$DataRoot,$Version);if($script:failUpdate){throw 'Injected upgrade failure'}
    $state=Get-Content (Join-Path $DataRoot 'agent.json') -Raw|ConvertFrom-Json;$state.version=$Version;$state|ConvertTo-Json|Set-Content (Join-Path $DataRoot 'agent.json') -Encoding UTF8
    'updated program'|Set-Content (Join-Path $ProgramRoot 'gmssh-agent.ps1');[pscustomobject]@{version=$Version;readiness=@{readyToPair=$true}}
}
function Reset-Fixture([switch]$Managed,[switch]$OwnedEngine){
    if(Test-Path $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}
    foreach($path in @($script:program,$script:data,$package,(Join-Path $script:data 'private'))){New-Item -ItemType Directory -Path $path -Force|Out-Null}
    $script:ownEngine=[bool]$OwnedEngine;$script:enginePresent=[bool]$OwnedEngine;$script:username=if($Managed){'gmssh'}else{'Existing User'}
    $script:changes=0;$script:accountEnabled=$true;$script:registryPresent=$true;$script:failMove=$false;$script:failRegistry=$false;$script:failUpdate=$false
    foreach($name in @('gmssh-agent.ps1','setup-uninstall.ps1','uninstall-windows.ps1')){'original program'|Set-Content (Join-Path $script:program $name)}
    $engine=Join-Path $fixture 'original-rustdesk.exe'
    if($OwnedEngine){
        $directory=Join-Path $script:program 'desktop-engine';New-Item -ItemType Directory $directory|Out-Null;$engine=Join-Path $directory 'rustdesk.exe';'synthetic signed engine'|Set-Content $engine
        @{files=@{'rustdesk.exe'=(Get-FileHash $engine).Hash.ToLowerInvariant()}}|ConvertTo-Json|Set-Content (Join-Path $directory 'engine-files.json')
    }
    @{schema=1;computer=[Environment]::MachineName;username=$script:username;accountSid=$script:sid;managedAccountSid=$(if($Managed){$script:sid}else{$null});trayUserSid=$script:traySid;installationMode=$(if($Managed){'managed'}else{'preserve-existing'});engine=$engine;version='0.4.0a34'}|ConvertTo-Json|Set-Content (Join-Path $script:data 'agent.json') -Encoding UTF8
    @{computer=[Environment]::MachineName;username=$script:username;controller='LocalSubnet';sshBinary='C:\synthetic\sshd.exe'}|ConvertTo-Json|Set-Content (Join-Path $script:data 'connection.json') -Encoding UTF8
    'synthetic encrypted credential'|Set-Content (Join-Path $script:data 'private/connect-password.dat')
    'synthetic independent grants'|Set-Content (Join-Path $script:data 'private/controllers.dat')
    $script:privateBefore=(Get-FileHash (Join-Path $script:data 'private/connect-password.dat')).Hash
    $script:tasks=@{};foreach($name in @('GMSSH Windows Tray','GMSSH Windows Connect')){$script:tasks[$name]=[pscustomobject]@{State='Running';Principal=[pscustomobject]@{UserId=$script:traySid}}}
    $script:rules=@{'External-SSH'=[pscustomobject]@{Name='External-SSH'};'GMSSH-Windows-Connect'=[pscustomobject]@{Name='GMSSH-Windows-Connect';DisplayName='Synthetic own rule';Group='';Enabled='True';Direction='Inbound';Action='Allow';Profile='Any';Program=(Join-Path $script:program 'gmssh-connect.exe')}}
}
function Assert-Private{Assert ((Get-FileHash (Join-Path $script:data 'private/connect-password.dat')).Hash -ceq $script:privateBefore) 'Private credential changed';Assert ($script:rules.ContainsKey('External-SSH')) 'External firewall changed'}
function Expect-Blocked($Action,[string]$Message){$blocked=$false;try{&$Action|Out-Null}catch{$blocked=$true};Assert $blocked $Message}
try{
    $script:uninstallValues=@{}
    function New-Item{param($Path,[switch]$Force)}
    function New-ItemProperty{param($LiteralPath,$Name,$Value,$PropertyType,[switch]$Force);$script:uninstallValues[$Name]=$Value}
    try{
        & $registerUninstaller -ProgramRoot $SourceRoot -Version '0.4.0a35'
        Assert ($script:uninstallValues.UninstallString -match ' -STA -WindowStyle Hidden ' -and
            $script:uninstallValues.UninstallString.EndsWith(' -File "'+(Join-Path $SourceRoot 'uninstall-windows.ps1')+'"')) 'Uninstall UI did not hide the host or preserve its quoted entry path'
        Assert (-not $script:uninstallValues.ContainsKey('QuietUninstallString')) 'Uninstaller bypassed its normal confirmation'
    }finally{Remove-Item Function:\New-Item;Remove-Item Function:\New-ItemProperty}
    Reset-Fixture
    $plan=Get-GMSSHRemovalPlan $script:program $script:data
    Assert ($plan.files.Count -eq 3 -and $plan.tasks.Count -eq 2 -and $plan.rules.Count -eq 1 -and -not $plan.managedAccount -and -not $plan.engine) 'Preview did not scope the original installation'
    Assert ($script:changes -eq 0) 'Preview mutated system state'
    'keep user data'|Set-Content (Join-Path $script:program 'notes.txt')
    Expect-Blocked {Get-GMSSHRemovalPlan $script:program $script:data} 'Unknown user file was removed'
    Remove-Item (Join-Path $script:program 'notes.txt')
    $script:tasks['GMSSH Windows Tray'].Principal.UserId='S-1-5-21-1-2-3-9999'
    Expect-Blocked {Get-GMSSHRemovalPlan $script:program $script:data} 'Foreign task accepted'
    Assert ($script:changes -eq 0) 'A rejected plan mutated state'
    Reset-Fixture;$script:rules['GMSSH-Windows-Connect'].Program='C:\foreign.exe'
    Expect-Blocked {Get-GMSSHRemovalPlan $script:program $script:data} 'Foreign firewall rule accepted'
    Reset-Fixture;$script:sid='S-1-5-21-1-2-3-9999'
    Expect-Blocked {Get-GMSSHRemovalPlan $script:program $script:data} 'Changed account accepted'
    $script:sid='S-1-5-21-1-2-3-1004'
    foreach($failure in @('move','registry')){
        Reset-Fixture;if($failure -ceq 'move'){$script:failMove=$true}else{$script:failRegistry=$true}
        Expect-Blocked {Uninstall-GMSSHInstallation $script:program $script:data} 'Injected uninstall failure was not reported'
        Assert ((Test-Path $script:program) -and -not(Test-Path (Join-Path $script:data 'uninstall.json')) -and $script:tasks.Count -eq 2 -and $script:rules.Count -eq 2 -and $script:registryPresent -and $script:accountEnabled) 'Uninstall did not restore the original installation'
        Assert-Private
    }
    Reset-Fixture
    $removed=Uninstall-GMSSHInstallation $script:program $script:data
    Assert ($removed.uninstalled -and -not(Test-Path $script:program) -and (Test-Path (Join-Path $removed.backup 'program/gmssh-agent.ps1')) -and $script:tasks.Count -eq 0 -and $script:rules.Count -eq 1 -and -not $script:registryPresent -and $script:accountEnabled) 'Uninstall result is wrong'
    Assert-Private
    $installed=Restore-GMSSHInstallation $package $script:program $script:data '0.4.0a35'
    Assert ($installed.version -ceq '0.4.0a35' -and (Test-Path $script:program) -and -not(Test-Path (Join-Path $script:data 'uninstall.json')) -and $script:tasks.Count -eq 2 -and $script:rules.Count -eq 2 -and $script:registryPresent) 'Preserved reinstall failed'
    Assert-Private
    Reset-Fixture;$removed=Uninstall-GMSSHInstallation $script:program $script:data
    'changed backup'|Set-Content (Join-Path $removed.backup 'program/gmssh-agent.ps1')
    Expect-Blocked {Restore-GMSSHInstallation $package $script:program $script:data '0.4.0a35'} 'Altered backup accepted'
    Assert (-not(Test-Path $script:program) -and $script:tasks.Count -eq 0) 'Rejected backup started tasks'
    Reset-Fixture;$removed=Uninstall-GMSSHInstallation $script:program $script:data;$script:failUpdate=$true
    Expect-Blocked {Restore-GMSSHInstallation $package $script:program $script:data '0.4.0a35'} 'Upgrade failure was hidden'
    Assert (-not(Test-Path $script:program) -and (Test-Path (Join-Path $script:data 'uninstall.json')) -and $script:tasks.Count -eq 0 -and $script:rules.Count -eq 1 -and -not $script:registryPresent) 'Failed reinstall did not return to the uninstalled state'
    Assert-Private
    Reset-Fixture -Managed -OwnedEngine
    $removed=Uninstall-GMSSHInstallation $script:program $script:data
    Assert ($removed.accountDisabled -and -not $script:accountEnabled -and -not $script:enginePresent) 'Owned account/engine were left active'
    $installed=Restore-GMSSHInstallation $package $script:program $script:data '0.4.0a35'
    Assert ($script:accountEnabled -and $script:enginePresent) 'Owned account/engine did not recover'
    Assert-Private
    'PASS: scoped preview; foreign files/tasks/rules/SID rejection; uninstall move/registry rollback; preserved credentials/services; reinstall and tampered-backup guards; failed reinstall rollback; owned account and engine restoration. All system operations mocked.'
}finally{if(Test-Path -LiteralPath $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}}
