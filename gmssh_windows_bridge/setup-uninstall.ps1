#requires -Version 5.1
# Removal is scoped to this installation. Credentials and user files stay in place.
function Assert-GMSSHRemovalDirectory([string]$Path) {
    $item=Get-Item -LiteralPath $Path -ErrorAction Stop
    if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '安装或备份目录不是可信的普通目录。'}
}

function Get-GMSSHUninstallRegistry([string]$ProgramRoot) {
    $key='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\GMSSHWindowsBridge'
    if(Test-Path -LiteralPath $key){
        $value=Get-ItemProperty -LiteralPath $key
        if($value.InstallLocation -ine $ProgramRoot -or $value.DisplayName -cne 'GMSSH Windows'){throw '同名卸载入口属于其他安装，已停止操作。'}
        return $value
    }
}

function Register-GMSSHUninstaller([string]$ProgramRoot,[string]$Version,[switch]$ValidateOnly) {
    [void](Get-GMSSHUninstallRegistry $ProgramRoot)
    if($ValidateOnly){return}
    $entry=Join-Path $ProgramRoot 'uninstall-windows.ps1'
    if(-not(Test-Path -LiteralPath $entry -PathType Leaf)){throw '卸载程序缺失。'}
    $key='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\GMSSHWindowsBridge'
    $shell=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $command='"'+$shell+'" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$entry+'"'
    New-Item -Path $key -Force|Out-Null
    foreach($value in @{DisplayName='GMSSH Windows';DisplayVersion=$Version;Publisher='GMSSH Windows Bridge';InstallLocation=$ProgramRoot;DisplayIcon=(Join-Path $ProgramRoot 'brand\gmssh.ico');UninstallString=$command}.GetEnumerator()){
        New-ItemProperty -LiteralPath $key -Name $value.Key -Value $value.Value -PropertyType String -Force|Out-Null
    }
    foreach($name in @('NoModify','NoRepair')){New-ItemProperty -LiteralPath $key -Name $name -Value 1 -PropertyType DWord -Force|Out-Null}
}

function Remove-GMSSHUninstallRegistry([string]$ProgramRoot){
    if(Get-GMSSHUninstallRegistry $ProgramRoot){Remove-Item -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\GMSSHWindowsBridge' -Recurse -ErrorAction Stop}
}

function Remove-GMSSHOwnedEngineService($Engine){
    $current=Get-CimInstance Win32_Service -Filter "Name='RustDesk'" -ErrorAction Stop
    if($current.PathName -ine $Engine.path -or $current.DisplayName -cne 'GMSSH Windows Desktop Engine' -or
        $current.StartName -notin @('LocalSystem','NT AUTHORITY\SYSTEM')){throw '桌面服务身份变化，未停止其他程序。'}
    Stop-Service RustDesk -ErrorAction Stop
    & (Join-Path ([Environment]::SystemDirectory) 'sc.exe') delete RustDesk|Out-Null
    if($LASTEXITCODE -ne 0){throw 'GMSSH 自有桌面服务未移除。'}
}

function Get-GMSSHRemovalRules([string]$ProgramRoot,$Connection,[bool]$PreserveExisting=$false) {
    [void](Get-GMSSHConnectRule $ProgramRoot)
    $ping=@(Get-GMSSHPingRules)
    $names=@('GMSSH-Windows-Connect','GMSSH-Windows-Connect-IPv6')+@($ping|ForEach-Object{$_.name})
    if(-not $PreserveExisting){$names+=@('GMSSH-Windows-Monitor-SSH','GMSSH-Windows-SSH-IPv6')}
    foreach($name in $names){
        $rules=@(Get-NetFirewallRule -PolicyStore PersistentStore -Name $name -ErrorAction SilentlyContinue|Where-Object{$null -ne $_})
        if($rules.Count -gt 1){throw '同名防火墙规则不唯一。'}
        if(-not $rules.Count){continue}
        $rule=$rules[0];$port=$rule|Get-NetFirewallPortFilter;$address=$rule|Get-NetFirewallAddressFilter;$app=$rule|Get-NetFirewallApplicationFilter;$service=$rule|Get-NetFirewallServiceFilter
        if([string]$rule.Direction -cne 'Inbound' -or [string]$rule.Action -cne 'Allow'){throw ('同名规则的作用已变化，未执行卸载：'+$name)}
        if($name -eq 'GMSSH-Windows-Monitor-SSH'){
            if([string]$port.Protocol -notin @('TCP','6') -or [string]$port.LocalPort -cne '22' -or
                @($address.RemoteAddress).Count -ne 1 -or [string]$address.RemoteAddress -cne [string]$Connection.controller -or
                [string]$app.Program -cne 'Any' -or [string]$service.Service -cne 'Any' -or
                [string]$rule.DisplayName -cne 'GMSSH monitoring from the local network or approved controller' -or
                [string]$rule.Profile -cne 'Any' -or @($address.LocalAddress).Count -ne 1 -or [string]$address.LocalAddress -cne 'Any'){throw '同名 SSH 规则不是安装器创建的配置。'}
        }elseif($name.EndsWith('-IPv6') -and $name -notlike '*-Ping-*'){
            $program=if($name -ceq 'GMSSH-Windows-Connect-IPv6'){Join-Path $ProgramRoot 'gmssh-connect.exe'}else{[string]$Connection.sshBinary}
            $expectedPort=if($name -ceq 'GMSSH-Windows-Connect-IPv6'){'22257'}else{'22'}
            if($rule.Group -cne 'GMSSH Windows IPv6 Access' -or [string]$port.Protocol -notin @('TCP','6') -or
                [string]$port.LocalPort -cne $expectedPort -or [string]$app.Program -ine $program){throw '同名 IPv6 规则的归属已变化。'}
            [void](ConvertTo-GMSSHIPv6Sources @($address.RemoteAddress))
        }
        [pscustomobject]@{name=$name;displayName=[string]$rule.DisplayName;group=[string]$rule.Group;enabled=[string]$rule.Enabled;profile=[string]$rule.Profile;
            protocol=[string]$port.Protocol;localPort=@($port.LocalPort);remotePort=@($port.RemotePort);icmpType=@($port.IcmpType);
            localAddress=@($address.LocalAddress);remoteAddress=@($address.RemoteAddress);program=[string]$app.Program;service=[string]$service.Service}
    }
}

function Restore-GMSSHRemovalRules($Rules) {
    foreach($rule in $Rules){
        if(Get-NetFirewallRule -PolicyStore PersistentStore -Name $rule.name -ErrorAction SilentlyContinue){continue}
        $arguments=@{PolicyStore='PersistentStore';Name=$rule.name;DisplayName=$rule.displayName;Enabled=$rule.enabled;Direction='Inbound';Action='Allow';Profile=$rule.profile;Protocol=$rule.protocol;
            LocalAddress=$rule.localAddress;RemoteAddress=$rule.remoteAddress;Program=$rule.program;Service=$rule.service}
        if($rule.group){$arguments.Group=$rule.group}
        if($rule.protocol -in @('ICMPv4','ICMPv6','1','58')){$arguments.IcmpType=$rule.icmpType}
        else{$arguments.LocalPort=$rule.localPort;$arguments.RemotePort=$rule.remotePort}
        New-NetFirewallRule @arguments|Out-Null
    }
}

function Move-GMSSHProgramDirectory([string]$Source,[string]$Destination){
    # Directory.Move cannot silently turn a failed rename into a partial cross-volume copy.
    [IO.Directory]::Move($Source,$Destination)
}

function Get-GMSSHRemovalPlan([string]$ProgramRoot,[string]$DataRoot) {
    Assert-GMSSHRemovalDirectory $ProgramRoot;Assert-GMSSHRemovalDirectory $DataRoot
    if(Test-Path -LiteralPath (Join-Path $DataRoot 'uninstall.json')){throw '已有卸载记录，请先核对或执行重装恢复。'}
    $state=Get-Content -LiteralPath (Join-Path $DataRoot 'agent.json') -Raw|ConvertFrom-Json
    $connection=Get-Content -LiteralPath (Join-Path $DataRoot 'connection.json') -Raw|ConvertFrom-Json
    $account=Get-LocalUser -Name $state.username -ErrorAction Stop
    $sid=ConvertTo-GMSSHUserSid $account.SID
    $expectedSid=if($state.installationMode -ceq 'preserve-existing'){$state.accountSid}else{$state.managedAccountSid}
    if($state.computer -ine [Environment]::MachineName -or $connection.computer -ine $state.computer -or
        $state.username -cne $connection.username -or ($expectedSid -and $expectedSid -cne $sid)){throw '电脑或账号身份变化，未执行卸载。'}
    $managed=[bool]($state.username -ceq 'gmssh' -and $state.managedAccountSid -ceq $sid -and $state.installationMode -cne 'preserve-existing')
    $tray=Register-GMSSHTrayTask -ProgramRoot $ProgramRoot -TrayUserSid $state.trayUserSid -ValidateOnly
    if($tray -and (ConvertTo-GMSSHUserSid $tray.Principal.UserId) -cne $state.trayUserSid){throw '托盘任务用户不是原安装用户。'}
    $connect=Get-GMSSHConnectTask $ProgramRoot $DataRoot
    $tasks=@(foreach($pair in @(@('GMSSH Windows Tray',$tray),@('GMSSH Windows Connect',$connect))){if($pair[1]){
        [pscustomobject]@{name=$pair[0];running=([string]$pair[1].State -ceq 'Running');xml=(Export-ScheduledTask -TaskName $pair[0] -TaskPath '\')}
    }})
    $engine=$null
    if(([IO.Path]::GetFullPath([string]$state.engine)).StartsWith(([IO.Path]::GetFullPath($ProgramRoot).TrimEnd('\')+'\desktop-engine\'),[StringComparison]::OrdinalIgnoreCase)){
        $current=Get-CimInstance Win32_Service -Filter "Name='RustDesk'" -ErrorAction Stop
        if($state.installationMode -ceq 'preserve-existing' -or $current.PathName -ine ('"'+$state.engine+'" --service') -or
            $current.DisplayName -cne 'GMSSH Windows Desktop Engine' -or $current.StartName -notin @('LocalSystem','NT AUTHORITY\SYSTEM') -or
            (Get-AuthenticodeSignature -LiteralPath $state.engine).Status -ne 'Valid'){throw '桌面服务的归属不明确，未执行卸载。'}
        $engine=[pscustomobject]@{name='RustDesk';path=[string]$current.PathName;displayName=[string]$current.DisplayName;start=[string]$current.StartMode;running=([string]$current.State -ceq 'Running');description=[string]$current.Description}
    }
    $top=@('gmssh-agent.ps1','controller-panel.ps1','collector.ps1','login.ps1','system-info.ps1','readonly-tools.ps1','ai-context.ps1','ai-desktop.ps1','setup-desktop.ps1','credential-dialog.ps1','setup-checks.ps1','setup-existing.ps1','setup-network.ps1','setup-maintenance.ps1','setup-connect.ps1','gmssh-connect.exe','connect-payload.json','go-qrcode-LICENSE.txt','setup-uninstall.ps1','uninstall-windows.ps1','windows-installers.json','install-desktop-engine.ps1')
    $engineFiles=@();$engineManifest=Join-Path $ProgramRoot 'desktop-engine\engine-files.json'
    if(Test-Path -LiteralPath $engineManifest){$engineFiles=@((Get-Content $engineManifest -Raw|ConvertFrom-Json).files.PSObject.Properties.Name)+@('engine-files.json')}
    $files=@(foreach($file in @(Get-ChildItem -LiteralPath $ProgramRoot -Recurse -Force)){
        if($file.Attributes -band [IO.FileAttributes]::ReparsePoint){throw '程序目录包含重解析点，未执行卸载。'}
        if($file.PSIsContainer){continue}
        $relative=$file.FullName.Substring($ProgramRoot.TrimEnd('\').Length+1).Replace('\','/')
        $known=($relative -in $top) -or ($relative -in @('brand/gmssh.ico','brand/gmssh.icns','brand/gmssh.png')) -or
            ($relative -match '^third-party-licenses/[A-Za-z0-9_.-]+\.txt$') -or
            ($relative.StartsWith('desktop-engine/') -and $relative.Substring(15) -in $engineFiles)
        if(-not $known){throw ('程序目录内有未识别文件，已保留现场：'+$relative)}
        [pscustomobject]@{name=$relative;sha256=(Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant();bytes=$file.Length}
    })
    [void](Get-GMSSHUninstallRegistry $ProgramRoot)
    [pscustomobject]@{schema=1;computer=$state.computer;username=$state.username;accountSid=$sid;managedAccount=$managed;accountWasEnabled=[bool]$account.Enabled;
        programRoot=$ProgramRoot;dataRoot=$DataRoot;version=$state.version;files=$files;tasks=$tasks;rules=@(Get-GMSSHRemovalRules $ProgramRoot $connection ($state.installationMode -ceq 'preserve-existing'));engine=$engine;
        preserved=@('Windows SSH 服务与主机密钥','原有账号、密码和用户文件','连接配置、独立授权和加密凭据','原独立 RustDesk 服务（如果存在）')}
}

function Get-GMSSHUninstallRecord([string]$ProgramRoot,[string]$DataRoot) {
    Assert-GMSSHRemovalDirectory $DataRoot
    $marker=Get-Content -LiteralPath (Join-Path $DataRoot 'uninstall.json') -Raw|ConvertFrom-Json
    $base=[IO.Path]::GetFullPath((Join-Path $DataRoot 'backups')).TrimEnd('\')+'\'
    $backup=[IO.Path]::GetFullPath([string]$marker.backup)
    if($marker.schema -ne 1 -or $marker.state -cne 'uninstalled' -or $marker.computer -ine [Environment]::MachineName -or
        -not $backup.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($backup) -notmatch '^uninstall-[0-9TZ-]+-[a-f0-9]{8}$'){throw '卸载恢复记录无效。'}
    Assert-GMSSHRemovalDirectory (Join-Path $DataRoot 'backups');Assert-GMSSHRemovalDirectory $backup
    $receipt=Join-Path $backup 'receipt.json'
    if((Get-FileHash -LiteralPath $receipt).Hash.ToLowerInvariant() -cne $marker.receiptSha256){throw '卸载备份清单变化，已停止恢复。'}
    $record=Get-Content -LiteralPath $receipt -Raw|ConvertFrom-Json
    if($record.programRoot -ine $ProgramRoot -or $record.dataRoot -ine $DataRoot -or $record.computer -ine $marker.computer){throw '卸载备份属于其他安装。'}
    $account=Get-LocalUser -Name $record.username -ErrorAction Stop
    if((ConvertTo-GMSSHUserSid $account.SID) -cne $record.accountSid){throw '卸载后账号身份已变化，已停止恢复。'}
    [pscustomobject]@{backup=$backup;plan=$record}
}

function Restore-GMSSHRemovalState($Plan,[switch]$StartTasks) {
    if($Plan.engine -and -not(Get-Service RustDesk -ErrorAction SilentlyContinue)){
        $startup=if($Plan.engine.start -eq 'Auto'){'Automatic'}elseif($Plan.engine.start -eq 'Disabled'){'Disabled'}else{'Manual'}
        New-Service -Name RustDesk -DisplayName $Plan.engine.displayName -BinaryPathName $Plan.engine.path -StartupType $startup -Description $Plan.engine.description|Out-Null
    }
    if($Plan.engine -and $Plan.engine.running){Start-Service RustDesk}
    foreach($task in $Plan.tasks){Register-ScheduledTask -TaskName $task.name -TaskPath '\' -Xml $task.xml -Force|Out-Null}
    Restore-GMSSHRemovalRules $Plan.rules
    if($Plan.managedAccount -and $Plan.accountWasEnabled){Enable-LocalUser -SID ([Security.Principal.SecurityIdentifier]::new($Plan.accountSid))}
    if($StartTasks){foreach($task in $Plan.tasks){if($task.running){Start-ScheduledTask -TaskName $task.name -TaskPath '\'}}}
}

function Uninstall-GMSSHInstallation([string]$ProgramRoot,[string]$DataRoot) {
    $plan=Get-GMSSHRemovalPlan $ProgramRoot $DataRoot
    $backupRoot=Join-Path $DataRoot 'backups'
    if(Test-Path $backupRoot){Assert-GMSSHRemovalDirectory $backupRoot}else{New-Item -ItemType Directory -Path $backupRoot|Out-Null}
    $backup=Join-Path $backupRoot ('uninstall-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Path $backup|Out-Null
    $receipt=Join-Path $backup 'receipt.json';$plan|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $receipt -Encoding UTF8
    $removedRules=@();$removedTasks=@();$moved=$false;$engineRemoved=$false;$accountDisabled=$false
    try{
        Stop-GMSSHTrayTask;Stop-GMSSHConnectTask $ProgramRoot $DataRoot
        foreach($task in $plan.tasks){$removedTasks+=,$task;Unregister-ScheduledTask -TaskName $task.name -TaskPath '\' -Confirm:$false -ErrorAction Stop}
        foreach($rule in $plan.rules){$removedRules+=,$rule;Remove-NetFirewallRule -PolicyStore PersistentStore -Name $rule.name -ErrorAction Stop}
        if($plan.engine){
            $engineRemoved=$true
            Remove-GMSSHOwnedEngineService $plan.engine
        }
        if($plan.managedAccount -and $plan.accountWasEnabled){$accountDisabled=$true;Disable-LocalUser -SID ([Security.Principal.SecurityIdentifier]::new($plan.accountSid))}
        # Moving preserves recoverable originals; no user data or private credentials are deleted.
        Move-GMSSHProgramDirectory $ProgramRoot (Join-Path $backup 'program');$moved=$true
        Remove-GMSSHUninstallRegistry $ProgramRoot
        @{schema=1;state='uninstalled';computer=$plan.computer;backup=$backup;receiptSha256=(Get-FileHash $receipt).Hash.ToLowerInvariant()}|
            ConvertTo-Json|Set-Content -LiteralPath (Join-Path $DataRoot 'uninstall.json') -Encoding UTF8
        [pscustomobject]@{uninstalled=$true;backup=$backup;files=$plan.files.Count;preservedConfiguration=$true;accountDisabled=$accountDisabled}
    }catch{
        $failure=$_.Exception.Message
        try{
            if($moved){Move-GMSSHProgramDirectory (Join-Path $backup 'program') $ProgramRoot}
            $partial=[pscustomobject]@{engine=$(if($engineRemoved){$plan.engine}else{$null});tasks=$removedTasks;rules=$removedRules;managedAccount=$accountDisabled;accountWasEnabled=$plan.accountWasEnabled;accountSid=$plan.accountSid}
            Restore-GMSSHRemovalState $partial -StartTasks
            if($plan.engine -and $plan.engine.running -and -not $engineRemoved){Start-Service RustDesk}
            foreach($task in $plan.tasks){if($task.running){Start-ScheduledTask -TaskName $task.name -TaskPath '\'}}
            Register-GMSSHUninstaller $ProgramRoot $plan.version
            Remove-Item -LiteralPath (Join-Path $DataRoot 'uninstall.json') -ErrorAction SilentlyContinue
        }catch{throw ('卸载未完成：'+$failure+'；恢复也未完成：'+$_.Exception.Message+'。备份：'+$backup)}
        throw ('卸载未完成，已恢复原程序和接入：'+$failure+'。备份：'+$backup)
    }
}

function Restore-GMSSHInstallation([string]$SetupRoot,[string]$ProgramRoot,[string]$DataRoot,[string]$Version) {
    $record=Get-GMSSHUninstallRecord $ProgramRoot $DataRoot;$plan=$record.plan
    if(Test-Path -LiteralPath $ProgramRoot){throw '程序目录已被占用，未执行恢复。'}
    $saved=Join-Path $record.backup 'program';Assert-GMSSHRemovalDirectory $saved
    $contents=@(Get-ChildItem -LiteralPath $saved -Recurse -Force)
    if(@($contents|Where-Object{$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count -or
        @($contents|Where-Object{-not $_.PSIsContainer}).Count -ne @($plan.files).Count){throw '备份目录包含额外、缺失或链接文件，已停止恢复。'}
    foreach($file in $plan.files){
        $relative=[string]$file.name
        if($relative.Contains(':') -or $relative.Contains('\') -or $relative.StartsWith('/') -or $relative.Split('/') -contains '..'){throw '备份清单路径无效。'}
        $path=Join-Path $saved $relative
        if((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint -or (Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant() -cne $file.sha256){throw '备份程序变化，未执行恢复。'}
    }
    foreach($task in $plan.tasks){if(Get-ScheduledTask -TaskName $task.name -TaskPath '\' -ErrorAction SilentlyContinue){throw '重装前出现同名任务，已停止覆盖。'}}
    foreach($rule in $plan.rules){if(Get-NetFirewallRule -PolicyStore PersistentStore -Name $rule.name -ErrorAction SilentlyContinue){throw '重装前出现同名规则，已停止覆盖。'}}
    if($plan.engine -and (Get-Service RustDesk -ErrorAction SilentlyContinue)){throw '重装前出现其他桌面服务，已停止覆盖。'}
    $markerPath=Join-Path $DataRoot 'uninstall.json';$marker=Get-Content -LiteralPath $markerPath -Raw
    $stage=Join-Path (Split-Path $ProgramRoot) ('.gmssh-restore-'+[guid]::NewGuid().ToString('N'))
    $moved=$false;$restoring=$false
    try{
        # Backup stays intact; expose only a complete copied program directory.
        Copy-Item -LiteralPath $saved -Destination $stage -Recurse -ErrorAction Stop
        foreach($file in $plan.files){if((Get-FileHash (Join-Path $stage $file.name)).Hash.ToLowerInvariant() -cne $file.sha256){throw '恢复副本校验失败。'}}
        Move-GMSSHProgramDirectory $stage $ProgramRoot;$moved=$true;$restoring=$true
        Restore-GMSSHRemovalState $plan -StartTasks
        # The complete original is now back; the normal updater performs its own identity checks.
        Copy-Item -LiteralPath $markerPath -Destination (Join-Path $record.backup 'uninstall-marker.json') -Force
        Remove-Item -LiteralPath $markerPath -ErrorAction Stop
        $updated=Update-GMSSHInstallation -SetupRoot $SetupRoot -ProgramRoot $ProgramRoot -DataRoot $DataRoot -Version $Version
        Register-GMSSHUninstaller $ProgramRoot $Version
        $updated
    }catch{
        $failure=$_.Exception.Message
        try{
            if($restoring){
                Stop-GMSSHTrayTask;Stop-GMSSHConnectTask $ProgramRoot $DataRoot
                foreach($task in $plan.tasks){if(Get-ScheduledTask -TaskName $task.name -TaskPath '\' -ErrorAction SilentlyContinue){Unregister-ScheduledTask -TaskName $task.name -TaskPath '\' -Confirm:$false -ErrorAction Stop}}
                foreach($rule in $plan.rules){if(Get-NetFirewallRule -PolicyStore PersistentStore -Name $rule.name -ErrorAction SilentlyContinue){Remove-NetFirewallRule -PolicyStore PersistentStore -Name $rule.name -ErrorAction Stop}}
                if($plan.engine -and (Get-Service RustDesk -ErrorAction SilentlyContinue)){Remove-GMSSHOwnedEngineService $plan.engine}
                if($plan.managedAccount -and $plan.accountWasEnabled){Disable-LocalUser -SID ([Security.Principal.SecurityIdentifier]::new($plan.accountSid))}
                Remove-GMSSHUninstallRegistry $ProgramRoot
            }
            if($moved){Move-GMSSHProgramDirectory $ProgramRoot (Join-Path $record.backup ('reinstall-failed-'+[guid]::NewGuid().ToString('N')))}
            $marker|Set-Content -LiteralPath $markerPath -Encoding UTF8
        }catch{throw ('重装未完成：'+$failure+'；恢复卸载状态也未完成：'+$_.Exception.Message+'。备份：'+$record.backup)}
        throw ('重装未完成，已回到卸载状态，原配置与备份保留：'+$failure+'。备份：'+$record.backup)
    }finally{if(Test-Path -LiteralPath $stage){Remove-Item -LiteralPath $stage -Recurse -Force}}
}
