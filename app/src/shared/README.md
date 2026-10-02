# shared

共享接口。M1 用到的部分在 #18 定稿，M2 新增的部分在 #52 定稿。修改这里要先单独开"接口变更"的 issue 或 PR（见 `AGENTS.md`）。
例外：`strings.zh-CN.ts` 每个 issue 都可以加自己模块的一段文字（只加不改，规则写在文件开头）。

- `schemas/`：用 zod 定义的内容格式。
  - 定稿：猫咪包 `cat.json`、片段元数据（含必需片段 `CLIP_SLOTS`、出声的片段 `CLIP_SOUNDS`）、姿势、设置、勿扰模式、存档（`save.ts`，含迁移步骤 `SAVE_MIGRATIONS`）。
  - 还是草稿：事件配置（M3 定稿）、素材工厂的候选 manifest（素材工厂 v0 #4 对接时定稿）。
  - 改完要运行 `npm run gen:schemas`，把 JSON Schema 重新生成到仓库根目录的 `schemas/`。
- `hitmask.ts`：点击遮罩的文件格式，以及读写它的函数。素材工厂和测试猫咪包按它输出，桌面层按它判断点击。
- `content-url.ts`：桌面层读取猫咪包文件用的 `ttcats-content://` 地址。
- `accelerator.ts`：全局快捷键（Electron accelerator）的写法、规范化和校验，一键隐藏快捷键用它。
- `display.ts`：显示器列表的格式，以及怎么认出设置里记住的那块显示器（`findDisplay`、`chooseDisplay`）。
- `ipc.ts`：窗口之间的消息——命令、事实、状态快照（ADR-0004）、程序状态（AppStatus），以及桌面层的窗口控制消息
  （鼠标穿透、幽灵模式，ADR-0003）和 preload 暴露的桥的类型。preload 的实现在 `src/preload/index.ts`。
- `core-api.ts`：core/game 和 core/stage 对外的接口（类型和几个共用常数）。
- `strings.zh-CN.ts`：所有界面文字和报错文字。

`shared/` 和 `core/` 一样不能依赖 Electron、DOM 或 PixiJS。

## M2 新增了什么（#52）

- **设置**：呼噜和喵叫的开关、音量（喵叫默认更轻）；安静时段的开始和结束（默认 23:00～08:00，开始等于结束表示没有）；
  一键隐藏快捷键（默认 Ctrl+Alt+Shift+H）；开机启动；自动更新；猫待在哪块显示器（默认主显示器）。
- **存档**升到版本 2：新增勿扰模式（没开 / 到某个时刻结束 / 直到关掉）。1→2 的迁移步骤在 `schemas/save.ts`，
  主进程创建 SaveStore 时传入。一键隐藏、开机静默、快进的时钟偏移不进存档。
- **命令**：勿扰开始和结束、一键隐藏切换；主进程自己处理的拍照、导出诊断信息、检查更新、重启并更新；
  调试台的快进时钟、开机静默、全部重新入场、发出声音、模拟全屏、模拟在猫旁边连续点击。
- **状态快照**：勿扰模式、一键隐藏、为什么不能出声（`silencedBy`）、调试台的时钟偏移。
- **程序状态** `AppStatus`：版本号、自动更新状态、快捷键注册结果、显示器列表。单独的推送通道 `ttcats:app-status`，
  面板打开时用 `getAppStatus` 拿一次。
- **core 接口**：GameCore 加 `tick(now)`、创建参数加时区 `utcOffsetMinutes` 和开机静默 `startupQuiet`；
  GameOutput 加 `snapshotChanged`（只推快照、不存档）；StageCommand 加 `cat/entrance`（全部重新入场）；
  PointerInput 加 `clickThrough`（穿过桌面层的点击）；StageFrame 加声音提示 `sounds`。
- **桌面层消息**：主进程发给桌面层的 `clickThrough`（在猫旁边的点击）和 `photo`（播放快门动画）；
  调试台画面状态里可以带上声音播放情况 `audio`。

每个 M2 功能用哪个调试命令触发，见 #52 的 PR 里的"功能 → 调试命令"对照表。
