$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
# Windows has no Linux .profile or sudo. Report absence without editing profiles
# or claiming root privileges; the terminal uses the authenticated Windows user.
'__GMB_LOGIN_PROFILE__=1'
'__GMB_LOGIN_USER__=' + $env:USERNAME
'__GMB_LOGIN_SUDO__=0'
'__GMB_LOGIN_SUDO_ACCESS__=0'
'__GMB_LOGIN_SUDO_PASSWORD__=0'
'__GMB_LOGIN_OS__=' + (Get-CimInstance Win32_OperatingSystem).Caption
