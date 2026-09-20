param([ValidateSet('export','import')][string]$Mode='export')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
if ($Mode -eq 'export') {
    $dialog=New-Object Windows.Forms.SaveFileDialog
    $dialog.Title='导出研究交接包到 U 盘'
    $dialog.FileName='wsc-handover-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.zip'
} else {
    $dialog=New-Object Windows.Forms.OpenFileDialog
    $dialog.Title='选择上一次导出的研究交接包'
}
$dialog.Filter='WSC 研究交接包 (*.zip)|*.zip'
if ($dialog.ShowDialog() -ne 'OK') { exit 0 }
$package=$dialog.FileName
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'bootstrap.ps1') -Mode stop
if ($LASTEXITCODE -ne 0) { throw '平台未能停止，请查看提示。' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run.ps1') tools/transfer.py $Mode $package
if ($LASTEXITCODE -ne 0) { Read-Host '交接未完成。按回车关闭'; exit 1 }
Read-Host '交接完成。按回车关闭；需要继续使用时双击启动平台'
