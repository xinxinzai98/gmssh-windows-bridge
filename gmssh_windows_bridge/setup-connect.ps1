#requires -Version 5.1
# Connection-code support. Call mutating functions only after normal elevation.
function Get-GMSSHConnectHelper([string]$ProgramRoot) {
    $file = Join-Path $ProgramRoot 'gmssh-connect.exe'
    $manifest = Join-Path $ProgramRoot 'connect-payload.json'
    foreach ($path in @($ProgramRoot,$file,$manifest)) {
        if (-not (Test-Path -LiteralPath $path) -or ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '一键接入组件缺失，请运行升级 / 修复。' }
    }
    $metadata = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if ($metadata.filename -cne 'gmssh-connect.exe' -or $metadata.protocol -ne 1 -or $metadata.sha256 -notmatch '^[a-f0-9]{64}$' -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $metadata.sha256) { throw '一键接入组件未通过完整性检查。' }
    $file
}

function Get-GMSSHConnectState([string]$DataRoot) {
    if ((Get-Item -LiteralPath $DataRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '本机接入目录不可信。' }
    $state = Get-Content -LiteralPath (Join-Path $DataRoot 'agent.json') -Raw | ConvertFrom-Json
    $account = Get-LocalUser -Name $state.username -ErrorAction Stop
    $preserved=$state.installationMode -ceq 'preserve-existing'
    $boundSid=if($preserved){$state.accountSid}else{$state.managedAccountSid}
    $validMode=if($preserved){-not $state.unifiedPassword -and -not $state.managedAccountSid}else{$state.unifiedPassword -and $state.username -ceq 'gmssh' -and $state.installationMode -in @($null,'','managed')}
    if (-not $validMode -or $state.computer -ine [Environment]::MachineName -or
        -not $account.Enabled -or $account.SID.Value -cne $boundSid -or $state.trayUserSid -notmatch '^S-1-[0-9]+(?:-[0-9]+){1,15}$') {
        throw '接入模式或本地账号身份无法核对，请保留手动添加。'
    }
    $state
}

function Invoke-GMSSHConnectHelper {
    param([string]$ProgramRoot,[string]$DataRoot,[ValidateSet('init','code','reset','revoke','status','qr','manage')][string]$Operation,[string]$InputJson)
    $file = Get-GMSSHConnectHelper $ProgramRoot
    $directory = [IO.Path]::GetFullPath($DataRoot)
    if ($directory -match '["\x00-\x1f]') { throw '接入目录无效。' }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $file
    $start.Arguments = $Operation + ' --state "' + $directory + '"'
    if ($Operation -eq 'code' -and $InputJson) { $start.Arguments += ' --connection-stdin' }
    $start.WorkingDirectory = $ProgramRoot
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $start.RedirectStandardOutput = $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw '无法启动一键接入组件。' }
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if ($InputJson) {
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes($InputJson)
            try { $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length); $process.StandardInput.BaseStream.Flush() }
            finally { [Array]::Clear($bytes,0,$bytes.Length) }
        }
        $process.StandardInput.Close()
        $waitMilliseconds = if ($Operation -eq 'status') { 3000 } elseif ($Operation -eq 'init') { 25000 } else { 15000 }
        if($Operation -eq 'init' -and ('System.Windows.Forms.Application' -as [type])){
            $deadline=[DateTime]::UtcNow.AddMilliseconds($waitMilliseconds)
            while(-not $process.WaitForExit(100)){
                [Windows.Forms.Application]::DoEvents()
                if([DateTime]::UtcNow -ge $deadline){$process.Kill();throw '一键接入操作超时。'}
            }
        } elseif (-not $process.WaitForExit($waitMilliseconds)) { $process.Kill(); throw '一键接入操作超时。' }
        $output = $stdout.GetAwaiter().GetResult().Trim()
        $failureCode = $stderr.GetAwaiter().GetResult().Trim()
        if ($process.ExitCode -ne 0) {
            # Never display arbitrary stderr; it may contain native paths or input.
            $message = switch -CaseSensitive ($failureCode) {
                'GMSSH_ERR_CREDENTIAL' { '现有 Windows 账号密码未通过验证。请输入账号密码，不是 Windows Hello PIN；本次未修改密码。' }
                'GMSSH_ERR_DESKTOP_CREDENTIAL' { 'Windows 账号密码已通过验证，但现有 RustDesk 固定密码未通过桌面验证。两份密码可以不同；原密码、已保存凭据和连接码均未修改。' }
                'GMSSH_ERR_DESKTOP_UNAVAILABLE' { '无法确认现有 RustDesk 的桌面认证。请检查桌面服务和直接 IP 访问；需人工批准或额外验证时先在原客户端核对。已保存凭据和连接码均未修改。' }
                'GMSSH_ERR_INSTALL_BINDING' { '连接文件与安装记录未通过身份核对，请运行本版本的升级 / 修复。' }
                'GMSSH_ERR_MACHINE_BINDING' { '安装记录与当前电脑不匹配，已停止接入。' }
                'GMSSH_ERR_ACCOUNT_BINDING' { '现有 Windows 账号 SID 与安装记录不匹配，已停止接入。' }
                'GMSSH_ERR_ADMIN_BINDING' { '接入组件未能确认原账号的管理员组身份，已停止接入；请运行升级 / 修复，不会提升账号权限。' }
                default { '一键接入未完成，请检查连接密码或运行升级 / 修复。' }
            }
            throw $message
        }
        if ($output.Length -gt $(if ($Operation -eq 'manage') { 65536 } else { 32768 })) { throw '一键接入响应超出限制。' }
        $output
    } finally { $InputJson = $null; $process.Dispose() }
}

function Get-GMSSHConnectHealth {
    param([string]$ProgramRoot,[string]$DataRoot,[switch]$Wait)
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $DataRoot 'private\connect-meta.dat'))) {
            return [pscustomobject]@{ready=$false;state='未启用';detail='首次使用时点击复制连接码并验证现有密码'}
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(6)
        while ($true) {
            $ready = $false
            try { $ready = (Invoke-GMSSHConnectHelper -ProgramRoot $ProgramRoot -DataRoot $DataRoot -Operation status) -ceq 'ready' } catch {}
            if ($ready) { break }
            if (-not $Wait -or [DateTime]::UtcNow -ge $deadline) { throw 'Unavailable' }
            Start-Sleep -Milliseconds 250
        }
        [pscustomobject]@{ready=$true;state='运行中';detail='已核对本机 HTTPS 身份和加密凭据存储；密码在实际连接时验证'}
    } catch {
        [pscustomobject]@{ready=$false;state='未就绪';detail='检查连接码任务、TCP 22257 和设备身份，必要时运行升级 / 修复'}
    }
}

function Set-GMSSHConnectPrivateAccess([string]$DataRoot,[string]$OwnerSid) {
    $folder = Join-Path $DataRoot 'private'
    if (Test-Path -LiteralPath $folder) {
        if ((Get-Item -LiteralPath $folder).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '私有接入目录包含重解析点。' }
    } else { New-Item -ItemType Directory -Path $folder -ErrorAction Stop | Out-Null }
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    $none = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $security = New-Object Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true,$false)
    foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
        $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl',$inherit,$none,$allow))
    }
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($OwnerSid),'ReadAndExecute',[Security.AccessControl.InheritanceFlags]::None,$none,$allow))
    Set-Acl -LiteralPath $folder -AclObject $security
    foreach ($name in @('connect-meta.dat','connect-password.dat','connect-identity.dat')) {
        $file = Join-Path $folder $name
        if (-not (Test-Path -LiteralPath $file)) { continue }
        if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '私有接入文件包含重解析点。' }
        $access = New-Object Security.AccessControl.FileSecurity
        $access.SetAccessRuleProtection($true,$false)
        foreach ($sid in @('S-1-5-18','S-1-5-32-544')) { $access.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl',$allow)) }
        if ($name -eq 'connect-meta.dat') { $access.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($OwnerSid),'Read',$allow)) }
        Set-Acl -LiteralPath $file -AclObject $access
    }
}

function Get-GMSSHConnectTask([string]$ProgramRoot,[string]$DataRoot) {
    $file = Join-Path $ProgramRoot 'gmssh-connect.exe'
    $arguments = 'serve --state "' + [IO.Path]::GetFullPath($DataRoot) + '"'
    $task = Get-ScheduledTask -TaskName 'GMSSH Windows Connect' -TaskPath '\' -ErrorAction SilentlyContinue
    if ($task -and (@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine $file -or $task.Actions[0].Arguments -cne $arguments -or
        (ConvertTo-GMSSHUserSid $task.Principal.UserId) -cne 'S-1-5-18' -or $task.Principal.LogonType -ne 'ServiceAccount')) { throw '同名一键接入任务属于其他程序，已停止操作。' }
    $task
}

function Get-GMSSHConnectRule([string]$ProgramRoot) {
    $file = Join-Path $ProgramRoot 'gmssh-connect.exe'
    $rule = Get-NetFirewallRule -Name 'GMSSH-Windows-Connect' -ErrorAction SilentlyContinue
    if ($rule) {
        $ports = $rule | Get-NetFirewallPortFilter; $addresses = $rule | Get-NetFirewallAddressFilter; $application = $rule | Get-NetFirewallApplicationFilter
        if ($rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow' -or [string]$ports.LocalPort -ne '22257' -or [string]$ports.Protocol -notin @('TCP','6') -or
            @($addresses.RemoteAddress).Count -ne 1 -or $addresses.RemoteAddress -cne 'LocalSubnet' -or $application.Program -ine $file) { throw '同名接入防火墙规则属于其他配置，已停止操作。' }
    }
    $rule
}

function Register-GMSSHConnectTask {
    param([string]$ProgramRoot,[string]$DataRoot,[switch]$ValidateOnly)
    $file = Get-GMSSHConnectHelper $ProgramRoot
    if (@(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { [string]$_.Enabled -ne 'True' }).Count) { throw 'Windows 防火墙未全部启用，请保留手动添加并先检查防火墙。' }
    $arguments = 'serve --state "' + [IO.Path]::GetFullPath($DataRoot) + '"'
    $task = Get-GMSSHConnectTask $ProgramRoot $DataRoot
    $rule = Get-GMSSHConnectRule $ProgramRoot
    if ($ValidateOnly) { return $task }
    if (-not $rule) {
        New-NetFirewallRule -Name 'GMSSH-Windows-Connect' -DisplayName 'GMSSH connection codes from the local subnet' -Enabled True -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22257 -RemoteAddress LocalSubnet -Program $file -Profile Any | Out-Null
    } elseif ([string]$rule.Enabled -ne 'True') { Enable-NetFirewallRule -Name 'GMSSH-Windows-Connect' | Out-Null }
    $action = New-ScheduledTaskAction -Execute $file -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName 'GMSSH Windows Connect' -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'GMSSH local-network connection code exchange' -Force | Out-Null
    Start-ScheduledTask -TaskName 'GMSSH Windows Connect' -TaskPath '\'
}

function Stop-GMSSHConnectTask([string]$ProgramRoot,[string]$DataRoot) {
    $task = Get-GMSSHConnectTask $ProgramRoot $DataRoot
    if (-not $task) { return }
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName 'GMSSH Windows Connect' -TaskPath '\' }
    $file = Join-Path $ProgramRoot 'gmssh-connect.exe'
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ($true) {
        if ((Get-ScheduledTask -TaskName 'GMSSH Windows Connect' -TaskPath '\').State -ne 'Running') {
            # Ready may precede executable-image release. Do not copy or reinitialize yet.
            try {
                $handle = [IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
                $handle.Dispose()
                return
            } catch [IO.IOException] { }
        }
        if ([DateTime]::UtcNow -ge $deadline) { throw '原一键接入程序仍被占用，已停止更新，请稍后重试。' }
        Start-Sleep -Milliseconds 100
    }
}

function Set-GMSSHConnectPassword([string]$ProgramRoot,[string]$DataRoot,[Security.SecureString]$Password,[Security.SecureString]$DesktopPassword=$null) {
    $state = Get-GMSSHConnectState $DataRoot
    $task = Register-GMSSHConnectTask -ProgramRoot $ProgramRoot -DataRoot $DataRoot -ValidateOnly
    $wasRunning = [bool]($task -and $task.State -eq 'Running')
    Set-GMSSHConnectPrivateAccess $DataRoot $state.trayUserSid
    Stop-GMSSHConnectTask $ProgramRoot $DataRoot
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
    $desktopPointer = [IntPtr]::Zero
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        $credentials=@{password=$plain}
        if($DesktopPassword){$desktopPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($DesktopPassword);$desktopPlain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($desktopPointer);$credentials.desktopPassword=$desktopPlain}
        $inputJson = $credentials | ConvertTo-Json -Compress
        if ((Invoke-GMSSHConnectHelper -ProgramRoot $ProgramRoot -DataRoot $DataRoot -Operation init -InputJson $inputJson) -cne 'ok') { throw '一键接入未确认保存。' }
    } catch {
        if ($wasRunning) { Start-ScheduledTask -TaskName 'GMSSH Windows Connect' -TaskPath '\' -ErrorAction SilentlyContinue }
        throw
    } finally { $plain=$null; $desktopPlain=$null; $credentials=$null; $inputJson=$null; [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer);if($desktopPointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($desktopPointer)} }
    try {
        Set-GMSSHConnectPrivateAccess $DataRoot $state.trayUserSid
        Register-GMSSHConnectTask -ProgramRoot $ProgramRoot -DataRoot $DataRoot
    } catch { throw '凭据已经保存，但 GMSSH 后台接入服务恢复未完成。请点击「启用 GMSSH 接入」或运行接入自检，无需重新输入密码。' }
}

function Enable-GMSSHExistingCredentials([string]$ProgramRoot,[string]$DataRoot) {
    $state=Get-GMSSHConnectState $DataRoot
    if($state.installationMode -cne 'preserve-existing'){throw '此操作仅用于保留现有服务的接入。'}
    . (Join-Path $ProgramRoot 'credential-dialog.ps1')
    $sshSecret=$null;$desktopSecret=$null;$progress=$null
    try {
        $sshSecret=Read-GMSSHPassword 'GMSSH Windows · 既有账号' ('请输入 '+$state.username+' 现有的 Windows 账号密码，不是 PIN。只验证和加密保存，不修改账号密码。') $false $true
        $desktopSecret=Read-GMSSHPassword 'GMSSH Windows · 既有桌面' '请输入现有 RustDesk 固定连接密码，可以与 Windows 账号密码不同。桌面认证通过后才保存；不会修改原软件的密码。' $false $true
        $progress=Show-GMSSHCredentialProgress
        Set-GMSSHConnectPassword $ProgramRoot $DataRoot $sshSecret $desktopSecret
        $health=Get-GMSSHConnectHealth -ProgramRoot $ProgramRoot -DataRoot $DataRoot -Wait
        if(-not $health.ready){throw '凭据已经保存，但 GMSSH 后台接入服务尚未就绪。请点击「启用 GMSSH 接入」或运行接入自检，无需重新输入密码。'}
        $progress.Text='GMSSH Windows · 接入凭据已更新';$progress.UseWaitCursor=$false
        Show-GMSSHNotice 'GMSSH Windows · 接入凭据已更新' "Windows 账号与 RustDesk 桌面验证均已通过。`r`n凭据已加密保存，GMSSH 后台接入服务已就绪。`r`n`r`n原 Windows 和 RustDesk 密码未修改。`r`n旧 SSH 接入码已刷新，现有独立授权保留。" 'Information' $progress
    } finally {if($progress){$progress.Close();$progress.Dispose()};if($sshSecret){$sshSecret.Dispose()};if($desktopSecret){$desktopSecret.Dispose()}}
}

function Get-GMSSHConnectCode([string]$ProgramRoot,[string]$DataRoot,[string]$Address) {
    $info = Get-GMSSHConnectionInfo -DataRoot $DataRoot
    if ($Address) {
        $parsed = $null
        if (-not [Net.IPAddress]::TryParse($Address,[ref]$parsed)) { throw '提供的连接地址无效。' }
        $info.addresses = @($parsed.ToString())
    }
    $public = $info | ConvertTo-Json -Depth 5 -Compress
    $code = Invoke-GMSSHConnectHelper -ProgramRoot $ProgramRoot -DataRoot $DataRoot -Operation code -InputJson $public
    if ($code -notmatch '^GMSSH-CONNECT1\.[A-Za-z0-9_-]+$') { throw '连接码尚未生成，请先启用一键接入。' }
    $code
}

function Reset-GMSSHConnectCode([string]$ProgramRoot,[string]$DataRoot) {
    $state = Get-GMSSHConnectState $DataRoot
    $task = Register-GMSSHConnectTask -ProgramRoot $ProgramRoot -DataRoot $DataRoot -ValidateOnly
    $wasRunning = [bool]($task -and $task.State -eq 'Running')
    Stop-GMSSHConnectTask $ProgramRoot $DataRoot
    try {
        if ((Invoke-GMSSHConnectHelper -ProgramRoot $ProgramRoot -DataRoot $DataRoot -Operation reset) -cne 'ok') { throw '连接码未确认重置。' }
        Set-GMSSHConnectPrivateAccess $DataRoot $state.trayUserSid
    } finally { if ($wasRunning) { Start-ScheduledTask -TaskName 'GMSSH Windows Connect' -TaskPath '\' } }
}
