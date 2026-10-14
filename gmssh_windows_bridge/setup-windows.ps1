#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidatePattern('^[a-zA-Z0-9-]{1,63}$')][string]$ExpectedComputer = $([Environment]::MachineName),
    [ValidatePattern('^[a-zA-Z0-9_.-]{1,64}$')][string]$WindowsUser = $env:USERNAME,
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
if ($ControllerAddress -ne 'LocalSubnet') {
    $controller = [Net.IPAddress]::Parse($ControllerAddress)
    if ($controller.GetAddressBytes().Length -ne 4) { throw 'Use LocalSubnet or one controller IPv4 address.' }
    $ControllerAddress = $controller.ToString()
}
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    $arguments = '-NoProfile -STA -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"' +
        ' -ExpectedComputer ' + $ExpectedComputer + ' -WindowsUser ' + $WindowsUser + ' -ControllerAddress ' + $ControllerAddress
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
$connectionPassword = $null
$trayUser = $WindowsUser
$dedicated = -not $MonitorOnly -and -not $TrayOnly -and -not $PreserveDesktop
Add-Type -AssemblyName System.Windows.Forms
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
        foreach ($name in @('gmssh-agent.ps1','setup-desktop.ps1','credential-dialog.ps1')) {
            Copy-Item (Join-Path $PSScriptRoot $name) (Join-Path $root $name)
        }
        if (Test-Path (Join-Path $PSScriptRoot 'brand')) {
            Copy-Item (Join-Path $PSScriptRoot 'brand') $root -Recurse -Force
        }
        Copy-Item (Join-Path $PSScriptRoot 'third-party-licenses') $root -Recurse -Force
        [ordered]@{ schema=1; computer=$ExpectedComputer; username=$WindowsUser; engine=$engine;
                    managedAccountSid=if ($createdAccount) { $createdAccount.SID.Value } else { $null };
                    accountRole=if ($createdAccount) { 'Administrator' } else { 'Existing' };
                    unifiedPassword=$dedicated } |
            ConvertTo-Json | Set-Content (Join-Path $reportDirectory 'agent.json') -Encoding UTF8
        $account = Get-LocalUser -Name $trayUser
        $arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'gmssh-agent.ps1') + '"'
        $action = New-ScheduledTaskAction -Execute (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe') -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $account.SID.Value
        $principal = New-ScheduledTaskPrincipal -UserId $account.SID.Value -LogonType Interactive -RunLevel Limited
        $taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
        Register-ScheduledTask -TaskName 'GMSSH Windows Tray' -Action $action -Trigger $trigger `
            -Principal $principal -Settings $taskSettings -Description 'GMSSH Windows local management panel' | Out-Null
        Start-ScheduledTask -TaskName 'GMSSH Windows Tray'
    }
    $export = Join-Path ([Environment]::GetFolderPath('Desktop')) 'GMSSH-connection.json'
    Copy-Item $connection $export -Force
    Remove-Item $progressFile
    Add-Type -AssemblyName System.Windows.Forms
    $credentialNote = if ($dedicated) { '账号：gmssh（管理员）。使用刚设置的 GMSSH 连接密码添加机器。' } else { '使用现有 Windows 账号密码添加机器。' }
    [void][Windows.Forms.MessageBox]::Show("安装完成。连接信息已保存到桌面：GMSSH-connection.json`r`n$credentialNote", 'GMSSH Windows')
} catch {
    if ($desktopNew) { Stop-Service RustDesk -ErrorAction SilentlyContinue }
    if ($createdAccount) { Remove-LocalUser -Name gmssh -ErrorAction SilentlyContinue }
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show(('安装未完成：' + $_.Exception.Message), 'GMSSH Windows')
    exit 1
} finally {
    if ($connectionPassword) { $connectionPassword.Dispose() }
    Remove-Item $progressFile -ErrorAction SilentlyContinue
    if (-not $progressProcess.HasExited) { $progressProcess.WaitForExit(2000) | Out-Null }
}
