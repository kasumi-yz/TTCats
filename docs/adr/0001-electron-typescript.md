---
status: accepted
---

# 用 Electron + TypeScript 构建桌宠

桌宠需要透明、置顶、鼠标能穿过的窗口，而且在 Windows 和 Mac 上要表现一致；整个项目的代码都由 AI 编写。我们选择 Electron + TypeScript，原因有三点：

- AI 在这套技术上写代码最可靠，出了问题也最容易修。
- Windows 和 Mac 用的是同一个 Chromium 内核，所以透明视频格式和渲染效果在两个系统上一致，第四阶段移植到 Mac 的成本最低。
- 第三阶段的网页小游戏也能直接沿用这套技术。

代价是安装包约 100～150MB，内存占用偏高。这个软件只给自己和亲友小范围使用，这个代价可以接受。

## Considered Options

- **Tauri**：安装包小。但需要写 Rust，而且 Windows 和 Mac 用的不是同一个内核（WebView2 和 WKWebView），连支持的透明视频格式都不一样，第四阶段移植时最容易出问题。
- **Godot**：做小游戏的能力最强。但 AI 对 Godot 4 掌握得较差，很多操作离不开图形编辑器，做普通的设置界面也很麻烦。
