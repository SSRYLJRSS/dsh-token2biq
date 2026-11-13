# Token 2b IQ · v2 全面设计（2026-11-04）

> 目标：在「同一模型 + 多代理 + 多轮互审 + 真实验证」的基础上，加入**可配置模型 / 跨厂评审 / 预算护栏 / 更好面板**，并与官方 Agent Teams **联动而非重复造轮子**。

## 0. 一句话定位
Token 2b IQ 是「项目经理 + 记账本」：它决定**干多少、谁评审、花多少、达没达标**，真正干活交给官方 Agent Teams（spawn_teammate / team_task_* / send_message / wait_agent）或 subagent。

## 1. 业界对标结论（researcher 调研）
- **同模型自评有系统性 self-preference，强模型自己出错时 harmful bias 更强**（arXiv 2504.03846、Arize 实测）→ 评审/裁判必须与生成**不同厂商**。
- 闲聊式多模型辩论常输给单 agent，**只有异构模型（Heter-MAD）才提升**（arXiv 2502.08788）；组合增益有天花板 1−β（arXiv 2606.27288）。
- 难度路由可省 ~85% 成本保 95% 质量（RouteLLM）；MoA/PoLL：异构小模型 panel > 单个大 judge 且更便宜。
- 代码评审产品（CodeRabbit/Bugbot/Qodo/Copilot）：**严重度分级 + nit 折叠 + finding 必带文件/行号/片段**。
- 成本护栏：**每 run token ledger + 软 80% 降级 / 硬 100% 停 + 模型分级 + 白名单**（LiteLLM / automatic.co）。
- Dashboard 标配：run 树（每步 tokens/cost）、预算进度、通过率趋势、模型对比、异常下钻。

## 2. 与本插件结合后落地的 6 条
1. **评审默认不同源**：设置 `requireDifferentVendor`（默认开）；`reviewModels` 评审池按顺序轮转。
2. **按角色指定模型**：`roleModels.{research,plan,generate,review,judge,verify,redteam,regression}`，每阶段 `provider::model`。
3. **模型白名单**：`allowModels` 为空=不限制；非空时仅这些模型可被选用，playbook 里越界模型自动退回「继承默认」。
4. **预算双阈值**：`baseBudgetTokens`（档位基数，实际 = ×2/×5/×10）+ `runBudgetTokens`（>0 统一硬上限覆盖）；`softRatio=0.8` 预警、`hardRatio=1.0` 熔断。
5. **结构化交接**：回执按阶段分派校验（research/plan 免 files，judge/redteam 用 verdict）。
6. **面板值得点开**：运行记录 + 概览（运行数 / 累计 token / 一次通过率）+ 设置页（模型/预算/白名单/评审策略）。

## 3. 数据模型
### settings.json（`~/.dsh/token2biq/settings.json`）
```
{
  version: 1,
  defaultMode: 'Auto'|'S1'|'S2'|'S3',
  baseBudgetTokens: 50000,
  runBudgetTokens: 0,          // >0 覆盖档位倍率
  softRatio: 0.8, hardRatio: 1.0,
  allowModels: ['provider::model', ...],   // 空=不限制
  roleModels: { research:null, plan:null, generate:null, review:null, judge:null, verify:null, redteam:null, regression:null },
  reviewModels: ['provider::model', ...],
  maxReviewers: 2,
  requireDifferentVendor: true,
  independentReview: false
}
```
模型引用统一 `provider::model`（provider=modelCatalog.groups[].id，model=模型 id），见 `parseModelRef`。

### 运行态（state.json，沿用）
Run{ id, mode, requestedMode, goal, status, plan, stages[], tasks[], reviews[], verdict, ledger, paused, escalations[], failStreak }。

## 4. 模型联动（真·按角色选模型）
- 官方 `agentLoop.createAgent(ownerCtx, { ..., agentOptions:{provider, model, reasoningEffort?, maxTokens?} })` 与 `subagents.startActivation({ ..., request:{ agentOptions } })` 都支持 `AgentOptions{provider,model}`。
- 因此两种落地：
  - **建议式（默认）**：`buildTeamPlaybook` 给每步 `model` 字段，主模型在 spawn 队员时按此选模型/预设。
  - **强制式（`independentReview=true`，路线图）**：插件用 `agentLoop` 直接拉起指定模型的独立评委，绕开「自报回执」，输出结构化 verdict。
- 模型目录由宿主 `sessionController.modelCatalog()` 提供，插件 `GET /token2biq/models` 归一化成 `{ref, provider, providerName, id, name, description, reasoning}` 给面板。

## 5. 预算护栏
- 现有 `checkBudget(spent,budget)`：≥80% warn、≥100% exceeded→暂停。
- 新增 `baseBudgetTokens`（设置页可改）+ `runBudgetTokens`（统一硬上限覆盖档位倍率）。
- 熔断只暂停后续阶段、交付现状，不会静默超支（对齐 automatic.co 建议）。
- 白名单 + 按角色模型，防止模型被「随手换成最贵的」。

## 6. 面板（client.js）
- 顶部双标签：**运行记录** / **设置**。
- 运行记录：概览统计卡（运行数 / 累计 token / 一次通过率）+ 现有运行卡片（档位/额外做了什么/结论/token/时间/流程）。
- 设置：默认档位、预算基数、统一硬上限、评审策略（不同源 / 独立评委 / 评审数）、按角色选模型、评审池多选、允许模型白名单；保存即 POST `/token2biq/settings`。
- 模型下拉数据来自 `/token2biq/models`；无目录时提示「宿主 sessionController 未就绪（需重启 DSH）」。

## 7. HTTP / 工具接口
| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | /token2biq/state | 面板全量（含 settings、runs、liveUsage、current） |
| GET | /token2biq/settings | 读设置 |
| POST | /token2biq/settings | 改设置（持久化） |
| GET | /token2biq/models | 模型目录（provider::model） |
| GET | /token2biq/export | 导出 Markdown |
| POST | /token2biq/{mode,pause,config,action} | 档位/暂停/旧配置/工具动作 |
- 工具 `token2biq` 新增 `action=settings`（读设置；带 settings 对象则写）。

## 8. 与官方 Agent Teams 的关系（不重复造轮子）
- **身份**：插件=策略层（档位/计划/预算/台账/看板）；Agent Teams=执行层（建队员/共享任务/DAG/消息）。
- **绑定**：每阶段映射一个共享任务 + 一个角色队员；`record` 回传 `teamTaskId`/`owner` 使「任务板↔台账」一一对应。
- **并行约束**：共享 cwd、无文件锁，generate 默认串行，writeScopes 互斥才并行；并行数 ≤ maxMembers(8)。
- **无冲突**：插件不注册 agent 运行时、不抢占团队工具；官方团队工具照常可用。两者是「经理」与「施工队」。

## 9. 文件清单
- 新增：`lib/settings.js`（设置存储/规整）、`test/settings.test.js`、`docs/DESIGN-V2.md`。
- 改动：`lib/paths.js`（resolveSettingsFile）、`lib/orchestrator.js`（buildTeamPlaybook 支持模型/评审池/白名单）、`lib/service.js`（接入 settings、planFor 预算、getSettings/updateSettings、state 暴露）、`lib/index.js`（/settings、/models、tool action）、`lib/client.js`（双标签 + 概览 + 设置页）、`package.json`（files 增 settings.js）。

## 10. 生效方式与路线图
- **生效**：host 侧 `lib/*.js` 改动需**完整重启 DSH**；`lib/client.js` 改动刷新页面即可（dev:web 或重启）。
- 路线图：① `independentReview=true` 用 `agentLoop` 真跑异源评委；② 严重度分级（blocker/major/nit 折叠）与 finding 证据字段；③ 通过率/成本趋势图；④ 每 run 归因标签与异常下钻。
