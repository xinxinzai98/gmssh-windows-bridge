#requires -Version 5.1
# Read-only setup checks. No account, service, password or firewall changes.
. (Join-Path $PSScriptRoot 'setup-existing.ps1')
function Test-GMSSHHostKeyDirectory([string]$Path) {
    if (-not (Test-Path $Path)) { return $true }
    $directory = Get-Item -LiteralPath $Path
    if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
    $items = @(Get-ChildItem -LiteralPath $Path -Force)
    if (-not $items.Count) { return $true }
    # A clean reinstall may preserve only complete, standard OS host-key pairs.
    # The SSH server still validates the actual keys and their ACL during startup.
    if (@($items | Where-Object { $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $_.Length -eq 0 -or $_.Name -notmatch '^ssh_host_(rsa|ecdsa|ed25519)_key(\.pub)?$' }).Count) { return $false }
    foreach ($item in $items) {
        $name = $item.Name -replace '\.pub$',''
        if ($items.Name -notcontains $name -or $items.Name -notcontains ($name+'.pub')) { return $false }
    }
    return $true
}

function Get-GMSSHAddresses {
    $ipv4 = @(); $ipv6 = @()
    foreach ($row in (Get-NetIPAddress -ErrorAction Stop)) {
        if ([string]$row.AddressState -notin @('Preferred','Deprecated')) { continue }
        $address = $null
        if (-not [Net.IPAddress]::TryParse([string]$row.IPAddress,[ref]$address) -or
            [Net.IPAddress]::IsLoopback($address)) { continue }
        if ($address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) {
            # A remote interface index cannot be reused as the controller's scope ID.
            if ($address.IsIPv6LinkLocal -or $address.IsIPv6Multicast -or $address.IsIPv4MappedToIPv6 -or
                $address.Equals([Net.IPAddress]::IPv6Any) -or $address.ScopeId -ne 0) { continue }
            $ipv6 += $address.ToString().ToLowerInvariant()
        } else {
            $bytes = $address.GetAddressBytes()
            if ($bytes[0] -eq 0 -or $bytes[0] -ge 224 -or ($bytes[0] -eq 169 -and $bytes[1] -eq 254)) { continue }
            $ipv4 += $address.ToString()
        }
    }
    @($ipv4 + $ipv6) | Select-Object -Unique
}

function Get-GMSSHConnectionInfo {
    param([string]$DataRoot = (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'GMSSHWindowsBridge'))
    $public = Get-Content (Join-Path $DataRoot 'connection.json') -Raw | ConvertFrom-Json
    $public.addresses = @(Get-GMSSHAddresses)
    $ssh = Get-Service sshd -ErrorAction SilentlyContinue
    $public.sshStatus = if ($ssh) { [string]$ssh.Status } else { 'NotInstalled' }
    $public.sshStartup = if ($ssh) { [string]$ssh.StartType } else { '' }
    $desktopAuth = 'manual'
    try {
        $agent = Get-Content (Join-Path $DataRoot 'agent.json') -Raw -ErrorAction Stop | ConvertFrom-Json
        $account = Get-LocalUser -Name $public.username -ErrorAction Stop
        if ($agent.unifiedPassword -eq $true -and $agent.username -ceq $public.username -and $agent.managedAccountSid -ceq $account.SID.Value) { $desktopAuth = 'shared-ssh' }
    } catch { }
    $public | Add-Member -NotePropertyName desktopAuth -NotePropertyValue $desktopAuth -Force
    $public
}

function Get-GMSSHStartupStatus {
    param([string]$DataRoot = (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'GMSSHWindowsBridge'))
    $agent = Get-Content (Join-Path $DataRoot 'agent.json') -Raw | ConvertFrom-Json
    $public = Get-GMSSHConnectionInfo -DataRoot $DataRoot
    $ssh = Get-Service sshd -ErrorAction SilentlyContinue
    $desktop = Get-Service RustDesk -ErrorAction SilentlyContinue
    $boot = $null
    try { $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o') } catch { }
    [ordered]@{schema=1;computer=[Environment]::MachineName;version=$agent.version;checkedAt=[DateTime]::UtcNow.ToString('o');
        bootedAt=$boot;addresses=@($public.addresses);sshStatus=[string]$ssh.Status;sshStartup=[string]$ssh.StartType;
        desktopStatus=[string]$desktop.Status;desktopStartup=[string]$desktop.StartType;
        servicesReady=([bool]($ssh -and $desktop -and $ssh.Status -eq 'Running' -and $desktop.Status -eq 'Running' -and $ssh.StartType -eq 'Automatic' -and $desktop.StartType -eq 'Automatic'));
        desktopAuth=$public.desktopAuth;scope='interactive-user-startup; full administrator check is separate'}
}

function ConvertTo-GMSSHUserSid([string]$User) {
    if ($User -match '^S-1-[0-9]+(?:-[0-9]+){1,15}$') { return $User }
    try { return (New-Object Security.Principal.NTAccount($User)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { return '' }
}

function Get-GMSSHInstallPlan {
    param([string]$SetupRoot, [bool]$Dedicated, [bool]$MonitorOnly, [bool]$TrayOnly, [bool]$PreserveExisting=$false, [string]$WindowsUser=$env:USERNAME,
          [string]$DataRoot = (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'GMSSHWindowsBridge'),
          [string]$ProgramRoot = (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'GMSSHWindowsBridge'),
          [string]$SSHRoot = (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'ssh'))
    if ($env:OS -ne 'Windows_NT' -or [Environment]::OSVersion.Version.Major -lt 10) { throw '需要 Windows 10 / Windows Server 2016 或更新版本。' }
    $agentPath = Join-Path $DataRoot 'agent.json'
    $connectionPath = Join-Path $DataRoot 'connection.json'
    if (Test-Path $agentPath) {
        $agent = Get-Content $agentPath -Raw | ConvertFrom-Json
        $connection = Get-Content $connectionPath -Raw | ConvertFrom-Json
        $account = Get-LocalUser -Name $agent.username -ErrorAction SilentlyContinue
        if ($agent.computer -ine [Environment]::MachineName -or $connection.computer -ine $agent.computer -or
            $connection.username -cne $agent.username -or -not $account -or
            ($agent.managedAccountSid -and $agent.managedAccountSid -cne $account.SID.Value) -or
            ($agent.installationMode -ceq 'preserve-existing' -and $agent.accountSid -cne $account.SID.Value) -or
            (-not (Test-Path (Join-Path $ProgramRoot 'gmssh-agent.ps1')) -and -not (Test-Path (Join-Path $DataRoot 'uninstall.json')))) {
            throw '现有安装记录不完整或账号身份已变化。本次不会覆盖账号、密码和配置，请先检查原安装。'
        }
        if(Test-Path (Join-Path $DataRoot 'uninstall.json')){
            if(Test-Path -LiteralPath $ProgramRoot){throw '卸载恢复记录与现有程序目录冲突，请保留现场并核对。'}
            . (Join-Path $SetupRoot 'setup-uninstall.ps1')
            [void](Get-GMSSHUninstallRecord $ProgramRoot $DataRoot)
            return 'Uninstalled'
        }
        return 'Existing'
    }
    if (-not [Environment]::Is64BitProcess -or @(Get-CimInstance Win32_Processor | Where-Object Architecture -ne 9).Count) {
        throw '当前离线安装包需要 x64 Windows 和 64 位 Windows PowerShell。'
    }
    if ($Dedicated -and (Get-LocalUser -Name gmssh -ErrorAction SilentlyContinue)) { throw '本机已有 gmssh 账号，安装不会覆盖其密码。请先由管理员确认此账号用途。' }
    if ($Dedicated -and ((Test-Path $connectionPath) -or (Test-Path $ProgramRoot))) { throw '发现已有或未完成的 GMSSH 安装，本次不会覆盖。请保留现场并检查原安装结果。' }
    if ($PreserveExisting) {
        if ($Dedicated -or $MonitorOnly -or $TrayOnly -or (Test-Path $DataRoot) -or (Test-Path $ProgramRoot)) { throw '保留模式参数冲突或 GMSSH 目录已存在，本次未覆盖。' }
        [void](Get-GMSSHExistingServices -WindowsUser $WindowsUser -SSHRoot $SSHRoot)
        if(@(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object {[string]$_.Enabled -ne 'True'}).Count){throw '保留模式需要 Windows 防火墙已启用，本次未修改。'}
    }
    if (-not $TrayOnly -and -not $PreserveExisting) {
        $sshData = $SSHRoot
        $ssh = Get-Service sshd -ErrorAction SilentlyContinue
        if (($ssh -and $ssh.Status -ne 'Stopped') -or (Test-Path (Join-Path $sshData 'sshd_config')) -or
            -not (Test-GMSSHHostKeyDirectory $sshData) -or
            (Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue) -or
            (Get-NetFirewallRule -Name 'GMSSH-Windows-Monitor-SSH' -ErrorAction SilentlyContinue)) {
            throw '发现已有 SSH 服务、配置或端口占用。本次尚未创建账号或安装组件，请先由管理员核对现有 SSH。'
        }
        if (@(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { [string]$_.Enabled -ne 'True' }).Count) { throw 'Windows 防火墙未全部启用，请先检查防火墙状态。' }
    }
    if ($Dedicated -and (Get-Service RustDesk -ErrorAction SilentlyContinue)) { throw '发现独立的桌面服务，本次不会重设其密码。已有桌面请使用保留模式。' }
    $manifest = Get-Content (Join-Path $SetupRoot 'windows-installers.json') -Raw | ConvertFrom-Json
    $runtimeSource = 'bundled'
    $setupConfig = Join-Path $SetupRoot 'setup-config.json'
    if (Test-Path $setupConfig) {
        $settings = Get-Content $setupConfig -Raw | ConvertFrom-Json
        if ($settings.runtimeSource) { $runtimeSource = $settings.runtimeSource }
    }
    if ($runtimeSource -notin @('bundled','microsoft')) { throw '运行库来源配置无效。' }
    foreach ($name in @('openssh','vcredist')) {
        $item = $manifest.$name
        if ($item.filename -notmatch '^[a-zA-Z0-9_.-]+$' -or $item.sha256 -notmatch '^[a-f0-9]{64}$') { throw '离线组件清单无效。' }
        $file = Join-Path $SetupRoot ('installers\' + $item.filename)
        if ($name -eq 'vcredist' -and $runtimeSource -ceq 'microsoft' -and -not (Test-Path $file)) {
            $uri = [uri]$item.url
            $required = $null
            if ($item.filename -cne 'VC_redist.x64.exe' -or $uri.Scheme -cne 'https' -or
                $uri.Host -cne 'download.visualstudio.microsoft.com' -or
                -not [version]::TryParse([string]$item.version, [ref]$required)) { throw '微软运行库下载清单无效。' }
            continue
        }
        if (-not (Test-Path $file) -or (Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item.sha256 -or
            (Get-AuthenticodeSignature $file).Status -ne 'Valid') { throw ('离线组件缺失或校验失败：' + $item.filename) }
    }
    if (-not $MonitorOnly) {
        if (Test-Path (Join-Path $SetupRoot 'setup-connect.ps1')) {
            . (Join-Path $SetupRoot 'setup-connect.ps1')
            [void](Get-GMSSHConnectHelper $SetupRoot)
            if (($Dedicated -or $PreserveExisting) -and ((Get-GMSSHConnectTask $ProgramRoot $DataRoot) -or (Get-GMSSHConnectRule $ProgramRoot) -or
                (Get-NetTCPConnection -State Listen -LocalPort 22257 -ErrorAction SilentlyContinue))) { throw '一键接入任务、规则或端口已被占用，本次尚未创建账号。' }
        }
        $payload = Get-Content (Join-Path $SetupRoot 'desktop-payload.json') -Raw | ConvertFrom-Json
        if ($payload.filename -cne 'desktop-engine.zip' -or $payload.sourceSha256 -cne $manifest.rustdesk.sha256 -or
            (Get-FileHash (Join-Path $SetupRoot 'desktop-engine.zip') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $payload.sha256) { throw '离线桌面组件校验失败。' }
    }
    if ($PreserveExisting) { return 'PreserveExisting' }
    return 'New'
}

function Test-GMSSHRuntimeInstalled {
    param([version]$Required)
    $installed = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
    $current = $null
    if (-not $installed -or $installed.Installed -ne 1 -or
        -not [version]::TryParse(([string]$installed.Version).TrimStart('v'), [ref]$current) -or $current -lt $Required) { return $false }
    foreach ($name in @('msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll')) {
        if (-not (Test-Path (Join-Path ([Environment]::SystemDirectory) $name))) { return $false }
    }
    return $true
}

function Get-GMSSHReadiness {
    param([bool]$MonitorOnly = $false,
          [string]$DataRoot = (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'GMSSHWindowsBridge'),
          [string]$ProgramRoot = (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'GMSSHWindowsBridge'),
          [string]$SSHRoot = (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'ssh'))
    $checks = New-Object 'Collections.Generic.List[object]'
    function Add-Check([string]$Name, [bool]$Ok, [string]$Detail) { $checks.Add([ordered]@{name=$Name;ok=$Ok;detail=$Detail}) }
    $connection = Get-Content (Join-Path $DataRoot 'connection.json') -Raw | ConvertFrom-Json
    $agent=$null
    if(-not $MonitorOnly){$agent=Get-Content (Join-Path $DataRoot 'agent.json') -Raw | ConvertFrom-Json}
    $preserved=$agent -and $agent.installationMode -ceq 'preserve-existing'
    $sshPort=if($connection.sshPort){[int]$connection.sshPort}else{22}
    $ssh = Get-Service sshd -ErrorAction SilentlyContinue
    Add-Check 'SSH 服务' ([bool]($ssh -and $ssh.Status -eq 'Running' -and $ssh.StartType -eq 'Automatic')) '应运行并自动启动'
    $ports = @(Get-NetTCPConnection -State Listen -LocalPort $sshPort,21118 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique)
    Add-Check 'SSH 端口' ($ports -contains $sshPort) ('TCP '+$sshPort+' 本机监听')
    $sshData = $SSHRoot
    if($preserved){
        try{
            $profile=Get-GMSSHExistingServices -WindowsUser $connection.username
            Add-Check '文件互传与桌面隧道' $true '既有 SSH 有效配置的 SFTP 与本机转发检查'
            Add-Check '主机身份' ($profile.sshHostPublicKey -ceq $connection.sshHostPublicKey -and $connection.sshHostFingerprint.Contains($profile.sshHostFingerprint)) '既有服务实际公钥与连接文件一致'
            Add-Check '既有服务身份' ($profile.accountSid -ceq $agent.accountSid -and $profile.sshBinary -ieq $connection.sshBinary -and $profile.sshConfig -ieq $connection.sshConfig -and $profile.sshPort -eq $sshPort -and $profile.engine -ieq $agent.engine) '服务、端口与账号仍匹配保留接入记录'
        }catch{Add-Check '既有服务配置与身份' $false '原服务状态或身份变化，请由原管理员核对；本次未修改'}
    } else { try {
        $config = Get-Content (Join-Path $sshData 'sshd_config') -Raw
        Add-Check '文件互传' ($config -match '(?m)^\s*Subsystem\s+sftp\s+sftp-server\.exe\s*$') 'SFTP 子系统配置'
        $public = (Get-Content (Join-Path $sshData 'ssh_host_ed25519_key.pub') -Raw).Trim()
        $hash = [Security.Cryptography.SHA256]::Create()
        try { $fingerprint = 'SHA256:' + [Convert]::ToBase64String($hash.ComputeHash([Convert]::FromBase64String($public.Split(' ')[1]))).TrimEnd('=') }
        finally { $hash.Dispose() }
        Add-Check '主机身份' ($public -ceq $connection.sshHostPublicKey -and $connection.sshHostFingerprint.Contains($fingerprint)) '实际公钥与连接文件一致'
    } catch { Add-Check 'SSH 配置与身份' $false '无法读取或核验 SSH 配置，请使用管理员自检' } }
    $account = Get-LocalUser -Name $connection.username -ErrorAction SilentlyContinue
    Add-Check '连接账号' ([bool]($account -and $account.Enabled)) '账号存在且已启用'
    $rule = Get-NetFirewallRule -Name 'GMSSH-Windows-Monitor-SSH' -ErrorAction SilentlyContinue
    $filter = if ($rule) { $rule | Get-NetFirewallAddressFilter }
    $portFilter = if ($rule) { $rule | Get-NetFirewallPortFilter }
    $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { [string]$_.Enabled -ne 'True' })
    if($preserved){Add-Check '防火墙状态' (-not $profiles.Count) '保留原 SSH 与桌面规则；实际局域网访问需要控制端验证'}else{
    Add-Check '局域网防火墙' ([bool]($rule -and [string]$rule.Enabled -eq 'True' -and $rule.Direction -eq 'Inbound' -and $rule.Action -eq 'Allow' -and
        @($filter.RemoteAddress).Count -eq 1 -and $filter.RemoteAddress -eq $connection.controller -and
        [string]$portFilter.LocalPort -eq '22' -and [string]$portFilter.Protocol -in @('TCP','6') -and -not $profiles.Count)) '安装器的 SSH 规则及防火墙状态' }
    if (-not $MonitorOnly) {
        $agent = Get-Content (Join-Path $DataRoot 'agent.json') -Raw | ConvertFrom-Json
        if ($agent.unifiedPassword -or $preserved) {
            try {
                . (Join-Path $ProgramRoot 'setup-connect.ps1')
                $codeHealth = Get-GMSSHConnectHealth $ProgramRoot $DataRoot -Wait
                Add-Check '连接码服务' $codeHealth.ready $codeHealth.detail
                $codeTask = Get-GMSSHConnectTask $ProgramRoot $DataRoot
                Add-Check '连接码开机任务' ([bool]($codeTask -and $codeTask.State -eq 'Running')) '本程序的 SYSTEM 开机任务应运行'
                $codeRule = Get-GMSSHConnectRule $ProgramRoot
                Add-Check '连接码局域网规则' ([bool]($codeRule -and [string]$codeRule.Enabled -eq 'True')) '本程序的 TCP 22257 局域网规则应启用'
            } catch { Add-Check '连接码服务与配置' $false '无法核对，请使用管理员自检或运行升级 / 修复' }
        }
        Add-Check '安装账号身份' ([bool]($account -and $agent.computer -ieq [Environment]::MachineName -and $agent.username -ceq $connection.username -and
            (-not $agent.managedAccountSid -or $agent.managedAccountSid -ceq $account.SID.Value))) '保留安装记录中的账号身份'
        if ($agent.accountRole -eq 'Administrator') {
            $administrators = Get-LocalGroup -SID 'S-1-5-32-544'
            Add-Check '管理权限' ([bool](Get-LocalGroupMember -Group $administrators.Name | Where-Object { $_.SID.Value -eq $account.SID.Value })) '专用账号仍在管理员组中'
        }
        $desktop = Get-Service RustDesk -ErrorAction SilentlyContinue
        Add-Check '桌面服务' ([bool]($desktop -and $desktop.Status -eq 'Running' -and $desktop.StartType -eq 'Automatic')) '应运行并自动启动'
        Add-Check '桌面端口' ($ports -contains 21118) 'TCP 21118 本机监听，实际连接经 SSH 隧道'
        $task = Get-ScheduledTask -TaskName 'GMSSH Windows Tray' -TaskPath '\' -ErrorAction SilentlyContinue
        $powerShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
        $arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $ProgramRoot 'gmssh-agent.ps1') + '"'
        Add-Check '托盘自启' ([bool]($task -and @($task.Actions).Count -eq 1 -and $task.Actions[0].Execute -ieq $powerShell -and
            $task.Actions[0].Arguments -ceq $arguments -and $task.State -ne 'Disabled')) '登录任务指向本程序'
        $traySid = [string]$agent.trayUserSid
        $principalMatches = $task -and $traySid -match '^S-1-[0-9]+(?:-[0-9]+){1,15}$' -and (ConvertTo-GMSSHUserSid $task.Principal.UserId) -ceq $traySid
        $logon = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.Enabled -and (ConvertTo-GMSSHUserSid $_.UserId) -ceq $traySid })
        Add-Check '托盘登录用户' ([bool]($principalMatches -and $logon.Count -gt 0 -and $task.Principal.LogonType -eq 'Interactive')) '原用户登录时启动，不依赖安装窗口'
    }
    $addresses = @(Get-GMSSHAddresses)
    Add-Check '网络地址' ($addresses.Count -gt 0) '当前可用 IPv4 / IPv6 地址'
    [ordered]@{schema=1;computer=[Environment]::MachineName;checkedAt=[DateTime]::Now.ToString('o');
        readyToPair=(@($checks | Where-Object { -not $_.ok }).Count -eq 0);addresses=$addresses;checks=@($checks.ToArray())}
}

function Format-GMSSHReadiness($Result) {
    $title = if ($Result.readyToPair) { '本机自检通过，可以进行首次配对。' } else { '部分项目需要检查；本次未修改密码和服务配置。' }
    $lines = @($title, ('当前地址：' + ($Result.addresses -join ', ')), '')
    foreach ($check in $Result.checks) { $lines += $(if ($check.ok) { '[通过] ' } else { '[检查] ' }) + $check.name + '：' + $check.detail }
    $lines += @('', '本机自检不能代替控制端的指纹核对、局域网连接和实际传输验收。')
    $lines -join "`r`n"
}
