# main/platform/win

本模块仅实现 #19 的三项主进程查询，不负责轮询、窗口隐藏或幽灵模式的持续时间。

通过 `await createPlatform()`（从 `main/platform/index.ts` 导入）创建接口，然后同步查询：

- `isFullscreen()`：通知状态为 2、3、4 时返回 `true`，覆盖全屏程序、D3D 独占全屏和演示模式；HRESULT 失败会抛出含 API 名和错误码的诊断错误。
- `isCtrlDown()`：读取合并的 Ctrl 当前按下位，左右 Ctrl 均有效，不使用不可靠的“最近按过”位。
- `isLeftButtonDown()`：读取系统设置里的主按钮。每次检查 `SM_SWAPBUTTON`，交换左右键后立即改读物理右键，供拖动松手兜底使用。

非 Windows 系统返回三项均为 `false` 的接口，不导入 Windows 实现或加载 DLL。
`GetAsyncKeyState` 在非活动桌面、权限限制等情况下也可能返回 0，这是系统 API 的限制。

## 构建与验证

`electron.vite.config.ts` 将 koffi 保留为外部运行时依赖，避免把原生模块内联到 JavaScript。
独立的 `out/main/platform.js` 入口用于在 Electron 主进程里验证本模块；应用入口不增加轮询。
当前仓库尚无安装包配置，本次验证的是 `npm run build` 的构建产物与 Electron 加载，不声称已验证 NSIS 安装包。

在仓库根目录运行：

```powershell
npm ci
npm run check
npm run build
npm run test:smoke
```

本模块单元测试覆盖通知状态分类、HRESULT 失败、按下位、松手后残留的“最近按过”位、运行中交换左右键，以及 Linux/macOS 的降级接口。

如需手动观察三项查询，在根目录运行下面命令；打开全屏视频、按住/松开 Ctrl 或主按钮，输出应立即对应变化。按 Ctrl+C 结束。

```powershell
node --input-type=module -e "import {createPlatform} from './app/out/main/platform.js'; const p=await createPlatform(); let last=''; setInterval(()=>{const s=JSON.stringify({fullscreen:p.isFullscreen(),ctrl:p.isCtrlDown(),leftButton:p.isLeftButtonDown()}); if(s!==last){console.log(s);last=s;}},20);"
```

## 本次 Windows 实测

证据见同目录 `native-results.json`。在 Electron 44.5.1 的主进程中加载**构建后的**平台入口和 koffi 3.3.2，使用临时测试窗口验证：

- 左右 Ctrl 分别按下和松开。
- 普通设置与实际调用 `SwapMouseButton` 交换左右键后，物理左/右按钮分别按下和松开；最终核对恢复原设置。
- 在独立窗口播放仓库已有的合成 WebM，进入真实全屏后查询为 `true`，退出后为 `false`，同时确认视频在播放。
- 22 项检查全部通过。系统输入仅落到本次创建的窗口，结束后释放按键并恢复光标；临时输入模拟脚本未作为功能提交，完整交互测试仍属于 #29。

测量前确认没有其他 Electron 会话；曾有一次失败启动遗留本会话的 Electron 进程，清理后重新测量，下面只保留清理后的结果。
每项预热 1,000 次，测量 20 批 × 1,000 次；用 `process.hrtime.bigint()` 测整批耗时后除以次数，包括 JavaScript 包装和 koffi 调用。批次均值范围不是单次调用的峰值。

| 查询                     | 平均单次耗时（微秒） | 批次均值范围（微秒） |
| ------------------------ | -------------------: | -------------------: |
| 全屏                     |               86.515 |       81.426～94.255 |
| Ctrl                     |                0.068 |         0.063～0.093 |
| 主按钮（含交换设置查询） |                0.081 |         0.077～0.095 |

按键查询远小于 20ms 轮询间隔；全屏查询也可沿用 M0 的 500ms 周期。这里不启动任何轮询。

API 语义参考：[GetAsyncKeyState](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getasynckeystate)、[通知状态](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ne-shellapi-query_user_notification_state)。
