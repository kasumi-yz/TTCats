# 主进程日志（#27）

`createApplicationLog()` 使用 `app.getPath('appData')/TTCats/logs/`，在 Windows 上就是 `%APPDATA%\TTCats\logs\`。正式入口先取得单实例锁，再创建日志。测试用 `new FileLog({ directory })` 指定隔离目录。

- `main.log` 达到 1 MiB 前轮转，保留 `.1`～`.5`；总大小最多 6 MiB。单条错误先限制长度，再按 UTF-8 字节大小截短，中文不会被切坏。
- `write(message)` 同步写入；失败抛出中文错误。事件监听使用 `report(message)`，写盘失败会明确输出到标准错误，避免日志故障阻止桌面层恢复。
- `attachMainLog(log)` 记录致命异常和 Node warning（包含 Electron 默认策略下的未处理 Promise 错误）。不接管 `uncaughtException` 或 `unhandledRejection`，不改变退出策略，不启动新进程。
- `attachRendererLog(webContents, name, log)` 记录 Electron 的 `console-message` 警告/错误和渲染进程退出。每个来源每秒最多写入 10 条页面消息，超出的部分写一条带省略数量的摘要；进程崩溃记录不受这个限额影响。Electron 会把页面未捕获异常、未处理 rejection 输出到这个事件；Windows 验收覆盖了桌面层和面板两者。
- 创建面板时接入 `attachRendererLog`；桌面层已由 `attachRecovery` 接入。返回函数负责解除监听，退出时调用。

本模块不记录系统桌面、照片或应用之外的网页内容。正式入口接线由 #28 完成。
