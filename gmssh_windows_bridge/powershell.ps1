[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
function global:prompt {
    $location = Get-Location
    'PS ' + $location.Path + '> '
}
