#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidatePattern('^[\p{L}\p{N}-]{1,63}$')][string]$ExpectedComputer = $([Environment]::MachineName),
    [ValidatePattern('^[\p{L}\p{M}\p{N}_. -]{1,64}$')][string]$WindowsUser = $env:USERNAME,
    [ValidatePattern('^S-1-[0-9]+(?:-[0-9]+){1,15}$')][string]$TrayUserSid,
    [string]$ControllerAddress,
    [switch]$MonitorOnly,
    [switch]$TrayOnly,
    [switch]$PreserveDesktop,
    [switch]$PreserveExisting
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
    if ($settings.preserveExisting) { $PreserveExisting = $true }
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
    if ($PreserveExisting) { $arguments += ' -PreserveExisting' }
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
$connectWarning = ''
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
    if (-not $MonitorOnly -and -not $TrayOnly -and -not (Test-Path (Join-Path $reportDirectory 'agent.json')) -and
        -not $PreserveExisting -and (Get-Service sshd -ErrorAction SilentlyContinue)) {
        if ([Windows.Forms.MessageBox]::Show("检测到已有 SSH 服务。可保留原 SSH、桌面服务、账号、密码、主机密钥和防火墙设置，添加 GMSSH 托盘与接入组件。`r`n不替换原服务；不满足兼容条件时只提示原因。", 'GMSSH Windows · 保留现有服务', 'OKCancel') -ne 'OK') { return }
        $PreserveExisting = $true
    }
    if ($PreserveExisting) {
        if ($MonitorOnly -or $TrayOnly) { throw '保留现有服务模式不能与仅监控或仅托盘参数同时使用。' }
        $dedicated = $false; $PreserveDesktop = $true
        if (-not $PSBoundParameters.ContainsKey('WindowsUser')) {
            $ownerAccount = @(Get-LocalUser | Where-Object { $_.SID.Value -ceq $TrayUserSid })
            if ($ownerAccount.Count -ne 1) { throw '原登录用户不是可核对的本地账号，请明确指定既有本地连接账号。' }
            $WindowsUser = $ownerAccount[0].Name
        }
    }
    $plan = Get-GMSSHInstallPlan -SetupRoot $PSScriptRoot -Dedicated $dedicated -MonitorOnly ([bool]$MonitorOnly) -TrayOnly ([bool]$TrayOnly) -PreserveExisting ([bool]$PreserveExisting) -WindowsUser $WindowsUser
    if ($plan -eq 'PreserveExisting') { $existingProfile = Get-GMSSHExistingServices -WindowsUser $WindowsUser }
    if($plan -eq 'Uninstalled'){
        . (Join-Path $PSScriptRoot 'setup-maintenance.ps1');. (Join-Path $PSScriptRoot 'setup-uninstall.ps1')
        if([Windows.Forms.MessageBox]::Show("检测到已卸载的 GMSSH 和保留配置。将恢复程序并更新到 $($settings.version)，恢复原设备身份、授权和自启。`r`n原账号密码、用户文件、SSH 和独立 RustDesk 不变。",'GMSSH Windows · 重新安装','OKCancel') -ne 'OK'){return}
        $restored=Restore-GMSSHInstallation -SetupRoot $PSScriptRoot -ProgramRoot $root -DataRoot $reportDirectory -Version $settings.version
        [void](Save-ConnectionResult $restored.readiness)
        [void][Windows.Forms.MessageBox]::Show(("重新安装完成，原连接配置已恢复。`r`n`r`n"+(Format-GMSSHReadiness $restored.readiness)),'GMSSH Windows · 重装完成')
        return
    }
    if ($plan -eq 'Existing') {
        $updated = $null
        if (-not $MonitorOnly) {
            if(Test-Path (Join-Path $PSScriptRoot 'setup-uninstall.ps1')){. (Join-Path $PSScriptRoot 'setup-uninstall.ps1');Register-GMSSHUninstaller $root $settings.version -ValidateOnly}
            if (-not $settings.version) { throw '更新包缺少版本，请完整解压后运行安装程序。' }
            $state = Get-Content (Join-Path $reportDirectory 'agent.json') -Raw | ConvertFrom-Json
            $description = "检测到已安装版本 $($state.version)。将备份并更新到 $($settings.version)，修复本程序的登录自启与自动服务。`r`n保留现有账号、连接密码、SSH 主机密钥和桌面引擎。`r`n托盘窗口会重新启动，远端已运行的程序继续运行。"
            if ($state.unifiedPassword -and (Test-Path (Join-Path $PSScriptRoot 'setup-connect.ps1'))) { $description += "`r`n新增长效连接码的开机接入任务，局域网可访问 TCP 22257。首次复制时需验证现有密码；验证后密码以 Windows 保护的密文保存在本机。" }
            if ([Windows.Forms.MessageBox]::Show($description, 'GMSSH Windows · 升级 / 修复', 'OKCancel') -ne 'OK') { return }
            . (Join-Path $PSScriptRoot 'setup-maintenance.ps1')
            $updated = Update-GMSSHInstallation -SetupRoot $PSScriptRoot -ProgramRoot $root -DataRoot $reportDirectory -Version $settings.version
            if(Test-Path (Join-Path $root 'setup-uninstall.ps1')){. (Join-Path $root 'setup-uninstall.ps1');Register-GMSSHUninstaller $root $settings.version}
        }
        $readiness = if ($updated) { $updated.readiness } else { Get-GMSSHReadiness -MonitorOnly ([bool]$MonitorOnly) }
        $desktopSaved = Save-ConnectionResult $readiness
        if ($desktopSaved) { $exportHint = '桌面上的 GMSSH-connection.json 和 GMSSH-readiness.json 已更新。也可从系统托盘复制连接信息。' }
        $updateHint = if ($updated) { "升级 / 修复完成。账号与密码已保留。`r`n程序备份：$($updated.backup)" } else { '检测到已有 GMSSH 安装，账号与密码已保留。' }
        [void][Windows.Forms.MessageBox]::Show(($updateHint + "`r`n`r`n" + (Format-GMSSHReadiness $readiness) + "`r`n`r`n" + $exportHint), 'GMSSH Windows · 安装状态')
        return
    }
} catch {
    $failureTitle = if ($plan -eq 'Existing') { '升级 / 修复未完成：' } elseif($plan -eq 'Uninstalled'){'重装恢复未完成：'} else { '安装前检查未通过：' }
    [void][Windows.Forms.MessageBox]::Show(($failureTitle + $_.Exception.Message + "`r`n本次未重设现有账号密码。"), 'GMSSH Windows')
    exit 1
}
$description = "将安装局域网 SSH 和桌面后台服务，设置开机启动及 GMSSH 托盘。`r`n同一子网可访问本机 SSH 22 端口，登录账号为 $WindowsUser。`r`nWindows 账号密码不会更改。"
if ($MonitorOnly) { $description = "只补装局域网 SSH，允许同一子网访问 22 端口，登录账号为 $WindowsUser。`r`n保留现有桌面密码和设置。" }
elseif ($PreserveDesktop -or $TrayOnly) { $description += "`r`n本次复用已有桌面引擎，保留其密码和访问设置。" }
if ($dedicated) { $description = "将创建本地管理员账号 gmssh，用于远程管理文件、运行终端和修改系统设置，密码不自动过期。`r`n系统保护目录和其他用户的加密文件仍受 Windows 权限限制。`r`n安装桌面后台引擎、开机服务和 GMSSH 托盘。`r`n你只设置一次 GMSSH 连接密码，同时用于 SSH 和桌面；原 Windows 账号密码不会改变。" }
if ($dedicated) { $description += "`r`n启用长效连接码：局域网 TCP 22257 和开机接入任务；连接密码以 Windows 保护的密文保存。连接码不含明文密码，但持有码即可接入，请按密码保管。" }
if ($PreserveExisting) { $description = "保留原 SSH 和 RustDesk 服务、账号 $WindowsUser、密码、主机密钥与防火墙设置。`r`n新增 GMSSH 托盘与程序文件；不接管原服务的启停或自启设置。`r`n启用连接码时需输入既有 Windows 账号密码和桌面密码，加密保存在本机；不会修改它们。新增本程序的 SYSTEM 接入任务和局域网 TCP 22257。" }
if (-not $PreserveExisting -and $settings -and $settings.runtimeSource -ceq 'microsoft') { $description += "`r`n缺少所需 VC++ 运行库时，将联网从微软官方获取并校验后安装。" }
if ([Windows.Forms.MessageBox]::Show($description, 'GMSSH Windows · 开始安装', 'OKCancel') -ne 'OK') { return }
$progressFile = Join-Path $PSScriptRoot 'installation-status.txt'
'正在准备运行环境…' | Set-Content $progressFile -Encoding UTF8
$progressArguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'setup-progress.ps1') + '" -StatusFile "' + $progressFile + '"'
$progressProcess = Start-Process (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $progressArguments -PassThru
try {
    if ($PreserveDesktop -and -not (Get-Service RustDesk -ErrorAction SilentlyContinue)) { throw 'The existing desktop service is required by this test package.' }
    if (-not $PreserveExisting) { & (Join-Path $PSScriptRoot 'install-vc-runtime.ps1') }
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
    if ($PreserveExisting) {
        $WindowsUser = $existingProfile.username
        Save-GMSSHExistingConnection -Profile $existingProfile -DataRoot $reportDirectory -ControllerAddress $ControllerAddress
    } elseif (-not $TrayOnly) {
        & (Join-Path $PSScriptRoot 'setup-monitor.ps1') -ExpectedComputer $ExpectedComputer `
            -ControllerAddress $ControllerAddress -WindowsUser $WindowsUser -Install
        if (-not $?) { throw 'SSH setup did not finish.' }
    } elseif (-not (Test-Path $connection)) { throw 'Configure monitoring before adding the tray program.' }
    if (-not $MonitorOnly) {
        if (Test-Path (Join-Path $reportDirectory 'agent.json')) { throw 'GMSSH Windows tray is already configured.' }
        $desktopNew = -not [bool](Get-Service RustDesk -ErrorAction SilentlyContinue)
        '正在准备桌面后台服务…' | Set-Content $progressFile -Encoding UTF8
        $engine = if ($PreserveExisting) { $existingProfile.engine } else { & (Join-Path $PSScriptRoot 'install-desktop-engine.ps1') }
        if (-not $TrayOnly -and -not $PreserveDesktop) {
            '请在密码窗口设置桌面密码…' | Set-Content $progressFile -Encoding UTF8
            & (Join-Path $PSScriptRoot 'setup-desktop.ps1') -RustDesk $engine -SetupPassword $connectionPassword
            if (-not $?) { throw 'Desktop setup did not finish.' }
        }
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        '正在配置 GMSSH 托盘…' | Set-Content $progressFile -Encoding UTF8
        foreach ($name in @('gmssh-agent.ps1','controller-panel.ps1','collector.ps1','login.ps1','system-info.ps1','readonly-tools.ps1','ai-context.ps1','ai-desktop.ps1','setup-desktop.ps1','credential-dialog.ps1','setup-checks.ps1','setup-existing.ps1','setup-network.ps1','setup-maintenance.ps1','setup-connect.ps1','gmssh-connect.exe','connect-payload.json','setup-uninstall.ps1','uninstall-windows.ps1')) {
            Copy-Item (Join-Path $PSScriptRoot $name) (Join-Path $root $name)
        }
        if (Test-Path (Join-Path $PSScriptRoot 'brand')) {
            Copy-Item (Join-Path $PSScriptRoot 'brand') $root -Recurse -Force
        }
        Copy-Item (Join-Path $PSScriptRoot 'third-party-licenses') $root -Recurse -Force
        [ordered]@{ schema=1; computer=$ExpectedComputer; username=$WindowsUser; engine=$engine;
                    managedAccountSid=if ($createdAccount) { $createdAccount.SID.Value } else { $null };
                    accountRole=if ($createdAccount) { 'Administrator' } else { 'Existing' };
                    unifiedPassword=$dedicated; trayUserSid=$TrayUserSid; version=$settings.version;
                    installationMode=if($PreserveExisting){'preserve-existing'}elseif($dedicated){'managed'}else{'legacy'};
                    accountSid=if($PreserveExisting){$existingProfile.accountSid}else{$null} } |
            ConvertTo-Json | Set-Content (Join-Path $reportDirectory 'agent.json') -Encoding UTF8
        # Commit the usable SSH/desktop installation before the optional code
        # component. A code failure must not delete its now-working account.
        $installationCommitted = $true
        if ($dedicated -or $PreserveExisting) {
            '正在启用长效连接码…' | Set-Content $progressFile -Encoding UTF8
            . (Join-Path $root 'setup-connect.ps1')
            try {
                if ($PreserveExisting) { Enable-GMSSHExistingCredentials $root $reportDirectory }
                else { Set-GMSSHConnectPassword $root $reportDirectory $connectionPassword }
            }
            catch { $connectWarning = "`r`n连接码尚未启用：" + $_.Exception.Message + ' 可先手动添加，再从托盘验证当前密码启用。' }
        }
        . (Join-Path $PSScriptRoot 'setup-maintenance.ps1')
        Register-GMSSHTrayTask -ProgramRoot $root -TrayUserSid $TrayUserSid
        . (Join-Path $root 'setup-uninstall.ps1');Register-GMSSHUninstaller $root $settings.version
    }
    $installationCommitted = $true
    '正在执行接入自检…' | Set-Content $progressFile -Encoding UTF8
    $readiness = Get-GMSSHReadiness -MonitorOnly ([bool]$MonitorOnly)
    $desktopSaved = Save-ConnectionResult $readiness
    if ($desktopSaved) { $exportHint = '桌面上已生成 GMSSH-connection.json 和 GMSSH-readiness.json。也可从系统托盘复制连接信息。' }
    Remove-Item $progressFile
    Add-Type -AssemblyName System.Windows.Forms
    $credentialNote = if ($dedicated -or $PreserveExisting) { '打开 GMSSH 托盘，点「复制连接码」；在 Mac 点加号 →「添加机器」→「Windows」，粘贴连接码后连接。也可手动填写。连接码长期有效，请按密码保管。' } else { '使用现有 Windows 账号密码添加机器。' }
    if($PreserveExisting){$credentialNote='打开 GMSSH 托盘，点「创建接入授权」，选择所需权限并创建授权码；在 Mac 加号 →「添加机器」→「Windows」粘贴。独立桌面通道使用服务端保存的既有桌面凭据。也可从托盘复制普通连接信息，或使用仅供 SSH 的接入码后单独认证桌面。'}
    $resultTitle = if ($readiness.readyToPair) { '安装完成 · 本机自检通过' } else { '组件已安装 · 有项目需要检查' }
    [void][Windows.Forms.MessageBox]::Show(("$credentialNote$connectWarning`r`n`r`n" + (Format-GMSSHReadiness $readiness) + "`r`n`r`n" + $exportHint + "`r`n连接文件交给控制端管理员完成首次添加；这两个文件不含密码。"), ('GMSSH Windows · ' + $resultTitle))
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
