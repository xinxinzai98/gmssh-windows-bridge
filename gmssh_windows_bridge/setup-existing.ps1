#requires -Version 5.1
# Attach to existing services without editing their config, credentials or state.
function Get-GMSSHExistingServicePath([string]$Command,[string]$Name) {
    $commandLine=[Environment]::ExpandEnvironmentVariables($Command).Trim()
    $config=$null
    if($Name -eq 'sshd') {
        if($commandLine -match '^"([^"\r\n]+)"(?:\s+-f\s+"([^"\r\n]+)")?\s*$') {
            $binary=$Matches[1];if($Matches[2]){$config=$Matches[2]}
        } elseif($commandLine -match '^([^"\r\n]+\.exe)\s*$') { $binary=$Matches[1] }
        else {throw '既有 SSH 服务参数暂不支持；请保留原服务并由管理员核对启动命令。'}
    } else {
        if($commandLine -notmatch '^"([^"\r\n]+)"\s+--service\s*$'){throw '既有桌面服务启动命令无法核对。'}
        $binary=$Matches[1]
    }
    if(-not [IO.Path]::IsPathRooted($binary) -or [IO.Path]::GetFileName($binary) -ine $(if($Name -eq 'sshd'){'sshd.exe'}else{'rustdesk.exe'}) -or
        -not (Test-Path -LiteralPath $binary -PathType Leaf) -or (Get-AuthenticodeSignature -LiteralPath $binary).Status -ne 'Valid') {
        throw '既有服务程序不存在或未通过签名检查。'
    }
    [pscustomobject]@{binary=[IO.Path]::GetFullPath($binary);config=$config;command=$commandLine}
}

function Get-GMSSHExistingSSHOptions([string]$Binary,[string]$Config) {
    if($Config -match '["\x00-\x1f]'){throw '既有 SSH 配置路径无效。'}
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=$Binary;$start.Arguments='-T -f "'+$Config+'"'
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$start.RedirectStandardError=$true
    $process=New-Object Diagnostics.Process;$process.StartInfo=$start
    try {
        if(-not $process.Start()){throw '无法只读检查既有 SSH 配置。'}
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(10000)){$process.Kill();throw '既有 SSH 配置检查超时，原服务未更改。'}
        $text=$stdout.GetAwaiter().GetResult();[void]$stderr.GetAwaiter().GetResult()
        if($process.ExitCode -ne 0 -or $text.Length -gt 131072){throw '既有 SSH 配置未通过只读检查，原服务未更改。'}
        $text -split '\r?\n'
    } finally {$process.Dispose()}
}

function Get-GMSSHExistingServices {
    param([string]$WindowsUser,[string]$SSHRoot=(Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'ssh'))
    $account=Get-LocalUser -Name $WindowsUser -ErrorAction Stop
    if(-not $account.Enabled){throw '所选既有本地账号未启用。'}
    $administrators=Get-LocalGroup -SID 'S-1-5-32-544' -ErrorAction Stop
    if(-not @(Get-LocalGroupMember -Group $administrators.Name -ErrorAction Stop|Where-Object{$_.SID.Value -ceq $account.SID.Value}).Count){
        throw '独立文件通道以服务身份工作，保留模式仅支持已有本地管理员账号；本次不会提升原账号权限。'
    }
    $paths=@{}
    foreach($name in @('sshd','RustDesk')) {
        $service=Get-Service $name -ErrorAction Stop
        if($service.Status -ne 'Running' -or $service.StartType -ne 'Automatic') {
            throw ('保留模式需要原 '+$name+' 服务已运行且自动启动；请在原服务中处理，本次未修改。')
        }
        $spec=Get-CimInstance Win32_Service -Filter ("Name='"+$name+"'") -ErrorAction Stop
        $paths[$name]=Get-GMSSHExistingServicePath ([string]$spec.PathName) $name
    }
    $config=$paths.sshd.config
    if(-not $config){$config=Join-Path $SSHRoot 'sshd_config'}
    if(-not [IO.Path]::IsPathRooted($config) -or -not (Test-Path -LiteralPath $config -PathType Leaf)){throw '无法读取既有 SSH 配置。'}
    $options=@(Get-GMSSHExistingSSHOptions $paths.sshd.binary $config)
    $ports=@($options|Where-Object {$_ -match '^port [0-9]+$'}|ForEach-Object {[int]($_.Substring(5))}|Select-Object -Unique)
    if($ports.Count -ne 1 -or $ports[0] -lt 1 -or $ports[0] -gt 65535){throw '保留模式暂时需要一个明确的既有 SSH 监听端口。'}
    if($options -notcontains 'passwordauthentication yes'){throw '既有 SSH 未允许密码认证；请使用原有方式管理，本次未放宽认证设置。'}
    if(-not @($options|Where-Object {$_ -match '^subsystem sftp (?:sftp-server\.exe|internal-sftp|"?[^"\r\n]+[\\/]sftp-server\.exe"?)(?:\s|$)'}).Count){throw '既有 SSH 缺少可识别的 SFTP 子系统，本次未修改。'}
    $forward=@($options|Where-Object {$_ -match '^allowtcpforwarding (yes|local)$'})
    $permit=@($options|Where-Object {$_ -eq 'permitopen any' -or $_ -match '^permitopen (?:\S+ )*127\.0\.0\.1:21118(?: |$)'})
    if(-not $forward.Count -or -not $permit.Count -or $options -contains 'disableforwarding yes'){throw '既有 SSH 不允许所需的本机桌面隧道，本次未放宽转发设置。'}
    foreach($item in @(@($ports[0],$paths.sshd.binary),@(21118,$paths.RustDesk.binary))) {
        $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $item[0] -ErrorAction SilentlyContinue)
        $owned=@($listeners|Where-Object { try { (Get-Process -Id $_.OwningProcess -ErrorAction Stop).Path -ieq $item[1] } catch {$false} })
        if(-not $owned.Count){throw ('既有 TCP '+$item[0]+' 未由对应服务程序监听；请在原程序中处理，本次未修改。')}
    }
    $keys=@($options|Where-Object {$_ -match '^hostkey .+'}|ForEach-Object {$_.Substring(8).Trim('"')})
    $public=$null
    foreach($key in $keys) {
        $file=[Environment]::ExpandEnvironmentVariables($key.Replace('__PROGRAMDATA__',[Environment]::GetFolderPath('CommonApplicationData')))+'.pub'
        if(Test-Path -LiteralPath $file -PathType Leaf) {
            $candidate=[IO.File]::ReadAllText($file).Trim()
            if($candidate -match '^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$'){$public=$candidate;break}
        }
    }
    if(-not $public){throw '既有 SSH 缺少可读取的 Ed25519 公钥；本次不会生成或替换主机密钥。'}
    $blob=[Convert]::FromBase64String($public.Split(' ')[1])
    if($blob.Length -ne 51 -or [BitConverter]::ToString($blob,0,4) -cne '00-00-00-0B' -or
        [Text.Encoding]::ASCII.GetString($blob,4,11) -cne 'ssh-ed25519' -or [BitConverter]::ToString($blob,15,4) -cne '00-00-00-20'){throw '既有 Ed25519 公钥格式无效。'}
    $hash=[Security.Cryptography.SHA256]::Create()
    try {$fingerprint='SHA256:'+ [Convert]::ToBase64String($hash.ComputeHash($blob)).TrimEnd('=')}finally{$hash.Dispose()}
    [pscustomobject]@{username=$account.Name;accountSid=$account.SID.Value;sshPort=$ports[0];sshBinary=$paths.sshd.binary;
        sshConfig=[IO.Path]::GetFullPath($config);sshHostPublicKey=$public;sshHostFingerprint=$fingerprint;
        engine=$paths.RustDesk.binary;sshServiceCommand=$paths.sshd.command;desktopServiceCommand=$paths.RustDesk.command}
}

function Save-GMSSHExistingConnection {
    param($Profile,[string]$DataRoot,[string]$ControllerAddress)
    if(Test-Path -LiteralPath $DataRoot){throw '保留接入需要新的 GMSSH 数据目录；发现已有目录，未覆盖。'}
    New-Item -ItemType Directory -Path $DataRoot | Out-Null
    & (Join-Path ([Environment]::SystemDirectory) 'icacls.exe') $DataRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
    if($LASTEXITCODE -ne 0){throw '无法保护新接入记录目录。'}
    $public=[ordered]@{schema=1;computer=[Environment]::MachineName;username=$Profile.username;addresses=@(Get-GMSSHAddresses);
        sshPort=$Profile.sshPort;controller=$ControllerAddress;sshHostPublicKey=$Profile.sshHostPublicKey;
        sshHostFingerprint=$Profile.sshHostFingerprint;sshBinary=$Profile.sshBinary;sshConfig=$Profile.sshConfig;
        sshStatus='Running';sshStartup='Automatic';desktopAuth='manual'}
    $public | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $DataRoot 'connection.json') -Encoding UTF8
}
