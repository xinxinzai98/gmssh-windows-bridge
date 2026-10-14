#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$metadata = (Get-Content (Join-Path $PSScriptRoot 'windows-installers.json') -Raw | ConvertFrom-Json).vcredist
if ($metadata.filename -cne 'VC_redist.x64.exe' -or $metadata.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Runtime installer metadata is invalid.' }
$program = Join-Path $PSScriptRoot ('installers\' + $metadata.filename)
if ((Get-FileHash $program -Algorithm SHA256).Hash.ToLowerInvariant() -cne $metadata.sha256 -or
    (Get-AuthenticodeSignature $program).Status -ne 'Valid') { throw 'Microsoft runtime installer verification failed.' }
$required = $null
if (-not [version]::TryParse((Get-Item $program).VersionInfo.ProductVersion, [ref]$required)) { throw 'Runtime installer version could not be verified.' }
$installed = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
$current = $null
$ready = $installed -and $installed.Installed -eq 1 -and
    [version]::TryParse(([string]$installed.Version).TrimStart('v'), [ref]$current) -and $current -ge $required
foreach ($name in @('msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll')) {
    $ready = $ready -and (Test-Path (Join-Path ([Environment]::SystemDirectory) $name))
}
if (-not $ready) {
    $installation = Start-Process $program -ArgumentList '/install /quiet /norestart' -Wait -PassThru
    if ($installation.ExitCode -eq 3010) { throw 'Restart Windows to finish installing the Microsoft runtime, then run setup again.' }
    if ($installation.ExitCode -ne 0) { throw ('Microsoft runtime installation failed: ' + $installation.ExitCode) }
}
