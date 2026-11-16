# 变更日志

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
