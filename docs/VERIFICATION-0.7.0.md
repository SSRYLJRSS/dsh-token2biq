# 0.7.0 实测记录（2026-11-18）

本文件只记录 0.7.0 这一次发布实际跑过的命令与结果；方法论与验收矩阵见 [VERIFICATION.md](VERIFICATION.md)。

## 改了什么

| 文件 | 改动 |
| --- | --- |
| `lib/orchestrator.js` | `taskType` 判定（`detectTaskType` / `resolveTaskType`）、`INVESTIGATION_PLANS`（S1–S4）、`planFor`、`synth` 阶段 |
| `lib/settings.js` | `normalizeTaskType`、`normalizePipelineGate` 支持 `auto`、`effectivePipelineGate`、默认 `taskType: 'auto'` |
| `lib/service.js` | `start` 落 `taskType` 快照；`record`/`finish` 用有效门禁；`testsRun` 形状在 record 阶段提前校验；`runSessions` 会话→运行 token 归集 |
| `lib/receipts.js` | `synth` 按 worker 契约校验；`testsProven` 增加 `testsPassed === false` 否决 |
| `lib/client.js` | 概览「通过率趋势」（近 7 / 近 30 天 + 7 天迷你柱条）；设置→高级「任务类型」三选一 |

## 结果

```
$ npm run ci          # 干净 clone（b219c03 → 07cba42）
[check] 13 个文件通过（逐文件 node --check）
ℹ tests 373
ℹ pass 372
ℹ fail 0
[pack] 21 个文件；lib 模块 13 个齐全，无 test/docs/scripts/tgz 泄漏
```

## 安装 / 卸载

在 `/f/deepseekwork/.tmp-install-test` 的空工程里：

- `npm install dsh-token2biq-0.7.0.tgz` → `added 1 package`，`node_modules/dsh-token2biq/lib` 13 个模块齐全，逐文件 `node --check` 通过。
- 用宿主 `node_modules` 作 `NODE_PATH` 动态 import `lib/orchestrator.js` 成功，`generatePlan('S3',{taskType:'investigation'})` 得到 `research > synth > review > verify > regression`。
- `npm uninstall dsh-token2biq` → 目录消失、`package.json` 无残留键。

> ⚠️ 本机 `pnpm` 在 `registerProject` 阶段创建符号链接报 `EPERM`（`forceSymlink`）。这是 Windows 上 pnpm 全局 store 链接权限的环境限制，与本包无关：同样是这台机器，桌面 profile 里 0.6.3 的 pnpm 安装副本存在且 13 个 lib 与本仓库字节一致。

## 自检矩阵

`test/selfcheck-matrix.test.js` 覆盖 **S1–S4 × code/investigation** 共 8 条链路：按计划阶段逐个 `record`，再 `finish(PASS)`，全部通过。另外验证 S3 代码计划含 `generate`、S3 调查计划不含。

`test/investigation-tasktype.test.js` 9 例覆盖：类型判定（保守：出现代码动作词一律 code）、计划形态、`pipelineGate=auto` 的三分支、`synth` 契约、调查类在 strict 下可正常 `finish(PASS)`、以及代码任务的门禁**没有**被放宽。

## 发布产物

- tag `v0.7.0` → commit `07cba42`
- Release 资产：`dsh-token2biq-0.7.0.tgz`（123165 B）、`dsh-token2biq.tgz`（123165 B，供 `latest/download`）
- 下载回来的 tarball 与本地构建 md5 一致（`5d8b37eb67c6…`），解包后确认含 `INVESTIGATION_PLANS`、`effectivePipelineGate`、`t2biq-v3-task-type`、`runSessions`、`synth`

## dsh-market

条目 `data/plugins/SSRYLJRSS__dsh-token2biq.yml` 自 **2026-11-14** 起已在 `awesome-dsh-plugin/awesome-dsh-plugin` 的 `main` 上，分类 `workflow`；2026-11-15 更新过一次描述。本版**无需重新提交**——市场按仓库与 Release 解析安装源，0.7.0 的预构建 tarball 已就位。

## 已知限制（本版未变）

- 档位仍是「强提示 + 回执硬门禁」，不是内核级拦截。
- `taskType=auto` 是关键词判定，宁可误判为 code（更严格的流水线），也不误判为 investigation（会跳过实现阶段）。
- 面板趋势是纯前端按 `createdAt` 分桶，依赖 runs 列表本身完整。
## 独立评审（发布前）

0.7.0 候选版本在发布前交给一名**未参与实现**的评审代理复审 `b219c03..07cba42`。第一轮结论 **FAIL**，列出 7 项问题；全部修复后进入第二轮。

| # | 问题 | 修复 | 回归用例 |
| --- | --- | --- | --- |
| 1 | CODE_SIGNALS 漏收「优化/修改/调整/编写/添加/集成/调试」，会把代码任务判成调查任务而跳过 generate | 补齐中英文代码动词 | 评审回归：代码动词必须覆盖… |
| 2 | 设置面板把非 strict 折成 off，用户设的 auto 保存一次即被改回 | v3ToDraft 保留 auto + 新增 auto 单选/说明 | 面板渲染冒烟 |
| 3 | 工具 schema 缺 taskType，testsRun 只收 string | schema 增加 taskType enum；testsRun.items 改 anyOf string/object | check 逐文件语法 |
| 4 | INVESTIGATION_PLANS.S3 的 judge/redteam 只在 optionalStages、未进 stages（死配置） | stages 补齐 7 阶段，maxAgents 7 | S3 调查计划在 risk=high 下能展开 judge/redteam |
| 5 | 多候选调查运行无法 finish(PASS)：judge 只从 generate 收候选 | 候选来源改为 generate 或 synth | 多候选调查运行可 judge 择优并 finish(PASS) |
| 6 | README / CHANGELOG 被回退到 0.6.2（0.6.3 条目丢失） | 以 b219c03 的 0.6.3 文档为基线重做 0.7.0 增量 | grep 0.6.3 CHANGELOG.md 仍命中 |
| 7 | synth 缺角色映射、planFor 忽略 taskType、未知阶段提示未列 synth | 分别补齐 | synth 回执使用 synthesizer 角色 / planFor 能按 taskType 出计划 |

修复后：`npm run ci` → 373 例（372 pass / 1 skip / 0 fail）、check 13 文件、pack 21 文件。
