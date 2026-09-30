# main

主进程：窗口管理、托盘、core/game、存档、自动更新、日志和诊断、崩溃恢复。

和操作系统打交道的代码（koffi、`process.platform` 判断等）只能放在 `platform/<os>/` 下，
ESLint 会拦下其他地方的用法（硬性规则 3）。
