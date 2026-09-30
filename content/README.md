# content

猫咪包、事件配置。所有内容都要通过 `npm run validate:content` 校验（硬性规则 4）。

```
content/cats/<猫id>/
  cat.json          身份、体型、性格参数、关系、声音位（schemas/cat.schema.json）
  poses/            姿势帧
  clips/            片段：<名字>.webm + 同名 .json 元数据（schemas/clip.schema.json）
  sounds/           声音
content/events/<事件id>.json   事件配置（schemas/event.schema.json）
```

目前只有豆豆的 `cat.json`（草稿），用来测试校验流程。性格参数是按设计方案里的描述估的初值；
到家日可以不写。
