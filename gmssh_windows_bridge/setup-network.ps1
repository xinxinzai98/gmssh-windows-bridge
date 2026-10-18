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
