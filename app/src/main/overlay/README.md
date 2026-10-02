# 桌面层窗口模块

#25 的正式模块，主入口整合由 #28 负责。

## 接线

1. 在 app.ready 之前调用 `configureOverlayGpu()`，强制低功耗 GPU。
2. ready 后调用 `createOverlay({ system, settings, onError, ... })`，system 使用 #19 的 `createPlatform()`。
3. `onWindow(window)` 在首次加载之前调用一次，由主入口安装崩溃恢复与日志。`reload()` 和 `rebuild()` 都复用该窗口，不再次安装恢复控制器，保留滚动窗口内的重试额度。
4. `onMessage` 只转出右键菜单请求和画面调试报告。存档、快照、StageCommand、Fact 的路由仍由 #28 负责。
5. 设置变化时调用 `updateSettings(settings)`；恢复模块的 `reload` 回调调用返回控制器的 `reload()`；进入安全模式时调用 `enterSafeMode()`；退出时等待 `dispose()`。
6. 默认 preload 是 `out/preload/index.cjs`；默认页面是 `out/renderer/overlay/index.html`，开发服务器对应 `/overlay/index.html`。#28 接线时需把桌面层 HTML 加入 renderer 构建入口；当前构建配置只有 panels，#25 允许范围不含构建配置。

每 20ms 在主进程检查租约、光标、左键和 Ctrl，每 500ms 查询全屏。按 shared 的 OVERLAY_TIMING 执行。拖动中按 Ctrl 不释放猫；松手事件丢失时发送 dragCancel。系统查询失败会释放鼠标、取消拖动并交给 onError，不能把错误当成正常状态。

显示器事件串行处理，同一时间最多保留一个尚未开始的事件重建。开始前读取全部显示器，按 `settings.display` 用共享的 `chooseDisplay` 选出桌面层所在的那块（没设置或认不出来时用主显示器，不改设置；那块接回来后下一次显示器事件会放回去），再读它的 id、工作区和缩放；参数未变时跳过，所以无关显示器的通知或重复通知不会重建。设置里换显示器时也走同一个队列（#65）。每次判断完都通过 `onDisplays` 把全部显示器和当前那块交给主入口，写进程序状态给面板和调试台看。全屏查询只问桌面层所在那块显示器。`rebuild()` 更新原窗口 bounds 后调用同一个正式加载函数；`reload()` 只重载原窗口。两者共享串行队列，不销毁窗口、不清零恢复额度。窗口已关闭时不自动新建；退出时取消队列中尚未开始的工作。

每次加载前重置鼠标租约、拖动、幽灵状态和 rendererReady，并隐藏窗口、恢复穿透。加载期间忽略旧页面输入；成功后按当前设置和全屏状态决定是否显示。失败时继续隐藏和穿透，将错误交给 onError，并让 reload/rebuild 的 Promise reject，保留原窗口等待恢复模块处理随后到达的崩溃事件。

首次加载失败的特殊约定：仅当 onWindow 已成功返回且 webContents.isCrashed() 确认渲染进程崩溃时，createOverlay 仍返回可用控制器，错误由 onError 报告，保留窗口等待随后到达的 gone。onWindow 存在本身不代表失败已被处理；文件缺失等非崩溃加载错误仍清理窗口及监听并 reject。主入口负责在 onWindow 内接入恢复，reload 回调等待 overlayReady，避免首次初始化竞态。没有 onWindow 或挂钩本身抛错时也清理并 reject。

`enterSafeMode()` 在本次运行中不可撤销：立即释放输入并隐藏窗口；设置变化、全屏恢复、加载完成、显式 reload/rebuild 和显示器事件都不能再次显示或重载。主入口仍需协调恢复失败路径调用此方法，以及停用包、回退游戏状态和存档写入；本模块只负责窗口。IPC 输入只接受该窗口的主框架。

收到 hover 时，租约接收和即时安全检查共用一次系统输入采样；20ms 看门狗继续独立运行。发送 IPC 前跳过已销毁或已崩溃的 webContents，避免死进程发送异常阻断安全模式隐藏。

## 验证

在根目录执行：

```powershell
npm ci
npm run gen:test-pack
npm run check
npm run build
npm run test:smoke
npm run perf -w app -- --verify
npm run perf -w app
npm run perf -w app -- --moving-pointer
```

也可进入 app 后直接执行 `npm run perf`。根 package.json 不在 #25 允许范围内，因此没有添加根目录 perf 转发命令。

`--verify` 会操作真实鼠标和 Ctrl、打开专用探针窗口与全屏窗口。测试时暂停人工输入，并让测试窗口在前台。不会向用户自己的文档输入文字。点击与焦点证据来自系统 SendInput 和实际窗口，不由截图代替。

正式性能默认三种状态各测 300 秒，各自先预热 15 秒，约每秒采样一次，统计所有应用进程 CPU 和私有内存的平均与峰值。CPU 使用 [Electron CPUUsage](https://www.electronjs.org/docs/latest/api/structures/cpu-usage) 的整机百分比之和，不再除以核心数；私有内存按 KB / 1024 转成 MB。全屏探针在同一个测试应用中，因此它的进程也计入全屏状态统计。每 15 秒检查其他 electron / python / pythonw / ComfyUI；查询失败或发现竞争进程会失败，不输出通过结论。`--seconds=10` 可用于探索，不替代默认正式测量。

`--moving-pointer` 单独测正常播放 300 秒，预热 15 秒。每16ms发送一次真实系统鼠标移动，横扫地板上的猫和空白；不点击。专用普通探针覆盖工作区，它的进程也计入统计。记录发送次数和桌面层实际收到的 mousemove 次数；若输入未到达桌面层则失败。该测试同样需要保持桌面解锁、停止人工输入及独占机器。#24 合并后，性能脚本默认使用真实 core/stage（可用 `--test-driver` 指定固定位置驱动）。真实行为模块的移动测量写入 `verification/perf-stage-moving-summary.json` 和 `app/out/overlay-check/results/perf-stage-moving-raw.json`；固定驱动写入 `perf-moving-summary.json` 和 `perf-moving-raw.json`。不覆盖静止鼠标的三状态汇总。

固定位置驱动的移动鼠标复测：300秒、282次采样，CPU平均1.54%、峰值2.98%，私有内存平均600.63MB、峰值613.79MB。平均CPU及内存峰值达标。发送11820次系统移动，桌面层记录11871个mousemove事件；独占检查通过。此次原始采样按每行一个样本另存为 `verification/perf-moving-raw.jsonl` 并提交，方便复核各进程数据。旧三状态汇总仍是首次实现的历史证据，本轮没有重测全部隐藏和全屏状态的性能。

同步 #24（main 239d793）后的真实 core/stage 移动鼠标复测同样测300秒、282次采样：CPU平均1.73%、峰值2.11%，私有内存平均594.76MB、峰值605.78MB，达标。汇总为 `verification/perf-stage-moving-summary.json`，原始采样为 `verification/perf-stage-moving-raw.jsonl`。两份归档的原始采样都已独立重算，样本数量、CPU平均和内存峰值与各自汇总一致。素材仍是合成测试猫；真实猫素材与完整主进程接线后的整应用验收仍归后续任务。

脚本将原始采样写入 `app/out/overlay-check/results/perf-raw.json`，汇总和桌面交互证据在本目录 `verification/`。本次逐进程原始采样被后续桌面复测的旧版构建清理；保留了完整三阶段汇总和终端阶段结果。构建已改为保留 results，后续复测不会再清理测量文件。汇总含屏幕、GPU 信息与测量口径。未采集 GPU Engine 利用率；GPU 信息只用于确认设备和渲染器，不能当成 GPU 占用数据。

独立 `desktop.fixture.ts`、renderer 的 `test.html` / `test-entry.ts` / `test-driver.ts` 只由验收构建引用，不从正式入口导入。`--verify` 使用固定位置驱动复测窗口与输入链路，不能代替 #24 的互动业务逻辑验收。性能测量及正式 renderer/index.ts 使用真实 createStageCore，猫会自主行动，素材仍是3只合成测试猫。

## 本机结果

详见 `verification/desktop-results.json`、`verification/perf-summary.json`。当前屏幕是 2880×1800、150%（工作区 2880×1728），这次只实测笔记本；台式机两种分辨率及整合后的 M1 验收由后续任务按 D23 执行。自动坐标测试覆盖 D23 四种配置及 1920×1080、125%。

桌面验收记录：空白/腿缝穿透、不抢焦点、跨范围拖动、拖动中 Ctrl、两秒保持、renderer 卡死时 200ms 内释放、冷片段加载保留画面、连续打断、缓存上限、真实全屏停止绘制、三次重建只留一个窗口。`overlay.png` 是独立桌面层捕获；`composed.png` 是工作区合成捕获，蓝色角色属于 Codex 自带桌宠，不是 TTCats。

初次桌面启动因测试 preload 路径失败；首次点击因前台远程窗口拦截失败，用户最小化后通过；连续重建曾出现零窗口触发退出，修复后通过。这些失败未被计为通过。
