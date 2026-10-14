#requires -Version 5.1
[CmdletBinding()]
param([ValidateSet('Tray','Start','Stop','Password','SSHPassword')][string]$Action = 'Tray')
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\Modules'
$root = Split-Path $PSCommandPath
$agentScript = $PSCommandPath
$statePath = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'GMSSHWindowsBridge\agent.json'
if (-not (Test-Path $statePath)) { throw 'GMSSH Windows has not been configured.' }
$state = Get-Content $statePath -Raw | ConvertFrom-Json
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Action -ne 'Tray') {
    if (-not $admin) { throw 'Administrator approval is required for this operation.' }
    try {
        switch ($Action) {
            Start { Start-Service RustDesk; Start-Service sshd }
            Stop { Stop-Service sshd; Stop-Service RustDesk }
            Password {
                $options = @{ RustDesk=$state.engine; ChangePasswordOnly=$true }
                if ($state.unifiedPassword) { $options.ManagedAccount = $state.username }
                & (Join-Path $root 'setup-desktop.ps1') @options
            }
            SSHPassword {
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
$subtitle = New-AgentLabel $panel '本机连接与服务管理' 77 51 320 22
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
$sshCard = New-AgentCard 24 240 288 92
$sshTitle = New-AgentLabel $sshCard 'SSH 服务' 18 12 150 24
$sshStatus = New-AgentLabel $sshCard '正在读取…' 18 45 150 27
$sshStatus.Font = New-Object Drawing.Font('Segoe UI', 13, [Drawing.FontStyle]::Bold)
$sshPort = New-AgentLabel $sshCard 'TCP 22' 175 14 95 22; $sshPort.ForeColor = $muted
$desktopCard = New-AgentCard 328 240 288 92
$desktopTitle = New-AgentLabel $desktopCard '桌面服务' 18 12 150 24
$desktopStatus = New-AgentLabel $desktopCard '正在读取…' 18 45 252 27
$desktopStatus.Font = New-Object Drawing.Font('Segoe UI', 13, [Drawing.FontStyle]::Bold)
$passwordLabel = if ($state.unifiedPassword) { '修改连接密码' } else { '修改桌面密码' }
$copy = New-AgentButton $panel '复制连接信息' 24 344 288 42 $true
$change = New-AgentButton $panel $passwordLabel 328 344 288 42
$capabilityNote = New-AgentLabel $panel "键鼠、文本剪贴板通过桌面端；文件通过 SSH。`r`n可用性以控制端连接为准。" 24 394 592 36
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
$closeHint = New-AgentLabel $panel '关闭窗口后，服务继续运行' 314 515 300 24
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
        $addresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
            $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'
        } | Select-Object -ExpandProperty IPAddress -Unique) -join ', '
        $addressesLabel.Text = if ($addresses) { $addresses } else { '未发现可用的 IPv4 地址' }
        $tooltip.SetToolTip($addressesLabel, $addressesLabel.Text)
        Set-ServiceLabel $sshStatus $ssh; Set-ServiceLabel $desktopStatus $desktop
        $ready = $ssh.Status -eq 'Running' -and $desktop.Status -eq 'Running'
        $overall.Text = if ($ready) { '服务运行中' } else { '服务未就绪' }
        $overall.ForeColor = if ($ready) { $online } else { $warning }
        $tray.Text = 'GMSSH Windows · ' + $overall.Text
        $startButton.Enabled = $start.Enabled = [bool]($ssh -and $desktop -and -not $ready)
        $stopButton.Enabled = $stop.Enabled = [bool]($ssh -and $desktop -and ($ssh.Status -eq 'Running' -or $desktop.Status -eq 'Running'))
        $current = 'SSH：' + $sshStatus.Text + '；桌面：' + $desktopStatus.Text + '。'
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
            return
        }
        Add-AgentActivity $(switch ($Name) { Start { '启动服务操作已完成。' }; Stop { '停止服务操作已完成。' }; default { '密码窗口已关闭；修改结果见窗口提示。' } })
        Refresh-Status
    } catch {
        Add-AgentActivity '操作未完成，请检查管理员授权和服务状态。'
        [void][Windows.Forms.MessageBox]::Show('操作未完成，请检查管理员授权和服务状态。', 'GMSSH Windows')
        Refresh-Status
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
if ($state.managedAccountSid -and -not $state.unifiedPassword) {
    $sshPassword = $menu.Items.Add('修改 SSH 密码'); $sshPassword.Add_Click({ Invoke-AgentAction SSHPassword })
    $sshChange = New-AgentButton $sshCard '修改 SSH 密码' 160 48 110 28
    $sshChange.Font = New-Object Drawing.Font('Segoe UI', 9)
    $sshChange.Add_Click({ Invoke-AgentAction SSHPassword })
}
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$start = $menu.Items.Add('启动后台服务'); $start.Add_Click({ Invoke-AgentAction Start })
$stop = $menu.Items.Add('停止后台服务'); $stop.Add_Click({ Invoke-AgentAction Stop })
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$exit = $menu.Items.Add('退出托盘（服务继续运行）'); $exit.Add_Click({ $context.ExitThread() })
$tray.Add_DoubleClick({ Show-Panel })
$panel.Add_FormClosing({ param($sender,$event); $event.Cancel = $true; $panel.Hide() })
$change.Add_Click({ Invoke-AgentAction Password })
$copy.Add_Click({
    try {
        [Windows.Forms.Clipboard]::SetText((Get-Content (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'GMSSHWindowsBridge\connection.json') -Raw))
        Add-AgentActivity '公开连接信息已复制，不含密码。'
    } catch { Add-AgentActivity '连接信息尚未生成或无法复制。'; [void][Windows.Forms.MessageBox]::Show('连接信息尚未生成或无法复制。', 'GMSSH Windows') }
})
$startButton.Add_Click({ Invoke-AgentAction Start }); $stopButton.Add_Click({ Invoke-AgentAction Stop })
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 5000; $timer.Add_Tick({ Refresh-Status }); $timer.Start()
try { Refresh-Status; [Windows.Forms.Application]::Run($context) }
finally {
    $timer.Dispose(); $tray.Visible = $false; $tray.Dispose(); $tooltip.Dispose()
    $logo.Image.Dispose(); $panel.Dispose()
    if ($brandIcon) { $brandIcon.Dispose() }
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
