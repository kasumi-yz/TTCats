# M0-F：豆豆拎起与放下问题交接给 Claude

关联：[#7](https://github.com/kasumi-yz/TTCats/issues/7)。记录：Codex，2026-10-02。

## 交接时的状态与用户要求

后续状态：用户已要求“继续修拎起放下的问题”，Codex按更新后的#7第4.5节重新认领并恢复修复。此文保留停止修复时的历史交接，不再表示当前暂停；最新实现和验证见 `M0-F-豆豆素材.md` 的“按第4.5节恢复跟手修复”。

用户已审看最新约42秒的v2视频，结论是**仍不通过**：

> 拎起前仍然有不自然的移动，放下的动作太慢了。本次不做修复，总结问题文档交接给Claude，顺便把视频路径告诉我

本轮只整理交接，不改播放器、参数、提示词或素材，不生成或重新录屏，不启动Claude自动修复。Codex解除#7认领，保留现有分支、工作树和全部外部素材证据，供Claude按认领流程接手；没有替Claude提前认领。#7未完成，未开PR、未提交或合并，ADR-0002保持proposed。

**此前“播放流程通过”“关键点坐标连续”不等于用户观感通过。** 最新用户结论优先，不得把v2写成已被用户接受，不得把关键点0偏移当作全身视觉连续证明。

## 优先复看的视频

最新版用户审看视频（1000×650、约42.11秒、无声、实际时间戳VFR）：

```text
D:\TTCats-素材库\work\issue-7\drag-continuity-v2\neck-grab-capture\doudou-drag-continuity-v2-review.mp4
```

黄色圈表示页面鼠标位置。四组独立测试分别是深色站姿、深色坐姿、浅色站姿、浅色坐姿；站姿演示拎起后松手，坐姿演示先往下移动再轻放。前三组站稳后各有0.65秒“下一组独立测试”卡片，只覆盖测试重置，不覆盖拎起、下落、land或站稳动作。

同目录无分隔卡的实际录屏：`doudou-drag-continuity-v2.mp4`。2476张原始JPEG、实际时间戳 `frames.json`、播放状态 `result.json`、`continuity-trace.json`、`continuity-verification.json`、`scene-separator-record.json`、`startup-trim.json`均保留；实际采样58.752fps、最大间隔0.06143秒。仅裁去最初约0.016秒未显示猫的启动画面，没有插帧。

其他历史版本（保留用于对照，不算通过）：

- 身体核心点抓取v2：`D:\TTCats-素材库\work\issue-7\drag-continuity-v2\actual-capture\doudou-drag-continuity-v2.mp4`。
- 38秒完整拖放：`D:\TTCats-素材库\work\issue-7\drop-transition-v1\actual-capture\doudou-pickup-release-dark-light.mp4`；用户指出拎起漂移、放下小段瞬移。
- 20秒拎起预览：`D:\TTCats-素材库\work\issue-7\pickup-transition-v1\actual-capture\doudou-pickup-dark-light.mp4`；只录了拎起/悬空，没有放下。
- 最早约50秒实际Electron录屏：`D:\TTCats-素材库\work\issue-7\desktop-validation\evidence\actual-electron-dark-light.mp4`；只有6～7fps采样，不能用于判断原素材流畅度。

## 问题一：拎起前仍有不自然移动

用户明确指出v2仍有问题；用户尚未指定具体秒数，因此不编造发生时间或唯一根因。

已做但不足以解决的处理：

1. 原来在220ms内把鼠标按下点吸附到估计后颈，会让猫在鼠标不动时自行移动；v2已取消该吸附，改为保持按下时抓取偏移。
2. 连接姿势切换时，按当前鼻尖世界坐标对齐下一片段首帧；抓点偏移随新首帧后颈重算。
3. 黄色鼠标圈与约1.1秒分步移动区分鼠标搬动与猫自身移动；分别录过身体核心点、后颈附近抓取。

**待Claude核对的原因，不是已确认诊断：**

- H3过渡开头有静止/准备段，首轮抽样观察约前0.5～0.75秒尚未真正抬起；鼻尖、头颈或身体先动，可能形成“先挪再拎”的观感。需要在原始逐帧与最终实际录屏分别确认。
- scruff并非真正关节点：由人工首尾轮廓估计、鼻尖模板及相对偏移插值得到。把这个估计点固定住，并不保证猫全身或真正后颈稳定；鼻尖模板误差和姿势变形会被转为root补偿移动。
- 站/坐待机在中途被打断，而拎起首帧是标准姿势；鼻尖对齐无法保证整个身体轮廓一致。
- 录屏脚本先跨过12像素拖动阈值、停约600ms，再向上移动。脚本输入、原始画面和接线补偿应分别排查，不能只凭一张关键点检查判定视觉问题已修好。

建议Claude先并排查看原始首帧附近、关闭位置补偿的原始画面、开启补偿的实际画面，再决定问题属于生成内容、关键点还是输入接线。本轮不执行这些排查或修复。

## 问题二：放下动作太慢

最新版悬空和land保持**原速1倍**；只有两个新增拎起过渡为2倍速。land 2026是107帧、24fps，原视频约4.458秒。从实际状态首次观测land到首次观测idle-stand，四组约4.469、4.508、4.499、4.394秒（状态上报有延迟，非精确视频长度）。因此约4.5秒的身体展开/站稳段是明确事实，用户认为太慢。

松手后的程序下落与land身体过渡是两段：前者使用演示重力1800显示像素/秒平方，后者播放H3生成的悬空触地→站姿视频。慢感可能主要在后者，也可能包含前后的静止段；需要Claude按真实画面确认，不能把缩短整段播放等同于解决所有动作节奏。

已尝试：松手暂停当前悬空画面，保留当时位置再下落；接触位置补偿当前鼻尖与land首帧差，切入land及回站姿按nose对齐；视频重播等待seeked并更新纹理，避免旧画面闪出。**本轮没有加速land、裁剪停顿或重新生成。** 若后续决定加速/裁剪，需记录实际播放速度或裁剪范围，保留原素材与失败证据，不掩盖原H3结果。

## 接手所需位置与素材

- 主目录 `D:\TTCats` 始终在main；不要在此修改代码。
- 唯一issue7工作树 `C:\Users\Salmon\.codex\worktrees\issue-7-doudou-assets\TTCats`，分支 `codex/issue-7-doudou-assets`。交接时有暂存/未提交文档与提示词，先查git status；保留、复用本分支工作树，避免重复建issue7分支覆盖成果。
- 允许修改：`docs/验证报告/M0-F-*`、`docs/素材制作手册.md`、`experiments/generators/**`中的生成相关记录。共享接口、生产app、仓库overlay-spike不在#7范围。
- 外部实际验证副本：`D:\TTCats-素材库\work\issue-7\desktop-validation`；当前接线在 `src/renderer/overlay.ts`，清单 `assets/clips/manifest.json`新增nose数据仅供外部验证。
- 修改说明 `adaptation-notes.md`。修改前源码备份 `D:\TTCats-素材库\work\issue-7\overlay-before-drift-fix.ts`。历史 `adapt-generated-pickup.py`含旧220ms吸附，不应重新套回当前副本。
- 原Claude18段原文：工作树 `experiments/generators/doudou-prompts.json`；Codex新增两段：`doudou-pickup-prompts.json`。用户此前明确允许Codex自行处理拎起，新增提示词记录作者与授权，不能冒充Claude原文。
- 当前录屏入口：`D:\TTCats-素材库\work\issue-7\capture-neck-continuity-cdp.mjs`；编码/插卡记录均在素材库。真实照片、原始视频、模型及处理中间帧不能提交仓库。

关键生成素材：

| 片段                   | 工厂任务              | 原始视频                                                   |
| ---------------------- | --------------------- | ---------------------------------------------------------- |
| stand-to-dangle，种子6 | clip-ef47eff4a5644e8b | `D:\TTCats-素材库\inbox\h3-20261002-175806-00b46505-1.mp4` |
| sit-to-dangle，种子6   | clip-26309173c69a41c2 | `D:\TTCats-素材库\inbox\h3-20261002-180228-c4b37bd8-1.mp4` |
| land，种子2026         | clip-cb22e46e66294650 | `D:\TTCats-素材库\inbox\h3-20261002-034110-cab6cf3e-1.mp4` |
| dangle，种子1234       | clip-2ff29165016e416c | 详见该工厂任务ingest.json与generator-log.json              |

工厂任务目录为 `D:\TTCats-素材库\factory\<任务>`，含原始拆帧frames、抠图matte、generator-log、关键点记录和finalize导出；站/坐新增过渡均107帧、24fps。具体参数、模型与已有偏差详见主报告 `docs/验证报告/M0-F-豆豆素材.md`。

## 验证边界与交接完成标准

- v2两个抓取位置各深浅背景四流程完成、没有pageerror；每轮8组抓取偏移和16个接缝的人工关键点坐标约0差异。**用户仍不接受，不得据此说画面合格。**
- 已有媒体schema、实际WebM alpha/HitMask、静音检查通过；完整npm检查19文件384测试、70内容及schema最新、生成器7/7为之前记录。本轮仅文档格式/git差异检查，没有伪造新的应用测试。
- 旧Windows真实SendInput 10/10对应旧硬切版本。最新只用Playwright页面事件，且页面测试标志避免物理松手watchdog取消合成输入；不等于新的Windows实际交互通过。重测物理输入前需重新约定输入隔离，保留真实失败证据。
- 原严格坐下后脚、悬空抓点、落地脚趾检查失败继续保留。用户接受的软色边无需重新阻塞，但不等于严格无色边。姿势选择坐姿2、悬空1，以及早期“像豆豆”不等于当前完整动作链通过。
- 本轮交接后由Claude先读AGENTS.md、claim-issue.md、最新issue正文及评论、这份交接与主报告，再决定下一步。不要直接复制目前自动检查结论为视觉通过；后续实现若越界需另开issue，不替#24实现生产逻辑。
