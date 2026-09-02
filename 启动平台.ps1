# StoneLab 一键启动
#   .\启动平台.ps1           开发模式：后端 127.0.0.1:8020 + Vite 前端 127.0.0.1:5173（热更新）
#   .\启动平台.ps1 -Prod     生产模式：先构建前端，再由后端单进程托管，访问 http://127.0.0.1:8020/
#   .\启动平台.ps1 -Port 8030   改后端端口（开发模式下 Vite 代理仍指向 8020，只建议在 -Prod 下改）
param(
    [switch]$Prod,
    [int]$Port = 8020
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  StoneLab · 汉画像石研究平台" -ForegroundColor White
Write-Host ""

if (-not (Test-Path "$here\web\node_modules")) {
    Write-Host "  首次运行：安装前端依赖…" -ForegroundColor Cyan
    Push-Location "$here\web"; npm install --no-audit --no-fund; Pop-Location
}

if ($Prod) {
    Write-Host "  构建前端（web/dist）…" -ForegroundColor Cyan
    Push-Location "$here\web"; npm run build; Pop-Location
}

# 端口被占用时先提示，避免与上一次遗留的进程冲突
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    $pidBusy = ($busy | Select-Object -First 1).OwningProcess
    Write-Host "  端口 $Port 已被进程 $pidBusy 占用（可能是上一次未关闭的后端）。" -ForegroundColor Yellow
    $ans = Read-Host "  结束该进程并继续？(y/N)"
    if ($ans -match '^[Yy]') { Stop-Process -Id $pidBusy -Force; Start-Sleep -Seconds 1 } else { exit 1 }
}

Write-Host "  启动后端 http://127.0.0.1:$Port …" -ForegroundColor Cyan
Start-Process -WindowStyle Minimized powershell -ArgumentList @(
    "-NoExit", "-Command",
    "`$env:PYTHONUTF8='1'; `$env:STONELAB_PORT='$Port'; Set-Location '$here\server'; python -m uvicorn app.main:app --host 127.0.0.1 --port $Port"
) | Out-Null

$ok = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    try {
        $h = Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 3
        Write-Host "  后端就绪：$($h.Content)" -ForegroundColor Green
        $ok = $true; break
    } catch { }
}
if (-not $ok) { Write-Host "  后端未响应，请查看最小化的后端窗口。" -ForegroundColor Red }

if ($Prod) {
    Start-Process "http://127.0.0.1:$Port/"
    Write-Host "  已在浏览器打开 http://127.0.0.1:$Port/ （接口文档 /docs）" -ForegroundColor Green
} else {
    Start-Process "http://127.0.0.1:5173/"
    Write-Host "  前端开发服务器启动中（Ctrl+C 结束）…" -ForegroundColor Cyan
    Push-Location "$here\web"
    npm run dev
    Pop-Location
}
