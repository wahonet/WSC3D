param([switch]$Force)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$project=Get-Content -LiteralPath (Join-Path $workspace 'config\project.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ruleName='WSC-Local-Network-'+$project.port
$machineId=(Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid
$receiptPath=Join-Path $workspace 'logs\lan-status.json'
if(!$Force -and (Test-Path -LiteralPath $receiptPath)) {
    $receipt=Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if($receipt.machine_id -eq $machineId -and $receipt.rule -eq $ruleName -and $receipt.enabled -eq 'True' -and $receipt.action -eq 'Allow' -and (@($receipt.remote) -join ',') -eq 'LocalSubnet') {
        Write-Output 'Local subnet access already configured.'
        exit 0
    }
}
$admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (!$admin) {
    $parameters=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-Force')
    $process=Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList $parameters -Wait -PassThru
    exit $process.ExitCode
}
if (!(Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $ruleName -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $project.port -RemoteAddress LocalSubnet -Profile Any | Out-Null
}
else {
    Set-NetFirewallRule -Name $ruleName -Enabled True -Direction Inbound -Action Allow -Protocol TCP -LocalPort $project.port -RemoteAddress LocalSubnet -Profile Any | Out-Null
}
Write-Output 'Local subnet access configured.'
$rule=Get-NetFirewallRule -Name $ruleName
$address=$rule | Get-NetFirewallAddressFilter
$port=$rule | Get-NetFirewallPortFilter
$report=@{machine_id=$machineId;rule=$ruleName;enabled=[string]$rule.Enabled;action=[string]$rule.Action;remote=@($address.RemoteAddress);port=@($port.LocalPort)}
$logFolder=Join-Path $workspace 'logs'
[IO.Directory]::CreateDirectory($logFolder) | Out-Null
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $logFolder 'lan-status.json') -Encoding UTF8
