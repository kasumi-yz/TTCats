# 认领并完成 issue

用户让你认领、做、或者自己挑一个 issue 时，按下面的步骤走。规则以 `AGENTS.md` 的"多会话并行开发的规则"为准，本文把它们排成先后顺序，并补上规则里没写到的细节。

一个会话同一时间只做一个 issue。

## 1. 读

读 `AGENTS.md`，再用 `gh issue view <N> --comments` 读 issue，然后读 issue"参考"一节列出的设计方案章节、ADR 和 `CONTEXT.md`。

读完的标准：你能用自己的话复述每一条验收标准，并说出允许修改哪些目录。

## 2. 判断能不能接

逐条核对，全部满足才往下走：

- 没有指派人，也没有 `agent:claude` 或 `agent:codex` 标签。
- 前置 issue 全部关闭。GitHub 原生依赖用 `gh api 'repos/{owner}/{repo}/issues/<N>' --jq .issue_dependencies_summary.blocked_by` 查，结果为 0 才算；正文"前置 issue"一节列出的也要逐个确认已关闭。
- 这台机器满足 issue 的环境标签（见 `AGENTS.md`"环境标签"）。
- issue 写得够清楚，照着就能做。

有一条不满足：issue 保持原样，用中文告诉用户卡在哪一条。

**用户让你自己挑时**：候选是开着、带 `ready-for-agent` 标签、并满足上面四条的 issue，取编号最小的。告诉用户选了哪个、为什么，然后直接往下走。一个都没有，就告诉用户每个 `ready-for-agent` issue 各卡在哪。

## 3. 认领

Claude 和 Codex 用的是同一个 GitHub 账号，只看指派人分不出谁在做，所以三样都要有：

1. `gh issue edit <N> --add-assignee @me --add-label agent:claude`（Codex 用 `agent:codex`）。
2. 留一条评论：哪个工具、哪台机器、哪个分支在做。
3. 重新读一遍 issue 的评论。如果另一个会话也留了认领评论，评论时间晚的一方退出：去掉自己加的标签，留言说明已退出，再告诉用户。

完成标准：issue 上有你的标签，你的认领评论是最早的一条。

## 4. 准备工作树

- 工具已经给这个会话建好了工作树（Codex App、Claude 桌面版都可能这样做）：直接用它。确认它是从最新的 `origin/main` 开出来的；分支名里没有 issue 编号的，改成带编号的。
- 你在仓库主文件夹里：先 `git pull`，再按 `AGENTS.md` 里的命令新建工作树和分支。

之后所有改动都只在工作树里做，主文件夹一直停在 `main`。

## 5. 动手做

只改 issue"允许修改的目录"。必须改 `app/src/shared/` 或 `schemas/` 时，先停下：按 `.github/ISSUE_TEMPLATE/task.md` 另开一个"接口变更" issue，告诉用户，等它合并以后再继续。

## 6. 验证并提 PR

1. 跑 `npm run check` 和 issue"验证命令"里的每一条，全部通过。
2. 推送分支，按 `.github/pull_request_template.md` 写 PR：正文写 `Closes #<N>`，"作者"填 Claude 或 Codex。
3. CI 失败时，修到通过为止。

完成标准：PR 已经开好，本地检查和验证命令全部通过。

## 7. 汇报

用中文大白话告诉用户：做了什么、PR 链接、还有没有没解决的问题、需不需要用户亲手试（需要的话步骤越少越好）。合并由用户在 GitHub 上点。

符合 `docs/agents/pr-review.md`"免审的小改动"的，在 PR 描述里写明"免审：<理由>"，汇报时告诉用户"这个 PR 没有审查，可以直接合并"。

## 等待合并时

审查通过以后，`main` 又往前走了，或者出现了冲突，**不用**主动同步、重跑 CI。等用户说"打包合并"，由合并包统一处理（见 `docs/agents/merge-batch.md`）。只有用户要求单独合并这一个 PR 时，才同步 `main`。

## 收到审查意见

读 PR 上的全部评论，逐条处理：

- **必须改**：全部改掉。
- **建议改**：自己判断。不改的，在 PR 上回复理由。
- **可以不管**：自己决定。

改完推送，在 PR 上留言列出改了哪些、哪些没改以及原因。

## 放弃认领

用户说这个 issue 先不做了：取消指派（`--remove-assignee @me`），去掉 `agent:*` 标签，在 issue 下留言说明做到了哪一步、为什么停下；已经推送了分支或开了 PR 的，把链接写进留言。

## PR 合并以后

在主文件夹 `git pull`，再按 `AGENTS.md` 删掉这个 issue 的工作树。下一个 issue 开新会话来做。
