# 本地 H3 生成器（M0-E）

关联 #6、设计决定 D8、ADR-0006。用户于 2026-10-01 决定先只搭 MiniMax H3，Wan 2.2 比较暂缓。
这里提供本机首尾帧调用脚本、ComfyUI API 工作流和官方界面模板。真实照片、模型、原始视频均不提交到仓库。

## 已验证的配置

- Windows 11、RTX 5090 D v2 / 24GB 显存、约 32GB 内存。
- ComfyUI 0.38.0 NVIDIA 标准便携版，Python 3.13.14、PyTorch 2.14.0+cu130 / CUDA 13.0。
- FL2VA INT8 主模型、NVFP4 Qwen 文本编码器、INT8 视频 VAE、FP32 音频 VAE。
- 使用 ComfyUI 原生节点，未安装额外节点、Sage Attention 或 Turbo LoRA。
- 具体文件、版本、发布地址与 SHA-256 见 `model-manifest.json`；实测结果见 `docs/验证报告/M0-E-本地生成环境.md`。

用户已确认符合社区许可证的地区条件。本次只做本地个人项目验证；重装前也应查看发布方当前的许可证。

## 日常使用

打开 PowerShell，在本目录启动 ComfyUI：

```powershell
.\start_h3.ps1
```

看到 `http://127.0.0.1:8188` 后，保留这个窗口，再打开另一个 PowerShell：

```powershell
cd D:\TTCats-issue6\experiments\generators
$env:TTCATS_ASSET_ROOT = 'D:\TTCats-素材库'
uv run python queue_clip.py --first 'D:\TTCats-素材库\tests\first.png' --last 'D:\TTCats-素材库\tests\last.png' --prompt 'A locked camera. A red ball slowly moves from left to right across a solid cyan background. Keep the ball round and the lighting constant. No camera motion, no cuts. Quiet room tone.'
```

换成自己的首帧和尾帧，再改提示词即可。猫的姿势帧应保持同样的光线、角度、尺寸和纯色背景。
默认输出 1344×768、24fps、20 步。请求 5 秒会向上对齐为 124 帧，实际 5.167 秒。
可指定 `--seconds 4` 至 `15`、`--steps`、`--seed`、`--width`、`--height`；宽高必须是 32 的倍数，总面积不能超过 1344×768。

输出在 `$env:TTCATS_ASSET_ROOT\inbox`：

- MP4 原始视频，带模型生成的音频。
- 同名 JSON 素材档案：首尾帧校验值、提示词、参数、完整提交工作流、模型版本、任务 ID、耗时和输出校验值。

计时包含排队、首次加载、生成、解码和下载；比较生成器时应保证没有其他生成任务。
`--timeout` 默认为 7200 秒。超时或按 Ctrl+C 只停止脚本等待，不自动取消 ComfyUI 的任务。
不要直接重复提交；先在 ComfyUI 检查队列，必要时停止当前任务。

只检查连接、节点和模型文件，不提交任务：

```powershell
uv run python queue_clip.py --first 'D:\TTCats-素材库\tests\first.png' --last 'D:\TTCats-素材库\tests\last.png' --prompt '检查' --check-only
```

## 从头重装

1. 检查 `nvidia-smi` 能识别显卡；驱动须能支持 CUDA 13.0。本次驱动为 610.74。
2. 安装工具：

   ```powershell
   winget install --id astral-sh.uv --exact --source winget
   winget install --id Gyan.FFmpeg --exact --source winget
   winget install --id 7zip.7zip --exact --source winget
   ```

   本次为 uv 0.12.21、ffmpeg 9.0.2。已有工具可以复用，安装后重新打开终端以更新命令路径。
   调用脚本只使用 Python 标准库；`uv run` 管理本目录的独立环境。可用现有 Python 3.12，缺少解释器时 uv 会下载。

3. 下载 ComfyUI 固定版本到仓库外，并验证：

   ```powershell
   curl.exe -L --fail --output D:\ChromeDownloads\ComfyUI_windows_portable_nvidia-v0.38.0.7z https://github.com/Comfy-Org/ComfyUI/releases/download/v0.38.0/ComfyUI_windows_portable_nvidia.7z
   Get-FileHash D:\ChromeDownloads\ComfyUI_windows_portable_nvidia-v0.38.0.7z -Algorithm SHA256
   ```

   SHA-256 必须是 `8f137eac345707fd7e42bcf8e29377415243011ca15522a86aed6c77331fbd56`。
   用 7-Zip 解压到 `D:\ComfyUI`，得到 `D:\ComfyUI\ComfyUI_windows_portable`。
   选择标准 NVIDIA 包，CUDA 12.6 包不适用于本次 Blackwell 配置。

4. 将 `model-manifest.json` 中的四个模型保存在 `D:\ChromeDownloads`。
   已有文件先用 `Get-FileHash -Algorithm SHA256` 对照清单，校验通过就复用。
   下载地址由清单中的仓库、版本和相对路径组成：
   `https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/<model_revision>/<path>`。
   如果改用镜像，也要对照相同的 SHA-256，记录实际下载来源。

5. 执行下列 PowerShell 命令，为 ComfyUI 分类建立硬链接。硬链接不复制模型数据，原来的文件仍在原处；两端都在 D 盘的 NTFS 分区上。

   ```powershell
   $manifest = Get-Content .\model-manifest.json -Raw | ConvertFrom-Json
   foreach ($model in $manifest.models) {
       $original = Join-Path 'D:\ChromeDownloads' (Split-Path $model.path -Leaf)
       $link = Join-Path 'D:\ChromeDownloads\TTCats-H3' $model.path
       New-Item -ItemType Directory -Path (Split-Path $link -Parent) -Force | Out-Null
       if (-not (Test-Path -LiteralPath $link)) {
           New-Item -ItemType HardLink -Path $link -Target $original | Out-Null
       }
   }
   ```

6. 在 `D:\ComfyUI\ComfyUI_windows_portable\ComfyUI\extra_model_paths.yaml` 中加入：

   ```yaml
   ttcats_h3:
     base_path: D:/ChromeDownloads/TTCats-H3
     diffusion_models: diffusion_models
     text_encoders: text_encoders
     vae: vae
   ```

7. 按「日常使用」启动，并执行 `--check-only`。打开浏览器中的 ComfyUI 可查看队列。
   `workflows/h3-i2v-official-ui.json` 是未改动的官方界面模板；`workflows/h3-fl2va-api.json` 是展开基础模式、接入首尾帧的 API 格式。
   API 版本去除了未启用的 Turbo LoRA 分支，所以不用下载额外模型。不要把官方模板中的演示提示词误当成猫的提示词。

## 验证与采样

```powershell
uv run python -m unittest -v test_queue_clip.py
```

测试使用本机假服务，覆盖首尾帧上传、排队、视频下载、素材档案、生成失败与等待超时，不需要模型或显卡。

实际生成时，可用另一窗口采样：

```powershell
# 先查本次 ComfyUI 的进程号
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object ExecutablePath -Like 'D:\ComfyUI\*' | Select-Object ProcessId,ExecutablePath
.\monitor.ps1 -ComfyProcessId <进程号> -OutputPath 'D:\ComfyUI\本次采样.csv'
```

采样大约每 2 秒一次；包含整张显卡显存、进程驻留内存、进程申请内存、系统剩余内存。整张显卡包括桌面和后台程序占用，不能称为 H3 独占显存。
进程申请内存包含可分页内存，不能当成实际物理内存。采样可能漏掉短暂峰值；进程累计驻留内存峰值单独记录。
跑性能测试时，不应同时运行其他 Electron 或素材工厂会话。采样完成按 Ctrl+C 停止，CSV 保留在仓库外。

原始视频可用 `ffprobe` 检查：

```powershell
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames -show_entries format=duration -of json '<生成结果.mp4>'
```

## 当前边界

本轮只验证 H3。合成测试图片只能证明环境和首尾帧调用能运行，不能证明真实猫的形象一致性、动作效果或循环衔接；后者需要用猫的姿势帧再测。
Wan 2.2 和在线工具未在本轮比较，不能据此宣布 H3 是主力生成器。
