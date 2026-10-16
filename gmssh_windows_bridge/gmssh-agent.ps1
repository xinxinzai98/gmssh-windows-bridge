#requires -Version 5.1
[CmdletBinding()]
param([ValidateSet('Tray','Start','Stop','Password','SSHPassword','Check','EnableCode','ResetCode')][string]$Action = 'Tray')
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\Modules'
$root = Split-Path $PSCommandPath
$agentScript = $PSCommandPath
$statePath = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'GMSSHWindowsBridge\agent.json'
if (-not (Test-Path $statePath)) { throw 'GMSSH Windows has not been configured.' }
$state = Get-Content $statePath -Raw | ConvertFrom-Json
$dataRoot = Split-Path $statePath
. (Join-Path $root 'setup-checks.ps1')
if (Test-Path (Join-Path $root 'setup-connect.ps1')) { . (Join-Path $root 'setup-connect.ps1') }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Action -ne 'Tray') {
    if (-not $admin) { throw 'Administrator approval is required for this operation.' }
    try {
        switch ($Action) {
            Start { Start-Service RustDesk; Start-Service sshd; if ($state.unifiedPassword -and (Test-Path (Join-Path $root 'gmssh-connect.exe'))) { Register-GMSSHConnectTask -ProgramRoot $root -DataRoot $dataRoot } }
            Stop { if (Test-Path (Join-Path $root 'gmssh-connect.exe')) { Stop-GMSSHConnectTask $root $dataRoot }; Stop-Service sshd; Stop-Service RustDesk }
            EnableCode {
                [void](Get-GMSSHConnectState $dataRoot)
                . (Join-Path $root 'credential-dialog.ps1')
                $secret = Read-GMSSHPassword 'GMSSH Windows · 启用连接码' '请输入当前 GMSSH 连接密码。验证后将加密保存在本机，用于一键接入；不会修改密码。' $false
                try { Set-GMSSHConnectPassword $root $dataRoot $secret } finally { $secret.Dispose() }
            }
            ResetCode {
                Add-Type -AssemblyName System.Windows.Forms
                if ([Windows.Forms.MessageBox]::Show('重置后旧连接码将无法再用于添加设备。已保存的连接保留；若要让它们也失效，请修改连接密码。','GMSSH Windows · 重置连接码','OKCancel') -ne 'OK') { return }
                Reset-GMSSHConnectCode $root $dataRoot
                [Windows.Forms.Clipboard]::SetText((Get-GMSSHConnectCode $root $dataRoot))
                [void][Windows.Forms.MessageBox]::Show('新连接码已复制，旧码已失效。','GMSSH Windows')
            }
            Check {
                Add-Type -AssemblyName System.Windows.Forms
                [void][Windows.Forms.MessageBox]::Show((Format-GMSSHReadiness (Get-GMSSHReadiness)), 'GMSSH Windows · 接入自检')
            }
            Password {
                $options = @{ RustDesk=$state.engine; ChangePasswordOnly=$true }
                if ($state.unifiedPassword) { $options.ManagedAccount = $state.username }
                & (Join-Path $root 'setup-desktop.ps1') @options
            }
            SSHPassword {
                if ($state.unifiedPassword) { throw '此设备使用统一密码，请选择「修改连接密码」。' }
                $account = Get-LocalUser -Name gmssh
                if ($state.username -cne 'gmssh' -or $state.managedAccountSid -cne $account.SID.Value) { throw 'Account is not managed by this program.' }
                . (Join-Path $root 'credential-dialog.ps1')
                $secret = Read-GMSSHPassword 'GMSSH Windows · 修改 SSH 密码' '仅更新专用 gmssh 账号密码，已有桌面密码保持不变。'
                try { Set-LocalUser -Name gmssh -Password $secret } finally { $secret.Dispose() }
                [void][Windows.Forms.MessageBox]::Show('SSH 密码已修改。请在控制端更新记住的密码。','GMSSH Windows')
            }
        }
    } catch {
        Add-Type -AssemblyName System.Windows.Forms
        [void][Windows.Forms.MessageBox]::Show(('操作未完成：' + $_.Exception.Message), 'GMSSH Windows')
        exit 1
    }
    return
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $root 'credential-dialog.ps1')
$created = $false
$mutex = New-Object Threading.Mutex($true, 'Local\GMSSHWindowsTray', [ref]$created)
if (-not $created) { $mutex.Dispose(); return }
[Windows.Forms.Application]::EnableVisualStyles()
$context = New-Object Windows.Forms.ApplicationContext
$tray = New-Object Windows.Forms.NotifyIcon
$brandIcon = $null
$iconPath = Join-Path $root 'brand\gmssh.ico'
if (Test-Path $iconPath) { try { $brandIcon = New-Object Drawing.Icon($iconPath) } catch { } }
$tray.Icon = if ($brandIcon) { $brandIcon } else { [Drawing.SystemIcons]::Application }
$tray.Text = 'GMSSH Windows'
$tray.Visible = $true
$menu = New-Object Windows.Forms.ContextMenuStrip
$tray.ContextMenuStrip = $menu
$background = [Drawing.ColorTranslator]::FromHtml('#141414')
$surface = [Drawing.ColorTranslator]::FromHtml('#202020')
$muted = [Drawing.ColorTranslator]::FromHtml('#a7a7af')
$accent = [Drawing.ColorTranslator]::FromHtml('#5667ff')
$border = [Drawing.ColorTranslator]::FromHtml('#36363e')
$online = [Drawing.ColorTranslator]::FromHtml('#69d68b')
$warning = [Drawing.ColorTranslator]::FromHtml('#f5c36b')
$menu.BackColor = $surface; $menu.ForeColor = [Drawing.Color]::WhiteSmoke
$menu.Font = New-Object Drawing.Font('Segoe UI', 10)
$panel = New-Object Windows.Forms.Form
$panel.Text = 'GMSSH Windows'
$panel.ClientSize = New-Object Drawing.Size(640, 560)
$panel.StartPosition = 'CenterScreen'
$panel.Font = New-Object Drawing.Font('Segoe UI', 10)
$panel.BackColor = $background; $panel.ForeColor = [Drawing.Color]::WhiteSmoke
$panel.FormBorderStyle = 'FixedSingle'; $panel.MaximizeBox = $false
$panel.Icon = $tray.Icon
Set-GMSSHDarkTitleBar $panel
function New-AgentLabel($Parent, [string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height) {
    $label = New-Object Windows.Forms.Label
    $label.Text = $Text; $label.SetBounds($X, $Y, $Width, $Height)
    $label.AutoEllipsis = $true; $Parent.Controls.Add($label)
    return $label
}
function New-AgentButton($Parent, [string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height, [bool]$Primary=$false) {
    $button = New-Object Windows.Forms.Button
    $button.Text = $Text; $button.SetBounds($X, $Y, $Width, $Height)
    $button.FlatStyle = 'Flat'; $button.UseVisualStyleBackColor = $false
    $button.BackColor = if ($Primary) { $accent } else { $surface }
    $button.ForeColor = [Drawing.Color]::WhiteSmoke; $button.FlatAppearance.BorderColor = $border
    if ($Primary) { $button.FlatAppearance.BorderSize = 0 }
    $button.FlatAppearance.MouseOverBackColor = [Drawing.ColorTranslator]::FromHtml($(if ($Primary) { '#6777ff' } else { '#303030' }))
    $button.Cursor = [Windows.Forms.Cursors]::Hand; $Parent.Controls.Add($button)
    return $button
}
function New-AgentCard([int]$X, [int]$Y, [int]$Width, [int]$Height) {
    $card = New-Object Windows.Forms.Panel
    $card.SetBounds($X, $Y, $Width, $Height); $card.BackColor = $surface
    $panel.Controls.Add($card)
    return $card
}
$logo = New-Object Windows.Forms.PictureBox
$logo.SetBounds(24, 22, 40, 40); $logo.SizeMode = 'Zoom'
try { $logo.Image = [Drawing.Image]::FromFile((Join-Path $root 'brand\gmssh.png')) }
catch { $logo.Image = $panel.Icon.ToBitmap() }
$panel.Controls.Add($logo)
$title = New-AgentLabel $panel 'GMSSH Windows' 76 18 360 30
$title.Font = New-Object Drawing.Font('Segoe UI', 18, [Drawing.FontStyle]::Bold)
$subtitle = New-AgentLabel $panel ('本机连接与服务管理 · '+$state.version) 77 51 360 22
$subtitle.ForeColor = $muted
$overall = New-AgentLabel $panel '正在读取状态' 440 28 176 25
$overall.TextAlign = 'MiddleRight'
$machine = New-AgentCard 24 86 592 142
$machineName = New-AgentLabel $machine $env:COMPUTERNAME 18 12 556 30
$machineName.Font = New-Object Drawing.Font('Segoe UI', 17, [Drawing.FontStyle]::Bold)
$ipCaption = New-AgentLabel $machine '局域网地址' 18 55 98 22; $ipCaption.ForeColor = $muted
$addressesLabel = New-AgentLabel $machine '正在读取…' 120 55 454 22
$accountCaption = New-AgentLabel $machine '连接账号' 18 85 98 22; $accountCaption.ForeColor = $muted
$role = if ($state.accountRole -eq 'Administrator') { '管理员' } else { '已有账号' }
$accountLabel = New-AgentLabel $machine ($state.username + '（' + $role + '）') 120 85 454 22
$passwordNote = if ($state.unifiedPassword) { 'SSH 与桌面使用同一连接密码' } else { 'SSH 与桌面使用各自的密码' }
$passwordHint = New-AgentLabel $machine $passwordNote 18 114 556 20; $passwordHint.ForeColor = $muted
$sshCard = New-AgentCard 24 240 184 92
$sshTitle = New-AgentLabel $sshCard 'SSH 服务 · TCP 22' 18 12 150 24
$sshStatus = New-AgentLabel $sshCard '正在读取…' 18 45 150 27
$sshStatus.Font = New-Object Drawing.Font('Segoe UI', 13, [Drawing.FontStyle]::Bold)
$desktopCard = New-AgentCard 220 240 184 92
$desktopTitle = New-AgentLabel $desktopCard '桌面服务' 18 12 150 24
$desktopStatus = New-AgentLabel $desktopCard '正在读取…' 18 45 150 27
$desktopStatus.Font = New-Object Drawing.Font('Segoe UI', 13, [Drawing.FontStyle]::Bold)
$connectCard = New-AgentCard 416 240 200 92
$connectTitle = New-AgentLabel $connectCard '连接码服务' 18 12 164 24
$connectStatus = New-AgentLabel $connectCard '正在读取…' 18 45 164 27
$connectStatus.Font = New-Object Drawing.Font('Segoe UI', 13, [Drawing.FontStyle]::Bold)
$passwordLabel = if ($state.unifiedPassword) { '修改连接密码' } else { '修改桌面密码' }
$copyLabel = if ($state.unifiedPassword) { '复制连接码' } else { '复制连接信息' }
$copy = New-AgentButton $panel $copyLabel 24 344 288 42 $true
$change = New-AgentButton $panel $passwordLabel 328 344 288 42
$capabilityText = if ($state.unifiedPassword) { "连接码可反复使用，仅交给信任的人。`r`n修改连接密码或重置连接码后，旧码失效。" } else { "键鼠、文本剪贴板通过桌面端；文件通过 SSH。`r`n可用性以控制端连接为准。" }
$capabilityNote = New-AgentLabel $panel $capabilityText 24 394 592 36
$capabilityNote.ForeColor = $muted
$activityTitle = New-AgentLabel $panel '本次会话活动' 24 434 592 22
$activity = New-Object Windows.Forms.TextBox
$activity.SetBounds(24, 461, 592, 38); $activity.Multiline = $true
$activity.ReadOnly = $true; $activity.TabStop = $false; $activity.ScrollBars = 'Vertical'
$activity.BorderStyle = 'None'; $activity.BackColor = $surface; $activity.ForeColor = $muted
$activity.Font = New-Object Drawing.Font('Segoe UI', 9)
$panel.Controls.Add($activity)
$startButton = New-AgentButton $panel '启动后台服务' 24 511 132 30
$stopButton = New-AgentButton $panel '停止后台服务' 168 511 132 30
$checkButton = New-AgentButton $panel '接入自检' 312 511 132 30
$closeHint = New-AgentLabel $panel '关闭后服务继续运行' 456 515 160 24
$closeHint.ForeColor = $muted; $closeHint.TextAlign = 'MiddleRight'
$tooltip = New-Object Windows.Forms.ToolTip
$script:lastServiceStatus = ''
$script:lastStatusError = ''
function Add-AgentActivity([string]$Message) {
    $activity.Lines = @(@($activity.Lines | Select-Object -Last 7) + ([DateTime]::Now.ToString('HH:mm:ss') + '  ' + $Message))
    $activity.SelectionStart = $activity.TextLength; $activity.ScrollToCaret()
}
function Set-ServiceLabel($Label, $Service) {
    $Label.Text = if (-not $Service) { '未安装' } else { switch ([string]$Service.Status) {
        Running { '运行中' }; Stopped { '已停止' }; StartPending { '正在启动' }; StopPending { '正在停止' }; default { [string]$Service.Status }
    } }
    $Label.ForeColor = if ($Service -and $Service.Status -eq 'Running') { $online } else { $warning }
}
function Refresh-Status {
    try {
        $ssh = Get-Service sshd -ErrorAction SilentlyContinue
        $desktop = Get-Service RustDesk -ErrorAction SilentlyContinue
        $addresses = @(Get-GMSSHAddresses) -join ', '
        $addressesLabel.Text = if ($addresses) { $addresses } else { '未发现可用的 IPv4 地址' }
        $tooltip.SetToolTip($addressesLabel, $addressesLabel.Text)
        Set-ServiceLabel $sshStatus $ssh; Set-ServiceLabel $desktopStatus $desktop
        $codeHealth = if (-not $state.unifiedPassword) { [pscustomobject]@{ready=$true;state='手动接入';detail='此安装保留手动连接'} }
            elseif (Get-Command Get-GMSSHConnectHealth -ErrorAction SilentlyContinue) { Get-GMSSHConnectHealth $root $dataRoot }
            else { [pscustomobject]@{ready=$false;state='组件待修复';detail='请运行本版本的升级 / 修复以补齐连接码组件'} }
        $connectStatus.Text = $codeHealth.state
        $connectStatus.ForeColor = if ($codeHealth.ready) { $online } else { $warning }
        $tooltip.SetToolTip($connectStatus,$codeHealth.detail)
        $ready = $ssh.Status -eq 'Running' -and $desktop.Status -eq 'Running' -and $codeHealth.ready
        $overall.Text = if ($ready) { '服务运行中' } elseif ($codeHealth.state -eq '未启用') { '连接码待启用' } else { '部分服务未就绪' }
        $overall.ForeColor = if ($ready) { $online } else { $warning }
        $tray.Text = 'GMSSH Windows · ' + $overall.Text
        $startButton.Enabled = $start.Enabled = [bool]($ssh -and $desktop -and ($ssh.Status -ne 'Running' -or $desktop.Status -ne 'Running' -or $codeHealth.state -eq '未就绪'))
        $stopButton.Enabled = $stop.Enabled = [bool]($ssh -and $desktop -and ($ssh.Status -eq 'Running' -or $desktop.Status -eq 'Running' -or ($state.unifiedPassword -and $codeHealth.ready)))
        $current = 'SSH：' + $sshStatus.Text + '；桌面：' + $desktopStatus.Text + '；连接码：' + $connectStatus.Text + '。'
        if ($current -cne $script:lastServiceStatus) { Add-AgentActivity $current; $script:lastServiceStatus = $current }
        $script:lastStatusError = ''
    } catch {
        $overall.Text = '状态读取失败'; $overall.ForeColor = $warning
        $tray.Text = 'GMSSH Windows · 状态读取失败'
        $startButton.Enabled = $start.Enabled = $false
        $stopButton.Enabled = $stop.Enabled = $false
        if (-not $script:lastStatusError) { Add-AgentActivity '状态读取未完成，请检查本机网络和服务。'; $script:lastStatusError = 'failed' }
    }
}
function Invoke-AgentAction([string]$Name) {
    try {
        $arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $agentScript + '" -Action ' + $Name
        $operation = Start-Process (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $arguments -Verb RunAs -Wait -PassThru
        if ($operation.ExitCode -ne 0) {
            Add-AgentActivity '操作未完成，详情请查看操作窗口提示。'
            Refresh-Status
            return $false
        }
        Add-AgentActivity $(switch ($Name) { Start { '启动服务操作已完成。' }; Stop { '停止服务操作已完成。' }; Check { '接入自检已完成；检查结果见自检窗口。' }; EnableCode { '长效连接码已启用。' }; ResetCode { '连接码设置窗口已关闭。' }; default { '密码窗口已关闭；修改结果见窗口提示。' } })
        Refresh-Status
        return $true
    } catch {
        Add-AgentActivity '操作未完成，请检查管理员授权和服务状态。'
        [void][Windows.Forms.MessageBox]::Show('操作未完成，请检查管理员授权和服务状态。', 'GMSSH Windows')
        Refresh-Status
        return $false
    }
}
function Show-Panel {
    Refresh-Status
    $panel.Show()
    $panel.WindowState = 'Normal'
    $panel.Activate()
}
$open = $menu.Items.Add('打开管理面板'); $open.Add_Click({ Show-Panel })
$password = $menu.Items.Add($passwordLabel); $password.Add_Click({ Invoke-AgentAction Password })
if ($state.unifiedPassword) { $resetCode = $menu.Items.Add('重置连接码'); $resetCode.Add_Click({ Invoke-AgentAction ResetCode }) }
$publicCopy = $menu.Items.Add('复制普通连接信息（不含密码）')
$publicCopy.Add_Click({ try { [Windows.Forms.Clipboard]::SetText(((Get-GMSSHConnectionInfo) | ConvertTo-Json -Depth 5)); Add-AgentActivity '公开连接信息已复制，不含连接码或密码。' } catch { Add-AgentActivity '公开连接信息无法复制。' } })
if ($state.managedAccountSid -and -not $state.unifiedPassword) {
    $sshPassword = $menu.Items.Add('修改 SSH 密码'); $sshPassword.Add_Click({ Invoke-AgentAction SSHPassword })
    $sshChange = New-AgentButton $sshCard '修改 SSH 密码' 160 48 110 28
    $sshChange.Font = New-Object Drawing.Font('Segoe UI', 9)
    $sshChange.Add_Click({ Invoke-AgentAction SSHPassword })
}
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$start = $menu.Items.Add('启动后台服务'); $start.Add_Click({ Invoke-AgentAction Start })
$stop = $menu.Items.Add('停止后台服务'); $stop.Add_Click({ Invoke-AgentAction Stop })
$check = $menu.Items.Add('接入自检（管理员）'); $check.Add_Click({ Invoke-AgentAction Check })
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$exit = $menu.Items.Add('退出托盘（服务继续运行）'); $exit.Add_Click({ $context.ExitThread() })
$tray.Add_DoubleClick({ Show-Panel })
$panel.Add_FormClosing({ param($sender,$event); $event.Cancel = $true; $panel.Hide() })
$change.Add_Click({ Invoke-AgentAction Password })
$copy.Add_Click({
    try {
        if ($state.unifiedPassword) {
            [void](Get-GMSSHConnectHelper $root)
            try { $code = Get-GMSSHConnectCode $root $dataRoot }
            catch { if (-not (Invoke-AgentAction EnableCode)) { return }; $code = Get-GMSSHConnectCode $root $dataRoot }
            [Windows.Forms.Clipboard]::SetText($code); $code=$null
            Add-AgentActivity '长效连接码已复制，可在管理端粘贴添加。'
        } else {
            [Windows.Forms.Clipboard]::SetText(((Get-GMSSHConnectionInfo) | ConvertTo-Json -Depth 5))
            Add-AgentActivity '公开连接信息已复制，不含密码。'
        }
    } catch { Add-AgentActivity '连接信息尚未生成或无法复制。'; [void][Windows.Forms.MessageBox]::Show('连接码暂不可用，请检查当前连接密码或运行升级 / 修复。也可从托盘复制普通连接信息后手动添加。', 'GMSSH Windows') }
})
$startButton.Add_Click({ Invoke-AgentAction Start }); $stopButton.Add_Click({ Invoke-AgentAction Stop })
$checkButton.Add_Click({ Invoke-AgentAction Check })
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 5000; $timer.Add_Tick({ Refresh-Status }); $timer.Start()
try {
    $startup = Get-GMSSHStartupStatus
    $local = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'GMSSHWindowsBridge'
    New-Item -ItemType Directory -Path $local -Force | Out-Null
    $startup | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $local 'startup-status.json') -Encoding UTF8
    Get-GMSSHConnectionInfo | ConvertTo-Json -Depth 5 | Set-Content (Join-Path ([Environment]::GetFolderPath('Desktop')) 'GMSSH-connection.json') -Encoding UTF8
    Add-AgentActivity '登录自启检查已完成，桌面连接信息已刷新。'
} catch { Add-AgentActivity '启动检查或连接信息导出未完成，可从托盘运行接入自检。' }
try { Refresh-Status; [Windows.Forms.Application]::Run($context) }
finally {
    $timer.Dispose(); $tray.Visible = $false; $tray.Dispose(); $tooltip.Dispose()
    $logo.Image.Dispose(); $panel.Dispose()
    if ($brandIcon) { $brandIcon.Dispose() }
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
