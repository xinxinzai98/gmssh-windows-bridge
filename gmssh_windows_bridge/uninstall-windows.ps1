#requires -Version 5.1
[CmdletBinding()]
param([switch]$Preview)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
if($env:OS -ne 'Windows_NT'){throw '卸载程序仅在 Windows 上运行。'}
$programRoot=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'GMSSHWindowsBridge'
$dataRoot=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'GMSSHWindowsBridge'
$admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $admin){
    $arguments='-NoProfile -STA -ExecutionPolicy Bypass -File "'+$PSCommandPath+'"'
    if($Preview){$arguments+=' -Preview'}
    $child=Start-Process (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $arguments -Verb RunAs -PassThru -Wait
    exit $child.ExitCode
}
foreach($name in @('setup-checks.ps1','setup-connect.ps1','setup-network.ps1','setup-maintenance.ps1','setup-uninstall.ps1')){. (Join-Path $programRoot $name)}
if($Preview){Get-GMSSHRemovalPlan $programRoot $dataRoot|ConvertTo-Json -Depth 10;return}
. (Join-Path $programRoot 'credential-dialog.ps1')
$progress=$null
try{
    $plan=Get-GMSSHRemovalPlan $programRoot $dataRoot
    Add-Type -AssemblyName System.Windows.Forms,System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    $form=New-Object Windows.Forms.Form
    $form.Text='卸载 GMSSH Windows';$form.ClientSize=[Drawing.Size]::new(600,430);$form.StartPosition='CenterScreen';$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false
    $form.BackColor=[Drawing.ColorTranslator]::FromHtml('#141414');$form.ForeColor=[Drawing.Color]::WhiteSmoke;$form.Font=[Drawing.Font]::new('Segoe UI',10)
    Set-GMSSHDarkTitleBar $form
    $heading=[Windows.Forms.Label]::new();$heading.Text='卸载程序，保留连接配置';$heading.Font=[Drawing.Font]::new('Segoe UI',16,[Drawing.FontStyle]::Bold);$heading.SetBounds(24,20,552,34)
    $hint=[Windows.Forms.Label]::new();$hint.Text='GMSSH 连接会断开。运行安装包可从保留配置恢复，无需重设原密码。';$hint.SetBounds(24,64,552,44)
    $details=[Windows.Forms.TextBox]::new();$details.Multiline=$true;$details.ReadOnly=$true;$details.ScrollBars='Vertical';$details.BackColor=[Drawing.ColorTranslator]::FromHtml('#202020');$details.ForeColor=[Drawing.Color]::WhiteSmoke;$details.SetBounds(24,116,552,236)
    $lines=@('将移除：',('  GMSSH 程序文件 '+$plan.files.Count+' 项（移入可恢复备份）'),('  后台任务 '+$plan.tasks.Count+' 项'),('  GMSSH 自建防火墙规则 '+$plan.rules.Count+' 项'))
    if($plan.engine){$lines+='  GMSSH 内部桌面服务'}
    if($plan.managedAccount){$lines+='  停用 GMSSH 自建账号，保留账号与文件用于重装'}
    $lines+=@('','保留：')+@($plan.preserved|ForEach-Object{'  '+$_})+@('','文件清单：')+@($plan.files|ForEach-Object{'  '+$_.name})
    $details.Text=$lines -join "`r`n"
    $cancel=[Windows.Forms.Button]::new();$cancel.Text='取消';$cancel.DialogResult='Cancel';$cancel.SetBounds(352,374,104,32)
    $remove=[Windows.Forms.Button]::new();$remove.Text='备份并卸载';$remove.DialogResult='OK';$remove.SetBounds(468,374,108,32);$remove.BackColor=[Drawing.ColorTranslator]::FromHtml('#5667ff');$remove.ForeColor=[Drawing.Color]::White
    $form.Controls.AddRange(@($heading,$hint,$details,$cancel,$remove));$form.CancelButton=$cancel
    try{if($form.ShowDialog() -ne 'OK'){return}}finally{$form.Dispose()}
    $progress=Show-GMSSHCredentialProgress -Title 'GMSSH Windows · 正在卸载' -Message "正在备份并移除 GMSSH 自身组件。`r`n原服务、用户文件和连接配置将保留。"
    Set-Location ([Environment]::SystemDirectory);[Environment]::CurrentDirectory=[Environment]::SystemDirectory
    $result=Uninstall-GMSSHInstallation $programRoot $dataRoot
    Show-GMSSHNotice 'GMSSH Windows · 卸载完成' ("GMSSH 程序、任务和自身规则已移除，原有服务与用户文件已保留。`r`n连接配置已保留，运行安装包即可恢复。`r`n`r`n备份位置："+$result.backup) 'Information' $progress
}catch{
    Show-GMSSHNotice 'GMSSH Windows · 卸载未完成' $_.Exception.Message 'Warning' $progress
    exit 1
}finally{if($progress){$progress.Close();$progress.Dispose()}}
