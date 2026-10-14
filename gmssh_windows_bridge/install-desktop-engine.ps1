#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'GMSSHWindowsBridge'
$engine = Join-Path $root 'desktop-engine'
$program = Join-Path $engine 'rustdesk.exe'
$existing = Get-Service RustDesk -ErrorAction SilentlyContinue
if ($existing) {
    $command = (Get-CimInstance Win32_Service -Filter "Name='RustDesk'").PathName
    if ($command -notmatch '^"([^"]+)"\s+--service$') { throw 'Review the existing desktop service before continuing.' }
    $program = $Matches[1]
    if ((Get-AuthenticodeSignature $program).Status -ne 'Valid') { throw 'Existing desktop engine signature validation failed.' }
    if ($existing.Status -ne 'Running') { Start-Service RustDesk }
    return $program
}
$state = 'HKLM:\SOFTWARE\RustDesk\InstallState\RustDesk'
if ((Test-Path $engine) -or (Test-Path $state) -or (Test-Path (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'RustDesk'))) {
    throw 'Desktop engine files already exist. Review the existing installation before replacing them.'
}
$metadata = Get-Content (Join-Path $PSScriptRoot 'desktop-payload.json') -Raw | ConvertFrom-Json
$expected = (Get-Content (Join-Path $PSScriptRoot 'windows-installers.json') -Raw | ConvertFrom-Json).rustdesk
if ($metadata.filename -cne 'desktop-engine.zip' -or $metadata.sha256 -notmatch '^[a-f0-9]{64}$' -or
    $metadata.sourceSha256 -cne $expected.sha256) { throw 'Desktop engine provenance is invalid.' }
$payload = Join-Path $PSScriptRoot $metadata.filename
if ((Get-FileHash $payload -Algorithm SHA256).Hash.ToLowerInvariant() -cne $metadata.sha256) {
    throw 'Desktop engine archive verification failed.'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($payload)
try {
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        if ($name.StartsWith('/') -or $name.Contains(':') -or $name.Split('/') -contains '..') {
            throw 'Unsafe desktop engine archive path.'
        }
    }
} finally { $archive.Dispose() }
New-Item -ItemType Directory -Path $engine -Force | Out-Null
Expand-Archive -LiteralPath $payload -DestinationPath $engine
$files = Get-Content (Join-Path $engine 'engine-files.json') -Raw | ConvertFrom-Json
if ($files.source.sha256 -cne $expected.sha256) { throw 'Desktop engine source does not match the pinned release.' }
foreach ($item in $files.files.PSObject.Properties) {
    $name = $item.Name.Replace('/', '\')
    if ($name.Contains(':') -or $name.StartsWith('\') -or $name.Split('\') -contains '..') { throw 'Unsafe engine manifest path.' }
    if ((Get-FileHash (Join-Path $engine $name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item.Value) {
        throw 'Extracted desktop engine content differs from the official payload.'
    }
}
if (@(Get-ChildItem $engine -Recurse -File).Count -ne @($files.files.PSObject.Properties).Count + 1 -or
    (Get-AuthenticodeSignature $program).Status -ne 'Valid') { throw 'Desktop engine file or signature verification failed.' }
# This is the native engine's supported install-path discovery key; no separate
# RustDesk app, installer UI, tray shortcut, or uninstall entry is registered.
New-Item -Path $state -Force | Out-Null
New-ItemProperty -Path $state -Name InstallLocation -Value $engine -PropertyType String -Force | Out-Null
try {
    New-Service -Name RustDesk -DisplayName 'GMSSH Windows Desktop Engine' `
        -BinaryPathName ('"' + $program + '" --service') -StartupType Manual | Out-Null
    Start-Service RustDesk
    (Get-Service RustDesk).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
} catch {
    Stop-Service RustDesk -ErrorAction SilentlyContinue
    throw
}
return $program
