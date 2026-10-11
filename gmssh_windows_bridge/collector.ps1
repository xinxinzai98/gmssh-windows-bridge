$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$culture = [Globalization.CultureInfo]::InvariantCulture
function Metric($name, $value) {
    if ($value -is [IFormattable]) { $value = $value.ToString($null, $culture) }
    '__GMB_' + $name + '__=' + $value
}

if ($MetricMode -eq 'fast') {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BridgeSystemTimes {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
}
'@
    $idle1 = 0L; $kernel1 = 0L; $user1 = 0L
    $idle2 = 0L; $kernel2 = 0L; $user2 = 0L
    if (-not [BridgeSystemTimes]::GetSystemTimes([ref]$idle1, [ref]$kernel1, [ref]$user1)) {
        throw 'GetSystemTimes failed'
    }
    Start-Sleep -Milliseconds 1000
    if (-not [BridgeSystemTimes]::GetSystemTimes([ref]$idle2, [ref]$kernel2, [ref]$user2)) {
        throw 'GetSystemTimes failed'
    }
    # Kernel time includes idle; both counters are 100ns units over all CPUs.
    $total = $kernel2 + $user2
    $delta = $total - $kernel1 - $user1
    if ($delta -le 0) { throw 'No CPU sample interval' }
    $usage = [Math]::Min(100, [Math]::Max(0, 100 * (1 - ($idle2 - $idle1) / [double]$delta)))
    $os = Get-CimInstance Win32_OperatingSystem
    $memoryTotal = [long]$os.TotalVisibleMemorySize * 1024
    $memoryUsed = $memoryTotal - [long]$os.FreePhysicalMemory * 1024
    Metric 'CPU_TOTAL' $total
    Metric 'CPU_IDLE' $idle2
    Metric 'CPU_USAGE' ([Math]::Round($usage, 2))
    Metric 'MEM_TOTAL_BYTES' $memoryTotal
    Metric 'MEM_USED_BYTES' $memoryUsed
} elseif ($MetricMode -eq 'slow') {
    $os = Get-CimInstance Win32_OperatingSystem
    $system = Get-CimInstance Win32_ComputerSystem
    # Compatibility descriptor; never claim that the actual Windows OS is Linux.
    Metric 'OS_KERNEL' ('Windows ' + $os.Version + ' (Linux metrics protocol adapter)')
    Metric 'OS_NAME' $os.Caption
    Metric 'CPU_CORES' $system.NumberOfLogicalProcessors
    Metric 'UPTIME_SECONDS' ([long]((Get-Date) - $os.LastBootUpTime).TotalSeconds)
    Metric 'PROCESS_COUNT' @(Get-Process).Count
    # Windows approximation: processes with nonzero CPU in the provider sample.
    $active = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
        Where-Object { $_.Name -notin @('_Total', 'Idle') -and $_.PercentProcessorTime -gt 0 })
    Metric 'ACTIVE_PROCESS_COUNT' $active.Count
    Metric 'CID' ''
    '__GMB_DISKS_BEGIN__'
    Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
        if ($_.Size -gt 0) {
            # /dev/windows/C is only a protocol alias; keep real C:\ and NTFS.
            @(('/dev/windows/' + $_.DeviceID.TrimEnd(':')), $_.FileSystem,
              ([long]$_.Size).ToString($culture), 1, ([long]$_.FreeSpace).ToString($culture),
              ($_.DeviceID + '\')) -join "`t"
        }
    }
    '__GMB_DISKS_END__'
} else {
    throw 'Unknown metric mode'
}
