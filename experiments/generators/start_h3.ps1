param(
    [string]$ComfyRoot = 'D:\ComfyUI\ComfyUI_windows_portable',
    [int]$Port = 8188
)

$ErrorActionPreference = 'Stop'
$python = Join-Path $ComfyRoot 'python_embeded\python.exe'
$main = Join-Path $ComfyRoot 'ComfyUI\main.py'
if (-not (Test-Path -LiteralPath $python)) { throw "缺少 ComfyUI 自带的 Python：$python" }
if (-not (Test-Path -LiteralPath $main)) { throw "缺少 ComfyUI 程序：$main" }
$env:PYTHONIOENCODING = 'utf-8'
Push-Location (Join-Path $ComfyRoot 'ComfyUI')
try {
    & $python -s $main --listen 127.0.0.1 --port $Port --lowvram --reserve-vram 3 --disable-auto-launch --cache-none
    if ($LASTEXITCODE -ne 0) { throw "ComfyUI 启动或运行失败，退出码：$LASTEXITCODE" }
} finally {
    Pop-Location
}
