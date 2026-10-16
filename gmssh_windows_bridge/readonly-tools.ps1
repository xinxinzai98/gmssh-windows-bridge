# Packaged read-only queries. $options is validated and decoded by the controller.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Short-Text($Value,[int]$Limit=100) {
    $text = ([string]$Value) -replace '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]',''
    if ($text.Length -gt $Limit) { return $text.Substring(0,$Limit) }
    return $text
}
function Matches-Search($Value) { return ([string]$Value).IndexOf([string]$options.search,[StringComparison]::OrdinalIgnoreCase) -ge 0 }
$reply = [ordered]@{schema=1;kind='windows';tool=$options.tool;sampledAt=[DateTime]::UtcNow.ToString('o');state='passed';code='OK';items=@();truncated=$false}
try {
    switch ($options.tool) {
        capabilities {
            $serverVersion=$null; $engineVersion=$null
            try {
                $file=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'GMSSHWindowsBridge\agent.json'
                if (Test-Path -LiteralPath $file -PathType Leaf) {
                    $state=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
                    if ([string]$state.version -match '^\d+\.\d+\.\d+[a-zA-Z0-9.-]*$') { $serverVersion=[string]$state.version }
                    if ([string]$state.engine -match '^[a-zA-Z]:\\' -and (Test-Path -LiteralPath $state.engine -PathType Leaf)) {
                        $engineVersion=Short-Text ((Get-Item -LiteralPath $state.engine).VersionInfo.ProductVersion) 64
                        if (-not $engineVersion) { $engineVersion=$null }
                    }
                }
            } catch { }
            $reply.versions=@{server=$serverVersion;engine=$engineVersion;os=[Environment]::OSVersion.VersionString}
            $reply.capabilities=@{processes=[bool](Get-Command Get-Process -ErrorAction SilentlyContinue);services=[bool](Get-Command Get-CimInstance -ErrorAction SilentlyContinue);logs=[bool](Get-Command Get-WinEvent -ErrorAction SilentlyContinue);sources=@('system','application')}
        }
        processes {
            if (-not (Get-Command Get-Process -ErrorAction SilentlyContinue)) { $reply.state='unsupported';$reply.code='TOOL_UNAVAILABLE';break }
            $first=@{}; $cores=[Math]::Max(1,[Environment]::ProcessorCount)
            foreach ($process in @(Get-Process)) {
                try { $first[[string]$process.Id]=@($process.StartTime.ToUniversalTime().Ticks,$process.TotalProcessorTime.TotalSeconds) } catch { }
            }
            $watch=[Diagnostics.Stopwatch]::StartNew(); Start-Sleep -Milliseconds 1000
            $rows=@(foreach ($process in @(Get-Process)) {
                if (-not (Matches-Search $process.ProcessName) -and -not (Matches-Search ([string]$process.Id))) { continue }
                $cpu=$null; $memory=$null
                try {
                    $previous=$first[[string]$process.Id]
                    if ($previous -and $previous[0] -eq $process.StartTime.ToUniversalTime().Ticks) {
                        $delta=$process.TotalProcessorTime.TotalSeconds-$previous[1]
                        if ($delta -ge 0) { $cpu=[Math]::Round([Math]::Min(100,100*$delta/($watch.Elapsed.TotalSeconds*$cores)),1) }
                    }
                } catch { }
                try { $memory=[long]$process.WorkingSet64 } catch { }
                [pscustomobject]@{pid=[int]$process.Id;name=(Short-Text $process.ProcessName);cpuPercent=$cpu;memoryBytes=$memory}
            })
            switch ($options.sort) {
                cpu { $rows=@($rows | Sort-Object cpuPercent -Descending) }
                memory { $rows=@($rows | Sort-Object memoryBytes -Descending) }
                pid { $rows=@($rows | Sort-Object pid) }
                default { $rows=@($rows | Sort-Object name) }
            }
            $reply.items=@($rows | Select-Object -First ([int]$options.limit));$reply.truncated=$rows.Count -gt $options.limit
            $reply.units=@{cpu='logical-processors-normalized';memory='working-set';sampleSeconds=[Math]::Round($watch.Elapsed.TotalSeconds,2);cores=$cores}
        }
        services {
            if (-not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) { $reply.state='unsupported';$reply.code='TOOL_UNAVAILABLE';break }
            $rows=@(Get-CimInstance Win32_Service | Where-Object { (Matches-Search $_.Name) -or (Matches-Search $_.DisplayName) } | ForEach-Object {
                [pscustomobject]@{name=(Short-Text $_.Name);displayName=(Short-Text $_.DisplayName);state=(Short-Text $_.State 32);startType=(Short-Text $_.StartMode 32)}
            })
            if ($options.sort -eq 'state') { $rows=@($rows | Sort-Object state,name) } else { $rows=@($rows | Sort-Object name) }
            $reply.items=@($rows | Select-Object -First ([int]$options.limit));$reply.truncated=$rows.Count -gt $options.limit
        }
        { $_ -in @('logs','log-detail') } {
            if (-not (Get-Command Get-WinEvent -ErrorAction SilentlyContinue)) { $reply.state='unsupported';$reply.code='EVENT_LOG_UNAVAILABLE';break }
            $source=if ($options.source -eq 'application') { 'Application' } else { 'System' }
            try {
                if ($options.tool -eq 'log-detail') {
                    $events=@(Get-WinEvent -LogName $source -FilterXPath ('*[System[EventRecordID = '+[string][long]$options.recordId+']]') -MaxEvents 1)
                } else {
                    $events=@(Get-WinEvent -FilterHashtable @{LogName=$source;StartTime=[DateTime]::Now.AddHours(-[int]$options.hours)} -MaxEvents ([int]$options.limit+1))
                }
            } catch {
                if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { $events=@() } else { throw }
            }
            $maximum=if ($options.tool -eq 'log-detail') { 1 } else { [int]$options.limit }
            $reply.truncated=$events.Count -gt $maximum
            $reply.items=@($events | Select-Object -First $maximum | ForEach-Object {
                $message='';try { $message=[string]$_.Message } catch { }
                $row=[ordered]@{recordId=[long]$_.RecordId;source=$options.source;time=$_.TimeCreated.ToUniversalTime().ToString('o');level=(Short-Text $_.LevelDisplayName 32);provider=(Short-Text $_.ProviderName 64);eventId=[int]$_.Id}
                if ($options.tool -eq 'log-detail') { $row.message=Short-Text $message 4096;$row.messageTruncated=$message.Length -gt 4096 }
                else { $row.preview=(Short-Text ($message -replace '[\r\n\t]+',' ') 100) }
                [pscustomobject]$row
            })
        }
        default { throw 'Unsupported query' }
    }
} catch {
    $reply.state='failed';$reply.items=@();$reply.truncated=$false
    $reply.code=if ($_.Exception -is [UnauthorizedAccessException] -or $_.Exception -is [Security.SecurityException] -or $_.FullyQualifiedErrorId -match 'AccessDenied|Unauthorized|SecurityException') { 'ACCESS_DENIED' } else { 'QUERY_FAILED' }
}
$reply.sampledAt=[DateTime]::UtcNow.ToString('o')
ConvertTo-Json -InputObject $reply -Depth 6 -Compress
