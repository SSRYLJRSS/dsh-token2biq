# Token 2b IQ · 历史回顾与优化记录（2026-11-03）

本次基于真实运行数据 `C:\Users\33887\.dsh\token2biq\state.json` 回顾插件运作，发现并修复以下问题。

## 一、发现的问题（回顾历史/日志）

1. **实时 token 数字严重误导**：面板「实时 token 102.7M / 670 次模型调用」来自宿主 `llm/stream` Tap 的**全进程累计**（含本对话自身的 670 次调用、99.9M 缓存读），并非本插件开销；本插件真实运行成本只有 954 tok（S3）/1650 tok（演示）。
   - 修复：统计卡改为「本插件累计 token」「本次运行 token」；全进程数降级为页脚「诊断用」并明确标注「含全部对话，不代表本插件开销」。
2. **阶段状态数据不一致**：历史运行（旧版服务写入）`stage.status` 永久停在 `running/pending`，看板在没有任何任务时仍显示「进行中」。
   - 修复：`service.runView` 改为从任务派生有效状态（`effStageStatus`：有失败→失败；任务全完成→完成；有完成→进行中；运行已结束且无任务→跳过）；`finish` 收尾 pending→跳过、running→完成。
3. **演示运行标注「可删除」却没有删除入口**。
   - 修复：新增 `delete` 动作（工具/HTTP 均可）+ 历史表「删除」按钮；`runs` 摘要补充 `verdict` 字段。
4. **面板不够直观**（普通人要自己拼阶段、token、结论）。
   - 修复：新增「最近一次运行」故事卡：目标 / 档位含义 / 协作代理数 / 本次 token / 结论 / 裁决理由 + **按发生顺序的流程时间线**（每步：中文阶段名、角色、状态、token、一句话说明）+ **用/不用本插件对比**卡。
5. **缺少历史对比入口**。
   - 修复：新增「历史运行」表（时间 / 档位 / 目标 / 状态 / 结论 / token / 删除），点击任一行即可切换查看。
6. **token 固定开销**：工具 schema 已从 3197B 精简到 1429B（≈360 tok），低于 NFR「插件开销 <2k tok/轮」上限（已达标，面板展示该指标）。

## 二、真实数据佐证（run_mw07bw9s_b · S3 只读维护审计）

- 代理 7 个：研究 / 计划 / 生成 / 评审 / 裁决 / 红队 / 回归
- 评审 1 次 PASS；红队 1 次；独立验证/回归 1 次；裁决 PASS
- 本运行 token 954（输入 574 / 输出 380），预算上限 500000（0.2%）
- 结论：PASS（五份报告落盘、11 项门禁 exit 0、cargo test 1366 passed/0 failed、19 项事实核查、21+8 项红队均已处理、未改任何源码）

## 三、验证

- `node --check lib/*.js` 通过
- 单测：orchestrator / budget-guard / receipts / service.integration = 25/25；新增 service.view = 4/4（共 29）
- smoke-load 11/11、smoke-tool 13/13、smoke-usage 5/5
- **新增 render-smoke 16/16**：用极简 React 桩真实调用 client.js 导出的展示组件，验证「最近一次运行故事 / 历史运行 / 阶段明细 / 台账」在真实数据结构下渲染出预期文案且不抛错；并断言统计卡不再出现误导性的 `102.7M`。
- `service.state()` 实测：S3 运行 7 阶段全部派生为 done；演示运行 plan=skipped；delete 动作正常

---

# 第二轮优化 · 与官方 Agent Teams 对齐（2026-11-04）

背景：DeepSeek Harness 官方已内置多智能体团队（`dsh-experimental-agent-team`，工具 `spawn_teammate / team_task_create / send_message / wait_agent / team_task_* / list_agents / interrupt_agent`）。Token 2b IQ 定位为**编排策略/记账/展示层**，执行层应交给官方团队原语，二者不是竞争而是「大脑 vs 手脚」。本轮把插件从「假设执行者是 subagent/workflow」改为「对齐官方 Agent Teams」，并修复 3 个实质缺陷。

## 对齐改动

1. **团队执行手册 `buildTeamPlaybook(plan)`（orchestrator.js）**：把每个档位流水线映射为官方团队步骤——每阶段 1 个共享任务 + 1 个角色队员，给出 `role / parallel(fan-out|serial) / subject / doneWhen / writeScopes`，并声明团队规则（`spawn_teammate`→`team_task_create`→`send_message`→`wait_agent`；并行数不得超 `maxMembers=8` 含 Lead；写锁缺失须 writeScopes 互斥；预算 80% 收敛/100% 熔断）。`start` 与 `action=map` 返回该手册。
2. **工具描述与 help 改为团队优先**（index.js / service.js）：TOOL_DESCRIPTION 与 help 明确「执行用 Agent Teams」，不再说 subagent/workflow；参数新增 `teamTaskId`、`owner`，动作新增 `map`。
3. **台账↔任务板绑定**（run-store.js / service.js）：`addTask` 持久化 `teamTaskId`（共享任务 id）与 `owner`（队员 target）；`taskView`/报告回显，使每次 token 记账都能对应到官方任务板的一行。

## 缺陷修复

4. **S3 回执 schema 错配（receipts.js）**：原先 research/plan/judge/redteam 被当作 worker 强制要求 `files+diffSummary`，导致 S3 只能靠塞假的 files 才跑通（历史 run_mw07bw9s_b 即如此）。现按阶段分派：`research/plan→validateNoteReceipt`（需 summary/diffSummary，files 可选，支持 findings/sources）；`judge/redteam→validateVerdictReceipt`（需 verdict，FAIL 需 issues，files 可选，支持 rationale）；`generate→worker`；`review`；`verify/regression`。
5. **闸门升级「假升级」（run-store.js applyEscalation / service.js）**：原先 S1/S2 连续 2 次评审 FAIL 只写一条 escalations 记录并提示，`run.mode/stages` 不变——面板仍停在原档。现在 `applyEscalation` 真正切换 `run.mode`、合并新档位计划并补足缺失阶段（S2→S3 补 research/judge/redteam/regression），旧计划中多余的 pending 阶段标 skipped。并修复一个引用别名 bug：applyEscalation 会原地改共享 run 对象，`from` 必须在调用前取值，否则升级记录写成「S3→S3」。
6. **成败判定统一**：`record` 中凡回执带 `verdict` 的阶段（review/verify/judge/redteam/regression）一律由 verdict 定 `status`（PASS→done，FAIL→failed），其余看 `status`，避免 judge/redteam FAIL 被记成 done。非法阶段（不在本 run 计划内）记录时返回 `warnings` 提示。

## 验证

- `node --test test/*.test.js` → **36/36 全绿**（新增 7 条：playbook、S3 免 files、teamTaskId/owner、真升级、map、note/verdict 回执分派等）。
- 兼容：旧 `addEscalation` 保留；`start` 新增 `playbook` 字段为增量返回，不破坏既有调用。

## 生效方式

- lib/*.js 为宿主代码，DSH 只在启动时装载（no-hmr）→ **改后需重启 DSH**（或重启 profile 会话）才在 GUI/工具中生效；单测直接跑源码，无需重启即可验证逻辑。

---

# 第三轮优化 · 删除预算限制 + 档位控消耗 + 强制联动开关（2026-11-04）

背景：用户判定「硬预算根本限制不了实际 token（尤其用官方 Agent Teams 时插件管不到队员用量），限制了反而断任务、导致失败」，要求删除预算功能；改用「档位参与角色数量」作为粗略的 token 控制手段；并评估把「与官方 Agent Teams 联动」做成强制选项。

## 改动
- **删除预算功能**：删除 `lib/budget-guard.js`（含 `checkBudget`/`WARN_RATIO`）；`settings.js` 移除 `baseBudgetTokens/runBudgetTokens/softRatio/hardRatio`；`orchestrator.generatePlan` 不再计算 `budget`，改为返回 `costWeight`（S1×2/S2×5/S3×10，仅展示）与 `stageCount`；`service.record` 删除预算熔断/自动暂停块；`runView`/`run-store.summary`/`report` 去掉 budget/pct；面板设置页移除预算输入，改为说明「档位=角色数量」。
- **档位控消耗**：`buildTeamPlaybook` 规则改为「本档 N 阶段、最多 M 并行代理，档位越高越费 token，这是粗粒度旋钮，不设硬上限」。
- **强制联动开关（forceTeam）**：`settings.forceTeam` 三态 `'auto'|'on'|'off'`，**默认 `'auto'`（仅 S2/S3 强制，S1 不强制）**。强制时 `service.record` 校验 `teamTaskId` + `owner`，缺失直接拒收；`start`/`playbook` 按当前档位提示。面板「设置」为三选下拉。用户拍板选「仅 S2/S3 强制」。
- 测试更新：删除 `budget-guard.test.js` 与预算熔断用例；新增 `forceTeam` 三态用例（含 S2 拒、S1 放行）；`node --test test/*.test.js` → **43/43** 全绿。

## 调研结论（是否应无条件强制团队）
- 高耦合任务并行收益有限、每次交互都产生 token 成本（IJCA shared-task-list）；多智能体在高耦合场景常无增益，确定性编排仅比单代理差约 1.11 分但开销约 +20%（Zenodo: Do Multi-Agent LLM Systems Actually Help?）。
- 结论：不建议对所有任务无条件强制团队（小任务/紧耦合会白烧）；本版默认「仅 S2/S3 强制、S1 不强制」，可在设置改「始终强制 / 从不」。

---

# 第四轮优化 · Auto 强制混合模式（2026-11-04）

背景：Auto 原为纯关键词+长度启发式，能判但不懂语义，中文无关键词的长任务易误判成 S1；用户要求「强制混合模式，不给用户太多选项」——即 Auto 固定为「关键词先筛 + 拿不准时低思考模型复核」，不暴露额外设置项。

## 设计
- `orchestrator.classifyDetailed(goal)`：在关键词打分基础上给出 `{tier, score, confident}`；`score <= -1 || score >= 3` 为有把握（明显小/明显大），中间 0..2 视为拿不准。
- Auto 流程：有把握 → 直接定档（零额外调用）；拿不准 → 调一次低思考模型复核；模型失败/超时/解析失败 → 回退关键词结果。分类只在 `start`/`plan` 跑一次，成本可忽略。
- 关键前提：不新增任何用户可见选项；Auto 的行为对用户透明，面板仅显示「自动→S2 · Auto 判定：模型复核」。

## 改动
- **lib/orchestrator.js**：新增导出 `classifyDetailed`；`classify` 改为委托它；`generatePlan(mode, opts)` 支持 `opts.resolvedMode` 覆盖 Auto 的分类结果（`PLANS[resolvedMode]` 校验）。
- **lib/service.js**：`start({goal,mode,resolvedMode,autoDecision})` 透传 resolvedMode 并把 `autoDecision` 落库；新增 `autoDecide(goal)`（启发式→可注入 `this.classifier`→兜底）、`startWithAuto(args)`、`handleToolAsync(args)`（仅 start 走异步，其余复用同步 handleTool）；`runView` 暴露 `autoDecision`。
- **lib/index.js**：新增 `makeLlmClassifier(ctx, log)` —— 走宿主 `llm.stream` 做一次性低思考补全（**不是起子代理**），路由优先 `agentDefaultModel.currentSelection()`，回退 `magpie` / `workbuddy/deepseek-v4.1-flash`，`reasoningEffort:'off'`、`maxTokens:220`、2.5s AbortController 超时、严格 JSON 解析；`apply` 里 `service.classifier = makeLlmClassifier(ctx, log)`；HTTP `/action` 与工具 execute 改用 `await service.handleToolAsync(...)`。
- **lib/run-store.js**：`summary()` 增加 `autoDecision`。
- **lib/client.js**：运行记录列表在 Auto 运行时显示「自动→S2」并在副标题标注「Auto 判定：模型复核/关键词」。
- **测试**：`orchestrator.test` 增 `classifyDetailed` 把握度与 `resolvedMode` 覆盖；`service.integration.test` 增「关键词拿不准→注入分类器复核→失败回退」「startWithAuto 采用复核档位并记录 autoDecision」。`node --test test/*.test.js` → **47/47**；smoke-load 11 / smoke-tool 13 / smoke-usage 5 / render-smoke 19 全绿。

## 说明
- 本环境 `llm` 服务无「轻量一次性补全」封装，但有 `llm.stream(GenerateOptions)`，直接用其做分类最省（无需建会话/子代理）；宿主 `llm` 不可用时静默回退关键词，绝不卡住主任务。
- 宿主侧改动（index/service/orchestrator/run-store）需重启 DSH 生效；client.js 刷新页面即可。

---

# 第五轮优化 · 侧栏图标 + 全面代码审查（2026-11-04）

## 用户反馈
- 侧栏图标外面有一圈框，其他插件图标没有；去掉框，并与其它图标统一大小。
- 全面复查项目与代码；检查与官方 Agent Teams 联动是否冲突；做整体优化（性能、省 token、提示词质量）。

## UI 改动
- `lib/client.js` `Token2bIQIcon`：删除自绘的圆角矩形外框 `<rect>`，只保留「三节点 + 连线」图标本体；节点由 x=8/16,y=8/16 撑到 x=6.5/17.5、y=7/17.5，半径 r 1.9→2.3，stroke 1.6→1.9，使图形填满 24×24 viewBox；尺寸继续使用 Slot 传入的 `size`（见 `SidebarPanelIconOwnerProps{size,active}`），与其它面板图标一致。

## 代码审查与修复
- **Auto 分类不污染实时 token**：`service.noteUsage` 增加 `if (this._classifying > 0) return;`；`makeLlmClassifier(ctx, log, service)` 在分类调用期间 `service._classifying++`、结束 `--`——路由开销不再计入用户「实时 token」。
- **`action=map` 同步设置**：原来调用 `buildTeamPlaybook(this.planFor(...))` 未传 settings，导致手册缺 roleModels/forceTeam/评审池；改为 `buildTeamPlaybook(this.planFor(...), this.settings.get())`，与 start 一致。
- **`state()` 限流**：`run-store.listRuns(limit)` 支持上限，`service.state()` 只回传最近 40 条摘要，避免每次 4s 轮询序列化全量历史（性能/内存）。
- **提示词**：`TOOL_DESCRIPTION` 明确「插件自己不跑 agent、执行用官方 Agent Teams、每阶段 record 带 teamTaskId/owner」，并列出 map/help/settings 等动作，减少模型误用。
- 验证：新增 `test/audit.test.js`（listRuns 上限、分类调用不计入实时 token、map 同步设置）；`node --test test/*.test.js` → **50/50**；smoke-load 11 / smoke-tool 13 / smoke-usage 5 / render-smoke 19 全绿；`node --check lib/*.js` 通过。

## 与官方 Agent Teams 的集成结论
- 二者是「编排/记账层」与「执行层」的分工，不重复造轮子：插件不 spawn 自己的 agent（Auto 分类只是一次性 llm.stream 补全，不是代理）。
- 唯一真实摩擦是「双重记账」：官方 team_task 任务板 与 插件 ledger 各自记录。forceTeam（S2/S3 默认）强制 record 绑定 teamTaskId/owner 把两边对齐；forceTeam 关闭时可能只在单侧记录。
- 工具命名无冲突；`llm/stream` 监听只读、分类调用已排除计量，不会干扰团队消息/工具。

---

# 第六轮优化 · 独立只读审查后的修复（2026-11-04）

对全项目做了一次独立只读审查（subagent），按「能不能用」的优先级修复：

## 已修（高优先级）
- F1 工具参数 schema 补齐 `summary/role/brief/targetTaskId/byJudge/settings`；此前 `additionalProperties:false` 会把这些字段拒掉，导致 research/plan 回执与 `action=settings` 不可达。
- F3 `action=state` 改回精简视图（最近 15 条运行摘要 + 当前任务最近 8 条），工具输出改为紧凑 JSON；超 12KB 时返回明确的 truncated 提示，而不是把 JSON 截成非法文本。
- F2 强制联动逃生通道：`record` 的 hint 增加 `token2biq action=settings {"forceTeam":"off"}`（配合 F1 的 settings 字段），纯模型会话也能降级。
- F5 `llm/stream` 监听对 `next()` 加保护并记录日志，避免观测侧异常打断用户主模型流。
- F6 Auto 分类器：`reasoningEffort` 由非法的 `'off'` 改为 `'none'`、超时 2.5s→8s、补 `purpose`，降低静默回退与孤儿 token。
- F8 `updateSettings` 不再重置当前会话档位（只更新默认值），修「改设置把已选档位打回 Auto」。
- F9 `record` 增加状态守卫：已结束（done）或暂停（paused）的运行拒绝继续记账。
- F12 设置 `defaultMode` 支持大小写/中文归一（auto/s3/自动 等）。
- F16 工具输出统一紧凑 JSON（省 15–30% token）。
- F20 回执校验：`status=failed` 的 generate 允许用 notes 代替 files；未知阶段给出明确报错。

## 暂未改（已知项 / 路线图）
- F4 持久化加载的版本迁移/逐条归一化（旧 state.json 若单条损坏仍可能让面板报错）。
- F10 每次变更同步全量写盘 + 多进程 last-writer-wins（建议去抖 flush / per-run 文件）。
- F11 live.sessions 无界增长与多分片 usage 重复计数。
- F14 本地 HTTP 端点无 Origin/CSRF 校验与 body 上限（仅 127.0.0.1，风险有限）。
- F15 面板 4s 全量轮询、StatsBar「累计 token」实为记账 token（与真实 liveUsage 口径不同）。
- F13 writeScopes 恒空、generate 串行与 README「S2 并行」表述不一致（待统一文案/默认写域）。
- F19 测试仍以桩件为主，未跑真实宿主 llm/stream waterfall 与 schema 校验。

验证：`node --test test/*.test.js` → 50/50；smoke-load 11 / smoke-tool 13 / smoke-usage 5 / render-smoke 19 全绿。

---

# 第七轮优化 · 全面复盘后的修复（2026-11-06）

用户反馈：「记录显示完全是坏的」「其它设置选项是否真的应用了不知道」。本轮做了源码级全面复盘，确认并修复：

## 根因（已由源码确认）
1. **记录是假的**：`record()` 在没有 `tokensIn/tokensOut` 时用 `estTokens(JSON.stringify(args))`（字符/4）造出几百 token 当记账；面板 `StatsBar` 把 `Σrun.spent` 当「累计 token」（约 2604）——既不是真实消耗，也远小于宿主 `liveUsage`（约 106M）。真实用量从未被面板渲染 → 用户看到假数、真数不可见。
2. **设置大半是装饰**：`roleModels/reviewModels/maxReviewers/allowModels/requireDifferentVendor` 仅作为文本注入 `buildTeamPlaybook`；`independentReview` 只设 step 标志、无任何执行（no-op）。真正硬生效的只有 `forceTeam` 与 `defaultMode`。
3. **档位重启静默重置**：`service.mode = config.defaultMode`，`setMode` 不落盘，重启即回 Auto。
4. **旧快照无迁移**（F4）：`plan` 残留 `budget/baseBudgetTokens/budgetX`，`stage.status` 停在 running/pending，全靠视图层 `effStageStatus` 掩盖。

## 已修
- **真实用量归集**：宿主 `llm/stream` 的 usage 在 `noteUsage` 中按「当前活动运行」（`currentRunId`，由 start 建立、finish/pause 清除）归集到 `run.real{input,output,cacheRead,cacheWrite,total,requests}`；flush 2s 节流；`live.sessions` 上限 64 剪枝。面板 `RunItem` 优先显示 `N tok`（真实），无真实则 `≈N tok（估算）` 并 tooltip 说明；`StatsBar` 改 4 卡：运行数 / 真实 token（实时）/ 回执上报（含估算）/ 一次通过率 + 实时明细行。**两口径分开，不混算。**
- **档位持久化**：`setMode` 经 `store.setMode` 写入 `state.mode`，重启沿用（修问题 3）。
- **设置落地**：`record` 在 `forceTeam` 校验后，对上报的 `model`（`provider::model`）做 **allowModels 白名单** 与 **requireDifferentVendor 跨厂商** 硬校验（未上报 model 则跳过，保持向后兼容）。设置页顶部新增「生效范围」说明：默认档位/强制联动=硬生效；白名单/跨厂商=上报 model 时硬校验；角色模型/评审池/最多评审数=写入执行手册的约束建议；agentLoop 独立评委=预留未落地。
- **旧快照迁移**：`RunStore.load()` 调 `_migrate()` 幂等升级到 `version:2`：补 `ledger/tasks/reviews/escalations/real/generateModel`；`plan.costWeight ← budgetX` 并删除 `budget/baseBudgetTokens/budgetX`；按 `tasks` 派生 `stage.status`（有 done→done；运行 done 且无任务→skipped）。
- **工具与 HTTP 细节**：`TOOL_PARAMETERS` 增 `model`；`readJson` body 上限 1MB（F14 部分缓解）。

## 验证
- 新增 `test/review-fixes.test.js`（8 条：真实归集/finish 停止、估算与真实分离、档位持久化、旧快照迁移、白名单硬校验、跨厂商硬校验、无 model 兼容、generatePlan 无 budget）。
- `node --test test/*.test.js` → **59/59 全绿**（原 50 + 新增 9）；smoke-load 11 / smoke-tool 13 / smoke-usage 5 / render-smoke 19。
- ⚠ 本轮改动了宿主 `lib/index.js`、`lib/service.js`、`lib/run-store.js`、`lib/orchestrator.js`：**必须完整重启 DSH 才在运行实例生效**；`lib/client.js` 与文档可页面刷新生效。

## 仍遗留（未在本轮处理）
- 已补（同轮追加）：F13 `writeScopes` 支持按阶段声明 + generate 未声明时给并行安全提示 + README S2「generate(parallel)」改为「默认串行」；F15 面板轮询 4s→8s 且数据未变不重渲染；F10 部分（flush 临时文件名带 pid+序号，避免并发抢同一 `.tmp` 损坏）。
- 仍遗留：F10 多进程 last-writer-wins（需外部文件锁/单写者）、F11 分片 usage 重复计数、F19 未跑真实宿主 llm/stream waterfall 的自动化测试（当前用桩件）。
- **真实用量归属口径**：当前按「运行活跃期间全进程 usage 计入 currentRunId」，非按队员/会话精确归属；同一时段其他对话会被一并计入。精确归属需「会话→run」映射（后续）。

## 第八轮 · 主动编排（B）：从「被动手册」到「自己建团队」（2026-11-06）

**背景**：用户指出插件设计意图是主动介入 Agent Teams、用 token 换成功率，但实测插件纯被动（仅注册工具 + 观测 usage，无提示注入、无自动 spawn）。

**可行性**：宿主 API 全开放（`agentTeams.spawnTeammate/createTask`、`systemPrompt.section`、`agent/created|disposed` 事件、工具 `execute(args,exec)` 带 `exec.agent`），可做真主动。

**改动**：
- `orchestrator.js`：新增纯函数 `buildRoster(plan,playbook)`（每阶段队员 + 链式 `blockedByStage`）、`buildPolicy(role)`（Lead/队员提示文本）。
- `service.js`：`start()` 返回 `roster`；`startWithAuto(args,ctxInfo)` 在有 Team 运行时调 `autoSpawn`；`autoSpawn` 用 `agentTeams.createTask/spawnTeammate` 真建任务板与队员（Lead 身份校验 + 单项容错 + maxAgents 上限）；`handleToolAsync(args,ctxInfo)` 透传；`runView` 暴露 `orchestrated/teamTasks`。
- `index.js`：`ctx.inject(['agentTeams','agents'])` + `agent/created|disposed` → 给 Team 代理注入 `systemPrompt.section(name='token2biq:policy')`；工具 `execute(args,exec)` 取 `exec.agent/exec.signal` 组 `ctxInfo`；工具描述改为「主动编排」。
- 新增 `test/proactive.test.js`（6 条：花名册/提示/主动建团/回退/无 ctxInfo/spawn 容错）与 `test/proactive-wiring.test.js`（2 条：apply 注入 + execute(start) 真建团、无 agentTeams 降级）。

**验证**：`node --test test/*.test.js` → **67/67 全绿**；smoke-load 11 / smoke-tool 13 / smoke-usage 5 / render-smoke 19。

**仍遗留**：真实宿主端到端需用户重启后验证；「会话→run 精确归属」仍未做；门禁升级/预算熔断仍是「策略提示 + record 判定」，非宿主级硬熔断。

## 第九轮 · 「独立评委」真正落地（2026-11-06）

**背景**：设置项 `independentReview` 原标签写着「用官方 agentLoop 直接跑独立评委（预留，当前未落地）」，用户问为什么没做完。

**为什么之前没落地（宿主契约限制，非偷懒）**：
- 查 `@deepseek-ai/dsh-tool-cordis` 的 API 目录：`agentLoop` 是 agent **工厂/驱动器**（`create/createAgent/resume`）；而 `sessionController.prompt` / `subagents.prompt` 等提示接口只**投递** prompt，返回 `{accepted:true}` / `{messageId}`，**没有「同步跑完并返回模型裁决」的接口**（`SessionPromptValue={accepted:true}`，`SubagentPromptReceipt={messageId}`）。
- 要让插件自己算出一个 agentLoop 评委的 verdict，就得驱动完整 agent loop 再读会话日志——这等于**自造 agent 运行时**，直接违背本插件「不自造运行时」的设计铁律；而异步「起一个评委等它回报」又和普通 review 阶段重复，等于**双倍评审成本**。所以此前诚实地标为「预留」，没有硬塞一个假开关。

**本轮改动（用宿主真正支持的方式让开关生效）**：
- `buildRoster` 给 review/judge/redteam 标 `independent`（来自 playbook 的 independentReview 标记）。
- `service.record` 在 `independentReview` 开启时**硬校验**：review/judge/redteam 必须带 `owner`，且 `owner` 不能是本次 `generate` 的执行者——**执行者自评一律拒收**。
- spawn 的评委 prompt 追加盲审指令（只看产物+验收，不看执行者推理）。
- 面板标签改为「独立评委：评审/裁判/红队必须由非执行者的独立代理盲审裁决」；`settings.js` 注释同步更正。
- `test/proactive.test.js` 增 3 条（roster 标记、执行者自评被拒/独立评委放行、关闭时不拦）。

**验证**：`node --test test/*.test.js` → **70/70 全绿**；smoke-load 11 / smoke-tool 13 / smoke-usage 5 / render-smoke 19。

**说明**：这是「独立评委」的可落地正确形态（强制独立代理 + 盲审 + 拒收自评）。若坚持要「插件自己用某个模型同步跑完评委」，宿主无此同步接口，只能做成异步起评委回报（≈普通 review 再跑一遍，双倍成本），不建议。

## 第十轮 · 严格流水线 + 候选择优（pipelineGate，2026-11-08）

**背景**：用户确认方向 =「用 token 换 IQ：官方团队能跑但不强制开发规范，插件补审题/查资料/互审，适当多设候选比较择优」。行业证据（ICML2026 Adversarial Review：堆 agent 回报递减；generate-then-rank / CodeRM：Best-of-N 需可靠 verifier；Self-Preference Bias：评委需异构+盲审锚）→ 价值在「环节纪律 + 客观硬门禁」，不在堆人数。

**改动**：
- `settings.js` 增 `pipelineGate`（`off`|`strict`，默认 `off` 向后兼容）+ `normalizePipelineGate`。
- `service.start` 支持 `candidates`(1..5)→`run.candidates`、`run.spec`；`record` 在 `spec/plan/research` 捕获 `run.spec{summary,acceptance,constraints}`。
- strict 门禁：`generate` 前须 `run.spec`；`(candidates>1) generate` 须 `candidateId`、`judge` 须 `selectedCandidate`；`verify/regression` 须 `testsRun`；`finish` 须完成 verify/regression 且 PASS+testsRun，且多候选须 judge `selectedCandidate`。
- `receipts.js`：verify 回执保留 `testsRun/testsPassed`；verdict 回执保留 `selectedCandidate`。
- `orchestrator.buildTeamPlaybook` 增 strict 规则并返回 `pipelineGate`；`client.js` 设置面板加「流水线门禁」选择，并修掉「agentLoop 预留」旧文案。
- `runView` 暴露 `spec`/`candidates`。

**验证**：`node --test test/*.test.js` → **76/76 全绿**（新增 `test/pipeline.test.js` 6 条 strict 场景）；smoke 11/13/5、render 19。

**仍遗留**：真实宿主端到端需重启验证；真实 token 归属按「运行活跃期全进程用量」近似（见 A/B 协议用隔离会话规避）；多进程并发写盘（F10）仍需外部锁。

## 第十一轮 · 输入框「IQ」= 真正的会话级开关（2026-11-08）

**问题**：原来输入框「IQ」下拉选「关闭」只是前端 localStorage 显示，服务端没真禁用；选档位又会改全局 `this.mode`，影响其他会话，属误导。

**改动**：
- `service` 增 `sessionPrefs`（按 `agent.session.id` 记 `{enabled, mode}`）+ `setSessionPref/getSessionPref/_sessionIdOf`。
- `startWithAuto`：本会话 `enabled===false` → 直接拒 `start`（`disabled:true`）；本会话有 `mode` 且未显式传参 → 用该档，不污染全局。
- HTTP：新增 `GET/POST /token2biq/session`（sessionId/enabled/mode）；`client` 的 DockControl 改为按会话读写并挂载时同步「关闭」态到服务端，不再调全局 `/mode`。
- 单测 +1（会话开关）→ **78/78 全绿**。

**说明**：`sessionPrefs` 为内存态（重启后清空，前端 localStorage 仍记「关闭」并在挂载时回写服务端）。⚠ 宿主改动需完整重启 DSH 生效。


