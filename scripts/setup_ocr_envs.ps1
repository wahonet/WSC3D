# 建立两个 OCR 工作环境（均在 ml/ocr 下，不入库）。需要 uv（pip install uv）与 Python 3.12。
#   .\scripts\setup_ocr_envs.ps1            # 两个都建
#   .\scripts\setup_ocr_envs.ps1 -Only ndl  # 只建古籍环境
# 现代书籍：MinerU（模型从 ModelScope 下载到用户缓存目录；Blackwell 显卡用 CUDA 12.8 的 torch）
# 古籍：NDL-KotenOCR Lite（ONNX，CPU），引擎源码与模型需先放到 ml/ocr/ndlkotenocr-lite/src
param([ValidateSet('all', 'mineru', 'ndl')][string]$Only = 'all')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$env:UV_LOCK_TIMEOUT = '900'

if ($Only -in 'all', 'ndl') {
    Write-Host '== NDL-KotenOCR Lite 环境' -ForegroundColor Cyan
    if (-not (Test-Path 'ml/ocr/ndlkotenocr-lite/src/model/rtmdet-s-1280x1280.onnx')) {
        Write-Warning '缺少引擎：请把 ndlkotenocr-lite 仓库的 src/（含 model/*.onnx 与 config/）放到 ml/ocr/ndlkotenocr-lite/src'
    }
    uv venv ml/ocr/ndl-venv --python 3.12
    uv pip install --python ml/ocr/ndl-venv/Scripts/python.exe onnxruntime numpy pillow PyYAML lxml tqdm networkx pypdfium2
}

if ($Only -in 'all', 'mineru') {
    Write-Host '== MinerU 环境' -ForegroundColor Cyan
    uv venv ml/ocr/mineru-venv --python 3.12
    $py = 'ml/ocr/mineru-venv/Scripts/python.exe'
    uv pip install --python $py 'mineru[core]'
    # CUDA 版 torch（RTX 50 系为 Blackwell，需 cu128 及以上）
    uv pip install --python $py --reinstall torch torchvision --index-url https://download.pytorch.org/whl/cu128
    $env:MINERU_MODEL_SOURCE = 'modelscope'
    & 'ml/ocr/mineru-venv/Scripts/mineru-models-download.exe' -s modelscope -m all
    & $py -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"
}
Write-Host '完成。后端会按 app/config.py 的默认路径找到这两个环境；也可用 STONELAB_OCR_PYTHON / STONELAB_NDL_PYTHON 指定。'
