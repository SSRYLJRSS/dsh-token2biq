# Token 2b IQ 0.5.0 升级设计：与官方 Agent Teams 合并

> 目标：DSH 0.2.2-rc.3 / 插件 0.4.3 → 0.5.0 · 状态：**P0 已实施并验证（140 测试全绿）**，P1–P3 待做（见 §12）
> 依据：官方包源码实读（app.asar 解包）+ 本机实测（run_mwirim7m_1）

## 0. 一页纸结论

0.2.2-rc.3 把「多智能体」从社区插件自造提升为平台一等公民，同时**删除了插件赖以生存的三个 API**。

| 插件依赖 | 0.2.2-rc.3 | 后果 |
|---|---|---|
| `ctx.agentTeams.tryMembership` | **已删除** | 系统提示段永不注入；autoSpawn 静默返回 null |
| `ctx.agentTeams.listMembers` | **已删除** | 常驻队员复用失效（被 try/catch 吞掉） |
| `ctx.agentTeams.spawnTeammate` | **已删除** | 建团能力归零 |
| `createTask(caller,{subject,description,blockedBy,writeScopes})` | 保留 | 签名不变 |
| `subagent/model-selection-policy` 事件 | 保留 | schema 不变 |

**插件不是过时，而是底座被换掉了。** 正确做法不是修补 spawn，而是**把编排下沉给原生 workflow 引擎，插件上收为「意图层 + 策略层 + 记账层」**。

## 1. 现状断点（实测）

`token2biq action=start {mode:'S2'}` 返回 `orchestrated:false`，`created` 缺失，`next` 仍指向已不存在的 `spawn_teammate`。
根因：`autoSpawn` 第 322 行 `tryMembership` 抛错被吞 → `m=null` → `return null`。
代码中 `spawn_teammate`/`tryMembership`/`listMembers` 共 18 处（lib）+ 19 处（README）；135 个测试全绿是因为 mock 了真实宿主 API，形成盲区。

## 2. 原生能力契约（0.2.2-rc.3）

### 2.1 Team 执行层（`ctx.agentTeams`）

```ts
isEnabled(caller: Agent): boolean
setEnabled(agent, enabled, signal?): Promise<void>
createTask(caller, { subject, description, blockedBy?, writeScopes? }, signal?): Promise<TeamTaskView>
getTask(caller, id): TeamTaskView        // 同步
listTasks(caller): TeamTaskView[]        // 同步
updateTask(caller, { taskId, expectedRevision, action, ... }, signal?): Promise<TeamTaskView>

type Action = 'claim'|'release'|'edit'|'set_dependencies'|'complete'|'reopen'|'reassign'|'delete'
interface TeamTaskView {
  id; revision; subject; description
  status: 'pending'|'in_progress'|'completed'|'deleted'
  owner?: string                      // ownerName ?? ownerId
  blockedBy: string[]; writeScopes: string[]
  ready: boolean                      // pending 且所有 blocker 已 completed
  writeScopeWarnings: string[]        // 仅与 in_progress 邻居重叠时告警
}
```

领域不变量：
- `TeamId === root SessionId`；`root = ctx.subagents.rootOf(caller)`（不信任自报）。
- 每 root 一条 promise 尾链串行化读写（CAS 线性化前提）。
- `revision` 从 1 起连续递增；写前 `sessions.flush()`，失败抛 `TEAM_TASK_PERSISTENCE_UNCONFIRMED`（**任务已存在，重试前必须先读**）。
- `team/task` 事件隐式 `enabled ??= true`。
- 权限：`reassign` 仅 Lead；其余 action = Lead ∪ owner；`claim` 任何成员可抢 ready 任务。
- 关闭 = 保留一切、仅不可见；已排队未开始的 mutation 被 `TEAM_DISABLED` 拒绝。
- 文件系统**零隔离**，writeScopes 只是建议。

模型面工具（**snake_case**，与 service 的 camelCase 不同）：

| 工具 | 参数 |
|---|---|
| `team_task_create` | `subject`\*, `description`\*, `blocked_by[]`, `write_scopes[]` |
| `team_task_list` | `status`, `owner`, `unowned`, `ready`, `cursor`, `limit`(1..100) |
| `team_task_get` | `task_id`\* |
| `team_task_update` | `task_id`\*, `expected_revision`\*, `action`\* |

配置：`maxTasks` 256、`defaultEnabled` false。**已删除键（`maxMembers`/`maxMessageBytes`/`interrupt` 等）加载期直接抛错。**

### 2.2 Subagent 层

```ts
subagent(description, prompt, { name?, cwd?, agent_preset?, provider?, model?, reasoning_effort? })
subagent_fork(...)   // 继承父日志前缀；**不接受 model 选择参数**（KV cache 复用）
list_agents() / send_message({agent, message}) / wait_agent({timeout_ms}) / interrupt_agent({agent})
```

- spawn 支持 `provider/model/reasoning_effort`；fork 不支持。
- `wait_agent` 只等 inbox 输入；**任务板变更不唤醒**，需显式 `send_message`。
- 冷成员不自动恢复。

### 2.3 编排层（`workflow` 工具 / `ctx.workflowEngine`）

```ts
workflow({ script, meta:{name,description,whenToUse?,phases?}, args?, run_in_background? })
```

| 钩子 | 语义 |
|---|---|
| `agent(prompt, {label?, phase?, schema?, provider?, model?})` | 跑一个子代理至完成；带 `schema` 返回**校验后的对象**，失败返回 `null` |
| `pipeline(items, ...stages)` | 每项独立穿阶段，**无栅栏**（首选） |
| `parallel(thunks)` | 并发后统一等待（栅栏） |
| `phase(title)` / `log(msg)` / `args` | 进度与入参 |

- 并发上限默认 `min(16, max(1, cores-2))`；单 run `agent()` 上限 1000。
- 脚本无 fs/网络/定时器，只能通过 `agent()` 让子代理干活。
- 返回 `{runId, agentsStarted, result}`；后台模式返回 `{jobId, runId}`。

### 2.4 人机回路

- **Plan mode**：`/plan` 进入；系统提示段 order 500；`exit_plan_mode(planMarkdown)` 提交用户审批。
- **`ask_user_question`**：`ctx.userQuestions` seam（`dsh-user-questions` + `dsh-tool-ask-user` + `dsh-client-ui-user-questions` composer takeover）。

## 3. 目标架构：五层职责切分

```
用户大白话
   ▼
L1 意图层  (新增 clarify.js)     歧义检测 → ask_user_question → spec{goal,acceptance,constraints,risks}
   ▼
L2 策略层  (现有 orchestrator)   档位 S1–S4/Auto → stages[] + 角色 + 模型池（纯函数）
   ▼
L3 编译层  (新增 compile-workflow) plan+playbook → 确定性 JS 脚本（含 schema/模型路由/phase）
   ▼
L4 执行层  (原生)                workflow agent()/pipeline()/parallel() + team_task_* 任务板
   ▼
L5 记账层  (现有 record/finish)   回执校验 · 门禁 · token 台账 · 报告 · 面板
```

**一句话：插件不再建团，而是出剧本 + 记账。**

## 4. 关键设计决策

### D1 档位编译成工作流脚本（不再 spawn）
`S2` → `['plan','generate','review','verify']` → 脚本：

```js
phase('计划')
const plan = await agent(args.goal + '\n给出任务分解与验收标准', { label:'planner', phase:'计划', schema: PLAN_SCHEMA })
phase('实现')
const draft = await agent('按计划实现：' + plan.steps.join('；'), { label:'worker', phase:'实现', model: args.genModel })
phase('评审')
const verdicts = await parallel(args.reviewers.map((m, i) => () => agent(
  '独立评审，只报问题：' + draft, { label:'reviewer-'+(i+1), phase:'评审', model: m, schema: VERDICT_SCHEMA })))
phase('验证')
const verify = await agent('独立复验并给出测试命令', { label:'verifier', phase:'验证', schema: VERIFY_SCHEMA })
return { plan, draft, verdicts, verify }
```

收益：确定性、结构化、原生模型路由、原生进度 UI、可重放、不依赖模型"记得按流程走"。

### D2 任务板：强绑定 → 镜像 + 校验
`start` 时插件直接 `ctx.agentTeams.createTask`（camelCase）建阶段任务，`taskId` 写进 run；
`record` 时 `getTask` 校验 `status==='in_progress'` 且 `revision` 匹配，冲突则重读再写。

### D3 澄清复用 plan-mode 语义
不造第二套 plan：S3/S4 建议用户 `/plan`；插件 `clarify` 只负责提问清单（`ask_user_question`），产出 `spec` 落进 `run.spec`。

| 档位 | 最多问题 | 必答项 |
|---|---|---|
| S1 | 0–1 | 仅阻塞性歧义 |
| S2 | 1–2 | 目标 + 验收标准 |
| S3 | 2–3 | + 约束/不做什么 |
| S4 | 3–4 | + 风险与回滚 |

### D4 门禁：运行期校验 → 编译期保证
`pipelineGate=strict` 时，`generate` 前必须有 `plan` 且带 `acceptance`、`verify` 必须带 `testsRun` 字段；
不合规根本生成不出脚本（`CompileError`），运行期只留兜底。

### D5 提问通道
```
teammate 受阻 → send_message(lead,{blocked:true,question,options?})
           → lead 调 ask_user_question
           → 用户回答 → lead send_message(teammate, answer) → 继续
```
插件职责：定义 `blocked` 回执 schema，`record` 时升格为 `run.escalations[]`。

### D6 能力协商与渐进降级
```ts
type Capabilities = { team: boolean; workflow: boolean; subagents: boolean; userQuestions: boolean }
```

| 组合 | 行为 |
|---|---|
| team + workflow + subagents | 全量：编译脚本 + 任务板 |
| subagents（无 workflow） | 退化为「手册 + 手动 subagent 编排」 |
| 仅 tools | 只记录，`orchestrated:false` + `degraded:'no-orchestration'` |
| 无 userQuestions | 澄清降级为一次成文提问 |

**任何降级都必须显式返回 `degraded` 原因，禁止静默。**

### D7 模型路由
复用 `collectModelRoutes` → `subagent/model-selection-policy`；编译期把 `playbook.steps[].model` 直接写进 `agent(..., {provider, model})`。

### D8 面板
任务板改用 `team_task_list` 数据；工作流进度对齐 `phase()` 标题；IQ 下拉补「本档预计 agent 数 / 成本权重」；降级时显示黄条。

## 5. 模块改造清单

| 文件 | 改动 |
|---|---|
| `lib/index.js` | `ctx.inject` 增加 `subagents`/`userQuestions`/`workflowEngine`；P202 换判定；`degraded` 透传 |
| `lib/service.js` | P322/P329/P371 重写；`start` 改为「建任务 + 编译脚本 + 返回 script」；`record` 增加 `teamTaskId` 存在性与 revision 校验 |
| `lib/orchestrator.js` | `STAGE_TEAM.writeScopes` 补齐；`buildPolicy` 文案全量替换 |
| `lib/compile-workflow.js` | **新增**：plan+playbook → JS 脚本字符串（schema 常量、模型路由、phase 标题） |
| `lib/clarify.js` | **新增**：歧义检测 + 按档位生成问题清单 |
| `lib/receipts.js` | 增加 `blocked` 回执与 `escalation` 校验 |
| `lib/settings.js` | 新增 `clarify: 'auto'|'off'`、`orchestrator: 'workflow'|'manual'|'off'` |
| `lib/client.js` | IQ 下拉补档位说明；面板加 phase 进度条；降级黄条 |
| `README.md` | 19 处 `spawn_teammate` 全替换；新增「首次安装四步」 |

## 6. 验收标准

1. `start {mode:'S2'}` 返回 `orchestrated:true` + `created:{tasks,script}`。
2. 脚本在 `workflow` 下跑通，产出 `{plan,draft,verdicts,verify}` 四个结构化结果。
3. `record` 带 `teamTaskId` 校验通过；不带时按 `forceTeam` 拒绝。
4. `strict` 且无 `acceptance` 时 `start` 抛 `CompileError`。
5. 三个已删 API 全仓 0 引用。
6. 新增契约测试：TeamService 形状断言 + workflow 脚本快照测试。
7. 无 `ctx.agentTeams` 时返回 `degraded:'no-team'` 而非抛错。

## 7. 分阶段实施

| 阶段 | 内容 | 产出 |
|---|---|---|
| **P0**（1 天） | 换掉三个已删 API + 文案替换 + 降级透传 | 恢复「能建团」 |
| **P1**（2–3 天） | `compile-workflow.js` + `start` 改造 + 契约测试 | 确定性编排 |
| **P2**（1–2 天） | `clarify.js` + `blocked` 回执 + 提问通道 | 人机回路 |
| **P3**（1 天） | 面板/下拉/README/首次引导 | 体验闭环 |

## 附：错误码速查

```
TEAM_DISABLED   TEAM_TASK_NOT_FOUND   TEAM_TASK_STALE_REVISION   TEAM_TASK_ALREADY_CLAIMED
TEAM_TASK_BLOCKED   TEAM_TASK_UNAUTHORIZED   TEAM_LEAD_REQUIRED   TEAM_MEMBER_NOT_FOUND
TEAM_TASK_HAS_DEPENDENTS   TEAM_TASK_DEPENDENCY_CYCLE   TEAM_INVALID_WRITE_SCOPE
TEAM_INVALID_ARGUMENT   TEAM_TASK_LIMIT   TEAM_TASK_PERSISTENCE_UNCONFIRMED
```

## 12. 实施状态（P0 已完成，2026-11-16）

### 12.1 改动清单

| 文件 | 改动 |
|---|---|
| `lib/index.js` | `teamRoleOf()` 改用 `agentTeams.isEnabled` + `subagents.rootOf`；新增 `ctx.inject(['subagents'])`；启动打印「宿主能力自检」 |
| `lib/service.js` | `autoSpawn` → `autoBoard`（**只建任务板 + 产出 `briefing[].delegation`，不再 spawn**）；`startWithAuto` 改调 `autoBoard`；`next` 文案更新；`autoSpawn` 保留为兼容别名 |
| `lib/orchestrator.js` | 规则/playbook 文案：`spawn_teammate` → `subagent`（含「subagent 可显式传 provider/model」） |
| `lib/run-store.js` | 注释：`owner` = `subagent` 的 `name` |
| `test/*` | `tier-policy` / `proactive` / `proactive-wiring` 的 fake 宿主迁移到 `isEnabled + rootOf + createTask`；删除已无意义的「复用常驻队员」用例，新增 F8a–F8d 契约用例 |
| `test/api-contract.test.js` | **新增**：静态断言 lib/ 不再引用已删除 API，且只通过 `isEnabled/createTask/rootOf` 调用宿主 |

### 12.2 验证

- `node --test test/*.test.js` → **140 pass / 0 fail**（含新增 3 条契约测试）
- 契约比对（`DSH_OFFICIAL_SRC` 指向官方解包源码）：`agentTeam.isEnabled` / `agentTeam.createTask` / `subagents.rootOf` 三个接缝均真实存在
- 版本：`package.json` 0.4.3 → **0.5.0**

### 12.3 行为变化（重要）

1. 插件**不再自己 spawn 队员**。`start` 返回 `created.briefing[]`，每条形如：

   ```json
   { "stage": "generate", "role": "generator", "name": "generate-generator", "taskId": "<共享任务 id>",
     "delegation": { "description": "S3·generator·<目标>", "name": "generate-generator", "prompt": "<可直接喂给 subagent 的提示>" } }
   ```

   Lead 用 `subagent({ description, name, prompt })` 照抄启动，天然获得宿主侧的并发/深度/模型能力。
2. 需要模型的阶段**不再进简报**，改由 Lead 用 `subagent(provider/model)` 直跑（`record` 时带同一个 `model`）。
3. 若宿主未注入 `subagents`，Lead 判定退化为「是成员即 Lead」——此时**所有**成员都会被注入 Lead 规则段（已知降级，自检日志会提示）。

### 12.4 P1 / P2 已完成（145 测试全绿）

| 项 | 实现 |
|---|---|
| P1 重试退避 | `autoBoard` 内新增 `withRetry`：**仅**对 `ECONNRESET/ETIMEDOUT/EAI_AGAIN/EPIPE/UNAVAILABLE/overload/rate-limit/5xx` 退避重试（150ms×n，最多 3 次）；**其他错误立即失败**——`createTask` 非幂等，盲目重试会在任务板上留重复任务 |
| P1 能力探测 | `created.capabilities = { teamTasks, leadGate, writeScopesDeclared }`，面板/日志可见，降级不再静默 |
| P1 Lead 门禁 | 工具 `start` 的 `ctxInfo` 补传 `subagents`——修复「任何队员都能建板」的越权缺陷（新增用例） |
| P2 结构化交接 | `_handoff(run, stage)`：把上游已完成阶段的 `files / diffSummary / verdict / openIssues` 汇总成 `briefing[].handoff`，并注入 `delegation.prompt` 的「交接（上游产物）」段 |

### 12.5 剩余（P3）

- **P3**：成本闸门（预算 80% 收敛 / 100% 熔断落到 `autoBoard`）；可观测性（事件流落盘）

## 13. 0.5.0 细节打磨（独立审查落地）

两位只读审查员（静默失败 + 用户可用性）各出 5–6 条，**全部为真实缺陷**，已全部修复并加测试（151 测试全绿）。

### 13.1 静默失败类

| # | 位置 | 缺陷 | 修复 |
|---|---|---|---|
| 1 | `client.js` choose() | 关闭/切档 POST 失败被 `.catch(()=>{})` 吞掉，UI 显示「已关闭」但服务端从未写入 → 照常编排烧 token | 捕获后**回滚**开关与档位，并 `console.warn` 原因 |
| 2 | `service.js` autoBoard | 5 处 `return null` 不带原因；调用方把「未知」硬解释成「本次没有常驻队员」，把宿主缺 API / 未开 Team / 身份脱离全伪装成正常态 | 统一返回 `{ok:false, reason}`，调用方写出真实原因 + 回退提示 |
| 3 | `run-store.js` load() | 快照损坏时静默清空，随后写操作把空状态原子覆盖回磁盘 → 历史运行/回执全丢且无从察觉 | 非 ENOENT 时 `console.warn` + 备份 `.corrupt-<ts>` 再重置 |
| 4 | `settings.js` _load() | 设置损坏静默回默认，`forceTeam`/`pipelineGate`/`allowModels` 门禁静默翻转 | 同上：告警 + 备份 |
| 5 | `index.js` teamRoleOf | 4 种语义不同情况统一 `return null`，该 agent 永远拿不到档位提示且无日志 | `isEnabled`/`rootOf` 抛错时 `warnProbe` 只打一次，「非成员」仍静默 |
| 6 | `index.js` compactToolResult | 截断兜底硬编码 `ok:true`，把失败结果洗成成功 | 保留 `result.ok !== false` |

### 13.2 用户可用性类

| # | 位置 | 缺陷 | 修复 |
|---|---|---|---|
| 7 | `client.js` 保存设置 | 面板无白名单控件，保存时却固定发 `allowModels: []` → 用工具配好的白名单被一次「保存」无声抹掉 | 保留 `draft.allowModels/reviewModels` |
| 8 | `report.js` | 报告只有 token 流水，无法自证「真建团队 / 真走异构多模型」 | 补 建板状态 / 宿主能力 / 预算闸门 / 实测用量 / 模型路由 |
| 9 | `report.js` + `taskView` | 估算 token 与实测 token 长得一样，注脚承诺「标注为估算」但从未标注 | `taskView.estimated` 透出，报告行尾加「（估算）」 |
| 10 | `index.js` action=state | `current` 缺 `paused/pauseReason/ledger/real/orchestrated/capabilities/budgetGate` | 全部补齐 |
| 11 | `service.js` `runView` | **从未暴露 `tasks`**，导致 `action=state` 永远 `taskCount:0 / tasks:[]` | `runView` 补 `tasks` |
| 12 | `service.js` taskView | 入参 `stage`、出参只有 `kind`；`diffSummary` 被折进多义的 `summary` | 回显 `stage` + `diffSummary` |
| 13 | `service.js` 四处 runId 守卫 | 未传 runId 直接吐「找不到运行 undefined」 | 单独分支：「缺少 runId：…run.id（形如 run_xxx）」+ 工具描述补说明 |

### 13.3 其它打磨

- **任务标题占位符**：`[S3] 调研：<目标>的现状/约束/证据` → 实际目标（`_fillGoal`，>60 字截断加 `…`）。任务板上不再出现字面 `<目标>`。
- **`next` 文案去重**：模型路由说明原在 `cappedNote` 与 `startWithAuto` 各写一遍，已移除前者。

### 13.4 验证

```
ℹ tests 151   ℹ pass 151   ℹ fail 0
```

独立 smoke（`apply(ctx)` 直连真实 ctx 契约）确认：
```
STATE taskCount=1 stage=research diff=调研完成：3 个约束 est=false
STATE paused=false ledger=yes orch=true caps=yes
REPORT 建板=true 能力=true 模型路由=false
MISSING={"ok":false,"error":"缺少 runId：请先 action=start，再传它返回的 run.id（形如 run_xxx）"}
```
