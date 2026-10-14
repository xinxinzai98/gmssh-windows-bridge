#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ExpectedComputer,
    [string]$ControllerAddress = 'LocalSubnet',
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_.-]{1,64}$')][string]$WindowsUser,
    [switch]$Install
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'setup-checks.ps1')

# Pairing metadata only; this does not verify or enable hardware wake support.
function Get-GMSSHWakeAdapters {
    try {
        $result = @(foreach ($adapter in (Get-NetAdapter -Physical -ErrorAction Stop | Where-Object { $_.Status -eq 'Up' })) {
            $mac = ([string]$adapter.MacAddress -replace '[-:]', '').ToUpperInvariant()
            if ($mac -notmatch '^[0-9A-F]{12}$' -or $mac -in @('000000000000','FFFFFFFFFFFF')) { continue }
            foreach ($address in (Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction Stop | Where-Object {
                $_.AddressState -eq 'Preferred' -and
                $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'
            })) {
                [ordered]@{ name=[string]$adapter.Name; mac=($mac -replace '(..)(?=.)', '$1:');
                    address=[string]$address.IPAddress; prefixLength=[int]$address.PrefixLength }
            }
        })
        return $result
    } catch { return @() }
}

if ($env:OS -ne 'Windows_NT') { throw 'Run this script on the intended Windows computer.' }
if ($([Environment]::MachineName) -ine $ExpectedComputer) { throw 'Computer name does not match the approved target.' }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Open an Administrator Windows PowerShell window and run this script again.' }
if ($ControllerAddress -ne 'LocalSubnet') {
    $controller = [Net.IPAddress]::Parse($ControllerAddress)
    if ($controller.GetAddressBytes().Length -ne 4) { throw 'Use LocalSubnet or one controller IPv4 address.' }
    $ControllerAddress = $controller.ToString()
}
$WindowsUser = $WindowsUser.ToLowerInvariant()
$allowedUser = if ($ControllerAddress -eq 'LocalSubnet') { $WindowsUser } else { "$WindowsUser@$ControllerAddress" }
$addresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred'
} | Select-Object -ExpandProperty IPAddress -Unique)
$account = Get-LocalUser -Name $WindowsUser
if (-not $account.Enabled) { throw 'The existing Windows account is disabled.' }
$service = Get-Service sshd -ErrorAction SilentlyContinue
$inboxBinary = Join-Path ([Environment]::SystemDirectory) 'OpenSSH\sshd.exe'
$offlineBinary = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'OpenSSH\sshd.exe'
$sshd = $inboxBinary
if ($service) {
    $sshd = [Environment]::ExpandEnvironmentVariables((Get-CimInstance Win32_Service -Filter "Name='sshd'").PathName).Trim('"')
}
$firewallEnabled = @((Get-NetFirewallProfile -PolicyStore ActiveStore) | Where-Object { [string]$_.Enabled -ne 'True' }).Count -eq 0
$sshDirectory = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'ssh'
$configPath = Join-Path $sshDirectory 'sshd_config'
$ruleName = 'GMSSH-Windows-Monitor-SSH'
$plan = [ordered]@{
    computer = $([Environment]::MachineName)
    username = $WindowsUser
    addresses = $addresses
    allowedController = $ControllerAddress
    sshPort = 22
    installationSource = 'Bundled official OpenSSH MSI; no Windows Update download'
    sshServicePresent = [bool]$service
    sshStatus = if ($service) { [string]$service.Status } else { 'NotInstalled' }
    firewallEnabled = $firewallEnabled
}
$plan | ConvertTo-Json
if (-not $Install) { return }

# This is first-time setup; do not silently rewrite a deployed SSH server.
if ($service -and $service.Status -ne 'Stopped') { throw 'An SSH service is already running. Review its current configuration before changing it.' }
if ($service) {
    if ($sshd -ine $inboxBinary -and $sshd -ine $offlineBinary) {
        throw 'The existing SSH service is not a recognized Microsoft OpenSSH installation. Review it separately.'
    }
}
if (Test-Path $configPath) { throw 'An SSH configuration already exists. Review it before installing.' }
if (-not (Test-GMSSHHostKeyDirectory $sshDirectory)) {
    throw 'The SSH data directory is not empty. Review the existing files first.'
}
if (-not $firewallEnabled) { throw 'A Windows firewall profile is disabled; review it before enabling remote SSH.' }
if (Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue) { throw 'TCP port 22 is already in use.' }
if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) { throw 'The monitor firewall rule already exists; review it before replacing it.' }

$createdRule = $false
$installedService = $false
try {
    if (-not $service) {
        if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'The bundled OpenSSH installer is for Windows x64.' }
        $metadata = (Get-Content (Join-Path $PSScriptRoot 'windows-installers.json') -Raw | ConvertFrom-Json).openssh
        if ($metadata.filename -notmatch '^OpenSSH-Win64-v[0-9.]+\.msi$' -or $metadata.sha256 -notmatch '^[a-f0-9]{64}$') {
            throw 'OpenSSH installer metadata is invalid.'
        }
        $installer = Join-Path $PSScriptRoot ('installers\' + $metadata.filename)
        if (-not (Test-Path $installer)) { throw 'The offline OpenSSH installer is missing. Extract the complete setup package.' }
        if ((Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $metadata.sha256 -or
            (Get-AuthenticodeSignature $installer).Status -ne 'Valid') { throw 'OpenSSH installer verification failed.' }
        Write-Host 'Installing the bundled Microsoft OpenSSH Server (offline)...'
        $installation = Start-Process (Join-Path ([Environment]::SystemDirectory) 'msiexec.exe') `
            -ArgumentList ('/i "' + $installer + '" ADDLOCAL=Server /qn /norestart') -Wait -PassThru
        if ($installation.ExitCode -eq 3010) { throw 'Windows requires a restart. Restart Windows before configuring monitoring.' }
        if ($installation.ExitCode -ne 0) { throw ('OpenSSH MSI installation failed: ' + $installation.ExitCode) }
        $sshd = [Environment]::ExpandEnvironmentVariables((Get-CimInstance Win32_Service -Filter "Name='sshd'").PathName).Trim('"')
    }
    $service = Get-Service sshd
    $installedService = $true
    if ($service.Status -ne 'Stopped') { Stop-Service sshd }
    # Disable the installer-created broad SSH rule before the first service start.
    Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue |
        Disable-NetFirewallRule | Out-Null
    New-Item -ItemType Directory -Path $sshDirectory -Force | Out-Null
    & (Join-Path ([Environment]::SystemDirectory) 'icacls.exe') $sshDirectory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to secure the new SSH data directory.' }
    $configuration = @(
        '# GMSSH Windows Bridge: first-time monitoring setup',
        'Port 22',
        "AllowUsers $allowedUser",
        'PasswordAuthentication yes',
        'PubkeyAuthentication no',
        'AllowTcpForwarding local',
        'PermitOpen 127.0.0.1:21118',
        'GatewayPorts no',
        'AllowAgentForwarding no',
        'Subsystem sftp sftp-server.exe'
    )
    [IO.File]::WriteAllLines($configPath, $configuration, [Text.Encoding]::ASCII)
    New-NetFirewallRule -Name $ruleName -DisplayName 'GMSSH monitoring from the local network or approved controller' `
        -Enabled True -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 `
        -LocalAddress Any -RemoteAddress $ControllerAddress -Profile Any | Out-Null
    $createdRule = $true
    # Windows OpenSSH generates its host keys with the correct ACL on first start.
    Start-Service sshd
    (Get-Service sshd).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
    if (($sshd -ine $inboxBinary -and $sshd -ine $offlineBinary) -or
        (Get-AuthenticodeSignature $sshd).Status -ne 'Valid') { throw 'Installed OpenSSH service binary verification failed.' }
    & $sshd -t -f $configPath
    if ($LASTEXITCODE -ne 0) { throw 'The installed SSH configuration did not pass validation.' }
    Set-Service sshd -StartupType Automatic
    $filter = Get-NetFirewallRule -Name $ruleName | Get-NetFirewallAddressFilter
    if (@($filter.RemoteAddress).Count -ne 1 -or $filter.RemoteAddress -ne $ControllerAddress -or
        @($filter.LocalAddress).Count -ne 1 -or $filter.LocalAddress -ne 'Any') {
        throw 'Firewall address readback does not match the approved devices.'
    }
    $publicKeyPath = Join-Path $sshDirectory 'ssh_host_ed25519_key.pub'
    $publicKey = (Get-Content $publicKeyPath -Raw).Trim()
    if ($publicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$') { throw 'Expected an Ed25519 public host key.' }
    $keygen = Join-Path (Split-Path $sshd) 'ssh-keygen.exe'
    $fingerprint = & $keygen -lf $publicKeyPath -E sha256
    if ($LASTEXITCODE -ne 0) { throw 'Failed to read the public host-key fingerprint.' }
    $report = [ordered]@{
        schema = 1
        computer = $([Environment]::MachineName)
        addresses = $addresses
        wakeAdapters = @(Get-GMSSHWakeAdapters)
        username = $WindowsUser
        sshPort = 22
        controller = $ControllerAddress
        sshHostPublicKey = $publicKey
        sshHostFingerprint = [string]$fingerprint
        sshStatus = [string](Get-Service sshd).Status
        sshStartup = [string](Get-Service sshd).StartType
        sshBinary = $sshd
    }
    $reportDirectory = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'GMSSHWindowsBridge'
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
    & (Join-Path ([Environment]::SystemDirectory) 'icacls.exe') $reportDirectory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to secure the public connection state directory.' }
    $reportPath = Join-Path $reportDirectory 'connection.json'
    $report | ConvertTo-Json -Depth 4 | Set-Content $reportPath -Encoding UTF8
    $report | ConvertTo-Json -Depth 4
    Write-Host "Setup complete. Public connection details: $reportPath"
    Write-Host 'Use the existing Windows account password in GMSSH; Windows PIN is not used by this setup.'
} catch {
    if ($installedService) {
        Stop-Service sshd -ErrorAction SilentlyContinue
        Set-Service sshd -StartupType Manual -ErrorAction SilentlyContinue
    }
    if ($createdRule) { Disable-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Out-Null }
    throw
}
