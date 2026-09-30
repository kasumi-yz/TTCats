# shared

共享接口（**草稿，M0 后定稿**）。修改这里要先单独开"接口变更"的 issue 或 PR（见 `AGENTS.md`）。

- `schemas/`：用 zod 定义的内容格式——猫咪包 `cat.json`、片段元数据、姿势、事件配置、设置、素材工厂的候选 manifest。
  改完要运行 `npm run gen:schemas`，把 JSON Schema 重新生成到仓库根目录的 `schemas/`。
- `ipc.ts`：窗口之间的三类消息——命令、事实、状态快照。
- `core-api.ts`：core/game 和 core/stage 对外的接口（只有类型）。
- `strings.zh-CN.ts`：所有界面文字和报错文字。

`shared/` 和 `core/` 一样不能依赖 Electron、DOM 或 PixiJS。
