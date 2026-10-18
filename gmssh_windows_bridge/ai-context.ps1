# Fixed read-only context; this script accepts no caller-supplied PowerShell.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$os=Get-CimInstance Win32_OperatingSystem
$tools=@(foreach($name in @('powershell.exe','pwsh.exe','cmd.exe','git.exe','python.exe','node.exe')) {
    $command=Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if($command){ @{name=$name;path=$command.Source;version=[string]$command.Version} }
})
@{schema=1;computer=$env:COMPUTERNAME;os=$os.Caption;version=$os.Version;
  sampledAt=[DateTime]::UtcNow.ToString('o');powershell=$PSVersionTable.PSVersion.ToString();
  brokerUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name;
  tools=$tools;disks=@(Get-CimInstance Win32_LogicalDisk | Select-Object -First 32 | ForEach-Object {
    @{name=$_.DeviceID;type=[int]$_.DriveType;free=[long]$_.FreeSpace;total=[long]$_.Size}
  })} | ConvertTo-Json -Depth 5 -Compress
