# M0-E：本地 H3 生成环境验证

关联：[#6](https://github.com/kasumi-yz/TTCats/issues/6)、设计方案 D8、ADR-0006。
测试日期：2026-10-01（北京时间）。作者：Codex。

## 结论与范围

**MiniMax H3 在本台式机上成功生成首尾帧控制的原始视频，并通过调用脚本保存到素材库收件箱。**

用户确认符合 H3 社区许可证的地区条件，并明确决定本轮先只搭 H3。
Wan 2.2 和在线工具未安装、未比较；本报告不改变 D8「先比较，再选主力」的产品决定，不把 H3 宣布为主力。
本次用合成图片验证环境和调用链，尚未验证真实猫的形象一致性、动作片段质量、循环点和姿势衔接。

## 台式机检查

| 项目 | 实测 |
| --- | --- |
| 操作系统 | Windows 11 专业版，10.0.26200 |
| 显卡 | NVIDIA GeForce RTX 5090 D v2，计算能力 12.0 |
| 显存 | `nvidia-smi` 显示 24455 MiB |
| 驱动 | 610.74；CUDA UMD 13.3 |
| 内存 | ComfyUI 显示 31861 MiB，约 31.1 GiB（通常称 32GB） |
| 初检可用内存 | 约 5.77 GiB，后台程序已占用较多 |
| D 盘初检空闲 | 约 1234.5 GiB，NTFS，足够预留 200GB |
| 分页文件 | 系统自动管理；测试前 C 盘 `pagefile.sys` 已分配 47727 MiB |
| 已有工具 | Git、GitHub CLI 2.98.0、Node.js 24.15.0、Python 3.12.10、7-Zip |
| 本轮新增 | uv 0.12.21、ffmpeg 9.0.2、ComfyUI NVIDIA 便携版 |

GitHub CLI 已经由用户完成浏览器授权；#6 已指派给当前 GitHub 用户，并加 `agent:codex` 标签、留下本会话认领与范围调整评论。
`D:\TTCats` 在 `main` 上完成更新；所有仓库改动均在 `D:\TTCats-issue6` 的 `issue-6-local-generators` 分支。

## 具体版本与文件

- ComfyUI **0.38.0**，提交 `6b747c0428c343e1417219641db93a4fb7cb69ae`。
- 便携运行环境：Python **3.13.14**、PyTorch **2.14.0+cu130**、CUDA **13.0**。
- 官方工作流仓库 `Comfy-Org/workflow_templates`，提交 `0bfbbbfa260e76f69137f5aa37b7553199c73bc0`，文件 `templates/video_minimax_h3_i2v.json`。
- 模型仓库 `Comfy-Org/MiniMax-H3`，对照版本 `e5eb578a89295337b8ff433a035929ce0279e0b6`。

| 文件 | 字节数 | 处理方式 |
| --- | ---: | --- |
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | 20970379616 | 复用用户已有 INT8 FL2VA 文件 |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 15687142551 | 复用用户已有 NVFP4 文本编码器 |
| `minimax_h3_video_vae_int8_convrot.safetensors` | 2811065184 | 复用用户已有 INT8 视频 VAE |
| `minimax_h3_audio_vae_fp32.safetensors` | 605254808 | 复用用户已有 FP32 音频 VAE |

四个模型的完整 SHA-256 与发布仓库该版本的 LFS 校验值一致，记录在 `experiments/generators/model-manifest.json`。
**原始下载渠道未知**：文件在本会话开始前就已存在，不能声称是本轮从 Hugging Face 下载。
模型仍放在 `D:\ChromeDownloads`；`D:\ChromeDownloads\TTCats-H3` 中按类型建立硬链接供 ComfyUI 读取，不复制约 40GB 的模型数据。

ComfyUI 从 [GitHub v0.38.0 发布页](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.38.0) 下载标准 NVIDIA 包，大小 1994326521 字节。
安装包 SHA-256：`8f137eac345707fd7e42bcf8e29377415243011ca15522a86aed6c77331fbd56`，解压前验证一致。
uv、ffmpeg 通过 winget 安装，安装器校验通过。没有安装 Wan、额外 ComfyUI 节点、独立 CUDA Toolkit、Sage Attention 或 Turbo LoRA。

## 工作流

`h3-i2v-official-ui.json` 保留未经改动的官方界面模板；`h3-fl2va-api.json` 将其基础模式展开为 ComfyUI API 格式：

- 连接两张图片到 `MiniMaxH3ImageToVideo.first_frame / last_frame`。
- 保留基础 FL2VA 权重、`res_multistep` 采样器、`simple` 调度器、20 步、24fps。
- 移除未启用的 Turbo LoRA 开关分支，不下载 LoRA。
- 宽高固定为 1344×768；5 秒向上对齐为 124 帧。
- 解码视频与音频，保存为 H.264 + AAC 的 MP4。

启动参数为 `--listen 127.0.0.1 --port 8188 --lowvram --reserve-vram 3 --disable-auto-launch --cache-none`。
ComfyUI 日志确认启用了动态显存加载和两条异步权重搬运流；这里验证的是 ComfyUI 量化权重与原生节点，**不是 SGLang 的官方 BF16/FP32 服务配置**。
本轮没有另行运行官方部署文档中 SGLang 的 `layerwise offload + kitchen_int8` 配置。选择 Windows 原生 ComfyUI 路线，使用已有 INT8 检查点和 ComfyUI 的动态权重搬运完成低显存验证；这证明该替代路线可运行，不等于已经验证 SGLang 的分层加载实现。

## 实测结果

测试输入为程序绘制的两张 1344×768 PNG：纯青色背景上，红球从左侧移到右侧。
使用同一提示词，种子为 6：

```text
A locked camera. A red ball slowly moves from left to right across a solid cyan background. Keep the ball round and the lighting constant. No camera motion, no cuts. Quiet room tone.
```

| 项目 | 结果 |
| --- | ---: |
| 是否成功 | 成功，视频与素材档案均保存到收件箱 |
| ComfyUI 执行耗时 | 日志 325.40 秒；历史事件计时 325.056 秒 |
| 调用脚本总耗时 | 330.359 秒，约 5 分 30 秒；包含首次加载、轮询和下载 |
| 请求时长 | 5 秒 |
| 实际时长 | ffprobe：5.166688 秒 |
| 分辨率 / 帧率 / 帧数 | 1344×768 / 24fps / 124 帧 |
| 视频 / 音频格式 | H.264 / AAC |
| 整张显卡显存采样峰值 | 23477 MiB，约 22.93 GiB |
| 测试前整张显卡基线 | 3634 MiB；包括桌面和后台程序 |
| ComfyUI 进程累计驻留内存峰值 | 8492343296 字节，约 7.91 GiB |
| ComfyUI 进程申请内存采样峰值 | 29761662976 字节，约 27.72 GiB |
| 系统剩余内存采样最低值 | 545.54 MiB |
| 生成期间采样数量 | 141，间隔约 2.3 秒（目标 2 秒加采样开销） |

开始：北京时间 03:51:32；结束：03:56:57。没有启动其他 Electron 或素材工厂测试。
采样显存为**整张卡的总占用**，不能称为 H3 独占显存；进程申请内存包含可分页部分，不能称为物理内存占用。
短暂峰值可能被采样漏掉。这里是一次首次运行结果，不是多次平均值。

结果文件（仓库外）：

- `D:\TTCats-素材库\inbox\h3-20261001-035131-11fcbb09-1.mp4`，264095 字节。
- 视频 SHA-256：`ce94ddaf7d62e408133445a5f0f865ef60678f6941cd56f65fafa03d0d97258a`。
- 同目录 `h3-20261001-035131-11fcbb09.json`：完整提交工作流、首尾帧 SHA-256、任务 ID、历史、耗时和结果 SHA-256。
- `D:\ComfyUI\setup-evidence\comfy-h3.log`：启动和生成日志。
- `D:\ComfyUI\setup-evidence\h3-metrics.csv`：采样原始数据。
- `D:\ComfyUI\setup-evidence\h3-result-summary.json`：仅生成期间采样统计。
- `D:\ComfyUI\setup-evidence\h3-test-contact-sheet.png`：抽帧检查图，目视可见红球逐步从左移向右，背景和圆形保持稳定；最后一个空格是排版补位。

未发生生成失败。内存余量非常小，建议制作片段时关闭不用的软件；本次成功不能保证更长片段、其他尺寸或复杂猫动作都能成功。
测试后通过 ComfyUI `/free` 卸载模型、释放缓存，整张显卡恢复到约 3334 MiB，界面服务仍可使用。

## 安装与重装

可逐条执行的下载、校验、解压、硬链接、路径配置、启动和调用步骤见 `experiments/generators/README.md`。
主要位置：

- ComfyUI：`D:\ComfyUI\ComfyUI_windows_portable`。
- 模型：`D:\ChromeDownloads`。
- 素材库：由环境变量 `TTCATS_ASSET_ROOT` 指定；本机为 `D:\TTCats-素材库`。
- 调用与启动脚本：`experiments/generators/`。

本机 Git 和 GitHub CLI 直接访问 GitHub 曾连接失败，使用现有系统代理后成功；未改动仓库的永久代理配置。
调用脚本访问本机 ComfyUI 时绕过网络代理，避免本地接口请求被转发。

## 验证命令与结果

- `npm run check`：通过；类型检查、lint/格式、123 项单元测试、内容校验、schema 最新检查通过。
- `uv run python -m unittest -v test_queue_clip.py`：通过；本机假服务验证上传、队列、下载、素材档案、生成错误、超时与只检查模式。
- `uv run python queue_clip.py --first ... --last ... --prompt ...`：真实 H3 生成成功。
- `uv run python queue_clip.py ... --check-only`：本机连接、节点和模型文件检查通过。
- `ffprobe`：确认非空 MP4、1344×768、24fps、124 帧、H.264 + AAC。

调用脚本没有新增 Python 第三方依赖。ComfyUI 的依赖由独立便携环境管理，未修改桌宠应用的依赖或共享接口。

## 尚未完成的比较项

- Wan 2.2：按用户指示暂缓。
- 在线生成器：未测试。
- 用豆豆的姿势帧重新验证：待姿势帧可用后执行。
- Claude 交叉审查与用户合并：由 PR 流程完成；本报告不把它们视为已通过。

## 审查后修订

2026-10-01 根据用户转交的交叉审查意见修订：日常使用和重装命令改为合并后保留的 `D:\TTCats\experiments\generators`，补齐模型下载、续传和 SHA-256 检查命令；说明视频与档案的对应文件名。
素材档案（AssetLog）新增实验记录版本、直接可读的提示词和参数、自动累加的生成尝试次数，并明确模型校验值是安装清单值，未在每次运行中重新计算。完整尝试记录保留在 `generation-records`，成功后才将档案放入收件箱。
状态查询支持有限重试，发生暂时故障不重新提交任务；新增对应测试，包括失败后的尝试编号累加、查询恢复与重试耗尽。修订后脚本共 7 项测试通过。
本节的修订未重跑显卡性能测试；上面的真实生成结果仍来自首次实测，不应将新记录字段倒填为当时已存在。

## 来源

- [MiniMax H3 官方本地部署说明](https://platform.minimax.io/docs/guides/local-deploy-h3)
- [ComfyUI H3 指南](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)
- [ComfyUI Windows 便携版说明](https://docs.comfy.org/installation/comfyui_portable_windows)
- [模型仓库](https://huggingface.co/Comfy-Org/MiniMax-H3)
