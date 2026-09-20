$toolScript = $args[0]
$toolArguments = @($args | Select-Object -Skip 1)
if (!$toolScript) { throw 'Usage: tools/run.ps1 tools/transfer.py status' }
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'bootstrap.ps1') -PrepareOnly | Out-Null
& (Join-Path $env:WSC_RUNTIME_ROOT 'python\python.exe') -X utf8 -B (Join-Path $PSScriptRoot 'run_tool.py') $toolScript @toolArguments
exit $LASTEXITCODE