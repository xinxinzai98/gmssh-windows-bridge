#requires -Version 5.1
# Real disposable files; every service, account, process and firewall query is a fixture.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../gmssh_windows_bridge/setup-checks.ps1')
. (Join-Path $PSScriptRoot '../gmssh_windows_bridge/setup-connect.ps1')
. (Join-Path $PSScriptRoot '../gmssh_windows_bridge/setup-network.ps1')
. (Join-Path $PSScriptRoot '../gmssh_windows_bridge/credential-dialog.ps1')
function Assert($value,[string]$message){if(-not $value){throw $message}}
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('gmssh-existing-'+[guid]::NewGuid().ToString('N'))
$script:sshBinary=Join-Path $fixture 'sshd.exe';$script:engine=Join-Path $fixture 'rustdesk.exe'
$script:config=Join-Path $fixture 'custom-sshd.conf';$key=Join-Path $fixture 'host_ed25519'
$dataRoot=Join-Path $fixture 'data';$root=Join-Path $fixture 'program'
$script:mutations=0;$script:connectStarts=0;$script:connectStops=0
$script:accountSid='S-1-5-21-1-2-3-1004';$script:signature='Valid';$script:conflict=$false;$script:administrator=$true
function Get-LocalUser{param($Name,$ErrorAction);[pscustomobject]@{Name='Existing User';Enabled=$true;SID=[pscustomobject]@{Value=$script:accountSid}}}
function Get-LocalGroup{param($SID,$ErrorAction);[pscustomobject]@{Name='Fixture administrators'}}
function Get-LocalGroupMember{param($Group,$ErrorAction);if($script:administrator){[pscustomobject]@{SID=[pscustomobject]@{Value=$script:accountSid}}}}
function Get-Service{param($Name,$ErrorAction);[pscustomobject]@{Status='Running';StartType='Automatic'}}
function Get-CimInstance{param($ClassName,$Filter,$ErrorAction);if($ClassName -eq 'Win32_Processor'){return [pscustomobject]@{Architecture=9}};[pscustomobject]@{PathName=$(if($Filter -eq "Name='sshd'"){'"'+$script:sshBinary+'" -f "'+$script:config+'"'}else{'"'+$script:engine+'" --service'})}}
function Get-AuthenticodeSignature{param($LiteralPath);[pscustomobject]@{Status=$script:signature}}
function Get-NetTCPConnection{param($State,$LocalPort,$ErrorAction);[pscustomobject]@{LocalPort=$LocalPort;OwningProcess=$(if($LocalPort -eq 2222){1000}else{1001})}}
function Get-Process{param($Id,$ErrorAction);[pscustomobject]@{Path=$(if($script:conflict){'foreign.exe'}elseif($Id -eq 1000){$script:sshBinary}else{$script:engine})}}
function Get-GMSSHExistingSSHOptions{param($Binary,$Config);Assert ($Binary -ceq $script:sshBinary -and $Config -ceq $script:config) 'Wrong existing SSH was inspected';$script:options}
function Get-NetFirewallProfile{param($PolicyStore);[pscustomobject]@{Enabled='True'}}
function Set-Service{$script:mutations++;throw 'Mutation forbidden'}
function Start-Service{$script:mutations++;throw 'Mutation forbidden'}
function Stop-Service{$script:mutations++;throw 'Mutation forbidden'}
function Set-LocalUser{$script:mutations++;throw 'Mutation forbidden'}
function Stop-GMSSHConnectTask{param($ProgramRoot,$DataRoot);$script:connectStops++}
function Register-GMSSHConnectTask{param($ProgramRoot,$DataRoot);$script:connectStarts++}
try {
    Assert (Test-GMSSHPasswordInput '123456' $false '' $true) 'Existing short credential was rejected'
    Assert (-not (Test-GMSSHPasswordInput '123456' $true '123456' $true)) 'New-password policy was weakened'
    Assert (-not (Test-GMSSHPasswordInput '' $false '' $true)) 'Blank existing credential was accepted'
    Assert (-not (Test-GMSSHPasswordInput "bad`nvalue" $false '' $true)) 'Control characters were accepted'
    New-Item -ItemType Directory -Path $fixture,$dataRoot,$root,(Join-Path $dataRoot 'private')|Out-Null
    foreach($path in @($script:sshBinary,$script:engine,$script:config,(Join-Path $root 'gmssh-connect.exe'),(Join-Path $dataRoot 'private/connect-meta.dat'))){'fixture'|Set-Content $path}
    $public='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA fixture'
    $public|Set-Content ($key+'.pub')
    $script:options=@('port 2222','passwordauthentication yes','subsystem sftp internal-sftp','allowtcpforwarding yes','permitopen any',('hostkey '+$key))
    $profile=Get-GMSSHExistingServices -WindowsUser 'Existing User'
    $space=Join-Path $fixture 'space dir';New-Item -ItemType Directory $space|Out-Null
    $literal=Join-Path $space 'sshd.exe';'fixture'|Set-Content $literal
    Assert ((Get-GMSSHExistingServicePath $literal 'sshd').binary -ceq $literal) 'Literal service path with spaces was not safely resolved'
    Assert ($profile.sshPort -eq 2222 -and $profile.accountSid -ceq $script:accountSid -and $profile.sshConfig -ceq $script:config -and $profile.sshHostPublicKey -ceq $public) 'Existing identity, custom port or config lost'
    $preflight=Join-Path $fixture 'preflight';New-Item -ItemType Directory -Path $preflight,(Join-Path $preflight 'installers')|Out-Null
    $manifest=@{rustdesk=@{sha256=('a'*64)}}
    foreach($name in @('openssh','vcredist')){
        $file=Join-Path $preflight ('installers/'+$name+'.exe');'fixture'|Set-Content $file
        $manifest[$name]=@{filename=$name+'.exe';sha256=(Get-FileHash $file).Hash.ToLowerInvariant()}
    }
    $manifest|ConvertTo-Json|Set-Content (Join-Path $preflight 'windows-installers.json') -Encoding UTF8
    'fixture'|Set-Content (Join-Path $preflight 'desktop-engine.zip')
    @{filename='desktop-engine.zip';sourceSha256=('a'*64);sha256=(Get-FileHash (Join-Path $preflight 'desktop-engine.zip')).Hash.ToLowerInvariant()}|ConvertTo-Json|Set-Content (Join-Path $preflight 'desktop-payload.json') -Encoding UTF8
    $oldOS=$env:OS
    try{
        $env:OS='Windows_NT'
        $plan=Get-GMSSHInstallPlan -SetupRoot $preflight -Dedicated $false -PreserveExisting $true -WindowsUser 'Existing User' -DataRoot (Join-Path $fixture 'new-data') -ProgramRoot (Join-Path $fixture 'new-program')
        Assert ($plan -ceq 'PreserveExisting') 'Preserved first-run plan was not selected'
    }finally{$env:OS=$oldOS}
    $before=(Get-FileHash $script:config).Hash
    foreach($test in @('administrator','signature','listener','password','forward')){
        $oldOptions=$script:options
        switch($test){administrator{$script:administrator=$false};signature{$script:signature='NotSigned'};listener{$script:conflict=$true};password{$script:options=@($script:options|Where-Object{$_ -ne 'passwordauthentication yes'})};forward{$script:options=@($script:options|Where-Object{$_ -ne 'permitopen any'})}}
        $blocked=$false;try{Get-GMSSHExistingServices -WindowsUser 'Existing User'|Out-Null}catch{$blocked=$true}
        Assert $blocked ('Unsupported existing service accepted: '+$test)
        $script:signature='Valid';$script:conflict=$false;$script:options=$oldOptions;$script:administrator=$true
    }
    $state=@{computer=[Environment]::MachineName;username='Existing User';installationMode='preserve-existing';accountSid=$script:accountSid;trayUserSid='S-1-5-21-1-2-3-1001';unifiedPassword=$false}
    $path=Join-Path $dataRoot 'agent.json';$state|ConvertTo-Json|Set-Content $path -Encoding UTF8
    Assert ((Get-GMSSHConnectState $dataRoot).username -ceq 'Existing User') 'Preserved account rejected'
    $script:accountSid='S-1-5-21-1-2-3-9999'
    $blocked=$false;try{Get-GMSSHConnectState $dataRoot|Out-Null}catch{$blocked=$true}
    Assert $blocked 'Replaced existing account accepted'
    $script:accountSid=$state.accountSid
    $preserved=$true;$withConnectionCode=$true
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../gmssh_windows_bridge/gmssh-agent.ps1'),[ref]$tokens,[ref]$errors)
    Assert (-not $errors.Count) 'Tray source did not parse'
    $actions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.SwitchStatementAst] -and $node.Extent.Text.Contains('Start-Service RustDesk')},$true))
    Assert ($actions.Count -eq 1) 'Tray action dispatcher not found'
    $dispatch=[scriptblock]::Create($actions[0].Extent.Text)
    foreach($Action in @('Start','Stop')){. $dispatch}
    Assert ($script:connectStarts -eq 1 -and $script:connectStops -eq 1) 'Owned connect task not controlled'
    foreach($Action in @('Password','SSHPassword','IPv6Access')){
        $blocked=$false
        try{if($Action -eq 'IPv6Access'){Get-GMSSHIPv6AccessRules $root $dataRoot|Out-Null}else{. $dispatch}}catch{$blocked=$true}
        Assert $blocked ('Preserved credentials or original IPv6 rules were modifiable: '+$Action)
    }
    # Execute the production updater with fixture-owned task operations and files.
    . (Join-Path $PSScriptRoot '../gmssh_windows_bridge/setup-maintenance.ps1')
    $package=Join-Path $fixture 'package';New-Item -ItemType Directory $package|Out-Null
    foreach($name in @('gmssh-agent.ps1','setup-desktop.ps1','credential-dialog.ps1','setup-checks.ps1','setup-maintenance.ps1')){
        ('new-'+$name)|Set-Content (Join-Path $package $name)
        ('old-'+$name)|Set-Content (Join-Path $root $name)
    }
    'function Get-GMSSHExistingServices { param($WindowsUser); $script:profile }'|Set-Content (Join-Path $package 'setup-existing.ps1')
    $script:profile=$profile
    $state.engine=$profile.engine;$state.version='old';$state|ConvertTo-Json|Set-Content $path -Encoding UTF8
    $connection=@{username=$profile.username;sshBinary=$profile.sshBinary;sshConfig=$profile.sshConfig;sshPort=$profile.sshPort;sshHostPublicKey=$profile.sshHostPublicKey}
    $connection|ConvertTo-Json|Set-Content (Join-Path $dataRoot 'connection.json') -Encoding UTF8
    function Get-GMSSHInstallPlan{param($SetupRoot,$Dedicated,$DataRoot,$ProgramRoot);'Existing'}
    function Get-GMSSHReadiness{param($DataRoot,$ProgramRoot);@{readyToPair=$true}}
    function Register-GMSSHTrayTask{param($ProgramRoot,$TrayUserSid,[switch]$ValidateOnly);if($ValidateOnly){return $null};$script:connectStarts++}
    $updated=Update-GMSSHInstallation -SetupRoot $package -ProgramRoot $root -DataRoot $dataRoot -Version '0.4.0a33'
    Assert ($updated.version -ceq '0.4.0a33' -and (Get-Content (Join-Path $root 'gmssh-agent.ps1') -Raw).Trim() -ceq 'new-gmssh-agent.ps1') 'Preserved updater did not replace its own files'
    Assert ($script:mutations -eq 0 -and (Get-FileHash $script:config).Hash -ceq $before) 'Original service, account or config changed'
    'PASS: preserved identity, custom port/config, signature/listener guards, SID binding, owned task pause, upgrade and original-service/password protection; fixtures only.'
}finally{if(Test-Path $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}}
