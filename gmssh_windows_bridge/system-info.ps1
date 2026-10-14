$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$os = Get-CimInstance Win32_OperatingSystem
$cpu = @(Get-CimInstance Win32_Processor)
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -First 32 | ForEach-Object {
    @{name=$_.DeviceID; filesystem=$_.FileSystem; total=[long]$_.Size; free=[long]$_.FreeSpace}
})
$network = @(Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -First 32 | ForEach-Object {
    $adapter = $_
    $stats = $adapter | Get-NetAdapterStatistics
    $addresses = @(Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress)
    @{name=$adapter.Name; description=$adapter.InterfaceDescription; addresses=$addresses; mac=$adapter.MacAddress;
      speed=[long]$adapter.ReceiveLinkSpeed; received=[long]$stats.ReceivedBytes; sent=[long]$stats.SentBytes}
})
@{computer=$env:COMPUTERNAME; os=$os.Caption; version=$os.Version; cpu=($cpu.Name -join ', ');
  cores=[int](($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum);
  memory=[long]$os.TotalVisibleMemorySize * 1024; uptime=[long]((Get-Date)-$os.LastBootUpTime).TotalSeconds;
  processes=@(Get-Process).Count; disks=$disks; network=$network} | ConvertTo-Json -Depth 5 -Compress
