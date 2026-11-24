# 变更日志

## [0.8.0] - 2026-11-24

### 新增：任务画像 AI 分类 + 策略矩阵（P0）

- **任务画像**：`Auto` 与「锁定档位」下都会让模型对目标做一次轻量画像（`taskType`/`complexity`/`risk`）；显式 `taskType` 优先，无模型时回退关键词，失败不影响启动。
- **策略矩阵配平**：新增纯函数 `applyProfileToPlan`，按复杂度在档位上限内裁剪阶段（代码/调查 simple→3 阶段、medium→4 阶段，complex 保持全量），始终保留验收阶段（verify 或 regression）。
- **关键词兜底加固**：`detectTaskType` 改为「短语级否定」感知（「不改代码/无需修改/没有必要修改」不再判 code；「分别实现/特别优化/只修改」仍正确判 code），单个调查信号即可判 investigation；`doc` 任务等同调查流水线；高风险画像不裁剪阶段（保留红队/裁决）。
- 效果：只读/调查类任务不再被判 code 而卡在 testsRun 死锁；简单任务阶段数下降，节省 token。

### 验证

- `npm test` → 403 tests / 402 pass / 1 skip / 0 fail
- `npm run check` → 13 files pass；`npm run pack:check` 全绿

## [0.7.1] - 2026-11-22

### 维护版：兼容修复与稳定性（无新功能）

本版只维护 0.7.0 的既有功能，不新增工具、路由、设置项或 UI 功能；在 DSH 0.2.2-rc.5 上完成全量审计与回归。

- **A1 readJson 健壮性**：请求体改为按块收集后用 `Buffer.concat(...).toString('utf8')` 解码，修复中文/emoji 跨块损坏；非法 JSON 返回 400，请求中止返回 `__aborted`，不再静默当成空 body。
- **A2 分类 usage 隔离**：`Auto` 分类期间不再用全局 `_classifying` 计数误吞其它并发流的 usage；每条分类流使用独立 token，只跳过自身。
- **A3/A8 compactToolResult**：第 2 级不再回灌超大 `roster`，保住 `created/modelRouting`；`null/undefined` 返回合法 JSON 字符串。
- **A4 error/aborted 用量**：`llm/stream` 的 `finish` 若为 `error/aborted` 且无 usage，补记 `requests`，不伪造 token。
- **S-A1 autoBoard 落盘**：全量建档失败时 `orchestrated` 不再先写 true 后内存改 false；持久化值与实际结果一致。
- **C1 autoprovision**：支持列表式 `providers[].name/models[].id`；映射式 provider 回归不变。
- **C2 settings 中文档位**：`defaultMode` 复用 `orchestrator.normalizeMode`，支持轻量/标准/完整/完整加强/普通/进阶/大改。
- **C4 synth 思考强度**：`normalizeReasoning` 的角色集合加入 `synth`，不改变既有 8 角色 rolePools/UI。
- **S3 report 兜底**：非法事件时间不再抛 `RangeError`；`modelRouting` 含 null 不再抛。
- **B3 client 负缓存**：verdict 查询失败不再写 null 负缓存，下一轮会重试。

### 验证

- `node --test test/maintenance-round2.test.js` → 12 pass / 0 fail
- `npm test` → 390 tests / 389 pass / 1 skip / 0 fail
- `npm run check` → 13 files pass
- `npm run pack:check` → 21 files pass
- `npm run test:smoke` → 5/5 scripts pass
- 安装副本 6 个改动文件 `node --check` 通过，源码与安装副本 sha256 一致。

> 上传说明：`v0.7.1` 的 Release 资产需同时提供 `dsh-token2biq-0.7.1.tgz` 与 `dsh-token2biq.tgz`（供 `releases/latest/download` 使用）。
## [0.7.0] - 2026-11-18

### 调查/文档类任务独立流水线 + 门禁自动化 + 逐会话 token 归属

这一版来自一次真实踩坑：用 S3 跑「回顾调查」类任务时，代码流水线先要求 `generate`（调查任务没有实现产物），而 `finish(PASS)` 又要求「最新产物之后有验证」，形成无法收口的死结；同时 `testsRun` 只写命令名（`["node --test"]`）会被归一成 `ok:null`，finish 报一句「缺验证证据」，用户完全看不出是形状不对。

- **新增任务类型 `taskType`（auto / code / investigation）**：`start` 可显式传，默认 `auto` 按目标文本判定。判定刻意保守——**出现任何代码动作词（实现/重构/修复/优化/修改/调整/编写/添加/集成/调试/部署…）一律按 code 处理**，宁可让流水线更严，也不让实现阶段被跳过。
- **调查类流水线 `INVESTIGATION_PLANS`**：`research → synth（成稿）→ review → verify / regression`，**不含 generate**；S1 收缩为 `research → synth → verify`，S3/S4 追加 judge/redteam。新增 `synth` 阶段（角色 `synthesizer`，回执按 worker 契约校验：需 `files` + `diffSummary`）。
- **`pipelineGate` 新增 `auto` 模式**：按「任务类型 + 档位」自动决定生效门禁——调查任务一律 off；代码任务只在 S3/S4 启用 strict，S1/S2 小改保持宽松。默认值仍为 `off`（向后兼容）。面板「高级 → 流程门禁」同步提供三选一，且编辑其它设置不会再把它改回 off。
- **`testsRun` 证据形状提前校验**：strict 下 `record verify/regression` 且 `verdict=PASS` 时，若 `testsRun` 里没有任何 `ok:true` 也没有 `testsPassed:true`，立即拒收并给出两种合法写法；不再拖到 `finish` 才报一句看不懂的错。**FAIL 回执不受此限**（它本身就是在报告失败）。工具 schema 的 `testsRun` 同时放开字符串与 `{cmd, ok}` 对象两种形状。
- **逐会话 token 归属**：`noteUsage` 优先按「会话 → 运行」映射归集真实用量（`start` 记录 sessionId，`finish` 清理，Map 上限 256），并发运行不再互相串账；无映射时退回旧的全局活动运行口径。
- **多候选支持调查任务**：候选来源从只认 `generate` 扩展为 `generate | synth`，调查类任务也能做「多版本报告 + judge 择优」。
- **面板**：概览区新增近 7 天 / 近 30 天通过率趋势与 7 天迷你柱条；设置→高级页新增「任务类型」三选一。
- **测试**：新增 `test/investigation-tasktype.test.js`（9 例）与 `test/selfcheck-matrix.test.js`（9 例，S1–S4 × code/investigation 全链路 record→finish）。全量 `npm run ci`：373 例（372 pass / 1 skip / 0 fail）、check 13 文件、pack 21 文件。

### 独立评审修复（发布前）

0.7.0 候选版本经一名独立评审代理复审，发现并修复 7 处问题后才发布：

1. `CODE_SIGNALS` 漏收「优化/修改/调整/编写/添加/集成/调试」等常用代码动词，导致「分析…并优化」被判成调查任务而跳过实现；
2. 设置面板把非 strict 一律折成 off，用户设的 `auto` 打开面板保存一次就被静默改回；
3. 工具 schema 缺 `taskType` 且 `testsRun` 只收字符串，新能力无法通过公开工具使用；
4. `INVESTIGATION_PLANS.S3` 的 judge/redteam 只写在 optionalStages、没进 stages，risk=high 也展不开（死配置）；
5. 多候选调查运行无法 finish(PASS)：judge 的候选来源只认 generate；
6. README / CHANGELOG 曾被回退到 0.6.2（本条目即修复后的 0.6.3→0.7.0 正确基线）；
7. 次要：`synth` 缺角色映射、`planFor` 忽略 taskType、文档未列 synth。

## [0.6.3] - 2026-11-17

### 严格门禁 + 跨 profile 自动配置 + 健壮性

- 版本 `0.6.2` → `0.6.3`（patch；兼容范围保持不变 `dsh >=0.2.2-rc.3 <0.3.0-0`），无破坏性 API 变更。
- **P0 活动 profile 判定与跨 profile 自动配置**：新增 `resolveProfileDetailed`，按「显式参数 > settings.provisionProfile > DSH_PROFILE > 模块安装路径反解（`/profiles/<name>/node_modules/`）> 枚举 profiles/*（排除 `.bak/.tmp/.old` 等备份目录，仅唯一命中）」确定活动 profile；多 profile 且无可靠来源时回传候选并拒绝静默写入（不再默认 `desktop` 写偏）。已有同 id 的 `subagent-model-selection-settings` 条目时用 `planModelMerge` 增量补齐缺失模型，只插入新行、保留用户键值。`applyProvision` 回传 `profileTargeted/profileSource/candidates/merged`，并由 `service.provisionStatus` 承接。
- **P0 安装链路 TLS / junction**：README 与 INSTALL 补充 `NODE_OPTIONS=--use-system-ca`（GitHub 源 TLS 证书链）与 `node_modules/dsh-token2biq` junction 清理命令，覆盖 0.6.2 市场安装卡住根因。
- **P1 strict judge / testsRun 门禁**：新增 `testsProven`——`testsRun` 任一项 `ok:false` 一票否决（即使回执自报 `testsPassed:true`）；否则要求 `testsRun` 非空且逐项 `ok:true`，杜绝「只报命令名未报结果」蒙混通过；配套 strict finish 验证必须位于最新 `generate` 之后。
- **P1 提示词压缩**：精简 Lead 锁定档位纪律与队员 blocked 处理措辞（`orchestrator.buildPolicy`），减少冗余说明，保留「回执 / 不轮询 / 只改 writeScopes」硬约束。
- **P2 健壮性**：`report.buildReport` 对缺失/半成品 run 全面空值兜底（ledger/plan/stages/tasks/verdict 等），任何字段缺失不再 TypeError；`makeLlmClassifier` 移除硬编码的 `magpie/workbuddy/deepseek-v4.1-flash` 回退路由：优先使用宿主当前默认模型，取不到则返回 null 交由上层回退关键词分类，避免模型不存在时分类静默失败、掩盖真实配置问题。
- **测试**：新增 `strict-finish-gates`、`policy-degrade`、`report`、`llm-classifier` 4 个测试；更新 api-contract / autoprovision / bugfix-1113 / core-audit-regression / manifest / payload-size-061 / pipeline / spawn-prompt-cache 8 个测试。`npm run ci` 350/349/0/1、`npm run test:smoke` 5/5 全绿。

## [0.6.2] - 2026-11-17

### 安装链路修复 + 版本声明 + 市场/Release 全面更新

- 版本 `0.6.1` → `0.6.2`；DSH 兼容范围改为 `>=0.2.2-rc.3 <0.3.0-0`（按插件实际使用的 Agent Teams / subagents 接口下限声明），并同时写入顶层 `engines.dsh` 与 `dsh.compatibility.dsh`。市场与宿主现在都能直接识别版本与兼容性，不再显示“无版本声明 / 兼容未知”。
- **修复市场/云端安装一直卡住**：根因是此前 `link:` 本地安装留下的 `node_modules/dsh-token2biq` 目录联接（junction）；pnpm 11 在 import 阶段执行 `rename(dsh-token2biq_tmp_* -> dsh-token2biq)` 时抛 `ERR_PNPM_EPERM`，桌面端安装操作会一直停在“安装中”。README 已补充诊断与一键清理 junction 的命令；市场登记保持 GitHub 源安装；Release 另提供预构建 tarball 供可直连 Release 的网络使用。
- **预构建 tarball 分发**：Release 同时提供 `dsh-token2biq-0.6.2.tgz`（固定版本，注册表 pin 用）与 `dsh-token2biq.tgz`（version-free，供 `latest/download` 使用）；包内零运行时依赖、无安装脚本，`dsh plugin add <tarball>` 不需要 `allowBuilds` 授权。
- **自动配置复核**：`agent-team`（`defaultEnabled: true`、`maxTasks: 256`）与 `subagent-model-selection-settings`（`enabled: true` + 全量 `allowedModels`）已在真实 DSH 0.2.2-rc.3 + Desktop profile 验证生效；继续保证只追加 profile `cordis.patch.yml`、绝不改 `settings.yaml`、已有同 id 配置不覆盖、写前备份 / 原子写 / 写后校验 / 失败回滚。
- **测试**：新增 `test/manifest.test.js` 锁定版本、`engines.dsh` / `dsh.compatibility.dsh`、bundle patch 与发布 payload；`npm run ci` 与 `npm run test:smoke` 全量通过。
- **文档**：README / README.en 安装章节按“市场 GitHub 源 → CLI GitHub 源 → 预构建 tarball（可选）→ 本地源码 link”重写，补充 junction 清理、版本与兼容声明、TLS 证书链排障与 Release 双资产说明。

## [0.6.1] - 2026-11-17

### 真实宿主思考强度修复 + 高地板矩阵 + 载荷瘦身

- 版本 `0.6.0` → `0.6.1`（未改兼容范围 `dsh >=0.2.0-rc.1 <0.3.0-0`）。
- **P0 字段错配修复**：`resolveEffort` 优先读真实宿主的 `reasoning.supportedEfforts`（旧 `reasoning.efforts` 兜底），`client.js` 按模型下拉同步；仅 `defaultEffort`、无 `supportedEfforts` 的旧模型显示「仅默认 <档>」而非「不支持思考强度」。修复前真实模型一律解析为 `null`，所有强度设置失效。
- **P1 高地板矩阵**：`MODE_ROLE_EFFORT` / `V3_EFFORT_MATRIX` 统一仅 `high`/`xhigh`：S1 generate/verify high；S2 四阶段 high；S3 judge 与 S4 plan/review/judge/redteam 用 `xhigh`（不支持时按 `EFFORT_ORDER` 自动降 high），其余 high，兜底 high。不再自动出现 off/minimal/max。
- **P1 提示词与载荷瘦身**：`_spawnPrompt` 改为稳定前缀 + `---` 动态尾（≤400，利于 prompt 缓存）；`_handoff` 文本 ≤400、files/issues 各 ≤5；`autoBoard` 简报去掉重复 `handoff.items`；`startWithAuto` 返回体把 `playbook.steps`/`roster` 压成执行必需字段；S3 start 序列化 9386 → 约 6697 字节（约 -29%）。
- **P2 工具输出瘦身**：`TOOL_DESCRIPTION` 压到 3 行；`compactToolResult` 默认上限 12000 → 8192，非 JSON 结果改中段截断（head 4096 + `...[middle pruned]...` + tail 1024），对象仍保留合法 JSON 骨架（created/modelRouting/next）；`TOOL_PARAMETERS` 描述文本精简约 11%。
- **测试**：新增 `effort-real-schema`、`spawn-prompt-cache`、`payload-size-061`；旧 effort/UI/compact 断言更新到高地板矩阵与 8192 上限。

## [0.6.0] - 2026-11-17

### 编排瘦身与思考强度（token 约 2× 回归修复）

- 版本 `0.5.2` → `0.6.0`。目标：压回大版本后的 token 与耗时膨胀，同时落地可配置的思考强度，并保持质量与旧测试兼容。
- **档位重排**：S1 精简为 2 阶段（generate → verify，1 个代理）；S2 为 4 阶段（plan → generate → review → verify，最多 3 个代理）；S3 为核心 5 阶段（research → plan → generate → review → regression，最多 5 个代理），`risk=high` 时追加 judge / redteam（共 7 阶段）；S4 为完整 7 阶段（最多 8 个代理），仅 `review` 阶段评审双路并行（最多 2 个独立模型盲审，任一 FAIL 即该阶段 FAIL）。
- **计划生成**：`generatePlan` 新增 `risk` 入参（low/normal/high/strict），仅高风险进入可选阶段；返回 `optionalStages` / `risk` / `stageCount`。
- **思考强度（新增）**：设置升到 `version: 3`，新增 `reasoning: { default: 'auto', byRole: {}, byModel: {} }`；导出 `normalizeEffort` / `normalizeReasoning`，`SettingsStore.update` 对 `reasoning` 深合并（`default` 覆盖、`byRole`/`byModel` 浅合并、未提交键保留）。
- **effort 解析**：导出 `EFFORT_ORDER`（off→minimal→low→medium→high→xhigh→max）与 `MODE_ROLE_EFFORT` 矩阵；`resolveEffort` 按「按模型 > 按角色 > default > 矩阵」取值，模型无 reasoning 能力返回 `null`（调用方省略参数），首选档不支持时按顺序向下就近降档，再退回模型默认档。
- **手册/花名册/派活**：`buildTeamPlaybook`、`buildRoster`、`briefing` 的 delegation 增加 `reasoning_effort`（无则省略），`modelRouting` 增加 `effort`；花名册名字带 run 后缀，跨 run 不重名。
- **提示词瘦身**：精简 `TOOL_DESCRIPTION`、`_stageDescription`（≤500 字）、`_spawnPrompt`（≤400 字）、`buildPolicy`（Lead ≤3/4 行、队员 ≤3 行，去掉 `wait_agent` 轮询表述、保留「回执」）；`record` 返回结构瘦身。
- **面板**：设置新增「思考强度」页（默认策略 + 当前档位 + 生成 high·评审 medium·验证 low 预览、全局默认 select、8 角色覆盖表、按模型覆盖列表，模型不支持时显示「不支持思考强度」）。
- **文档**：README 中英文档位表与思考强度章节同步；新增 [0.6 优化说明](docs/OPTIMIZATION-0.6.md)。

## [0.5.2] - 2026-11-16

### 安装后自动配置宿主（免手动勾选）

- 新增 [autoprovision.js](lib/autoprovision.js)：插件加载时自动写 profile 层 `cordis.patch.yml`，把「启用官方 Agent Teams」与「子代理多模型选择 + 自动勾选当前模型」一步配好；重启 DSH 后生效。
- 只追加 `agent-team`（`defaultEnabled: true`）与 `subagent-model-selection-settings`（`enabled: true` + `allowedModels`）两个条目；**不修改 `settings.yaml`**，同 id 已有用户配置一律跳过不覆盖。
- 模型清单从 `settings.yaml` / profile patch 的 `llm-pi-ai.providers.*.models[].id` 扫描合并去重；扫描不到模型时只写团队条目，绝不写空 `allowedModels`。
- 写前备份 `cordis.patch.yml.bak-token2biq-<ts>`，临时文件 + 原子替换，写后校验（原内容前缀不变 + 条目生效），失败自动回滚且不向宿主抛错；幂等重复启动零改动。
- 设置新增 `autoProvision`（默认 true）与 `provisionProfile`（可空）；工具新增 `action=provision` 手动重跑；新增 9 条单测覆盖幂等/跳过/无模型/缺失目录/备份/写失败回滚/前缀不变。

## [0.5.1] - 2026-11-16

### 核心状态与阶段聚合

- 新增 [stage-state.js](lib/stage-state.js)：按执行 slot（`teamTaskId` 优先、`owner` 次之）取最新回执；任一 slot 最新回执失败即 `failed`，同一 slot 重试通过可自愈为 `done`。
- 服务查询、`record` 聚合与 `run-store` 恢复共用同一套阶段状态规则，修复「历史 FAIL 永久粘死看板」与「另一条 PASS 把 FAIL 抹成 done」两种自相矛盾。
- 交接 `_handoff` 改读真实 `task.receipt` 形状（`files/diffSummary/verdict/issues`），并兼容历史平铺快照；并行评审任一条 FAIL 即整体 FAIL。
- 多候选：`candidateId` 归一化并落库（1..N 内唯一）；`selectedCandidate` 必须指向已记录候选；`finish` 只认最新 judge 回执的 PASS。
- 最终 strict 评审/红队：`judge` 与 `redteam` 只认最新回执 PASS；红队原 RT1-4 复验 PASS；`S4` 阶段校验执行身份（owner/角色）与回执一致。
- strict 门禁：验证必须位于最新 `generate` 之后，每个 `verify/regression` slot 的最新回执 PASS 且 `testsRun` 全绿；`verdict` 只接受 `PASS/FAIL`。
- 历史回执幂等：同 `teamTaskId+owner+model` 的完全相同回执不重复记账，旧快照中的历史回执不会重复累计；产物更新后的新验证仍生效。
- R1 并发 finish 假成功：`finish` 在并发记录下串行判定，只有最新 judge 回执 PASS 且期间无并发新增失败时才返回成功，消除「先检查后写入」的假成功。
- R2 post-generate 验证重放去重：`generate` 之后首次提交的 `verify/regression` 回执进入验证序列；与最新回执完全相同的重放按幂等处理，不重复计数。
- R4 旧快照无身份回执：缺少 `teamTaskId/owner` 的历史回执独立成槽并 fail-closed，不并入最新回执，避免无身份记录污染阶段状态。
- S4 文案修正：`S4` 的并行组与身份校验描述与实现一致，不再把「同组并行」写成串行。
- 预算闸门统一到 `_budgetGate`：优先宿主 `real` 用量，回退回执 `ledger`；`runView` 容错缺省数组，避免面板因历史快照 500。

### 官方 Agent Teams 联动

- 新增 [host-integration.js](lib/host-integration.js)：只解析精确活跃会话，经官方 `isEnabled/setEnabled/rootOf` 读写团队状态；非根会话、未激活、接口缺失都返回真实原因，不伪造回滚。
- 删除插件自动追加 `subagent/model-selection-policy` 的授权路径；`applySubagentModelPolicy` 保留为显式拒绝的兼容导出；模型授权归官方用户设置。
- [cordis.patch.yml](cordis.patch.yml) 不再重声明 `tool-subagent` 的 `provider/toolName/modelSelection`，避免覆盖官方配置及未来字段。
- 系统提示段改为惰性求值，按当前 agent 角色与会话偏好生成；不再缓存 `leadAgentRef` 供其它会话借用。
- 新增 `GET /token2biq/host` 与 `POST /token2biq/host/team`；HTTP 门禁改为 fail-closed：`connection` 缺失/异常直接 503，未认证 401 由官方 `requestRejection` 返回，拒绝后不进入业务分支；POST 仍要求 `application/json`（415）。

### 存储与并发

- [run-store.js](lib/run-store.js) 改为锁内读取、三方合并、原子 `rename` 替换；合并基线只在落盘成功后前移，失败可重试且不重复计量。
- 写锁 fail-closed：存活 owner 不按年龄过期；死 PID 由 `.reap` 守卫串行回收；owner 未知或不完整时拒绝继续写入。
- 临时文件用 `wx` 创建并带 PID 感知清理（活跃 PID 或宽限期内保留）；`rename` 失败保留上一份好快照。
- 新增删除墓碑 `tombstones` 与淘汰墓碑，避免旧快照把已删除/被淘汰的运行合并回来；事件补 `id`，损坏快照可备份并按精确字节恢复。
- 终态保护：已完成/失败的运行不可被 `pause→resume` 复活；快照损坏时按备份/墓碑恢复后继续写入，不静默清空。
- [settings.js](lib/settings.js) 显式 `null` 表示纯内存；`update` 对 `roleModels`→`rolePools` 做镜像，连续只改 `roleModels` 也能生效。

### UI / 客户端

- 设置保存只提交本表单实际改动的字段，不再清空 `allowModels/reviewModels`；HTTP 200 但 `ok:false` / `persisted:false` 视为失败并在界面展示。
- IQ 下拉以服务端会话偏好为准，删除 `localStorage` 开关；切换/关闭失败保留已确认值并 `role=alert` 提示；旧会话响应不能覆盖新会话。
- 新增官方团队状态与显式「启用官方 Agent Teams」按钮（`POST /host/team`）；只有点击才写，挂载/打开菜单不发 POST。
- 可访问性：原生 `button`、`aria-pressed/aria-expanded`、Escape 关闭并恢复焦点、焦点样式；颜色回退值调整以改善对比度。
- 面板选择/详情用 `loadSeq` 丢弃过期响应，避免后到的旧响应覆盖新选择。

### 工程化

- [package.json](package.json) 增加 `scripts`（`check/check:all/test/test:isolation/test:smoke/pack:check/ci`）；版本 `0.5.0` → `0.5.1`。
- 新增 [check.mjs](scripts/check.mjs)（逐文件 `node --check`）、[check-pack.mjs](scripts/check-pack.mjs)（发布 payload 齐全/无泄漏）、[run.mjs](test/run.mjs)、[run-smoke.mjs](test/run-smoke.mjs)、[_isolation-preload.cjs](test/_isolation-preload.cjs)。
- 新增 [CI](.github/workflows/ci.yml)：Node 20/22/24 × Ubuntu/Windows。
- 工具与 HTTP 入口统一 async 错误处理，异常进入统一错误结构，不产生未处理 Promise 拒绝。
- 测试新增 `core-audit-regression`、`integration-audit`、`isolation`、`store-audit`、`ui-behavior` 等；每个测试进程独立临时 `DSH_HOME`。
- 文档：新增 [架构说明](docs/ARCHITECTURE.md) 与 [审查台账](docs/AUDIT-2026-11-16.md)；重写 [验证指南](docs/VERIFICATION.md)；README 中英文同步。

### 验证

最终静止树（未改源码）验证：

- `npm run check`：12 个文件通过。
- `npm test`：250 项 / 249 通过 / 0 失败 / 1 条件跳过（`DSH_OFFICIAL_SRC` 未设置）。
- `core-audit-regression`：34/34 通过。
- `npm run test:smoke`：四组通过。
- `npm run pack:check`：通过。
- `git diff --check`：通过。
- 真实 Chromium 四视口：沿用最终 client 的 `analysis/ui-render-audit.mjs` 证据（此后 client 未改）。
- 红队原 RT1-4 复验：PASS。

既定语义与未覆盖项（真实 GUI 401、完整宿主重启、官方源码比对跳过，以及 R3 无 attempt 序号的残余取舍）见 [验证指南](docs/VERIFICATION.md) 与 [审查台账](docs/AUDIT-2026-11-16.md)。
