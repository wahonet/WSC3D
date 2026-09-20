param(
    [ValidateSet('local','lan','stop','build','viewer')][string]$Mode = 'local',
    [switch]$PrepareOnly,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $workspace 'runtime\manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.format -ne 'wsc-runtime-1' -or $manifest.id -notmatch '^[a-f0-9]{20}$' -or $manifest.id -ne $manifest.sha256.Substring(0,20)) { throw 'Invalid runtime manifest' }
$cacheBase = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WSC-Unified\environments'
$runtimePath = Join-Path $cacheBase $manifest.id
$marker = Join-Path $runtimePath '.ready'
[IO.Directory]::CreateDirectory($cacheBase) | Out-Null
$lock = $null
for ($attempt=0; $attempt -lt 600; $attempt++) {
    try { $lock = [IO.File]::Open((Join-Path $cacheBase ($manifest.id+'.lock')),'OpenOrCreate','ReadWrite','None'); break }
    catch [IO.IOException] { Start-Sleep -Milliseconds 500 }
}
if (!$lock) { throw '运行环境正在被其他启动进程准备，请稍后重试。' }
try {
    if (!(Test-Path -LiteralPath $marker) -or !(Test-Path -LiteralPath (Join-Path $runtimePath 'python\python.exe'))) {
        Write-Output '首次启动：正在校验并准备本机运行环境。后续启动将直接复用。'
        Add-Type -AssemblyName System.IO.Compression
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        Add-Type -ReferencedAssemblies System.IO.Compression,System.IO.Compression.FileSystem -TypeDefinition @'
using System;
using System.IO;
using System.IO.Compression;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
public static class WscRuntimeArchive {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateHardLink(string target, string existing, IntPtr reserved);
    public static void Extract(string zipPath, string root, string[] paths, string[] hashes, long[] sizes) {
        string prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var written = new Dictionary<string,string>(StringComparer.Ordinal);
        using (var archive = ZipFile.OpenRead(zipPath)) {
            for (int i=0; i<paths.Length; i++) {
                string target = Path.GetFullPath(Path.Combine(root, paths[i].Replace('/',Path.DirectorySeparatorChar)));
                if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Runtime path escaped cache");
                if (hashes[i].Length!=64) throw new InvalidDataException("Invalid object digest");
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                if (File.Exists(target)) File.Delete(target);
                string existing;
                if (written.TryGetValue(hashes[i], out existing)) {
                    if (!CreateHardLink(target,existing,IntPtr.Zero)) File.Copy(existing,target);
                    continue;
                }
                var entry = archive.GetEntry("objects/"+hashes[i]);
                if (entry==null || entry.Length!=sizes[i]) throw new InvalidDataException("Missing runtime object: "+paths[i]);
                using(var input=entry.Open()) using(var output=File.Create(target)) input.CopyTo(output);
                string actual;
                using(var input=File.OpenRead(target)) using(var hash=SHA256.Create()) actual=BitConverter.ToString(hash.ComputeHash(input)).Replace("-","").ToLowerInvariant();
                if (actual!=hashes[i]) throw new InvalidDataException("Runtime checksum failed: "+paths[i]);
                written.Add(hashes[i],target);
            }
        }
    }
}
'@
        $bundle = Join-Path $workspace 'runtime\runtime.zip'
        if ((Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) { throw '运行环境包损坏，请恢复完整副本。' }
        $entries = @($manifest.entries)
        [WscRuntimeArchive]::Extract($bundle,$runtimePath,[string[]]$entries.path,[string[]]$entries.sha256,[long[]]$entries.bytes)
        [IO.File]::WriteAllText($marker,$manifest.sha256,[Text.Encoding]::ASCII)
    }
} finally { $lock.Dispose() }
foreach ($runtimeName in @('mineru','ndl')) {
    $venvFile=Join-Path $runtimePath ($runtimeName+'\pyvenv.cfg')
    $venvHome=Join-Path $runtimePath 'ocr-python'
    $before=[IO.File]::ReadAllText($venvFile)
    $after=[regex]::Replace($before,'(?m)^home\s*=.*$',('home = '+$venvHome))
    if($before -ne $after) { [IO.File]::WriteAllText($venvFile,$after,[Text.UTF8Encoding]::new($false)) }
}
$env:WSC_RUNTIME_ROOT = $runtimePath
$env:PYTHONDONTWRITEBYTECODE = '1'
$python = Join-Path $runtimePath 'python\python.exe'
if ($PrepareOnly) { Write-Output $runtimePath; return }
$arguments = @('-X','utf8','-B')
if ($Mode -eq 'build') { $arguments += (Join-Path $workspace 'tools\build_frontend.py') }
elseif ($Mode -eq 'viewer') { $arguments += @((Join-Path $workspace 'tools\viewer.py'),'--open-browser') }
else {
    $arguments += (Join-Path $workspace 'tools\launch_unified.py')
    if ($Mode -eq 'lan') { $arguments += '--lan' }
    if ($Mode -eq 'stop') { $arguments += '--stop' }
    if ($NoBrowser) { $arguments += '--no-browser' }
}
& $python @arguments
exit $LASTEXITCODE
