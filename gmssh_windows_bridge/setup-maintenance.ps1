#requires -Version 5.1
# Update only an installation whose device, account and service identities were checked.
function Register-GMSSHTrayTask {
    param([string]$ProgramRoot, [ValidatePattern('^S-1-[0-9]+(?:-[0-9]+){1,15}$')][string]$TrayUserSid, [switch]$ValidateOnly)
    $powerShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $ProgramRoot 'gmssh-agent.ps1') + '"'
    $current = Get-ScheduledTask -TaskName 'GMSSH Windows Tray' -TaskPath '\' -ErrorAction SilentlyContinue
    if ($current -and (@($current.Actions).Count -ne 1 -or $current.Actions[0].Execute -ine $powerShell -or $current.Actions[0].Arguments -cne $arguments)) {
        throw '同名托盘任务指向其他程序，已停止更新。'
    }
    if ($ValidateOnly) { return $current }
    $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $TrayUserSid
    $principal = New-ScheduledTaskPrincipal -UserId $TrayUserSid -LogonType Interactive -RunLevel Limited
    $options = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName 'GMSSH Windows Tray' -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $options -Description 'GMSSH Windows local management panel' -Force | Out-Null
    Start-ScheduledTask -TaskName 'GMSSH Windows Tray' -TaskPath '\'
}

function Stop-GMSSHTrayTask {
    $current = Get-ScheduledTask -TaskName 'GMSSH Windows Tray' -TaskPath '\' -ErrorAction SilentlyContinue
    if (-not $current -or $current.State -ne 'Running') { return }
    Stop-ScheduledTask -TaskName 'GMSSH Windows Tray' -TaskPath '\'
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ((Get-ScheduledTask -TaskName 'GMSSH Windows Tray' -TaskPath '\').State -eq 'Running') {
        if ([DateTime]::UtcNow -ge $deadline) { throw '原托盘进程尚未退出，已停止替换程序文件。' }
        Start-Sleep -Milliseconds 100
    }
}

function Update-GMSSHInstallation {
    param([string]$SetupRoot, [string]$ProgramRoot, [string]$DataRoot,
          [ValidatePattern('^[0-9A-Za-z.+-]{1,32}$')][string]$Version)
    if ((Get-GMSSHInstallPlan -SetupRoot $SetupRoot -Dedicated $false -DataRoot $DataRoot -ProgramRoot $ProgramRoot) -ne 'Existing') { throw '没有可更新的受管理安装。' }
    $statePath = Join-Path $DataRoot 'agent.json'
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    $connection = Get-Content (Join-Path $DataRoot 'connection.json') -Raw | ConvertFrom-Json
    if ($state.trayUserSid -notmatch '^S-1-[0-9]+(?:-[0-9]+){1,15}$') { throw '缺少原托盘用户身份，请先检查现有安装。' }
    foreach ($folder in @($ProgramRoot,$DataRoot)) {
        if ((Get-Item -LiteralPath $folder).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '安装目录包含重解析点，已停止更新。' }
    }
    # Keep the existing engine, branding and licenses, including locked images.
    $items = @('gmssh-agent.ps1','setup-desktop.ps1','credential-dialog.ps1','setup-checks.ps1','setup-maintenance.ps1')
    if (Test-Path -LiteralPath (Join-Path $SetupRoot 'go-qrcode-LICENSE.txt')) { $items += 'go-qrcode-LICENSE.txt' }
    $withConnect = Test-Path -LiteralPath (Join-Path $SetupRoot 'setup-connect.ps1')
    $connectTask = $null; $connectRule = $null
    if ($withConnect) {
        . (Join-Path $SetupRoot 'setup-connect.ps1')
        [void](Get-GMSSHConnectHelper $SetupRoot)
        $connectTask = Get-GMSSHConnectTask $ProgramRoot $DataRoot
        $connectRule = Get-GMSSHConnectRule $ProgramRoot
        $items += @('setup-connect.ps1','gmssh-connect.exe','connect-payload.json')
    }
    $connectWasRunning = [bool]($connectTask -and $connectTask.State -eq 'Running')
    $connectRuleWasEnabled = [bool]($connectRule -and [string]$connectRule.Enabled -eq 'True')
    foreach ($name in $items) {
        $source = Join-Path $SetupRoot $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw ('更新包不完整：'+$name) }
        if (@(@(Get-Item -LiteralPath $source)+@(Get-ChildItem -LiteralPath $source -Recurse -Force) | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw '更新包包含重解析点。' }
        $target = Join-Path $ProgramRoot $name
        if (Test-Path -LiteralPath $target) {
            if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw ('程序文件类型不符：'+$name) }
            if (@(@(Get-Item -LiteralPath $target)+@(Get-ChildItem -LiteralPath $target -Recurse -Force) | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw '程序文件包含重解析点，已停止更新。' }
        }
    }
    $task = Register-GMSSHTrayTask -ProgramRoot $ProgramRoot -TrayUserSid $state.trayUserSid -ValidateOnly
    $taskWasRunning = [bool]($task -and $task.State -eq 'Running')
    $ssh = Get-CimInstance Win32_Service -Filter "Name='sshd'"
    $desktop = Get-CimInstance Win32_Service -Filter "Name='RustDesk'"
    if (-not $ssh -or [Environment]::ExpandEnvironmentVariables($ssh.PathName).Trim().Trim('"') -ine $connection.sshBinary -or
        -not $desktop -or $desktop.PathName -ine ('"'+$state.engine+'" --service') -or
        (Get-AuthenticodeSignature -LiteralPath $state.engine).Status -ne 'Valid') { throw '现有服务与安装记录不一致，已停止更新。' }
    $backupRoot = Join-Path $DataRoot 'backups'
    if ((Test-Path $backupRoot) -and ((Get-Item $backupRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '备份目录不可信。' }
    $backup = Join-Path $backupRoot ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $existing = @($items | Where-Object { Test-Path -LiteralPath (Join-Path $ProgramRoot $_) })
    foreach ($name in $existing) { Copy-Item -LiteralPath (Join-Path $ProgramRoot $name) -Destination (Join-Path $backup $name) -Recurse -Force }
    Copy-Item -LiteralPath $statePath -Destination (Join-Path $backup 'agent.json')
    if ($task) { Export-ScheduledTask -TaskName 'GMSSH Windows Tray' -TaskPath '\' | Set-Content (Join-Path $backup 'tray.xml') -Encoding Unicode }
    if ($connectTask) { Export-ScheduledTask -TaskName 'GMSSH Windows Connect' -TaskPath '\' | Set-Content (Join-Path $backup 'connect.xml') -Encoding Unicode }
    $serviceNames = @('sshd')
    if ([IO.Path]::GetFullPath($state.engine).StartsWith(([IO.Path]::GetFullPath($ProgramRoot).TrimEnd('\')+'\desktop-engine\'),[StringComparison]::OrdinalIgnoreCase)) { $serviceNames += 'RustDesk' }
    $services = @(foreach ($name in $serviceNames) { $value=Get-Service $name; [pscustomobject]@{name=$name;start=[string]$value.StartType;running=($value.Status -eq 'Running')} })
    $taskChanged = $false
    $connectChanged = $false
    $phase = 'StopTray'
    try {
        if ($taskWasRunning) { Stop-GMSSHTrayTask }
        if ($withConnect) { $phase='StopConnect'; Stop-GMSSHConnectTask $ProgramRoot $DataRoot }
        foreach ($name in $items) { $phase='Copy:'+ $name; Copy-Item -LiteralPath (Join-Path $SetupRoot $name) -Destination (Join-Path $ProgramRoot $name) -Force }
        $phase = 'Services'
        foreach ($value in $services) {
            if ($value.start -ne 'Automatic') { Set-Service $value.name -StartupType Automatic }
            if (-not $value.running) { Start-Service $value.name }
        }
        $phase = 'Version'
        $state | Add-Member -NotePropertyName version -NotePropertyValue $Version -Force
        $temporary = $statePath+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
        try { $state | ConvertTo-Json -Depth 6 | Set-Content $temporary -Encoding UTF8; Move-Item -LiteralPath $temporary -Destination $statePath -Force }
        finally { if (Test-Path $temporary) { Remove-Item -LiteralPath $temporary -Force } }
        if ($withConnect -and $state.unifiedPassword) {
            $phase = 'ConnectRegistration'
            $connectChanged = $true
            Register-GMSSHConnectTask -ProgramRoot $ProgramRoot -DataRoot $DataRoot
        }
        $taskChanged = $true
        $phase = 'TrayRegistration'
        Register-GMSSHTrayTask -ProgramRoot $ProgramRoot -TrayUserSid $state.trayUserSid
        $phase = 'Readiness'
        [pscustomobject]@{version=$Version;backup=$backup;readiness=(Get-GMSSHReadiness -DataRoot $DataRoot -ProgramRoot $ProgramRoot)}
    } catch {
        $failure = $phase + ': ' + $_.Exception.Message
        try {
            if ($taskChanged) { Stop-GMSSHTrayTask }
            if ($withConnect) { Stop-GMSSHConnectTask $ProgramRoot $DataRoot }
            foreach ($name in $items) {
                $target=Join-Path $ProgramRoot $name
                if ($existing -contains $name) { Copy-Item -LiteralPath (Join-Path $backup $name) -Destination $target -Force }
                elseif (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
            }
            Copy-Item -LiteralPath (Join-Path $backup 'agent.json') -Destination $statePath -Force
            if ($connectChanged) {
                if ($connectTask) { Register-ScheduledTask -TaskName 'GMSSH Windows Connect' -TaskPath '\' -Xml (Get-Content (Join-Path $backup 'connect.xml') -Raw) -Force | Out-Null }
                else { Unregister-ScheduledTask -TaskName 'GMSSH Windows Connect' -TaskPath '\' -Confirm:$false -ErrorAction SilentlyContinue }
                if (-not $connectRule) { Remove-NetFirewallRule -Name 'GMSSH-Windows-Connect' -ErrorAction SilentlyContinue }
                elseif (-not $connectRuleWasEnabled) { Disable-NetFirewallRule -Name 'GMSSH-Windows-Connect' }
            }
            foreach ($value in $services) {
                Set-Service $value.name -StartupType $value.start
                if ($value.running) { Start-Service $value.name }
                else { Stop-Service $value.name -ErrorAction SilentlyContinue }
            }
            if ($taskChanged -and $task) { Register-ScheduledTask -TaskName 'GMSSH Windows Tray' -TaskPath '\' -Xml (Get-Content (Join-Path $backup 'tray.xml') -Raw) -Force | Out-Null }
            elseif ($taskChanged) { Unregister-ScheduledTask -TaskName 'GMSSH Windows Tray' -TaskPath '\' -Confirm:$false }
            if ($taskWasRunning) { Start-ScheduledTask -TaskName 'GMSSH Windows Tray' -TaskPath '\' }
            if ($connectWasRunning) { Start-ScheduledTask -TaskName 'GMSSH Windows Connect' -TaskPath '\' }
        } catch { throw ('更新未完成：'+$failure+'；自动恢复也未完成：'+$_.Exception.Message+'；备份：'+$backup+'；请由管理员检查。') }
        throw ('更新未完成，已恢复原程序。'+$failure+'；备份：'+$backup)
    }
}
