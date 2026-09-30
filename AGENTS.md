# AGENTS.md

TTCats 是一个桌面宠物游戏，原型是三只真实的家猫：豆豆、库啵、麻将。
本文件是所有 AI 编码会话共用的**唯一规则来源**，包括 Claude Code 和 ChatGPT/Codex。Claude Code 通过 `CLAUDE.md` 引入本文件。

## 开工前必读

- `docs/设计方案.md`：已经确认的产品决定和架构，包括 D1～D22。
- `CONTEXT.md`：术语表。代码命名、issue 标题、测试名都必须使用其中的词和对应的英文名。
- `docs/adr/`：架构决策。状态为 `proposed` 的决策还在等 M0 验证，不要把它们当成已经定下来的事实去扩展。
- 你认领的 GitHub issue：里面写明了背景、验收标准、允许修改的目录、前置 issue、所需环境和验证命令。

## 硬性规则

1. `app/src/core/` 不能依赖 Electron、DOM 或 PixiJS，必须能单独做单元测试。
2. 代码里不能为某一只猫写死行为。猫的一切都来自猫咪包里的数据，代码只根据性格参数和关系来决定行为（ADR-0005）。
3. 与操作系统打交道的代码只能放在 `app/src/main/platform/<os>/` 下。
4. 所有内容都必须通过 schema 校验，报错信息用中文，并且要说清楚是哪只猫、缺了什么。内容包括猫咪包、事件、互动配置。
5. 每个功能都必须能在调试台里手动触发。
6. 需要存档的状态只能由主进程修改。所有与时间相关的计算，都按真实经过的时间来算，不能按帧数累加（ADR-0004）。
7. 存档要有版本号，并支持迁移。写入时先写临时文件，写完再替换原文件，并保留最近 5 份备份。
8. 不要为以后的阶段预先写占位代码或空字段。以后需要什么，靠存档迁移再加。

## 多会话并行开发的规则

- **一个 issue 对应一个分支、一个 PR。禁止直接提交到 `main`。**如果同一台电脑上同时开了多个会话，每个会话都要在自己的 git worktree 里工作。
- **先认领再开工**：
  1. 把 issue 指派给自己。
  2. 加上 `agent:claude` 或 `agent:codex` 标签。
  3. 留一条评论，说明由哪个会话负责。

  已经有人指派或打了 `agent:*` 标签的 issue，不要去碰。所有前置 issue 都关闭之后才能开工，前置关系用 GitHub 原生的 issue 依赖来标。
- **不越界**：只修改 issue 里"允许修改的目录"。
  - 如果需要改共享接口，也就是 `app/src/shared/`（schema、IPC 类型、core 对外接口）或 `schemas/`，要先单独开一个"接口变更"的 issue 或 PR，等它合并以后再继续。
  - 如果新增了依赖包，要在 PR 里单独列出并说明原因。
- **环境标签**：
  - `env:any`：纯逻辑任务，云端会话也能做。
  - `env:windows-desktop`：需要真实的 Windows 桌面，比如透明窗口、koffi、交互测试脚本。
  - `env:gpu`：需要台式机的显卡，比如素材工厂、本地视频生成。

  云端会话只能认领 `env:any` 的 issue。
- **性能测试要独占机器**：跑性能测试时，同一台电脑上不能有其他会话在运行 Electron 或素材工厂，否则测出来的数据作废。
- **PR 合并前要过三关**：
  1. CI 全部通过。
  2. 交叉审查：Claude 写的 PR 由 Codex 审查，Codex 写的 PR 由 Claude 审查。
  3. 由用户在 GitHub 上点击合并。

  同一时间只合并一个 PR。一个 PR 合并以后，其余 PR 都要先同步最新的 `main`，再继续。
- **issue 必须写成能单独看懂的样子**：每个会话都是从零开始的，所以 issue 必须写清背景、验收标准、允许修改的目录、前置 issue、所需环境和验证命令。模板在 `.github/ISSUE_TEMPLATE/`。

## 仓库目录

```
app/src/main/              主进程，各平台的代码放在 platform/win、platform/mac
app/src/core/game          需要存档的规则（在主进程里运行）
app/src/core/stage         行为和动画规划（在桌面层里运行）
app/src/renderer/overlay   桌面层
app/src/renderer/panels    React 面板：设置、调试台等
app/src/shared/            共享接口：schema、IPC 类型、core 对外接口
schemas/                   由 zod 生成的 JSON Schema，给素材工厂用
content/                   猫咪包、事件、互动配置
tools/asset-factory/       素材工厂（Python + uv + ffmpeg）
experiments/               M0 的复现脚本和测试素材
docs/                      设计方案、ADR、验证报告、素材制作手册、验收清单
```

真实照片和 AI 生成的原始视频**不能提交到仓库**。它们放在仓库外的素材库里。

## 语言约定

- 文档、issue、PR 描述一律用中文。
- 代码里的标识符用英文，并且要和 `CONTEXT.md` 里的英文名保持一致。
- 界面文字集中放在一个中文语言文件里，不能散落在代码各处。

## 常用命令

（由 M0 的 D 线"协作底座"issue 补充，完成前这里暂时为空。）

## Agent skills

### Issue tracker

Issues and PRDs are tracked as GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
