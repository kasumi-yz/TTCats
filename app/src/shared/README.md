# shared

共享接口，M1 用到的部分已经定稿（#18）。修改这里要先单独开"接口变更"的 issue 或 PR（见 `AGENTS.md`）。
例外：`strings.zh-CN.ts` 每个 issue 都可以加自己模块的一段文字（只加不改，规则写在文件开头）。

- `schemas/`：用 zod 定义的内容格式。
  - 定稿：猫咪包 `cat.json`、片段元数据（含必需片段 `CLIP_SLOTS`）、姿势、设置、存档（`save.ts`）。
  - 还是草稿：事件配置（M3 定稿）、素材工厂的候选 manifest（素材工厂 v0 #4 对接时定稿）。
  - 改完要运行 `npm run gen:schemas`，把 JSON Schema 重新生成到仓库根目录的 `schemas/`。
- `hitmask.ts`：点击遮罩的文件格式，以及读写它的函数。素材工厂和测试猫咪包按它输出，桌面层按它判断点击。
- `content-url.ts`：桌面层读取猫咪包文件用的 `ttcats-content://` 地址。
- `ipc.ts`：窗口之间的消息——命令、事实、状态快照（ADR-0004），以及桌面层的窗口控制消息
  （鼠标穿透、幽灵模式，ADR-0003）和 preload 暴露的桥的类型。preload 的实现在 `src/preload/index.ts`。
- `core-api.ts`：core/game 和 core/stage 对外的接口（只有类型）。
- `strings.zh-CN.ts`：所有界面文字和报错文字。

`shared/` 和 `core/` 一样不能依赖 Electron、DOM 或 PixiJS。
