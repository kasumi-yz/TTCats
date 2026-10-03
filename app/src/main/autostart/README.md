# 开机启动（#67）

安装版使用 Electron 的登录启动接口，启动项名为 `top.ttcats.desktop`，与 `app/electron-builder.yml` 的 `appId` 和 `app/build/installer.nsh` 的清理名称一致。命令行为安装路径加 `--autostart`。

- 每次启动核对 `launchAtLogin`；设置变化后同步。开发模式只记日志，不修改注册表。
- 显式设置 AppUserModelId 后用 `openAtLogin` 比较完整命令行。不能只用 `launchItems.args`：Electron 在 Windows 上不会把命令行开关列进这个数组。
- 同名启动项被 Windows 禁用时，保留禁用状态并记日志。用户先在应用里关掉，再重新打开，属于重新注册。
- `--autostart` 优先于 `--settings`，第二实例也不会因此打开面板。正常启动失败会弹错误框，开机启动失败只写日志并退出。
- 主进程把 `startupQuiet` 传给现有 core/game，按真实时间每秒推进一次；只在快照变化时发布。一分钟后移除开机静默，其他静音原因仍保留。退出清理定时器，安全模式停止推进。
- 调试台沿用 #52/#58 的“模拟开机静默”和“快进时钟”。没有改共享类型、schema、存档格式或调试面板。
- 普通卸载（含 `/S`）删除 Run 和 StartupApproved 的同名值；`--updated` 不删除。

安装器沿用 #54 的 `runAfterFinish: false`，不会在安装结束时运行程序。启动项在安装版**首次打开**时注册；没有新增安装结束自动运行或直接写注册表的安装步骤。

## 本机验证

2026-10-03，Windows，Electron 44.5.1：

- `npm ci`、`npm run check`、`npm run build`、`npm run dist`：通过。815 个单元测试通过，正式内容和安装包内容检查通过。
- `npm run test:smoke`：11 项全部通过，本机并行会话使用独立测试快捷键。
- 安装版：设置页面“程序”标签下开关能删除/恢复启动项；启动项含正确安装路径和 `--autostart`。
- 安装版带开机参数：只有桌面层、没有设置面板、不抢焦点；快进一分钟后开机静默结束，安静时段保留。
- 在注册表边界模拟 Windows 禁用状态：正式应用不会重新启用它；`launchAtLogin` 偏好仍为开启。
- NSIS `/S --updated /currentuser` 覆盖安装：启动项保留，存档哈希不变。
- NSIS `/S /currentuser` 卸载：Run 和 StartupApproved 均无该启动项，存档哈希不变。

原始本机证据在未提交的 `app/dist/autostart-verification/{toggle,boot,disabled,update,uninstall}.json`。安装版复现脚本：

```powershell
# 先备份当前用户 appData/TTCats。安装并首次运行后：
npx tsx app/e2e/autostart-installed.ts '<安装目录>/TTCats.exe' toggle
npx tsx app/e2e/autostart-installed.ts '<安装目录>/TTCats.exe' boot
# disabled 模式需要先在 Windows 中禁用启动项。
npx tsx app/e2e/autostart-installed.ts '<安装目录>/TTCats.exe' disabled
```

完整冒烟覆盖无面板、第二实例、快进、调试按钮，以及**不主动查询主进程、只观察推送快照**的一分钟结束。声音测试显式关闭安静时段，避免运行时间改变测试前提。

本机并行会话争用调试快捷键时，可为冒烟单独指定 `TTCATS_SMOKE_DEBUG_SHORTCUT=CommandOrControl+Alt+Shift+F12`。只替换测试的原生边界，应用和 CI 默认仍使用正式快捷键；这不属于性能或多会话焦点验收。

## 留给 M2 / #68 的验收

- [ ] M2：用户真正重启电脑，确认猫自动入场，没有面板或提示框，没有抢走正在使用的窗口焦点。
- [ ] M2：头一分钟不出声，之后恢复正常声音规则；如果处于安静时段或勿扰模式，仍然保持安静。
- [ ] #68：通过两个真实 GitHub Releases 测试版本验证自动下载、安装、重新启动后启动项仍保留。本 issue 只实测了 NSIS 更新模式，不代替真实自动更新验收。

issue 不允许修改 `docs/`，所以这里保存待纳入 M2 总验收清单的条目，后续整体验收时汇总。
