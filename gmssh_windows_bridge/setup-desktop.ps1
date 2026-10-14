#Requires -Version 5.1
<## First-run setup after installing the official RustDesk 1.5 client.
    Passwords are entered interactively on Windows, never supplied in this script.
    -CheckOnly reads prerequisites. -SelfTest checks quoting without changing settings.
##>
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$SelfTest, [switch]$ChangePasswordOnly,
      [Security.SecureString]$SetupPassword, [string]$ManagedAccount,
      [string]$RustDesk = (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'RustDesk\rustdesk.exe'))
$ErrorActionPreference = 'Stop'

function Quote-NativeArgument([string]$Value) {
    $result = New-Object System.Text.StringBuilder
    [void]$result.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char]92) { $slashes++; continue }
        if ($character -eq [char]34) {
            [void]$result.Append([char]92, 2 * $slashes + 1)
        } else { [void]$result.Append([char]92, $slashes) }
        [void]$result.Append($character)
        $slashes = 0
    }
    [void]$result.Append([char]92, 2 * $slashes)
    [void]$result.Append('"')
    return $result.ToString()
}

if ($env:OS -ne 'Windows_NT') { throw '此配置向导仅在被控 Windows 电脑上运行。' }
if ($SelfTest) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DesktopArgumentCheck {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);
}
'@
    foreach ($sample in @('', 'a b', 'a"b', 'trailing\', 'two\"quotes', '固定 密码 abc', '--option')) {
        $count = 0
        $memory = [DesktopArgumentCheck]::CommandLineToArgvW(('test.exe ' + (Quote-NativeArgument $sample)), [ref]$count)
        if ($memory -eq [IntPtr]::Zero) { throw 'Windows 参数解析失败。' }
        try {
            $item = [Runtime.InteropServices.Marshal]::ReadIntPtr($memory, [IntPtr]::Size)
            if ($count -ne 2 -or [Runtime.InteropServices.Marshal]::PtrToStringUni($item) -cne $sample) {
                throw '密码参数引用检查失败。'
            }
        } finally { [void][DesktopArgumentCheck]::LocalFree($memory) }
    }
    Write-Output 'PASS: Windows native argument round-trip; no settings changed.'
    exit 0
}

if (-not (Test-Path -LiteralPath $RustDesk -PathType Leaf)) { throw '请先用官方安装程序安装 RustDesk 1.5。' }
$program = Get-Item -LiteralPath $RustDesk
if ($program.VersionInfo.ProductName -notlike '*RustDesk*' -or $program.VersionInfo.ProductVersion -notmatch '^1\.5\.') {
    throw '本预览配置向导仅核验过官方 RustDesk 1.5。'
}
if ((Get-AuthenticodeSignature -LiteralPath $RustDesk).Status -ne 'Valid') { throw 'RustDesk 程序签名未通过核验。' }
if ((Get-Service RustDesk).Status -ne 'Running') { throw '请先完成 RustDesk 正式安装并启动服务。' }
if ($CheckOnly) {
    [ordered]@{ HostName=$env:COMPUTERNAME; RustDeskVersion=$program.VersionInfo.ProductVersion; Service='Running' } | ConvertTo-Json
    exit 0
}
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请在这台 Windows 电脑上以管理员身份运行首次配置向导。'
}

function Invoke-RustDesk([string[]]$Arguments) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $RustDesk
    $start.Arguments = (($Arguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' ')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        [void]$process.Start()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'RustDesk 配置超时。' }
        if ($process.ExitCode -ne 0) { throw 'RustDesk 拒绝了配置操作。' }
        return $output.Result.Trim()
    } finally {
        $start.Arguments = ''
        $process.Dispose()
    }
}

Add-Type -AssemblyName System.Windows.Forms
$password = $null
$enteredPassword = $null
try {
    $secret = $SetupPassword
    if (-not $secret) {
        . (Join-Path $PSScriptRoot 'credential-dialog.ps1')
        $title = if ($ManagedAccount) { 'GMSSH Windows · 修改连接密码' } elseif ($ChangePasswordOnly) { 'GMSSH Windows · 修改桌面密码' } else { 'GMSSH Windows · 首次桌面密码' }
        $description = if ($ManagedAccount) { '同时更新 SSH 与桌面的连接密码，原有 Windows 登录密码不变。' } else { '仅设置桌面连接密码，Windows 登录和 SSH 密码不变。' }
        try { $enteredPassword = Read-GMSSHPassword $title $description }
        catch {
            if ($ChangePasswordOnly -and $_.Exception.Message -ceq '已取消密码设置。') { return }
            throw
        }
        $secret = $enteredPassword
    }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if ($ManagedAccount) {
        if ($ManagedAccount -cne 'gmssh') { throw '只允许更新本程序管理的 gmssh 账号。' }
        $statePath = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'GMSSHWindowsBridge\agent.json'
        $state = Get-Content $statePath -Raw | ConvertFrom-Json
        $account = Get-LocalUser -Name gmssh
        if ($state.managedAccountSid -cne $account.SID.Value) { throw '本地账号身份与安装记录不一致。' }
        Set-LocalUser -Name gmssh -Password $secret
    }
    try {
        if ((Invoke-RustDesk @('--password', $password)) -cne 'Done!') {
            throw '固定密码未得到 RustDesk 成功确认，请检查管理员权限和 RustDesk 设置策略。'
        }
    } catch {
        if ($ManagedAccount) { throw 'SSH 密码已更新，桌面引擎未确认更新。请用同一个新密码重试。' }
        throw
    }
    $password = $null
    if ($ChangePasswordOnly) {
        $message = if ($ManagedAccount) { 'SSH 与桌面连接密码已修改。控制端下次连接请更新记住的密码。' } else { '桌面密码已修改。控制端下次连接请更新记住的密码。' }
        [void][Windows.Forms.MessageBox]::Show($message, 'GMSSH Windows')
        return
    }
    $options = [ordered]@{
        'whitelist'='127.0.0.1'
        'direct-access-port'='21118'
        'verification-method'='use-permanent-password'
        'approve-mode'='password'
        'direct-server'='Y'
        'custom-rendezvous-server'='127.0.0.1'
        'relay-server'='127.0.0.1'
    }
    foreach ($name in $options.Keys) {
        [void](Invoke-RustDesk @('--option', $name, $options[$name]))
        if ((Invoke-RustDesk @('--option', $name)) -cne $options[$name]) {
            throw "固定密码已提交，但 $name 未通过回读。请在 RustDesk 正常设置界面核对后再连接。"
        }
    }
    Write-Host '固定密码和访问选项已配置。请在 GMSSH 首次连接时输入这个密码并记住；真实连接通过后才算验收完成。'
    Set-Service RustDesk -StartupType Automatic
    Write-Host "设备名称：$env:COMPUTERNAME"
} finally {
    $password = $null
    $secret = $null
    if ($enteredPassword) { $enteredPassword.Dispose() }
}
