param(
  [string]$Token = $env:HF_TOKEN,
  [string]$Endpoint = $env:WSC3D_SAM3_HF_ENDPOINT,
  [string]$LocalCheckpoint = $env:WSC3D_SAM3_LOCAL_CHECKPOINT
)

$ErrorActionPreference = "Stop"

$ServiceRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Python = Join-Path $ServiceRoot ".venv\Scripts\python.exe"
$Hf = Join-Path $ServiceRoot ".venv\Scripts\hf.exe"
$WeightsDir = Join-Path $ServiceRoot "weights\sam3"
$Checkpoint = Join-Path $WeightsDir "sam3.pt"

function Fail($Message) {
  Write-Host ""
  Write-Error $Message
  exit 1
}

if (!(Test-Path -LiteralPath $Python)) {
  Fail "Python venv not found at $Python. Run: cd ai-service; python -m venv .venv; .venv\Scripts\python.exe -m pip install -r requirements.txt"
}

if (!(Test-Path -LiteralPath $Hf)) {
  Fail "Hugging Face CLI not found in the venv. Run: cd ai-service; .venv\Scripts\python.exe -m pip install -r requirements.txt"
}

New-Item -ItemType Directory -Path $WeightsDir -Force | Out-Null

Write-Host "[1/4] Checking CUDA PyTorch..."
& $Python -c "import torch; print('torch', torch.__version__); print('cuda runtime', torch.version.cuda); print('cuda available', torch.cuda.is_available()); print('gpu', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none')"
if ($LASTEXITCODE -ne 0) {
  Fail "CUDA PyTorch check failed."
}

if ($LocalCheckpoint) {
  $ResolvedLocalCheckpoint = Resolve-Path -LiteralPath $LocalCheckpoint -ErrorAction Stop
  Write-Host "[2/4] Importing local SAM3 checkpoint..."
  Copy-Item -LiteralPath $ResolvedLocalCheckpoint -Destination $Checkpoint -Force
  Write-Host "Copied $ResolvedLocalCheckpoint to $Checkpoint"
  Write-Host "[3/4] Skipping Hugging Face download because -LocalCheckpoint was provided."
} elseif (Test-Path -LiteralPath $Checkpoint) {
  Write-Host "[2/4] Found existing local SAM3 checkpoint at $Checkpoint"
  Write-Host "[3/4] Skipping Hugging Face download."
} else {
if ($Endpoint) {
  $env:HF_ENDPOINT = $Endpoint
  Write-Host "Using HF_ENDPOINT=$Endpoint"
}

if ($Token) {
  Write-Host "[2/4] Logging in with HF_TOKEN/Token..."
  & $Hf auth login --token $Token
  if ($LASTEXITCODE -ne 0) {
    Fail "Hugging Face token login failed. Check that the token is valid and has access to facebook/sam3."
  }
} else {
  Write-Host "[2/4] Checking Hugging Face login..."
  & $Hf auth whoami
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "You are not logged in to Hugging Face CLI."
    Write-Host "1. Open https://huggingface.co/facebook/sam3 and accept/request access."
    Write-Host "2. Create a token at https://huggingface.co/settings/tokens"
    Write-Host "3. Run this script with a local token, for example:"
    Write-Host "   `$env:HF_TOKEN='hf_xxx'; powershell -ExecutionPolicy Bypass -File ai-service\scripts\setup-sam3.ps1"
    Write-Host ""
    Fail "Cannot download gated facebook/sam3 weights until the local Hugging Face CLI is authenticated."
  }
}

Write-Host "[3/4] Downloading facebook/sam3 weights..."
& $Hf download facebook/sam3 config.json sam3.pt --local-dir $WeightsDir
if ($LASTEXITCODE -ne 0) {
  Fail "Download failed. If you see 'Access denied', approve facebook/sam3 access on Hugging Face. If you see a timeout, set a proxy or WSC3D_SAM3_HF_ENDPOINT and retry."
}
}

if (!(Test-Path -LiteralPath $Checkpoint)) {
  Fail "Download command finished, but sam3.pt was not found at $Checkpoint."
}

$SizeMb = [math]::Round((Get-Item -LiteralPath $Checkpoint).Length / 1MB, 1)
if ($SizeMb -lt 100) {
  Fail "sam3.pt exists but is unexpectedly small ($SizeMb MB). Delete it and retry."
}

Write-Host "[4/4] Verifying project SAM3 loader..."
& $Python -c "from app.sam3_service import _checkpoint_path, _device; print('checkpoint', _checkpoint_path()); print('device', _device())"
if ($LASTEXITCODE -ne 0) {
  Fail "Project SAM3 loader verification failed."
}

Write-Host ""
Write-Host "SAM3 is ready:"
Write-Host "  $Checkpoint ($SizeMb MB)"
Write-Host "Restart AI service with: npm run dev:ai"
