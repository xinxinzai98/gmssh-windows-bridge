#requires -Version 5.1
# Native file transactions; all firewall, service and account queries are fixtures.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\gmssh_windows_bridge\setup-connect.ps1')
. (Join-Path $PSScriptRoot '..\gmssh_windows_bridge\setup-network.ps1')
function Assert($Value,[string]$Message){if(-not $Value){throw $Message}}
$values=@(ConvertTo-GMSSHIPv6Sources @('2001:DB8::20','2001:db8:10::99/64','2001:db8::20/128',' '))
Assert (($values -join ',') -ceq '2001:db8::20/128,2001:db8:10::/64') 'IPv6 source normalization failed'
foreach($bad in @('192.0.2.1','::/0','::1','fe80::1','ff02::1','::ffff:10.0.0.1','2001:db8::1%2','2001:db8::1/129','not-an-address')){
 $blocked=$false;try{ConvertTo-GMSSHIPv6Sources @($bad)|Out-Null}catch{$blocked=$true};Assert $blocked ('Invalid source accepted: '+$bad)
}
Assert (@(ConvertTo-GMSSHIPv6Sources @($null,'')).Count -eq 0) 'Empty source list failed'
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('gmssh-ipv6-check-'+[Guid]::NewGuid().ToString('N'))
$program=Join-Path $fixture 'program';$data=Join-Path $fixture 'data';$script:sshd=Join-Path $program 'sshd.exe'
$script:rules=@{'foreign-rule'=[pscustomobject]@{Group='Other software';Enabled='True'}};$script:changes=0;$script:fail='';$script:externalChange=$false
function Get-LocalUser{param($Name,$ErrorAction);[pscustomobject]@{Enabled=$true;SID=[pscustomobject]@{Value='S-1-5-21-1-2-3-1004'}}}
function Get-GMSSHConnectHelper{param($ProgramRoot);Join-Path $ProgramRoot 'gmssh-connect.exe'}
function Get-CimInstance{[CmdletBinding()]param($ClassName,$Filter);[pscustomobject]@{PathName=('"'+$script:sshd+'"')}}
function Owned($Name,$PolicyStore){Assert ($PolicyStore -ceq 'PersistentStore' -and $Name -in @('GMSSH-Windows-Connect-IPv6','GMSSH-Windows-SSH-IPv6')) 'Another firewall rule/store was touched'}
function Get-NetFirewallRule{[CmdletBinding()]param($PolicyStore,$Name);Owned $Name $PolicyStore;$script:rules[$Name]}
function Get-NetFirewallPortFilter{[CmdletBinding()]param([Parameter(ValueFromPipeline=$true)]$Rule);process{[pscustomobject]@{Protocol='TCP';LocalPort=$Rule.LocalPort}}}
function Get-NetFirewallAddressFilter{[CmdletBinding()]param([Parameter(ValueFromPipeline=$true)]$Rule);process{[pscustomobject]@{LocalAddress='Any';RemoteAddress=@($Rule.RemoteAddress|ForEach-Object {$_ -replace '/128$',''})}}}
function Get-NetFirewallApplicationFilter{[CmdletBinding()]param([Parameter(ValueFromPipeline=$true)]$Rule);process{[pscustomobject]@{Program=$Rule.Program}}}
function Fail-Once($Name){if($script:fail -ceq $Name){$script:fail='';throw 'Synthetic firewall failure'}}
function New-NetFirewallRule{[CmdletBinding()]param($PolicyStore,$Name,$DisplayName,$Group,$Enabled,$Direction,$Action,$Protocol,$LocalPort,$LocalAddress,$RemoteAddress,$Program,$Profile)
 Owned $Name $PolicyStore;Fail-Once $Name;$script:changes++
 $script:rules[$Name]=[pscustomobject]@{Group=$Group;Enabled=[string]$Enabled;Direction=$Direction;Action=$Action;LocalPort=$LocalPort;RemoteAddress=@($RemoteAddress);Program=$Program;Profile=$Profile}
}
function Set-NetFirewallRule{[CmdletBinding()]param($PolicyStore,$Name,$RemoteAddress,$Enabled);Owned $Name $PolicyStore;Fail-Once $Name;$script:changes++;$script:rules[$Name].RemoteAddress=@($RemoteAddress);$script:rules[$Name].Enabled=[string]$Enabled
 if($script:externalChange){$script:externalChange=$false;$changed=Get-Content $script:metadataPath -Raw|ConvertFrom-Json;$changed.marker='updated-by-another-operation';[IO.File]::WriteAllText($script:metadataPath,($changed|ConvertTo-Json -Depth 8))}
}
function Remove-NetFirewallRule{[CmdletBinding()]param($PolicyStore,$Name);Owned $Name $PolicyStore;$script:changes++;[void]$script:rules.Remove($Name)}
try{
 foreach($p in @($program,$data)){New-Item -ItemType Directory -Path $p|Out-Null}
 'fixture'|Set-Content $script:sshd
 @{computer=[Environment]::MachineName;username='gmssh';unifiedPassword=$true;managedAccountSid='S-1-5-21-1-2-3-1004';trayUserSid='S-1-5-21-1-2-3-1001';marker='retain-other-settings'}|ConvertTo-Json|Set-Content (Join-Path $data 'agent.json') -Encoding UTF8
 @{sshBinary=$script:sshd}|ConvertTo-Json|Set-Content (Join-Path $data 'connection.json') -Encoding UTF8
 $path=Join-Path $data 'agent.json';$script:metadataPath=$path;$original=[IO.File]::ReadAllText($path)
 Assert (@(Get-GMSSHIPv6Sources $data).Count -eq 0) 'Fresh installation was not local-only'
 $script:fail='GMSSH-Windows-SSH-IPv6';$blocked=$false
 try{Set-GMSSHIPv6Sources $program $data @('2001:db8::20')}catch{$blocked=$true}
 Assert ($blocked -and $script:rules.Count -eq 1 -and [IO.File]::ReadAllText($path) -ceq $original) 'Partial firewall failure left access or metadata changes'
 Set-GMSSHIPv6Sources $program $data @('2001:db8::20','2001:db8:10::99/64')
 Assert ((@(Get-GMSSHIPv6Sources $data)-join ',') -ceq ($values-join ',')) 'Saved source policy differs from input'
 Assert ($script:rules.Count -eq 3 -and $script:rules['GMSSH-Windows-SSH-IPv6'].LocalPort -eq 22 -and $script:rules['GMSSH-Windows-Connect-IPv6'].LocalPort -eq 22257) 'Required owned ports were not synchronized'
 Assert ((Get-Content $path -Raw|ConvertFrom-Json).marker -ceq 'retain-other-settings') 'Unrelated settings were lost'
 $original=[IO.File]::ReadAllText($path);$oldSources=$script:rules['GMSSH-Windows-Connect-IPv6'].RemoteAddress -join ','
 $lock=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 try{$blocked=$false;try{Set-GMSSHIPv6Sources $program $data @('2001:db8:20::4')}catch{$blocked=$true};Assert $blocked 'Locked metadata was overwritten'}finally{$lock.Dispose()}
 Assert ([IO.File]::ReadAllText($path) -ceq $original -and ($script:rules['GMSSH-Windows-Connect-IPv6'].RemoteAddress -join ',') -ceq $oldSources) 'Metadata write failure did not restore firewall scope'
 $script:externalChange=$true;$blocked=$false;try{Set-GMSSHIPv6Sources $program $data @('2001:db8:20::4')}catch{$blocked=$true}
 Assert ($blocked -and (Get-Content $path -Raw|ConvertFrom-Json).marker -ceq 'updated-by-another-operation' -and ($script:rules['GMSSH-Windows-Connect-IPv6'].RemoteAddress -join ',') -ceq $oldSources) 'A concurrent metadata edit was overwritten'
 $script:rules['GMSSH-Windows-SSH-IPv6'].Group='Foreign';$before=$script:changes;$blocked=$false
 try{Set-GMSSHIPv6Sources $program $data @()}catch{$blocked=$true}
 Assert ($blocked -and $script:changes -eq $before) 'Foreign rule collision changed the other rule'
 $script:rules['GMSSH-Windows-SSH-IPv6'].Group='GMSSH Windows IPv6 Access'
 Set-GMSSHIPv6Sources $program $data @()
 Assert ($script:rules.Count -eq 1 -and @(Get-GMSSHIPv6Sources $data).Count -eq 0 -and $script:rules['foreign-rule'].Enabled -ceq 'True') 'Local-only reset touched foreign rules or left external scope'
 'PASS: IPv6 normalization, owned port/program scopes, partial firewall rollback, native locked-file rollback, retained settings and local-only reset; no actual system configuration changed.'
}finally{if(Test-Path $fixture){Remove-Item -LiteralPath $fixture -Recurse -Force}}
