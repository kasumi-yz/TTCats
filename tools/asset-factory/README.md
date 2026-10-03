# 素材工厂 v1

对应 #4、#105、ADR-0006。把仓库外的原始视频加工成候选，再由人确认后输出片段。
不按猫的名字写死处理规则。所有生成记录、模型、拆帧、预览和结果都放在素材库。
v1 增加批量 H3 生成、续跑、量化初筛与自动处理。挑片台窗口和挑选结果消费由 #104 实现，
格式沿用已合并 #130 的 `docs/接口/挑片台.md`；评分只供参考，工具不会接受或淘汰真实猫的候选。

## v1：一条命令批量生成和处理

复用已安装的 H3/ComfyUI、BiRefNet、GPU 依赖及 ffmpeg。命令不会启动 ComfyUI、安装依赖或下载模型。
开始前确认本机 ComfyUI 在配置的地址运行，生成期间不要进行独占桌面/性能验收。
需新安装或下载时，先给用户列出大小、存放位置和影响，等确认后再动手。

1. 将 `examples/batch-cat.json` **复制到仓库外素材库**，按该猫已认可的姿势帧和测量值填写。
   样例提示词与数值仅展示格式，不能作为其他猫的已认可参数。路径相对于这份配置文件，
   支持绝对路径；真实照片、姿势帧和原始视频不进入仓库。
2. 猫的 id、中文名、外貌 `appearance`、实际背景 RGB、画布、站姿高度、显示高度、
   后脚位置 `rear_foot`、地面线 `ground_y`、姿势帧和初始关键点都集中在 `cat` 中。
   提示词只展开显式的 `{appearance}`，不改写其余原文；展开前后文本和 SHA-256 写入档案。
3. `clips` 写每段的共享片段名、类型、起止姿势、提示词、种子和生成时长。
   `action_seconds` 是提示词要求的**实际动作时长**，不要把生成总时长填进去。
   `first_frame`/`last_frame` 可覆盖起止姿势图，例如走路水平平移后的首尾帧。
   `rear_foot` 可覆盖本段首帧测量值；走路首帧平移以后，不能照抄标准站姿的横坐标。

```powershell
cd '<当前工作树>\tools\asset-factory'
$env:TTCATS_ASSET_ROOT = 'D:\TTCats-素材库'
uv run --extra gpu asset-factory batch --config 'D:\TTCats-素材库\batch-cat.json'
```

串行执行每段的每个种子：H3 → 原始素材档案 → ingest → matte/去残色 → 自动建议/初筛 →
深浅/镜像预览 → 按本猫比例重算显示高度 → 透明 WebM → 实际解码 alpha 的点击遮罩。
所有候选的 `manifest.status` 都为 `pending`，没有自动创建人工接受记录。
单项处理失败会保留原因并继续其他种子；有仍在运行或提交状态不确定的 H3 任务时停止排后续项。

配置支持直接处理已有原片：在某段添加 `inputs`，每项包含 `seed`、`path`、
符合共享 AssetLog 的 `asset_log`，可选 `generator_log`（原生成档案路径）。
此时不调用 H3，实际种子以 `inputs` 为准；档案缺字段、源路径不符就停止，不能伪造生成记录。
`asset_log.rawVideo` 填原视频的绝对路径，模型、工作流、提示词、次数和时间填真实值。

### 续跑与失败恢复

直接重跑同一条 `batch --config ...`。完成阶段原子发布，按原始文件和产物 SHA-256 复用；
不重复拆帧/抠图/导出，不创建第二份任务。未完成阶段会重新执行。
配置、姿势图、原片、生成档案、工作流、处理代码改变时，旧批次拒绝续跑；改配置里的 `id` 开新批次，旧证据保留。
同一批次的操作系统锁随进程退出释放；锁文件保留，不能手动删除正在使用的锁文件。

`batches/<id>/state.json` 保存阶段、原任务号和产物身份；`report.json` 列出候选路径、分数和失败原因。
H3 的每次实际提交另存 `generation-records`：模型清单/工作流版本、种子、次数、原文与展开文本、
姿势图哈希、任务号、运行库及输出哈希。模型哈希来自安装清单，本次没有重新读取几十 GB 模型，
档案明确 `verified_for_this_run: false`。下载的是本机生成结果，不是新模型或依赖。

- 查询中断：保存任务号，下次查同一任务；不重提。生成成功但结果复制中断也从同一历史结果恢复。
- 提交时断电/响应丢失：按持久 `client_id` 查询队列与历史；找不到或有多项时不猜测重提。
  确认原任务号以后，可用 `--adopt-task walk-42=<任务号>`；仍核对任务所属 `client_id`。
- **本人确认该任务从未提交**以后才用 `--retry-uncertain walk-42`；有重复生成风险，旧档案保留。
- 确认生成报错的任务默认保留失败，用 `--retry-failed` 明确开新一次生成；次数继续累加。
- 产物损坏/被修改：报错并保留原目录，用新的批次 id 重跑；不会覆盖现有候选或改写历史失败。

### 自动检查、锚点和关键点的边界

`auto/assessment.json` 保存测量方法、数值、参考阈值、0～100 参考分数和中文原因；
共享候选清单只带 `assessment.score/reasons`。分数是已测项目 `100/(1+(数值/参考上限)^2)` 的平均，
未测项不会被假装计为通过，不是“合格概率”，没有自动淘汰阈值。

| 项目 | 自动测量 | 仍需人工检查 |
|---|---|---|
| 首尾 | 与实际起止姿势帧的主体 RGB 差 | 身份、细节和衔接观感 |
| 背景 | 四角与配置背景色的偏差 | 镜头移动、地面线、手/人/文字/道具 |
| 毛边 | 软透明边接近背景色的比例 | 真实毛色可能相似，需看深浅背景 |
| 时长 | 归一化主体变化量检测开始/停下，与 action_seconds 比较 | 很小或被遮挡的动作可能漏测 |
| 循环 | 建议区间实际末帧到首帧的轮廓/颜色差 | 连续播放和脚接触 |
| 脚 | 完整可信 rear-toe 模板轨迹时量固定后脚水平范围/地面线偏差 | 走路每只脚接触、遮挡肉垫、模板是否认对 |

`anchor_mode`：`fixed` 使用本猫固定后脚与地面线、速度为 0；`translation` 按不透明主体水平移动
建议匀速段、平滑锚点和速度；`silhouette` 保留 v0 轮廓底部建议，适用于无可靠固定锚点时的草稿。
平移/轮廓只是代理，**不能当成真实脚趾没有打滑的证据**。锚点位置会影响换片段，必须挑选后核对。

`cat.landmarks` 或单段 `landmarks` 可提供 `nose`、`scruff`、用于量测的 `rear-toe`：

```json
{"nose": {"point": {"x": 607.0, "y": 505.0}, "radius": 5, "search": 12, "max_error": 0.18}}
```

坐标必须是该段**原始第一帧**的测量点。局部纹理匹配逐帧追踪，遮挡、低纹理或误差过大记 null；
未提供就不造轨迹。`rear-toe` 只作量测，不导出为游戏关键点；nose/scruff 建议保留原始帧坐标供挑片台修改。
建议的裁剪区间、循环和锚点写入同一 `suggest/suggestion.json`，与候选实际导出一致。

### 拎起和落地的可复用命令

```powershell
uv run --extra gpu asset-factory pickup-map clip-任务号 --options 'D:\TTCats-素材库\完整后颈标注.json'
uv run --extra gpu asset-factory derive-land clip-源任务号 --start 0 --end 124 --seconds 0.9 --fps 48 --curve linear
```

`pickup-map` 要求每帧有效 scruff；以原始后颈上移量建立单调高度→帧号建议，记录非单调修正量，
暂停/半途3倍返回/固定抓取偏移是接入建议，本命令不修改游戏。缺轨迹直接报错，不冒充跟手验收。
`derive-land` 接受人选定的时长、半开源区间和 linear/ease-out 取帧曲线，
从 ingest 解码帧选取、无插帧、无损 FFV1 保存派生原片。0.9 秒/48 fps 是43帧、实际43/48秒。
`derivations` 保存每帧源索引、原始/派生路径与 SHA-256、实际 ffmpeg 命令，原始初筛不会被改写。
派生原片再作为 `inputs` 批处理：按新裁剪重新算显示高度、跟踪关键点、生成遮罩。
原片首尾和派生新首尾须分别检查，脚底/跟手/放下接缝的真实桌面验收不由本命令代替。

### 与挑片台对接

每个候选仍是 `factory/<job>/finalize/manifest.json`，配套 ingest、原尺寸 matte、
suggest 和 `finalize/export-log.json.options`；增加的 `auto` 记录是工厂私有测量，不是另一份共享协议。
比例依据在 `auto/measurements.json`：`stand_height`、`stand_display_height`、源哈希及本次裁剪高度。
改变挑选区间后可以复用 `asset_factory.automation.display_height` 按该猫比例重算，不能继承旧高度。
人工结果只沿用 #130 的 `review-result.json` 原始帧/像素/哈希及锁约定；读取、confirm/finalize 正式导出由 #104 接入。
v1 不自动把任何真实候选改成 accepted，旧 v0 confirm/finalize 命令继续可用。

### 豆豆走路：自动与 M0-F 手工结果对比

2026-10-03，用 M0-F 已有的原视频（SHA-256 `3683554145a8f9555ce05abc73e4bc243ea72b531bdc873b2d86ebbb25c40231`）
从 ingest 开始重新 GPU 抠图和导出；没有重新生成原视频或覆盖手工结果。
量测完整记录在 `validation/issue-105-walk-comparison.json`，复现脚本为 `scripts/compare-candidates.py`。

| 项目 | M0-F 手工 | v1 自动候选 |
|---|---:|---:|
| 循环源区间 | [40,73) | [40,73) |
| 帧数 / fps / 秒 | 33 / 24 / 1.375 | 33 / 24 / 1.375 |
| 输出宽×高 | 726×306 | 726×306 |
| display_height | 153 | 153 |
| 原始步速 px/s | 176 | 173.6424（约 -1.34%） |
| 实际解码 alpha 首尾平均差（0～1） | 0.03038 | 0.04517 |
| 首尾差 / 普通相邻帧平均差 | 0.8532 | 1.2749 |
| 参考分数 | 无 | 83.99，仍为 pending |

共同区间内自动后脚锚点与手工轨迹的水平平均绝对差为 **16.494 原始像素**。
自动拟合不能等同手工支撑脚轨迹，接缝误差也更高；可以供挑片台修改，不取代用户已认可的成品。
早期算法将匀速直线外推到停顿首帧，锚点差约82.83像素；现已以真实首帧位置校准，早期外部证据未删除。
两份成品都有透明 alpha；本轮自动产物的共享 schema、候选 schema 及解码 alpha→点击遮罩逐字节复核通过。
全部33帧 nose 建议可用，但模板匹配不代替人核对；没有取得完整可信肉垫轨迹，脚打滑标为待人工检查。
深浅背景单帧图在仓库外 `work/issue-105/comparison-v3/comparison.png`；不是用户视觉接受或新版真实鼠标验证。

## 安装

需要 Python 3.12 或 3.13（uv 管理）、PATH 中的 ffmpeg 和 ffprobe，以及支持 CUDA 12.8 以上的 NVIDIA 驱动。
本机使用 RTX 5090 D v2；GPU 依赖可选，不让 Linux 单元测试下载模型或安装显卡环境。

```powershell
cd D:\TTCats\tools\asset-factory
$env:TTCATS_ASSET_ROOT = 'D:\TTCats-素材库'
uv sync --extra gpu
uv run --extra gpu asset-factory setup-model
```

第一次 GPU 安装还会下载 ONNX Runtime 和 CUDA/cuDNN 运行库，合计约 2GB；不修改系统环境或 ComfyUI。
`setup-model` 下载约 224MB 的固定模型，校验发布者 MD5 并记录实际 SHA-256。
网络失败后可以重试；失败目录不会成为正式模型目录。已经安装时无需重复运行该命令。
需要代理时，只在这次 PowerShell 设置 `HTTPS_PROXY` 为自己正在使用的代理地址。

模型采用 **BiRefNet-general-lite / bb_swin_v1_tiny / epoch_232**，许可证为 MIT。
轻量模型是 v0 初始选择，不代表已证明能处理豆豆的蓬松毛发；真实片段验收后再评估更大模型。
来源：[BiRefNet 模型与许可证](https://huggingface.co/ZhengPeng7/BiRefNet)、
[rembg 发布文件及完整性校验](https://github.com/danielgatis/rembg/blob/main/rembg/sessions/birefnet_general_lite.py)。
预处理使用 1024×1024、ImageNet 均值/标准差，输出 sigmoid 后归一化到透明度，恢复原始画面尺寸。
GPU 依赖的加载方法依据 [ONNX Runtime CUDA 文档](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)。
模型不随仓库或桌宠安装包分发；素材日志记录模型 SHA-256、运行库版本和实际 provider。

## 日常处理

### 1. 读取原始视频

```powershell
uv run --extra gpu asset-factory ingest --cat '豆豆' --source 'D:\TTCats-素材库\inbox\你的片段.mp4' --generator-log 'D:\TTCats-素材库\inbox\生成档案.json'
```

命令输出一个 `clip-…` 任务编号，后面的命令用它。省略 `--source` 会处理 inbox 的全部 MP4/MOV/MKV/WebM；
此时它们都被标为 `--cat` 指定的猫，混有其他猫的视频时应逐个指定源文件。
`--generator-log` 可省略；H3 生成器的视频和档案文件名不同，必须显式指定档案。
原样保留档案，不将实验生成器格式当成生产共享接口；档案应有实际模型版本、工作流、提示词、参数和生成次数。
拆帧采用平均帧率重采样成固定帧率，帧编号从 0 开始；可变帧率输入可能补帧或丢帧。
fps 保存在任务记录中，时长按实际帧数 / fps 计算，不使用运行耗时或播放帧计数。

### 2. GPU 抠图与去色边

```powershell
uv run --extra gpu asset-factory matte clip-你的编号 --background 0,180,220
```

`--background` 是原视频的纯色背景 RGB，必须按实际背景填写。工具不猜背景颜色。
先由 AI 提取透明度，再对软边做 RGB 近似反混合，保持主体的不透明像素和 alpha 不变。
视频背景不均匀、模型 alpha 不准确时，这一步可能误修；必须看深浅背景预览。
GPU 未正确加载时停止，不会把 CPU 回退写成 GPU 成功。

### 3. 查看建议

```powershell
uv run --extra gpu asset-factory suggest clip-你的编号
```

结果在素材库 `factory\clip-你的编号\suggest\`：

- `suggestion.json`：裁剪区间、循环区间、每帧落脚锚点、步速建议和警告。
- `preview-dark.png`、`preview-light.png`：均匀抽取最多 6 帧，左边原版、右边镜像版。
- `confirmation-template.json`：人工确认的起点；初始 `accepted` 为 false。

区间采用 `[开始帧, 结束帧)`，结束帧不包含在内。所有锚点都是原始画面中的像素坐标。
工具目前建议保留整个裁剪区间；通过主体归一化后的颜色和轮廓相似度找循环首尾，最短间隔约半秒。回到开头姿势的端点帧不纳入导出区间，避免重复停顿。
预览按抽样帧主体联合边界加边距裁切后缩放，保留深浅背景与镜像对照。
轮廓底部的中位数只是落脚锚点建议，尾巴、悬空、阴影都可能使它错误。
步速是首尾锚点水平位移 / 真实片段时长的估计，不能自动识别镜头移动或真实迈步。
建议值不自动代表片段合格；必须播放原片检查衔接、脚底打滑和猫的身份。

### 4. 确认参数

复制确认模板到素材库另一个 JSON 文件，修改 `selection` 中需要调整的字段，填入实际手工耗时 `manual_seconds`、
是否合格 `accepted` 和 `notes`，再运行：

```powershell
uv run --extra gpu asset-factory confirm clip-你的编号 --parameters 'D:\TTCats-素材库\确认参数.json'
```

原始帧数量的锚点全部保留，不要只留裁剪后的锚点。未接受的记录也能保存，但不能 finalize。
命令会记录改了哪些字段、多少帧锚点和人工用时；重新确认会原子替换当前确认文件，旧确认操作的日志仍保留。

### 5. 导出片段

在素材库创建 `导出选项.json`，例如站着待机：

```json
{
  "cat_id": "doudou",
  "asset_log": {
    "generator": "manual-inbox",
    "modelFiles": [],
    "prompt": "",
    "params": {},
    "attempt": 1,
    "startPoseFrame": "stand-first.png",
    "endPoseFrame": "stand-last.png",
    "rawVideo": "D:/TTCats-素材库/inbox/你的片段.mp4",
    "createdAt": "2026-10-01T08:00:00Z"
  },
  "name": "idle-stand",
  "variant": 1,
  "kind": "loop",
  "from_pose": "stand",
  "to_pose": "stand",
  "optional": false,
  "mirrorable": true,
  "facing": "right",
  "display_height": 150,
  "hit_mask_scale": 4
}
```

上例的档案写法只适用于手动收件箱来源，路径、时间和姿势帧名都要填写实际值。
H3 来源必须将 `generator` 写为实际 H3/ComfyUI 版本、`modelFiles` 填入实际量化文件和版本，
并填写工作流版本、提示词、参数、实际生成次数及原始视频路径。
`asset_log` 使用共享 AssetLog 的字段名，和生成器实验日志不同；原始实验日志仍原样保留。
缺少字段会阻止导出，工具不会编造模型版本或生成次数。`cat_id` 是猫咪包里的英文 id，和中文 `--cat` 分开。

```powershell
uv run --extra gpu asset-factory finalize clip-你的编号 --options 'D:\TTCats-素材库\导出选项.json'
```

导出目录是该任务下的 `finalize\`，其中 `clips\` 的文件可以复制进对应猫咪包：

- VP9 透明 WebM（yuva420p、关闭 auto-alt-ref、采用 M0-A 的 `-b:v 0 -crf 32 -row-mt 1` 压缩参数）。
- `*.hitmask.bin`，格式完全采用已合并 #18 的共享规则。
- 同名 JSON 片段资料，采用根目录 `schemas/clip.schema.json`，不另外定义片段格式。
- `manifest.json`：候选 id、猫的 id、确认结果和素材档案，校验根目录 `schemas/candidate-manifest.schema.json`。
- `aligned\`：对齐、裁剪和缩放后的帧，便于检查；不复制进猫咪包。
- `export-log.json`：所选区间、选项、时长、编码参数与视频字节数；完整处理耗时见素材库 `factory-logs\`。

循环片段导出循环区间，其他片段导出裁剪区间。按人工锚点做亚像素平移，把所有帧的可见主体联合裁剪，
留 2 像素边距，输出高度为 `display_height × 2`，宽高均为偶数。
锚点和关键点转换到新画面坐标；步速转换成 100% 显示尺寸下的像素/秒。
如需关键点，选项中添加 `keypoints`，每个关键点要提供原视频的逐帧坐标，看不到时填 null。
如需标注声音开始帧，添加原视频编号中的 `sound_start_frame`；必须落在导出区间内，标记转成片段内编号。
WebM 始终静音，原片有无音轨均可；D11 的猫叫由猫咪包 `sounds/` 下独立音效播放。

错误会说明是哪只猫和哪个字段/文件缺失。已有成功的抠图、建议或导出目录不会被覆盖；
修改抠图参数需重新 ingest，修改确认记录可再次 confirm；重新导出需另建任务，避免旧候选被悄悄替换。
中途失败删除本次临时结果、保留原始文件和已完成阶段，失败原因写入日志。
点击遮罩从最终 WebM 解码后的 alpha 生成，以避免编码前后细微透明度变化使点击范围偏离画面。

## 验证与调试

各阶段都能用上述命令单独手动触发；这是素材工厂的命令行调试入口，不修改 M1 面板。
必须在仓库完整 checkout 中使用，导出校验会读取共享 schema 和片段表。
JSON Schema 未包含的 Zod 自定义约束会另行检查；共享表写法变化时必须更新读取器，不能默默跳过。

```powershell
uv sync
uv run ruff check
uv run pytest
cd ..\..
npm run check
node --import tsx tools/asset-factory/scripts/verify-contract.mjs 'D:\TTCats-素材库\factory\clip-你的编号\finalize\clips\idle-stand-1.json'
```

pytest 用小型合成视频覆盖全部阶段；AI 推理使用明确标注的测试替身，不下载模型，不将替身当成 GPU 验证。
集成测试必须找到 ffmpeg/ffprobe，否则失败，不跳过。`verify-contract.mjs` 直接使用桌宠的 Zod schema 和点击遮罩实现，
逐帧读取 WebM 的真实 alpha，与导出遮罩逐字节比较；需要先在根目录 `npm ci`。
ffprobe 可能把透明 WebM 的像素格式显示为 yuv420p；要证明透明通道存在，必须用 `libvpx-vp9` 解码再检查 alpha。
Linux x86_64 的开发依赖包含固定 `ffmpeg-binaries==1.1.0`（wheel 约 60MB，校验值写入 uv.lock），
仅在 pytest 找不到系统工具时使用，并仅修改测试进程 PATH，不在测试时另行下载可执行文件。
Windows 日常处理和 GPU 验证仍使用本机安装的工具，CLI 不自动切换到测试依赖。
包来源及文件校验见 [ffmpeg-binaries 发布页](https://pypi.org/project/ffmpeg-binaries/)。

真实 GPU 合成链路可以复现（先安装 GPU 依赖和模型）：

```powershell
cd D:\TTCats\tools\asset-factory
uv run --extra gpu python scripts/run-synthetic.py
```

它只自动确认自己绘制的合成球，不能自动接受真实猫的候选。输出中会给出片段 JSON 的绝对路径。
要在 M0-A 技术验证小样里复测，先在 `experiments/overlay-spike` 执行 `npm install`，回到仓库根目录：

```powershell
node tools/asset-factory/scripts/verify-spike.mjs '上一步输出的片段 JSON 绝对路径'
```

该脚本把小样复制到素材库，替换合成的站着待机片段，读取三只猫的播放帧号并检查透明画面，结束后退出。
只给外部副本的控制通道增加端口文件，不改小样的 PixiJS 视频纹理播放代码，也不修改仓库的实验目录。
复现脚本固定检查 384×384 的合成输出，不适用于直接验证任意大小的真实猫片段。
截图、播放采样和结果 JSON 留在素材库 `factory-tests\spike-…\`。

已执行的 GPU 与桌面层实测，以及真实豆豆素材尚缺的验收项，见 `docs/验证报告/M0-C-素材工厂.md`。

动态合成循环验证加 `--check-loop`：要求每对相邻帧（含末帧到首帧）仍有变化，接缝平均 alpha 差不超过普通相邻帧平均差的两倍；这只是合成回归阈值，真实猫仍须人工看动作。
