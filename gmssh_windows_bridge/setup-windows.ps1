#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidatePattern('^[\p{L}\p{N}-]{1,63}$')][string]$ExpectedComputer = $([Environment]::MachineName),
    [ValidatePattern('^[\p{L}\p{M}\p{N}_. -]{1,64}$')][string]$WindowsUser = $env:USERNAME,
    [ValidatePattern('^S-1-[0-9]+(?:-[0-9]+){1,15}$')][string]$TrayUserSid,
    [string]$ControllerAddress,
    [switch]$MonitorOnly,
    [switch]$TrayOnly,
    [switch]$PreserveDesktop
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\Modules'
$ProgressPreference = 'SilentlyContinue'
if ($env:OS -ne 'Windows_NT') { throw 'Run this setup on the intended Windows computer.' }
if ($([Environment]::MachineName) -ine $ExpectedComputer) { throw 'Computer name does not match the intended device.' }
$settingsPath = Join-Path $PSScriptRoot 'setup-config.json'
if (Test-Path $settingsPath) {
    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
    if (-not $ControllerAddress) { $ControllerAddress = $settings.controllerAddress }
    if ($settings.monitorOnly) { $MonitorOnly = $true }
    if ($settings.preserveDesktop) { $PreserveDesktop = $true }
    if ($settings.expectedComputer -and $([Environment]::MachineName) -ine $settings.expectedComputer) { throw 'This test package is for a different computer.' }
}
if (-not $ControllerAddress) { $ControllerAddress = 'LocalSubnet' }
if (-not $TrayUserSid) { $TrayUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
if ($ControllerAddress -ne 'LocalSubnet') {
    $controller = [Net.IPAddress]::Parse($ControllerAddress)
    if ($controller.GetAddressBytes().Length -ne 4) { throw 'Use LocalSubnet or one controller IPv4 address.' }
    $ControllerAddress = $controller.ToString()
}
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    $arguments = '-NoProfile -STA -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"' +
        ' -ExpectedComputer ' + $ExpectedComputer + ' -WindowsUser "' + $WindowsUser + '" -TrayUserSid ' + $TrayUserSid + ' -ControllerAddress ' + $ControllerAddress
    if ($MonitorOnly) { $arguments += ' -MonitorOnly' }
    if ($TrayOnly) { $arguments += ' -TrayOnly' }
    if ($PreserveDesktop) { $arguments += ' -PreserveDesktop' }
    $elevated = Start-Process (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    exit $elevated.ExitCode
}
$root = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'GMSSHWindowsBridge'
$reportDirectory = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'GMSSHWindowsBridge'
$connection = Join-Path $reportDirectory 'connection.json'
$desktopNew = $false
$createdAccount = $null
$installationCommitted = $false
$connectionPassword = $null
$dedicated = -not $MonitorOnly -and -not $TrayOnly -and -not $PreserveDesktop
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'setup-checks.ps1')
function Save-ConnectionResult($Readiness) {
    $public = Get-GMSSHConnectionInfo
    $public | ConvertTo-Json -Depth 5 | Set-Content $connection -Encoding UTF8
    $Readiness | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $reportDirectory 'readiness.json') -Encoding UTF8
    # Another administrator's desktop is not the original interactive user's desktop.
    if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $TrayUserSid) { return $false }
    try {
        $desktopPath = [Environment]::GetFolderPath('Desktop')
        $public | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $desktopPath 'GMSSH-connection.json') -Encoding UTF8
        $Readiness | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $desktopPath 'GMSSH-readiness.json') -Encoding UTF8
        return $true
    } catch { return $false }
}
$exportHint = '连接文件和自检报告保存在 %ProgramData%\GMSSHWindowsBridge；也可从系统托盘复制连接信息。'
try {
    $plan = Get-GMSSHInstallPlan -SetupRoot $PSScriptRoot -Dedicated $dedicated -MonitorOnly ([bool]$MonitorOnly) -TrayOnly ([bool]$TrayOnly)
    if ($plan -eq 'Existing') {
        $readiness = Get-GMSSHReadiness
        $desktopSaved = Save-ConnectionResult $readiness
        if ($desktopSaved) { $exportHint = '桌面上的 GMSSH-connection.json 和 GMSSH-readiness.json 已更新。也可从系统托盘复制连接信息。' }
        [void][Windows.Forms.MessageBox]::Show(("检测到已有 GMSSH 安装，账号与密码已保留。`r`n`r`n" + (Format-GMSSHReadiness $readiness) + "`r`n`r`n" + $exportHint), 'GMSSH Windows · 已安装')
        return
    }
} catch {
    [void][Windows.Forms.MessageBox]::Show(('安装前检查未通过：' + $_.Exception.Message + "`r`n本次未创建账号或安装组件。"), 'GMSSH Windows')
    exit 1
}
$description = "将安装局域网 SSH 和桌面后台服务，设置开机启动及 GMSSH 托盘。`r`n同一子网可访问本机 SSH 22 端口，登录账号为 $WindowsUser。`r`nWindows 账号密码不会更改。"
if ($MonitorOnly) { $description = "只补装局域网 SSH，允许同一子网访问 22 端口，登录账号为 $WindowsUser。`r`n保留现有桌面密码和设置。" }
elseif ($PreserveDesktop -or $TrayOnly) { $description += "`r`n本次复用已有桌面引擎，保留其密码和访问设置。" }
if ($dedicated) { $description = "将创建本地管理员账号 gmssh，用于远程管理文件、运行终端和修改系统设置，密码不自动过期。`r`n系统保护目录和其他用户的加密文件仍受 Windows 权限限制。`r`n安装桌面后台引擎、开机服务和 GMSSH 托盘。`r`n你只设置一次 GMSSH 连接密码，同时用于 SSH 和桌面；原 Windows 账号密码不会改变。" }
if ([Windows.Forms.MessageBox]::Show($description, 'GMSSH Windows · 开始安装', 'OKCancel') -ne 'OK') { return }
$progressFile = Join-Path $PSScriptRoot 'installation-status.txt'
'正在准备运行环境…' | Set-Content $progressFile -Encoding UTF8
$progressArguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'setup-progress.ps1') + '" -StatusFile "' + $progressFile + '"'
$progressProcess = Start-Process (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $progressArguments -PassThru
try {
    if ($PreserveDesktop -and -not (Get-Service RustDesk -ErrorAction SilentlyContinue)) { throw 'The existing desktop service is required by this test package.' }
    & (Join-Path $PSScriptRoot 'install-vc-runtime.ps1')
    if ($dedicated) {
        if (Get-LocalUser -Name gmssh -ErrorAction SilentlyContinue) { throw '本地账号 gmssh 已存在；不会覆盖它，请检查现有安装。' }
        . (Join-Path $PSScriptRoot 'credential-dialog.ps1')
        '请设置 GMSSH 连接密码…' | Set-Content $progressFile -Encoding UTF8
        $connectionPassword = Read-GMSSHPassword 'GMSSH Windows · 连接密码' '此密码同时用于 SSH 和桌面。不会改变你原有的 Windows 账号密码。'
        $createdAccount = New-LocalUser -Name gmssh -Password $connectionPassword -AccountNeverExpires -PasswordNeverExpires `
            -Description 'GMSSH Windows LAN monitoring and desktop tunnel'
        $users = Get-LocalGroup -SID 'S-1-5-32-545'
        if (-not (Get-LocalGroupMember -Group $users.Name | Where-Object { $_.SID -eq $createdAccount.SID })) {
            Add-LocalGroupMember -Group $users.Name -Member $createdAccount
        }
        $administrators = Get-LocalGroup -SID 'S-1-5-32-544'
        Add-LocalGroupMember -Group $administrators.Name -Member $createdAccount
        if (-not (Get-LocalGroupMember -Group $administrators.Name | Where-Object { $_.SID -eq $createdAccount.SID })) {
            throw '未能确认 gmssh 账号的管理员权限。'
        }
        $WindowsUser = 'gmssh'
    }
    '正在安装并配置局域网连接…' | Set-Content $progressFile -Encoding UTF8
    if (-not $TrayOnly) {
        & (Join-Path $PSScriptRoot 'setup-monitor.ps1') -ExpectedComputer $ExpectedComputer `
            -ControllerAddress $ControllerAddress -WindowsUser $WindowsUser -Install
        if (-not $?) { throw 'SSH setup did not finish.' }
    } elseif (-not (Test-Path $connection)) { throw 'Configure monitoring before adding the tray program.' }
    if (-not $MonitorOnly) {
        if (Test-Path (Join-Path $reportDirectory 'agent.json')) { throw 'GMSSH Windows tray is already configured.' }
        $desktopNew = -not [bool](Get-Service RustDesk -ErrorAction SilentlyContinue)
        '正在准备桌面后台服务…' | Set-Content $progressFile -Encoding UTF8
        $engine = & (Join-Path $PSScriptRoot 'install-desktop-engine.ps1')
        if (-not $TrayOnly -and -not $PreserveDesktop) {
            '请在密码窗口设置桌面密码…' | Set-Content $progressFile -Encoding UTF8
            & (Join-Path $PSScriptRoot 'setup-desktop.ps1') -RustDesk $engine -SetupPassword $connectionPassword
            if (-not $?) { throw 'Desktop setup did not finish.' }
        }
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        '正在配置 GMSSH 托盘…' | Set-Content $progressFile -Encoding UTF8
        foreach ($name in @('gmssh-agent.ps1','setup-desktop.ps1','credential-dialog.ps1','setup-checks.ps1')) {
            Copy-Item (Join-Path $PSScriptRoot $name) (Join-Path $root $name)
        }
        if (Test-Path (Join-Path $PSScriptRoot 'brand')) {
            Copy-Item (Join-Path $PSScriptRoot 'brand') $root -Recurse -Force
        }
        Copy-Item (Join-Path $PSScriptRoot 'third-party-licenses') $root -Recurse -Force
        [ordered]@{ schema=1; computer=$ExpectedComputer; username=$WindowsUser; engine=$engine;
                    managedAccountSid=if ($createdAccount) { $createdAccount.SID.Value } else { $null };
                    accountRole=if ($createdAccount) { 'Administrator' } else { 'Existing' };
                    unifiedPassword=$dedicated; trayUserSid=$TrayUserSid; version=$settings.version } |
            ConvertTo-Json | Set-Content (Join-Path $reportDirectory 'agent.json') -Encoding UTF8
        $arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'gmssh-agent.ps1') + '"'
        $action = New-ScheduledTaskAction -Execute (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe') -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $TrayUserSid
        $principal = New-ScheduledTaskPrincipal -UserId $TrayUserSid -LogonType Interactive -RunLevel Limited
        $taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName 'GMSSH Windows Tray' -Action $action -Trigger $trigger `
            -Principal $principal -Settings $taskSettings -Description 'GMSSH Windows local management panel' | Out-Null
        Start-ScheduledTask -TaskName 'GMSSH Windows Tray'
    }
    $installationCommitted = $true
    '正在执行接入自检…' | Set-Content $progressFile -Encoding UTF8
    $readiness = Get-GMSSHReadiness -MonitorOnly ([bool]$MonitorOnly)
    $desktopSaved = Save-ConnectionResult $readiness
    if ($desktopSaved) { $exportHint = '桌面上已生成 GMSSH-connection.json 和 GMSSH-readiness.json。也可从系统托盘复制连接信息。' }
    Remove-Item $progressFile
    Add-Type -AssemblyName System.Windows.Forms
    $credentialNote = if ($dedicated) { '账号：gmssh（管理员）。使用刚设置的 GMSSH 连接密码添加机器。' } else { '使用现有 Windows 账号密码添加机器。' }
    $resultTitle = if ($readiness.readyToPair) { '安装完成 · 本机自检通过' } else { '组件已安装 · 有项目需要检查' }
    [void][Windows.Forms.MessageBox]::Show(("$credentialNote`r`n`r`n" + (Format-GMSSHReadiness $readiness) + "`r`n`r`n" + $exportHint + "`r`n连接文件交给控制端管理员完成首次添加；这两个文件不含密码。"), ('GMSSH Windows · ' + $resultTitle))
} catch {
    if (-not $installationCommitted) {
        if ($desktopNew) { Stop-Service RustDesk -ErrorAction SilentlyContinue }
        if ($createdAccount) { Remove-LocalUser -Name gmssh -ErrorAction SilentlyContinue }
    }
    Add-Type -AssemblyName System.Windows.Forms
    $failureTitle = if ($installationCommitted) { '组件已安装，自检或导出未完成；现有账号和密码已保留：' } else { '安装未完成：' }
    [void][Windows.Forms.MessageBox]::Show(($failureTitle + $_.Exception.Message), 'GMSSH Windows')
    exit 1
} finally {
    if ($connectionPassword) { $connectionPassword.Dispose() }
    Remove-Item $progressFile -ErrorAction SilentlyContinue
    if (-not $progressProcess.HasExited) { $progressProcess.WaitForExit(2000) | Out-Null }
}
