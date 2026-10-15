#requires -Version 5.1
param([string]$ChecksSource, [string]$RuntimeSource)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
if (-not $ChecksSource) { $ChecksSource=Get-Content (Join-Path $root 'gmssh_windows_bridge\setup-checks.ps1') -Raw -Encoding UTF8 }
if (-not $RuntimeSource) { $RuntimeSource=Get-Content (Join-Path $root 'gmssh_windows_bridge\install-vc-runtime.ps1') -Raw -Encoding UTF8 }
function Assert($Ok,[string]$Message) { if (-not $Ok) { throw $Message } }
. ([scriptblock]::Create($ChecksSource))
function Get-ItemProperty { param($Path,$ErrorAction) [pscustomobject]@{Installed=1;Version=$global:GMSSHRuntimeVersion} }
function Test-Path { param($Path) -not $global:GMSSHRuntimeMissingDll }
$global:GMSSHRuntimeVersion='v14.51.36247.0';$global:GMSSHRuntimeMissingDll=$false
Assert (Test-GMSSHRuntimeInstalled -Required ([version]'14.51.36247.0')) 'Ready runtime was rejected'
$global:GMSSHRuntimeVersion='v14.0.0.0'
Assert (-not (Test-GMSSHRuntimeInstalled -Required ([version]'14.51.36247.0'))) 'Old runtime was accepted'
$global:GMSSHRuntimeVersion='v14.51.36247.0';$global:GMSSHRuntimeMissingDll=$true
Assert (-not (Test-GMSSHRuntimeInstalled -Required ([version]'14.51.36247.0'))) 'Missing DLL was accepted'
Remove-Item Function:\Test-Path
Remove-Item Function:\Get-ItemProperty

$fixture=Join-Path ([IO.Path]::GetTempPath()) ('gmssh-runtime-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $program=Join-Path $fixture 'installers\VC_redist.x64.exe'
    $global:GMSSHRuntimeBody=[Text.Encoding]::UTF8.GetBytes('fixture-runtime')
    $hash=[Security.Cryptography.SHA256]::Create()
    try { $digest=([BitConverter]::ToString($hash.ComputeHash($global:GMSSHRuntimeBody))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
    @{vcredist=@{filename='VC_redist.x64.exe';version='14.51.36247.0';sha256=$digest;url='https://download.visualstudio.microsoft.com/download/pr/fixture/VC_redist.x64.exe'}}|ConvertTo-Json|Set-Content (Join-Path $fixture 'windows-installers.json') -Encoding UTF8
    @{runtimeSource='microsoft'}|ConvertTo-Json|Set-Content (Join-Path $fixture 'setup-config.json') -Encoding UTF8
    'function Test-GMSSHRuntimeInstalled { param($Required) return $global:GMSSHRuntimeReady }'|Set-Content (Join-Path $fixture 'setup-checks.ps1') -Encoding UTF8
    $RuntimeSource|Set-Content (Join-Path $fixture 'install-vc-runtime.ps1') -Encoding UTF8
    function Invoke-WebRequest {
        param([switch]$UseBasicParsing,$Uri,$OutFile,$TimeoutSec)
        Assert ($Uri.StartsWith('https://download.visualstudio.microsoft.com/')) 'Wrong download host'
        $global:GMSSHRuntimeDownloads++
        [IO.File]::WriteAllBytes($OutFile,$global:GMSSHRuntimeBody)
    }
    function Get-AuthenticodeSignature { param($FilePath) [pscustomobject]@{Status=$(if($global:GMSSHRuntimeBadSignature){'NotSigned'}else{'Valid'})} }
    function Start-Process {
        param($FilePath,$ArgumentList,[switch]$Wait,[switch]$PassThru)
        $global:GMSSHRuntimeInstalls++;$global:GMSSHRuntimeReady=$true
        [pscustomobject]@{ExitCode=0}
    }
    $global:GMSSHRuntimeDownloads=0;$global:GMSSHRuntimeInstalls=0;$global:GMSSHRuntimeReady=$true;$global:GMSSHRuntimeBadSignature=$false
    & (Join-Path $fixture 'install-vc-runtime.ps1')
    Assert ($global:GMSSHRuntimeDownloads -eq 0 -and $global:GMSSHRuntimeInstalls -eq 0) 'Ready runtime triggered download or installation'
    $global:GMSSHRuntimeReady=$false
    & (Join-Path $fixture 'install-vc-runtime.ps1')
    Assert ($global:GMSSHRuntimeDownloads -eq 1 -and $global:GMSSHRuntimeInstalls -eq 1) 'Missing runtime did not use verified download'
    Remove-Item -LiteralPath $program
    $global:GMSSHRuntimeReady=$false;$global:GMSSHRuntimeBadSignature=$true
    $blocked=$false;try { & (Join-Path $fixture 'install-vc-runtime.ps1') } catch { $blocked=$true }
    Assert ($blocked -and $global:GMSSHRuntimeInstalls -eq 1 -and -not (Test-Path $program)) 'Unverified download was executed or retained'
    Assert (-not @(Get-ChildItem $fixture -Recurse -Filter '*.download.exe').Count) 'Partial download was retained'
    'PASS: installed runtime short circuit, official download, signature rejection; all network and installation operations were mocked.'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
    Get-Variable -Name 'GMSSHRuntime*' -Scope Global -ErrorAction SilentlyContinue | Remove-Variable -Scope Global -ErrorAction SilentlyContinue
}
