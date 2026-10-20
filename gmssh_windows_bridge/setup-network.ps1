#requires -Version 5.1
# Optional echo-request rules. Installation does not enable them automatically.
function Get-GMSSHPingRules {
    foreach ($version in @(4,6)) {
        $name = 'GMSSH-Windows-Ping-IPv'+$version
        $protocol = 'ICMPv'+$version
        $type = if ($version -eq 4) { '8' } else { '128' }
        $rules = @(Get-NetFirewallRule -PolicyStore PersistentStore -Name $name -ErrorAction SilentlyContinue)
        if ($rules.Count -gt 1) { throw '发现重复的 GMSSH ping 规则，请先检查防火墙。' }
        $rule = if ($rules.Count) { $rules[0] } else { $null }
        if ($rule) {
            $port = $rule | Get-NetFirewallPortFilter -ErrorAction Stop
            $address = $rule | Get-NetFirewallAddressFilter -ErrorAction Stop
            $application = $rule | Get-NetFirewallApplicationFilter -ErrorAction Stop
            if ($rule.Group -cne 'GMSSH Windows Ping' -or [string]$rule.Direction -ne 'Inbound' -or
                [string]$rule.Action -ne 'Allow' -or [string]$rule.Profile -ne 'Any' -or
                [string]$port.Protocol -notin @($protocol,$(if ($version -eq 4) { '1' } else { '58' })) -or
                @($port.IcmpType).Count -ne 1 -or [string]$port.IcmpType -notin @($type,($type+':Any'),($type+':*')) -or
                @($address.RemoteAddress).Count -ne 1 -or [string]$address.RemoteAddress -ne 'Any' -or
                @($address.LocalAddress).Count -ne 1 -or [string]$address.LocalAddress -ne 'Any' -or
                [string]$application.Program -ne 'Any') {
                throw '同名 ping 规则不是本程序的标准回显规则，已停止修改。'
            }
        }
        [pscustomobject]@{name=$name;protocol=$protocol;type=$type;rule=$rule}
    }
}

function ConvertTo-GMSSHIPv6Sources([string[]]$Sources) {
    $normalized = @()
    foreach ($line in $Sources) {
        if ($null -eq $line) { continue }
        $value = $line.Trim()
        if (-not $value) { continue }
        $parts = $value.Split('/')
        $address = $null; $bits = 128
        if ($parts.Count -gt 2 -or -not [Net.IPAddress]::TryParse($parts[0],[ref]$address) -or
            $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetworkV6 -or
            $address.IsIPv4MappedToIPv6 -or $address.IsIPv6Multicast -or $address.IsIPv6LinkLocal -or
            $address.ScopeId -ne 0 -or [Net.IPAddress]::IsLoopback($address) -or $address.Equals([Net.IPAddress]::IPv6Any) -or
            ($parts.Count -eq 2 -and ($parts[1] -notmatch '^\d{1,3}$' -or -not [int]::TryParse($parts[1],[ref]$bits))) -or
            $bits -lt 1 -or $bits -gt 128) { throw '请每行填写一个管理端 IPv6 地址或 IPv6 网段，不能使用 IPv4、回环、链路本地或 ::/0。' }
        $bytes = $address.GetAddressBytes()
        for ($i=0;$i -lt 16;$i++) {
            $remaining = $bits-$i*8
            if ($remaining -le 0) { $bytes[$i]=0 }
            elseif ($remaining -lt 8) { $bytes[$i]=$bytes[$i] -band (255 -shl (8-$remaining)) }
        }
        $normalized += ([Net.IPAddress]::new($bytes).ToString().ToLowerInvariant()+'/'+$bits)
    }
    $normalized = @($normalized | Select-Object -Unique)
    if ($normalized.Count -gt 32) { throw '最多允许 32 个 IPv6 来源地址或网段。' }
    $normalized
}

function Get-GMSSHIPv6Sources([string]$DataRoot) {
    $state = Get-GMSSHConnectState $DataRoot
    @(ConvertTo-GMSSHIPv6Sources @($state.connectIpv6Sources))
}

function Get-GMSSHIPv6AccessRules([string]$ProgramRoot,[string]$DataRoot) {
    $state=Get-GMSSHConnectState $DataRoot
    if($state.installationMode -ceq 'preserve-existing'){throw '保留模式不修改既有 SSH 的 IPv6 防火墙规则；请由原服务管理员处理跨网段访问。'}
    $helper = Get-GMSSHConnectHelper $ProgramRoot
    $connection = Get-Content -LiteralPath (Join-Path $DataRoot 'connection.json') -Raw | ConvertFrom-Json
    $sshd = [IO.Path]::GetFullPath([string]$connection.sshBinary)
    $service = Get-CimInstance Win32_Service -Filter "Name='sshd'" -ErrorAction Stop
    $binary = ([string]$service.PathName).Trim().Trim('"')
    if (-not (Test-Path -LiteralPath $sshd -PathType Leaf) -or $binary -ine $sshd) { throw 'SSH 服务程序与本机安装记录不一致，未修改 IPv6 规则。' }
    foreach ($spec in @(@('Connect',22257,$helper),@('SSH',22,$sshd))) {
        $name = 'GMSSH-Windows-'+$spec[0]+'-IPv6'
        $rules = @(Get-NetFirewallRule -PolicyStore PersistentStore -Name $name -ErrorAction SilentlyContinue)
        if ($rules.Count -gt 1) { throw '发现重复的 GMSSH IPv6 规则，请先检查防火墙。' }
        $rule = if ($rules.Count) { $rules[0] } else { $null }; $addresses = @()
        if ($rule) {
            $port=$rule|Get-NetFirewallPortFilter -ErrorAction Stop; $address=$rule|Get-NetFirewallAddressFilter -ErrorAction Stop
            $application=$rule|Get-NetFirewallApplicationFilter -ErrorAction Stop
            if ($rule.Group -cne 'GMSSH Windows IPv6 Access' -or [string]$rule.Direction -ne 'Inbound' -or
                [string]$rule.Action -ne 'Allow' -or [string]$rule.Profile -ne 'Any' -or [string]$port.Protocol -notin @('TCP','6') -or
                [string]$port.LocalPort -cne [string]$spec[1] -or [string]$application.Program -ine [string]$spec[2] -or
                @($address.LocalAddress).Count -ne 1 -or [string]$address.LocalAddress -ne 'Any') { throw '同名 IPv6 规则的归属或程序不一致，已停止修改。' }
            $addresses=@(ConvertTo-GMSSHIPv6Sources @($address.RemoteAddress))
            if (-not $addresses.Count) { throw 'IPv6 规则缺少明确的来源范围。' }
        }
        [pscustomobject]@{name=$name;port=$spec[1];program=$spec[2];rule=$rule;addresses=$addresses;enabled=$(if($rule){[string]$rule.Enabled}else{'False'})}
    }
}

function Set-GMSSHIPv6Sources([string]$ProgramRoot,[string]$DataRoot,[string[]]$Sources) {
    $desired = @(ConvertTo-GMSSHIPv6Sources $Sources)
    $rules = @(Get-GMSSHIPv6AccessRules $ProgramRoot $DataRoot)
    $path = Join-Path $DataRoot 'agent.json'
    if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '安装记录包含重解析点。' }
    $oldText = [IO.File]::ReadAllText($path)
    $state = $oldText | ConvertFrom-Json
    $state | Add-Member -NotePropertyName connectIpv6Sources -NotePropertyValue @($desired) -Force
    $changed = @(); $saved = $false
    $temporary = $path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
    $backup = Join-Path $DataRoot ('agent-before-ipv6-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'.json')
    try {
        foreach ($item in $rules) {
            $changed += $item
            if (-not $desired.Count) {
                if ($item.rule) { Remove-NetFirewallRule -PolicyStore PersistentStore -Name $item.name -ErrorAction Stop }
            } elseif ($item.rule) {
                Set-NetFirewallRule -PolicyStore PersistentStore -Name $item.name -RemoteAddress $desired -Enabled True -ErrorAction Stop | Out-Null
            } else {
                New-NetFirewallRule -PolicyStore PersistentStore -Name $item.name -DisplayName ('GMSSH approved IPv6 TCP '+$item.port) -Group 'GMSSH Windows IPv6 Access' `
                    -Enabled True -Direction Inbound -Action Allow -Protocol TCP -LocalPort $item.port -LocalAddress Any -RemoteAddress $desired -Program $item.program -Profile Any -ErrorAction Stop | Out-Null
            }
        }
        foreach ($item in (Get-GMSSHIPv6AccessRules $ProgramRoot $DataRoot)) {
            if ($desired.Count) {
                if (-not $item.rule -or [string]$item.rule.Enabled -ne 'True' -or ((@($item.addresses|Sort-Object) -join ',') -cne (@($desired|Sort-Object) -join ','))) { throw 'IPv6 防火墙规则回读不一致。' }
            } elseif ($item.rule) { throw 'IPv6 额外规则未移除。' }
        }
        if ([IO.File]::ReadAllText($path) -cne $oldText) { throw '安装记录已由其他操作更新，请重新打开 IPv6 设置后再保存。' }
        [IO.File]::WriteAllText($temporary,($state|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
        [IO.File]::Replace($temporary,$path,$backup); $saved=$true
        if ((@(Get-GMSSHIPv6Sources $DataRoot) -join ',') -cne ($desired -join ',')) { throw 'IPv6 来源设置回读不一致。' }
    } catch {
        $failure=$_; $rollbackFailed=$false
        try { if ($saved) { [IO.File]::WriteAllText($temporary,$oldText,[Text.UTF8Encoding]::new($false));[IO.File]::Replace($temporary,$path,$null) } } catch { $rollbackFailed=$true }
        [array]::Reverse($changed)
        foreach ($item in $changed) {
            try {
                $current=Get-NetFirewallRule -PolicyStore PersistentStore -Name $item.name -ErrorAction SilentlyContinue
                if ($current -and $current.Group -cne 'GMSSH Windows IPv6 Access') { throw '规则归属已变化。' }
                if (-not $item.rule) {
                    if ($current) { Remove-NetFirewallRule -PolicyStore PersistentStore -Name $item.name -ErrorAction Stop }
                } elseif ($current) {
                    Set-NetFirewallRule -PolicyStore PersistentStore -Name $item.name -RemoteAddress $item.addresses -Enabled $item.enabled -ErrorAction Stop | Out-Null
                } else {
                    New-NetFirewallRule -PolicyStore PersistentStore -Name $item.name -DisplayName ('GMSSH approved IPv6 TCP '+$item.port) -Group 'GMSSH Windows IPv6 Access' `
                        -Enabled $item.enabled -Direction Inbound -Action Allow -Protocol TCP -LocalPort $item.port -LocalAddress Any -RemoteAddress $item.addresses -Program $item.program -Profile Any -ErrorAction Stop | Out-Null
                }
            } catch { $rollbackFailed=$true }
        }
        if ($rollbackFailed) { throw 'IPv6 设置未完成，部分回退失败。请保留安装记录备份并检查两条 GMSSH IPv6 规则。' }
        throw $failure
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }; $oldText=$null }
}

function Show-GMSSHIPv6Access([string]$ProgramRoot,[string]$DataRoot) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form=New-Object Windows.Forms.Form; $form.Text='GMSSH Windows · IPv6 接入';$form.ClientSize=New-Object Drawing.Size(590,390)
    $form.StartPosition='CenterScreen';$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false;$form.MinimizeBox=$false
    $form.BackColor=[Drawing.ColorTranslator]::FromHtml('#141414');$form.ForeColor=[Drawing.Color]::WhiteSmoke;$form.Font=New-Object Drawing.Font('Segoe UI',10)
    $brandIcon=$null;$iconPath=Join-Path $ProgramRoot 'brand\gmssh.ico'
    if(Test-Path -LiteralPath $iconPath){$brandIcon=New-Object Drawing.Icon($iconPath);$form.Icon=$brandIcon}
    Set-GMSSHDarkTitleBar $form
    $title=New-Object Windows.Forms.Label;$title.Text='允许哪些管理端通过 IPv6 接入？';$title.SetBounds(24,22,540,30);$title.Font=New-Object Drawing.Font('Segoe UI',14,[Drawing.FontStyle]::Bold);$form.Controls.Add($title)
    $hint=New-Object Windows.Forms.Label;$hint.Text="同一局域网的 IPv6 自动支持，无需填写。跨网段接入时，每行填写一个管理端的 IPv6 地址或网段。清空并保存可恢复仅局域网。";$hint.SetBounds(24,66,540,60);$form.Controls.Add($hint)
    $sources=New-Object Windows.Forms.TextBox;$sources.SetBounds(24,134,540,112);$sources.Multiline=$true;$sources.AcceptsReturn=$true;$sources.AccessibleName='允许的管理端 IPv6 地址或网段';$sources.ScrollBars='Vertical';$sources.MaxLength=4096;$sources.BackColor=[Drawing.ColorTranslator]::FromHtml('#202020');$sources.ForeColor=[Drawing.Color]::WhiteSmoke;$sources.Text=(@(Get-GMSSHIPv6Sources $DataRoot)-join "`r`n");$form.Controls.Add($sources)
    $note=New-Object Windows.Forms.Label;$note.Text='保存会同步接入服务来源范围和 TCP 22 / 22257 的专用防火墙规则。连接码与 SSH 认证仍需通过。';$note.SetBounds(24,258,540,44);$note.ForeColor=[Drawing.ColorTranslator]::FromHtml('#a7a7af');$form.Controls.Add($note)
    $status=New-Object Windows.Forms.Label;$status.SetBounds(24,308,350,60);$status.ForeColor=[Drawing.ColorTranslator]::FromHtml('#a7a7af');$form.Controls.Add($status)
    $save=New-Object Windows.Forms.Button;$save.Text='保存来源范围';$save.SetBounds(390,318,174,38);$save.FlatStyle='Flat';$save.BackColor=[Drawing.ColorTranslator]::FromHtml('#5667ff');$save.ForeColor=[Drawing.Color]::White;$form.Controls.Add($save)
    $save.Add_Click({try{$save.Enabled=$false;Set-GMSSHIPv6Sources $ProgramRoot $DataRoot $sources.Lines;$sources.Text=(@(Get-GMSSHIPv6Sources $DataRoot)-join "`r`n");$status.Text='已保存，可回到管理端粘贴连接码接入。'}catch{$status.Text=$_.Exception.Message}finally{$save.Enabled=$true}})
    try{[void]$form.ShowDialog()}finally{$form.Dispose();if($brandIcon){$brandIcon.Dispose()}}
}

function Get-GMSSHPingStatus {
    $rules = @(Get-GMSSHPingRules)
    $count = @($rules | Where-Object { $_.rule -and [string]$_.rule.Enabled -eq 'True' }).Count
    [pscustomobject]@{enabled=($count -eq 2);partial=($count -eq 1);
        state=$(if ($count -eq 2) { '已允许' } elseif ($count -eq 1) { '部分允许' } else { '未开启' })}
}

function Set-GMSSHPingAccess([bool]$Enabled) {
    # Check both identities before changing either rule. Never touch OS/third-party rules.
    $rules = @(Get-GMSSHPingRules)
    $changed = @()
    try {
        foreach ($item in $rules) {
            $wasEnabled = $item.rule -and [string]$item.rule.Enabled -eq 'True'
            if ($Enabled -and -not $item.rule) {
                $changed += [pscustomobject]@{item=$item;created=$true;enabled=$false}
                New-NetFirewallRule -PolicyStore PersistentStore -Name $item.name -DisplayName ('GMSSH ping '+$item.protocol) -Group 'GMSSH Windows Ping' `
                    -Direction Inbound -Action Allow -Enabled True -Profile Any -Protocol $item.protocol -IcmpType $item.type `
                    -LocalAddress Any -RemoteAddress Any -Program Any -ErrorAction Stop | Out-Null
            } elseif ($item.rule -and $wasEnabled -ne $Enabled) {
                $changed += [pscustomobject]@{item=$item;created=$false;enabled=$wasEnabled}
                if ($Enabled) { Enable-NetFirewallRule -PolicyStore PersistentStore -Name $item.name -ErrorAction Stop | Out-Null }
                else { Disable-NetFirewallRule -PolicyStore PersistentStore -Name $item.name -ErrorAction Stop | Out-Null }
            }
        }
        $status = Get-GMSSHPingStatus
        if ($status.enabled -ne $Enabled -or $status.partial) { throw 'ping 规则回读不一致。' }
    } catch {
        $failure = $_
        $rollbackFailed = $false
        [array]::Reverse($changed)
        foreach ($change in $changed) {
            try {
                if ($change.created) {
                    $created = Get-NetFirewallRule -PolicyStore PersistentStore -Name $change.item.name -ErrorAction SilentlyContinue
                    if ($created) {
                        if ($created.Group -cne 'GMSSH Windows Ping') { throw '规则归属已变化。' }
                        Remove-NetFirewallRule -PolicyStore PersistentStore -Name $change.item.name -ErrorAction Stop
                    }
                }
                elseif ($change.enabled) { Enable-NetFirewallRule -PolicyStore PersistentStore -Name $change.item.name -ErrorAction Stop | Out-Null }
                else { Disable-NetFirewallRule -PolicyStore PersistentStore -Name $change.item.name -ErrorAction Stop | Out-Null }
            } catch { $rollbackFailed = $true }
        }
        if ($rollbackFailed) { throw 'ping 设置未完成，部分规则未能回退，请检查 GMSSH-Windows-Ping-IPv4 / IPv6。' }
        throw $failure
    }
}
