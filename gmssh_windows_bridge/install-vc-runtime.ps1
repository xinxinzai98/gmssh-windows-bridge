#requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'setup-checks.ps1')
$metadata = (Get-Content (Join-Path $PSScriptRoot 'windows-installers.json') -Raw | ConvertFrom-Json).vcredist
$required = $null
if ($metadata.filename -cne 'VC_redist.x64.exe' -or $metadata.sha256 -notmatch '^[a-f0-9]{64}$' -or
    -not [version]::TryParse([string]$metadata.version, [ref]$required)) { throw 'Runtime installer metadata is invalid.' }
if (Test-GMSSHRuntimeInstalled -Required $required) { return }
$program = Join-Path $PSScriptRoot ('installers\' + $metadata.filename)
function Test-RuntimeFile([string]$File) {
    (Get-FileHash $File -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $metadata.sha256 -and
        (Get-AuthenticodeSignature $File).Status -eq 'Valid'
}
if (-not (Test-Path $program)) {
    $settings = Get-Content (Join-Path $PSScriptRoot 'setup-config.json') -Raw | ConvertFrom-Json
    $uri = [uri]$metadata.url
    if ($settings.runtimeSource -cne 'microsoft' -or $uri.Scheme -cne 'https' -or
        $uri.Host -cne 'download.visualstudio.microsoft.com') { throw 'The verified Microsoft runtime installer is missing.' }
    $statusFile = Join-Path $PSScriptRoot 'installation-status.txt'
    if (Test-Path $statusFile) { '正在从微软官方获取所需运行库…' | Set-Content $statusFile -Encoding UTF8 }
    New-Item -ItemType Directory -Path (Split-Path $program -Parent) -Force | Out-Null
    $download = $program + '.' + [Guid]::NewGuid().ToString('N') + '.download.exe'
    $previousProtocols = [Net.ServicePointManager]::SecurityProtocol
    try {
        [Net.ServicePointManager]::SecurityProtocol = $previousProtocols -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri $uri.AbsoluteUri -OutFile $download -TimeoutSec 180
        if (-not (Test-RuntimeFile $download)) { throw 'Microsoft runtime download verification failed.' }
        Move-Item -LiteralPath $download -Destination $program -ErrorAction Stop
    } catch {
        throw 'Microsoft runtime could not be obtained or verified. Install the official x64 runtime and run GMSSH setup again.'
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $previousProtocols
        if (Test-Path $download) { Remove-Item -LiteralPath $download -Force }
    }
}
if (-not (Test-RuntimeFile $program)) { throw 'Microsoft runtime installer verification failed.' }
$installation = Start-Process $program -ArgumentList '/install /quiet /norestart' -Wait -PassThru
if ($installation.ExitCode -eq 3010) { throw 'Restart Windows to finish installing the Microsoft runtime, then run setup again.' }
if ($installation.ExitCode -notin @(0,1638) -or -not (Test-GMSSHRuntimeInstalled -Required $required)) {
    throw ('Microsoft runtime installation did not complete: ' + $installation.ExitCode)
}
