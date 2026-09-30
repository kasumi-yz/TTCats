param(
    [Parameter(Mandatory = $true)][int]$ComfyProcessId,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [int]$IntervalSeconds = 2
)

# 记录整张显卡的使用量和 ComfyUI 进程内存；不把桌面背景占用算成模型独占。
$ErrorActionPreference = 'Stop'
if ($IntervalSeconds -lt 1) { throw '采样间隔至少为 1 秒。' }
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $resolvedOutput) { throw "采样文件已存在：$resolvedOutput" }
$parent = Split-Path -Parent $resolvedOutput
New-Item -ItemType Directory -Path $parent -Force | Out-Null
while ($true) {
    $comfyProcess = Get-Process -Id $ComfyProcessId -ErrorAction SilentlyContinue
    if (-not $comfyProcess) { break }
    $gpuLine = & nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits
    if ($LASTEXITCODE -ne 0) { throw 'nvidia-smi 采样失败。' }
    $gpuValues = ($gpuLine | Select-Object -First 1) -split ',\s*'
    $systemMemory = Get-CimInstance Win32_OperatingSystem
    [pscustomobject]@{
        utc = [DateTimeOffset]::UtcNow.ToString('o')
        gpu_used_mib = [double]$gpuValues[0]
        gpu_total_mib = [double]$gpuValues[1]
        gpu_utilization_percent = [double]$gpuValues[2]
        process_working_set_bytes = $comfyProcess.WorkingSet64
        process_private_bytes = $comfyProcess.PrivateMemorySize64
        process_peak_working_set_bytes = $comfyProcess.PeakWorkingSet64
        system_free_ram_mib = [math]::Round($systemMemory.FreePhysicalMemory / 1024, 2)
    } | Export-Csv -LiteralPath $resolvedOutput -NoTypeInformation -Append -Encoding utf8
    Start-Sleep -Seconds $IntervalSeconds
}
