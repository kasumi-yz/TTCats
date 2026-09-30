# core

纯 TypeScript 的游戏核心，分成两部分（ADR-0004）：

- `game/`：在主进程里运行，是需要存档的状态的唯一管理者。
- `stage/`：在桌面层里运行，管理可以随时丢弃的画面状态。

对外接口见 `src/shared/core-api.ts`（草稿，M0 后定稿）。

## 自动检查的规则

- 不能导入 `electron`、`pixi.js`、`react`、`react-dom`，也不能导入 `node:*` 模块（ESLint `no-restricted-imports`）。
- 不能用 DOM：`tsconfig.core.json` 不带 DOM 类型，ESLint 也禁止 `window`、`document` 等浏览器全局变量。
- 不读系统时钟（`Date.now()` 等）：时间一律由调用方传入，按真实经过的时间计算（硬性规则 6）。
- 单元测试放在被测文件旁边，命名为 `*.test.ts`。
