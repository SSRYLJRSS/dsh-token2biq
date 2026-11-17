# Token 2b IQ 0.6.0 实施规格（Lead 定稿）

目标：修复大版本后 token 约 2×、速度约 2× 慢；落地思考强度配置；保持质量与旧测试兼容。

## A. 设置 v3（lib/settings.js）
- DEFAULT_SETTINGS.version = 3，新增 reasoning: { default: 'auto', byRole: {}, byModel: {} }。
- 导出 normalizeEffort(v)：接受 'auto' 或 /^[a-z][a-z0-9_-]{0,31}$/ 小写 id，否则 'auto'。
- 导出 normalizeReasoning(raw)：default normalizeEffort；byRole 仅 ROLE_KINDS 键、值 normalizeEffort 后非 auto；byModel 仅 isModelRef key、值非 auto；返回 {default,byRole,byModel}。
- normalizeSettings 返回 reasoning。
- SettingsStore.update 对 reasoning 深合并：default 覆盖；byRole/byModel 分别浅合并，未提交键保留。

## B. 编排（lib/orchestrator.js）
- MODE_META：S1 maxAgents1；S2 3；S3 5；S4 8。文案见规格：S1 轻量 1 执行代理；S3 完整核心 5 阶段（research/plan/generate/review/regression）；S4 完整加强 7 阶段双路评审。
- PLANS：
  S1 stages ['generate','verify'], coreStages 同, optionalStages [], maxAgents 1, budgetX 2
  S2 stages ['plan','generate','review','verify'], optionalStages [], maxAgents 3, budgetX 5
  S3 stages ['research','plan','generate','review','judge','redteam','regression'], coreStages ['research','plan','generate','review','regression'], optionalStages ['judge','redteam'], maxAgents 5, budgetX 10
  S4 stages 同 S3 全 7 阶段, coreStages 全 7, optionalStages [], maxAgents 8, budgetX 16
- generatePlan(mode, opts)：risk=opts.risk==='high'||opts.risk==='strict'；risk 且有 optionalStages → stages=p.stages；否则 stages=p.coreStages||p.stages。返回 optionalStages 副本、risk 'high'|'normal'、stageCount=stages.length。
- 导出 EFFORT_ORDER ['off','minimal','low','medium','high','xhigh','max']。
- 导出 MODE_ROLE_EFFORT：
  S1 {generate:'low',review:'low',verify:'off',default:'low'}
  S2 {plan:'high',generate:'high',review:'low',verify:'low',default:'medium'}
  S3 {research:'high',plan:'high',generate:'high',review:'medium',judge:'high',redteam:'high',verify:'low',regression:'low',default:'medium'}
  S4 {research:'high',plan:'high',generate:'high',review:'high',judge:'high',redteam:'high',verify:'low',regression:'medium',default:'high'}
- 导出 resolveEffort({mode,stage,role,modelRef,modelMeta,settings})：
  1) settings.reasoning.byModel[modelRef] || byRole[role] || default；为 auto/空则取矩阵 stage/default。
  2) modelMeta[modelRef].reasoning 缺失/efforts 空 → null（调用方省略参数）。
  3) preferred 在 efforts 返回；否则按 EFFORT_ORDER 向下找最近；再 defaultEffort；再 efforts[0]。
- buildTeamPlaybook 增加 options.modelMeta、defaultModel、settings；mk() 加 effort。
  多审仅 S4 且 kind==='review'，models 取 min(paraCount,2)；steps 总数 ≤ plan.maxAgents（S4 最多 8；S1-S3 也受 TEAM_MAX_MEMBERS 约束）。
  rules 精简到 3 条核心；forceTeam/strict 开启时各加 1 短句。
- buildRoster(plan,playbook,opts={})：名字 base + '-' + runId 后 8 位小写字母数字；每项 effort。
- buildPolicy：lead locked ≤3 行（含 token2biq/start/队员/record/finish；明确不要轮询 wait_agent）；unlocked ≤4 行；teammate ≤3 行（claim→执行→complete；最终回答直接回执，不要 send_message）。旧测试匹配 /claim|任务/ 与 /send_message|回执/，保留"回执"。

## C. 服务（lib/service.js）
- start 增加 risk/modelMeta/defaultModel；generatePlan 传 risk；buildTeamPlaybook 传 settings.reasoning/modelMeta/defaultModel/settings；buildRoster 传 {runId:run.id}。
- startWithAuto 在 start 前 try：cat=await ctxInfo.modelCatalog(); modelMeta[g.id+'::'+m.id]={reasoning:m.reasoning||null}; defaultModel 从 cat.default 拼 ref。失败吞掉。
- _stageDescription ≤500 字符：id/stage/role、目标摘要≤80、判据、任务 id+revision、claim→执行→complete、最终回答即回执。
- _spawnPrompt(run,r,task) ≤400 字符（handoff 可选截 240）：taskId/revision、stage/role、目标摘要≤60、判据、写域、claim→执行→complete、最终回答 JSON 回执；不要 send_message/team_task_list/team_task_get（revision 过期才 get）。
- autoBoard：description 用 _stageDescription(...,view.revision)；tasks.push({stage,subject,taskId:view.id,revision:view.revision,owner:r.name})；briefing 的 delegation 加 reasoning_effort（无则省略）与 taskRevision；modelRouting 加 effort。
- record 返回瘦身为 {ok, task:{id,kind,role,status,stage,verdict,tokens,teamTaskId,owner,model}, review:{...}, warnings, estimatedTokens, escalate}；保留测试使用的字段。不要动 run-store。

## D. 入口（lib/index.js）
- TOOL_DESCRIPTION ≤5 行（约 400-600 字符），删除 send_message/wait_agent/team_task_list 监督表述；保留 start→briefing→record→finish、锁定档位必须 start、reasoning_effort 按 delegation 传。
- TOOL_PARAMETERS 保留字段但 description 精简；新增 risk enum low|normal|high。
- makeLlmClassifier：'none'→'off'；失败重试一次不传 effort，仍失败返回 null。
- 抽取插件级 getSessionController() helper（sessionControllerRef || ctx.get('sessionController') || sctx.get('sessionController')）；HTTP /models 与工具 ctxInfo 共用。
- ctxInfo 增加 modelCatalog async、defaultModel（agentDefaultModel.currentSelection 拼 ref）。
- state 动作 runs slice(0,5)、tasks slice(-5)、events slice(-10)。

## E. UI（lib/client.js）
- 新增思考强度页；draft/payload 增加 reasoning。
- 常量 V3_EFFORT_OPTIONS_GENERIC、V3_EFFORT_MATRIX（与 B 一致）、v3DefaultReasoning、v3NormalizeReasoning。
- v3DefaultDraft/v3ToDraft/v3BuildPayload 接入 reasoning；旧 settings 缺失自动补。
- SettingsView page 支持 model|effort|advanced；nav 增加「思考强度」。
- effort page：hero 摘要（默认策略、当前档位、生成 high·评审 medium·验证 low 预览）；全局默认 select；8 角色覆盖表（角色/用途/建议 badge/select）；按模型覆盖列表（从 rolePools 去重，显示模型支持 efforts 或“不支持思考强度”）；无模型时提示。
- CSS：.t2biq-v3-effort-hero、.t2biq-v3-effort-table、.t2biq-v3-effort-badge、.t2biq-v3-effort-model-row；窄屏卡片化。
- 可访问性：role=tabpanel/columnheader、aria-label、aria-selected。
- 保存逻辑不变，payload 永远带 reasoning。

## F. 测试/文档（test/**, README*, CHANGELOG.md, package.json, docs/**）
- 版本 0.6.0；CHANGELOG 0.6.0 段落；README 更新档位表与思考强度说明。
- 更新旧断言：S1 2 阶段、S3 stageCount 5、S4 maxAgents 8、S4 仅 review 双审、costWeight 如变。
- 新增 tests：settings reasoning 归一化/深合并；resolveEffort 缺 reasoning 返回 null/clamp；buildRoster 名字带 run 后缀；buildPolicy 不含 wait_agent 轮询；UI effort 页渲染与 payload。
- npm run ci 全绿。

## 验收
- npm run ci 通过；无语法错误；旧 settings 自动迁移；不支持 reasoning 的模型不传参数；S4 steps ≤8；跨 run 名字不同。
