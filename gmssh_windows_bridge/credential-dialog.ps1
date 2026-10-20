# Shared, user-controlled password dialog. Returns a SecureString; no file/log output.
function Set-GMSSHDarkTitleBar($Form) {
    try {
        if (-not ('GMSSHNativeWindow' -as [type])) {
            Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class GMSSHNativeWindow {
    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
}
'@
        }
        $Form.Add_HandleCreated({
            param($sender, $event)
            try {
                $enabled = 1
                if ([GMSSHNativeWindow]::DwmSetWindowAttribute($sender.Handle, 20, [ref]$enabled, 4) -ne 0) {
                    [void][GMSSHNativeWindow]::DwmSetWindowAttribute($sender.Handle, 19, [ref]$enabled, 4)
                }
            } catch { }
        })
    } catch { }
}
function Test-GMSSHPasswordInput([string]$Value,[bool]$Confirm,[string]$Repeated,[bool]$ExistingCredential=$false) {
    $minimum=if(-not $Confirm -and $ExistingCredential){1}else{8}
    return $Value.Length -ge $minimum -and (-not $Confirm -or $Value -ceq $Repeated) -and
        [Text.Encoding]::UTF8.GetByteCount($Value) -le 1024 -and $Value -notmatch '[\x00-\x1f]'
}

function Show-GMSSHNotice([string]$Title,[string]$Message,[ValidateSet('Information','Warning','Error')][string]$Icon='Information',$Owner=$null) {
    Add-Type -AssemblyName System.Windows.Forms
    $temporaryOwner=$null
    try {
        if(-not $Owner){$temporaryOwner=New-Object Windows.Forms.Form;$temporaryOwner.TopMost=$true;$temporaryOwner.ShowInTaskbar=$false;$Owner=$temporaryOwner}
        [void][Windows.Forms.MessageBox]::Show($Owner,$Message,$Title,[Windows.Forms.MessageBoxButtons]::OK,[Windows.Forms.MessageBoxIcon]([Enum]::Parse([Windows.Forms.MessageBoxIcon],$Icon)))
    } finally {if($temporaryOwner){$temporaryOwner.Dispose()}}
}

function Show-GMSSHCredentialProgress([string]$Title='GMSSH Windows · 正在更新接入凭据',[string]$Message="正在验证 Windows 账号和桌面密码，并安全保存。`r`n完成后会显示明确结果，请稍候。") {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form=New-Object Windows.Forms.Form
    $form.Text=$Title;$form.ClientSize=New-Object Drawing.Size(480,150)
    $form.StartPosition='CenterScreen';$form.FormBorderStyle='FixedDialog';$form.ControlBox=$false;$form.TopMost=$true
    $form.BackColor=[Drawing.ColorTranslator]::FromHtml('#141414');$form.ForeColor=[Drawing.Color]::WhiteSmoke
    $form.Font=New-Object Drawing.Font('Segoe UI',10);$form.UseWaitCursor=$true
    Set-GMSSHDarkTitleBar $form
    $label=New-Object Windows.Forms.Label
    $label.Text=$Message;$label.SetBounds(24,24,432,56)
    $bar=New-Object Windows.Forms.ProgressBar
    $bar.Style='Marquee';$bar.MarqueeAnimationSpeed=25;$bar.SetBounds(24,100,432,12)
    $form.Controls.AddRange(@($label,$bar));$form.Show();$form.Refresh();[Windows.Forms.Application]::DoEvents()
    return $form
}

function Read-GMSSHPassword([string]$Title, [string]$Description, [bool]$Confirm=$true,[bool]$ExistingCredential=$false) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    $background = [Drawing.ColorTranslator]::FromHtml('#141414')
    $surface = [Drawing.ColorTranslator]::FromHtml('#202020')
    $accent = [Drawing.ColorTranslator]::FromHtml('#5667ff')
    $muted = [Drawing.ColorTranslator]::FromHtml('#a7a7af')
    $form = New-Object Windows.Forms.Form
    $form.Text = $Title; $form.ClientSize = New-Object Drawing.Size(500, 348)
    $form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $form.MinimizeBox = $false
    Set-GMSSHDarkTitleBar $form
    $form.Font = New-Object Drawing.Font('Segoe UI', 10)
    $form.BackColor = $background; $form.ForeColor = [Drawing.Color]::WhiteSmoke
    $brandIcon = $null
    $iconPath = Join-Path $PSScriptRoot 'brand\gmssh.ico'
    if (Test-Path $iconPath) { try { $brandIcon = New-Object Drawing.Icon($iconPath); $form.Icon = $brandIcon } catch { } }
    if (-not $brandIcon) { $form.Icon = [Drawing.SystemIcons]::Application }
    $heading = New-Object Windows.Forms.Label
    $heading.Text = '连接密码'; $heading.SetBounds(24, 20, 452, 30)
    $heading.Font = New-Object Drawing.Font('Segoe UI', 16, [Drawing.FontStyle]::Bold); $form.Controls.Add($heading)
    $note = New-Object Windows.Forms.Label
    $note.Text = $Description; $note.ForeColor = $muted
    $note.SetBounds(24, 59, 452, 50); $form.Controls.Add($note)
    $boxes = @()
    for ($i = 0; $i -lt $(if ($Confirm) { 2 } else { 1 }); $i++) {
        $label = New-Object Windows.Forms.Label
        $label.Text = if ($i -eq 0) { if(-not $Confirm -and $ExistingCredential){'既有密码（不会修改）'}else{'连接密码（至少 8 个字符）'} } else { '再次输入密码' }
        $label.SetBounds(24, (119 + 69 * $i), 452, 24); $form.Controls.Add($label)
        $box = New-Object Windows.Forms.TextBox
        $box.UseSystemPasswordChar = $true; $box.SetBounds(24, (147 + 69 * $i), 452, 28)
        $box.BackColor = $surface; $box.ForeColor = [Drawing.Color]::WhiteSmoke; $box.BorderStyle = 'FixedSingle'
        $form.Controls.Add($box); $boxes += $box
    }
    $privacy = New-Object Windows.Forms.Label
    $privacy.Text = '明文密码不写入文件或日志。'; $privacy.ForeColor = $muted
    $privacy.SetBounds(24, 259, 452, 22); $form.Controls.Add($privacy)
    $save = New-Object Windows.Forms.Button
    $save.Text = '保存'; $save.DialogResult = 'OK'; $save.SetBounds(344, 296, 132, 36)
    $save.BackColor = $accent; $save.ForeColor = [Drawing.Color]::WhiteSmoke
    $save.FlatStyle = 'Flat'; $save.FlatAppearance.BorderSize = 0; $save.UseVisualStyleBackColor = $false
    $cancel = New-Object Windows.Forms.Button
    $cancel.Text = '取消'; $cancel.DialogResult = 'Cancel'; $cancel.SetBounds(196, 296, 132, 36)
    $cancel.BackColor = $surface; $cancel.ForeColor = [Drawing.Color]::WhiteSmoke
    $cancel.FlatStyle = 'Flat'; $cancel.FlatAppearance.BorderColor = [Drawing.ColorTranslator]::FromHtml('#36363e')
    $cancel.UseVisualStyleBackColor = $false
    $form.Controls.AddRange(@($save,$cancel)); $form.AcceptButton = $save; $form.CancelButton = $cancel
    if (-not $Confirm) {
        $form.ClientSize = New-Object Drawing.Size(500,279)
        $privacy.Top = 190; $save.Top = $cancel.Top = 227; $save.Text = '验证并启用'
    }
    try {
        do {
            if ($form.ShowDialog() -ne 'OK') { throw [OperationCanceledException]::new('已取消密码设置。') }
            $repeated=if($Confirm){$boxes[1].Text}else{''}
            $valid = Test-GMSSHPasswordInput $boxes[0].Text $Confirm $repeated $ExistingCredential
            if (-not $valid) { [void][Windows.Forms.MessageBox]::Show($(if ($Confirm) { '密码至少 8 个字符，两次输入须一致，且不超过 1024 字节。' } elseif($ExistingCredential){'请输入现有密码，不能为空、包含控制字符或超过 1024 字节；本次不重设密码。'}else { '请输入当前连接密码，至少 8 个字符，且不超过 1024 字节。' }), 'GMSSH Windows') }
        } while (-not $valid)
        $secret = New-Object Security.SecureString
        foreach ($character in $boxes[0].Text.ToCharArray()) { $secret.AppendChar($character) }
        $secret.MakeReadOnly()
        return $secret
    } finally {
        $boxes | ForEach-Object { $_.Clear() }; $form.Dispose()
        if ($brandIcon) { $brandIcon.Dispose() }
    }
}
