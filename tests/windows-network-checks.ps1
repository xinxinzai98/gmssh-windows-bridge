#requires -Version 5.1
# Firewall cmdlets are fixtures: these tests never change real firewall rules.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\gmssh_windows_bridge\setup-checks.ps1')
. (Join-Path $PSScriptRoot '..\gmssh_windows_bridge\setup-network.ps1')
. (Join-Path $PSScriptRoot '..\gmssh_windows_bridge\setup-connect.ps1')
function Assert($Value,[string]$Message) { if (-not $Value) { throw $Message } }
$script:addresses=@(
    @('10.10.10.2','Preferred'),@('2001:DB8:0:1:0:0:0:10','Preferred'),@('fd00::20','Preferred'),
    @('2001:db8:1::30','Deprecated'),@('2001:db8:1::40','Preferred'),@('2001:db8:0:1::10','Preferred'),
    @('fe80::1%5','Preferred'),@('::1','Preferred'),@('::','Preferred'),@('ff02::1','Preferred'),
    @('::ffff:10.10.10.2','Preferred'),@('169.254.1.2','Preferred'),@('127.0.0.1','Preferred'),
    @('2001:db8::bad','Tentative'),@('2001:db8::dead','Duplicate'),@('bad','Preferred')
) | ForEach-Object { [pscustomobject]@{IPAddress=$_[0];AddressState=$_[1]} }
function Get-NetIPAddress { [CmdletBinding()]param(); $script:addresses }
$expected=@('10.10.10.2','2001:db8:0:1::10','fd00::20','2001:db8:1::30','2001:db8:1::40')
Assert ((@(Get-GMSSHAddresses) -join ',') -ceq ($expected -join ',')) 'IPv6 addresses were lost, duplicated, or exported with an unusable scope'
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('gmssh-network-check-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    @{schema=1;computer='LAB-PC';username='gmssh';sshPort=22;addresses=@('10.10.10.1');sshStatus='old';sshStartup='old'} | ConvertTo-Json | Set-Content (Join-Path $fixture 'connection.json') -Encoding UTF8
    function Get-Service { param($Name,$ErrorAction); [pscustomobject]@{Status='Running';StartType='Automatic'} }
    $info=Get-GMSSHConnectionInfo -DataRoot $fixture
    Assert (($info.addresses -join ',') -ceq ($expected -join ',')) 'Public connection export retained stale IPv4-only addresses'
    function Invoke-GMSSHConnectHelper { param($ProgramRoot,$DataRoot,$Operation,$InputJson)
        Assert ($Operation -ceq 'code') 'Unexpected helper operation'
        $script:exported=$InputJson|ConvertFrom-Json
        'GMSSH-CONNECT1.synthetic'
    }
    [void](Get-GMSSHConnectCode -ProgramRoot $fixture -DataRoot $fixture)
    Assert (($script:exported.addresses -join ',') -ceq ($expected -join ',')) 'Connection-code/QR input lost IPv6 addresses'
    $script:addresses=@($script:addresses | Where-Object {$_.IPAddress -ne '10.10.10.2'})
    Assert (@(Get-GMSSHAddresses).Count -eq 4) 'An IPv6-only host had no exportable addresses'
} finally { Remove-Item -LiteralPath $fixture -Recurse -Force }

$script:rules=@{}; $script:changes=0; $script:fail=''
function Assert-RuleName($Name,$PolicyStore) {
    Assert ($Name -in @('GMSSH-Windows-Ping-IPv4','GMSSH-Windows-Ping-IPv6') -and $PolicyStore -ceq 'PersistentStore') 'Attempted to change another firewall rule or store'
}
function Get-NetFirewallRule { [CmdletBinding()]param($PolicyStore,$Name); Assert-RuleName $Name $PolicyStore; $script:rules[$Name] }
function Get-NetFirewallPortFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{Protocol=$Rule.Protocol;IcmpType=@($Rule.IcmpType)} } }
function Get-NetFirewallAddressFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{RemoteAddress='Any';LocalAddress='Any'} } }
function Get-NetFirewallApplicationFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{Program='Any'} } }
function New-NetFirewallRule { [CmdletBinding()]param($PolicyStore,$Name,$DisplayName,$Group,$Direction,$Action,$Enabled,$Profile,$Protocol,$IcmpType,$LocalAddress,$RemoteAddress,$Program)
    Assert-RuleName $Name $PolicyStore
    if ($script:fail -ceq $Name) { throw 'Synthetic second-rule failure' }
    $script:changes++; $script:rules[$Name]=[pscustomobject]@{Group=$Group;Direction=$Direction;Action=$Action;Enabled=[string]$Enabled;Profile=$Profile;Protocol=$Protocol;IcmpType=$IcmpType}
}
function Enable-NetFirewallRule { [CmdletBinding()]param($PolicyStore,$Name); Assert-RuleName $Name $PolicyStore; $script:changes++;$script:rules[$Name].Enabled='True' }
function Disable-NetFirewallRule { [CmdletBinding()]param($PolicyStore,$Name); Assert-RuleName $Name $PolicyStore; $script:changes++;$script:rules[$Name].Enabled='False' }
function Remove-NetFirewallRule { [CmdletBinding()]param($PolicyStore,$Name); Assert-RuleName $Name $PolicyStore;$script:changes++;[void]$script:rules.Remove($Name) }
Assert (-not (Get-GMSSHPingStatus).enabled -and $script:changes -eq 0) 'Status query changed firewall rules'
Set-GMSSHPingAccess $false
Assert ($script:rules.Count -eq 0 -and $script:changes -eq 0) 'Disabling on a fresh host created rules'
Set-GMSSHPingAccess $true
Assert ((Get-GMSSHPingStatus).enabled -and $script:rules.Count -eq 2) 'IPv4 and IPv6 echo request were not enabled together'
Assert ($script:rules['GMSSH-Windows-Ping-IPv4'].IcmpType -ceq '8' -and $script:rules['GMSSH-Windows-Ping-IPv6'].IcmpType -ceq '128') 'Ping allowed more than echo requests'
$before=$script:changes;Set-GMSSHPingAccess $true
Assert ($script:changes -eq $before) 'Repeated enable was not idempotent'
Set-GMSSHPingAccess $false
Assert (-not (Get-GMSSHPingStatus).enabled -and -not (Get-GMSSHPingStatus).partial) 'Disable left one address family enabled'
$before=$script:changes;Set-GMSSHPingAccess $false
Assert ($script:changes -eq $before) 'Repeated disable changed rules'
$script:rules['GMSSH-Windows-Ping-IPv6'].Group='Foreign rule';$before=$script:changes
$blocked=$false;try { Set-GMSSHPingAccess $true } catch { $blocked=$true }
Assert ($blocked -and $before -eq $script:changes) 'Foreign rule collision partially changed firewall rules'
$script:rules=@{};$script:fail='GMSSH-Windows-Ping-IPv6'
$blocked=$false;try { Set-GMSSHPingAccess $true } catch { $blocked=$true }
Assert ($blocked -and $script:rules.Count -eq 0) 'Partial enable was not rolled back'
'PASS: dual-stack exports, IPv6-only export, live code/QR addresses, echo-only rules, ownership, idempotence and rollback; no real firewall changes.'
