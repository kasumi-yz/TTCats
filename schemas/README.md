# schemas

由 `app/src/shared/schemas/` 里的 zod 定义自动生成的 JSON Schema（draft 2020-12），**不要手改**。
修改 zod 定义后运行 `npm run gen:schemas`，CI 会检查这里是不是最新的。

| 文件 | 校验的内容 |
|---|---|
| `cat.schema.json` | 猫咪包的 `cat.json` |
| `clip.schema.json` | 片段元数据（`clips/*.json`） |
| `event.schema.json` | 事件配置（`content/events/*.json`） |
| `candidate-manifest.schema.json` | 素材工厂候选文件夹里的 `manifest.json` |

注意：JSON Schema 只包含字段和格式规则。跨字段的规则（比如落脚锚点的数量要等于帧数、标准片段的起止姿势）
只在 `npm run validate:content` 里检查。素材工厂（Python）可以用 `jsonschema` 库做基础校验。

`cat`、`clip` 已经定稿（#18）；`event` 在 M3 定稿，`candidate-manifest` 在素材工厂 v0（#4）对接时定稿。
