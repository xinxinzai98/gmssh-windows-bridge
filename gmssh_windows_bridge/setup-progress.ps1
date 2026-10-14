param([string]$StatusFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'credential-dialog.ps1')
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form
$form.Text = 'GMSSH Windows · 安装中'
$form.ClientSize = New-Object Drawing.Size(500, 176)
$form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedDialog'
$form.ControlBox = $false; $form.Font = New-Object Drawing.Font('Segoe UI', 10)
$form.BackColor = [Drawing.ColorTranslator]::FromHtml('#141414'); $form.ForeColor = [Drawing.Color]::WhiteSmoke
Set-GMSSHDarkTitleBar $form
$brandIcon = $null
$iconPath = Join-Path $PSScriptRoot 'brand\gmssh.ico'
if (Test-Path $iconPath) { try { $brandIcon = New-Object Drawing.Icon($iconPath); $form.Icon = $brandIcon } catch { } }
if (-not $brandIcon) { $form.Icon = [Drawing.SystemIcons]::Application }
$heading = New-Object Windows.Forms.Label
$heading.SetBounds(24, 20, 452, 30); $heading.Text = '正在安装 GMSSH Windows'
$heading.Font = New-Object Drawing.Font('Segoe UI', 16, [Drawing.FontStyle]::Bold); $form.Controls.Add($heading)
$label = New-Object Windows.Forms.Label
$label.SetBounds(24, 63, 452, 40); $label.Text = '正在准备安装…'; $form.Controls.Add($label)
$progress = New-Object Windows.Forms.ProgressBar
$progress.SetBounds(24, 115, 452, 12); $progress.Style = 'Marquee'
$progress.BackColor = [Drawing.ColorTranslator]::FromHtml('#202020')
$progress.ForeColor = [Drawing.ColorTranslator]::FromHtml('#5667ff'); $form.Controls.Add($progress)
$note = New-Object Windows.Forms.Label
$note.SetBounds(24, 141, 452, 22); $note.Text = '请按窗口提示操作，安装结束后此窗口将自动关闭。'
$note.ForeColor = [Drawing.ColorTranslator]::FromHtml('#a7a7af'); $form.Controls.Add($note)
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({
    if (-not (Test-Path $StatusFile)) { $form.Close(); return }
    try { $label.Text = Get-Content $StatusFile -Raw -Encoding UTF8 } catch { }
})
$timer.Start()
try { [void]$form.ShowDialog() } finally {
    $timer.Dispose(); $form.Dispose()
    if ($brandIcon) { $brandIcon.Dispose() }
}
