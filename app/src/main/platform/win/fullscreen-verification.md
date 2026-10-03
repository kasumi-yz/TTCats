# #103 全屏误判复测

2026-10-03，ZEPHYR，Windows 11（10.0.26200），Electron 44.5.1。单屏物理分辨率 2880×1800、缩放 150%。

## 结果

`fullscreen-native-results.json` 保存通知状态、前台类名、样式、物理矩形及正式 `createWindowsPlatform().isFullscreen()` 的返回值。84 次采样全部符合预期；完全相同的行合并，`samples` 保留次数，共 16 种观测。

`legacy` 是将本轮读到的真实状态和矩形代入原来的忙碌分支所得结果，**不是再次调用旧版本**。本轮临时窗口和系统界面都在主屏，也不属于 NVIDIA 排除项，所以这一对照适用于这些样本。

| 场景                                       | 通知状态  | 原几何判断     | 修正后        |
| ------------------------------------------ | --------- | -------------- | ------------- |
| Alt+Tab 的 `XamlExplorerHostIslandWindow`  | 2（忙碌） | 全屏，误隐藏   | 不隐藏，15 次 |
| 任务视图的 `XamlExplorerHostIslandWindow`  | 2         | 全屏，误隐藏   | 不隐藏，13 次 |
| 任务视图切换时的 `ForegroundStaging`       | 2         | 未盖满，不隐藏 | 不隐藏，2 次  |
| 贴靠布局的 `XamlExplorerHostIslandWindow`  | 2         | 未盖满，不隐藏 | 不隐藏，15 次 |
| 带标题栏、设置最大化位且盖满屏幕的临时窗口 | 2         | 全屏，误隐藏   | 不隐藏        |
| **真实开启任务栏自动隐藏后的最大化窗口**   | 2         | 全屏，误隐藏   | 不隐藏        |
| 临时窗口按 F11 进入 / 退出全屏             | 2         | 隐藏 / 不隐藏  | 隐藏 / 不隐藏 |
| 无边框演示窗口进入 / 退出全屏              | 2         | 隐藏 / 不隐藏  | 隐藏 / 不隐藏 |
| 显示桌面（`Progman`）                      | 2         | 不隐藏         | 不隐藏        |

任务栏自动隐藏复测已获得用户确认。脚本读到初始任务栏状态为 0，临时开启后确认自动隐藏位生效，测完恢复并重新读取为 0。最大化窗口真实矩形为 `(-11,-11)-(2891,1811)`，盖满了整屏，样式为 `0x17cf0000`（包含最大化和完整标题栏）。

## 实测边界

- 本次没有外接副屏。副屏无任务栏的等价几何、负坐标和另一块屏幕的全屏隔离由纯函数测试和既有平台测试覆盖。
- 表情和剪贴板面板快捷键各采样 15 次，前台仍为普通测试窗口，本轮未捕获 `Windows.UI.Core.CoreWindow`；**不声称已实测该类名或输入法候选框**。这些类名的排除及大小写由单元测试覆盖。`ApplicationFrameWindow` 的 UWP 全屏仍算全屏，也由单元测试覆盖。
- 没有启动真实独占 D3D 游戏或 PowerPoint。真机用 F11 和无边框演示窗口验证等价全屏；系统通知状态 3（独占全屏）和 4（演示模式）的优先隐藏规则没有改变，平台单元测试确认窗口没盖满或在另一块屏幕时，它们也继续隐藏。
- 起初有因外部窗口遮挡而中止的测试轮，未作为通过证据。临时窗口的 F11 初版受到 Electron 默认菜单快捷键干扰，最终脚本移除临时窗口菜单后才通过；正式应用没有修改菜单。

## 如何复测

从仓库根目录执行，使用已经由 `npm ci` 安装的工具，不增加依赖：

```powershell
.\node_modules\.bin\esbuild app/src/main/platform/win/fullscreen-native.ts --bundle --platform=node --format=cjs --external:electron --external:koffi --outfile=app/out/fullscreen-native.cjs
.\node_modules\.bin\electron app/out/fullscreen-native.cjs --output=app/out/fullscreen-retest.json
```

默认不改系统设置。只有先取得用户确认，才在第二条命令后加 `--taskbar-autohide`；脚本会在收尾恢复并核对原值。脚本会短暂操作桌面，遇到窗口被遮挡或没有取得焦点立即中止，不向被遮挡的窗口点击。临时窗口、模拟按键、光标和原前台窗口在收尾处理，正式应用不导入该入口。

调试台已有模拟全屏入口，继续使用；本次没有改变 IPC 或增加共享接口。

## 来源

问题线索来自 issue #103 整理的 [clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) 用户问题及思路。该项目使用 AGPL-3.0，本实现没有读取或复制其源代码。

窗口样式和失败返回值按 Microsoft 官方说明独立实现：[窗口样式](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-styles)、[GetWindowLongPtrW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowlongptrw)。只有 `WS_MAXIMIZE` 和完整 `WS_CAPTION` 同时存在才排除；返回 0 时先前的错误被清除后再查询，读失败保留原有几何判断。
