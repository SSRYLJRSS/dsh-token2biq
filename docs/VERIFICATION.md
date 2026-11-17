# Token 2b IQ 验证指南

本文件取代早期逐轮聊天式记录。当前审查结果见 [审查台账](AUDIT-2026-11-16.md)，职责与已知限制见 [架构说明](ARCHITECTURE.md)。旧版本测试计数和旧端口的截图不作为当前版本通过证据。

## 隔离是运行测试的前置条件

先确认测试入口为每个执行进程分配临时 DSH_HOME，且 stateFile/settingsFile 的 null 不会被替换成默认用户路径。未完成此前，不直接在真实用户环境跑测试或装载冒烟。

运行前后记录真实用户 token2biq 目录下 state.json 与 settings.json 的 SHA-256 和修改时间；不存在的文件也记录为不存在。测试后应保持一致。所有测试写入应发生在临时目录，清理只针对本次创建的临时目录。

## 验证入口

工程化入口由 [package.json](../package.json) 定义：`npm run check`、`npm test`、`npm run test:smoke`、`npm run pack:check`。以实际 scripts 为准。

底层现有测试为 Node test runner 下的 test/*.test.js，装载/工具/usage 冒烟分别为 [smoke-load](../test/smoke-load.mjs)、[smoke-tool](../test/smoke-tool.mjs)、[smoke-usage](../test/smoke-usage.mjs)。直接执行这些文件时也必须继承临时 DSH_HOME。语法检查逐个文件调用 node --check，不能把多个源文件当作一个 node --check 调用。

## 验收矩阵

| 层级 | 必须覆盖 | 不能据此推断 |
| --- | --- | --- |
| 纯策略与回执 | 档位/角色、S4并行组、非法回执、strict证据、失败后恢复 | 官方宿主已启动代理 |
| 服务生命周期 | start/record/finish、重复回执、暂停/终态、部分建板失败 | 返回ok就代表所有队员已运行 |
| 持久化 | null纯内存、显式路径、重启、损坏文件、替换失败保护、删除不复活、并发合并 | 文件快照具备数据库事务保证 |
| 宿主契约mock | 工具schema/output、HTTP权限拒绝、root身份、createTask形状与依赖、模型策略 | 当前已安装宿主兼容所有路径 |
| 客户端自动化 | 首次空态、请求/保存失败、焦点与Escape、会话切换、卸载清理 | 真实GUI样式/加载版本正确 |
| 发布检查 | 包文件白名单；不包含测试、旧tgz、临时探针或用户数据 | 已发布npm或已创建远程tag |

## 真实宿主与首次启用验收

1. 在目标 profile 启用插件，核对工具注册和 /token2biq/state 路由可用。记录实际宿主版本及所加载插件版本。
2. 确认新产物已加载：宿主代码通常需重载/重启；客户端需构建链更新后再刷新。没有对应dev watcher时不能承诺刷新即更新。使用原有GUI，不启动替代服务器冒充验证。
3. 首次空态无假成功，设置可保存，失败有反馈；IQ关闭会阻止本会话启动。A/B会话分别设置，验证互不覆盖及重启后的实际语义。
4. 以隔离数据执行start并确认任务板。Lead实际调用subagent；子任务按依赖领取，配模型阶段也遵守依赖；S4同组并行，下游等待全组。
5. 回传阶段结果，确认strict拒绝缺证据，失败后修复可恢复，最终finish与面板/报告一致。
6. 在窄屏及明暗主题检查下拉、滚动、关闭、键盘操作。分别检查请求失败和保存失败反馈；确认进程级usage和回执估算没有混算。

上述步骤是验收方法，不代表已经执行。若重启或真实浏览器验证未进行，在结果中保留未覆盖项。

## 本次安装源与活跃运行状态

2026-11-17，Lead 已核验 desktop profile 的安装源为 commit-pinned GitHub 源（`git+https://github.com/SSRYLJRSS/dsh-token2biq.git#34eed5722adc3d43f057e0207c529bc92ac22e40`，版本 0.6.2）；旧的 `node_modules/dsh-token2biq` 目录联接已删除并替换为真实目录。官方 runtime 版本为 0.2.2-rc.3。

活跃进程仍为旧后端，须完整重启 DSH 后再确认新产物生效。安装源已更新不等于内存代码已替换，也不等于已通过真实GUI验收；本轮未启动替代服务器。

## 本轮（0.6.2）最终验证状态与未覆盖项

- `npm run ci`：327 项 / 326 通过 / 0 失败 / 1 条件跳过；`pack:check` 21 个文件、13 个 lib 模块齐全。
- `npm run test:smoke`：5/5。
- 自动配置专项：临时 DSH_HOME + 双模型 provider，首次写入 `agent-team`（defaultEnabled: true）与 `subagent-model-selection-settings`（enabled: true + allowedModels）；重复运行 0 变更。
- 安装：desktop profile `dsh plugin why` = 0.6.2；市场等价 commit-pinned GitHub 源安装 20.3s；CLI GitHub 源安装 12.2s/13.9s；预构建 tarball + `NODE_OPTIONS=--use-system-ca` 6.8s。
- Release v0.6.2 两资产 sha256 = `bddfc194a7b2c98450bcb1917a925f509958aef0a3228d8be6668fc46a99eb3b`；`engines.dsh` 与 `dsh.compatibility.dsh` 均为 `>=0.2.2-rc.3 <0.3.0-0`。
- 未覆盖项：已登录 GUI 的真实浏览器端到端、完整重启 DSH 后新后端产物生效；不据此宣称已通过。

## 历史（0.5.1）最终验证状态与未覆盖项

以下为最终静止树证据（未改源码）。

### 最终静止树证据

- `npm run check`：12 个文件通过。
- `npm test`：250 项 / 249 通过 / 0 失败 / 1 条件跳过（`DSH_OFFICIAL_SRC` 未设置）。
- `core-audit-regression`：34/34 通过。
- `npm run test:smoke`：四组通过。
- `npm run pack:check`：通过。
- `git diff --check`：通过。
- 存储专项（core-audit 回执）：21/21 通过；覆盖锁内读取、三方合并、原子替换、墓碑、死 PID 回收与 rename 失败保护。
- 四视口浏览器证据：`analysis/ui-render-audit.mjs` 驱动真实 Playwright Chromium，覆盖 light/dark × 1280/375——无横向溢出、无未标注 `input/select`、Dock 菜单在视口内、Escape 关闭且焦点恢复、挂载/打开菜单 POST=0、pageErrors=[]。该证据沿用最终 client（此后 client 未改）；脚本与截图属于本地审查产物，不纳入版本库。
- Node vm 客户端测试：`test/ui-behavior.test.js` 在 Node vm 中加载真实 React/ReactDOM，只覆盖客户端状态与行为（保存/失败/会话切换/焦点/Escape 等），不提供真实浏览器渲染证据。
- 红队原 RT1-4 复验：PASS。

### 既定语义与残余取舍

1. **验证早于最新 generate**：`verify/regression` 回执早于最新 `generate` 时，第一次提交的完全相同回执视为新验证；随后与最新回执相同的重放按幂等处理，不重复计数。
2. **无 attempt 序号（R3）**：当前回执没有 `attempt` 序号，无法绝对区分「同内容重试」与「网络重放」；这是评审保留的设计取舍，文档不把它写成已完全消除。
3. **无身份历史回执（R4）**：旧快照中缺少 `teamTaskId/owner` 的回执独立成槽并 fail-closed，不并入最新回执，避免污染阶段状态。
4. **S4 身份与并行**：`S4` 同组并行、下游等待全组；执行身份（owner/角色）必须与回执一致，文案不再写成串行。

### 必须区分的边界

1. **本地浏览器审查 ≠ 当前 GUI**：`analysis/ui-render-audit.mjs` 驱动真实 Chromium，但仍是本地审查脚本；`test/ui-behavior.test.js` 的 Node vm 只覆盖客户端状态/行为。两者都没有证明当前 GUI 已加载本次客户端产物，也没有验证真实网络门禁与宿主事件。
2. **当前 GUI 未认证 401**：live URL 仍返回 401。插件 HTTP 入口以官方 `connection.requestRejection` 为唯一授权来源——未认证 401、连接服务缺失/异常 503，拒绝后不进入业务分支。未在已登录 GUI 上执行端到端验收，因此面板/下拉的线上行为不标为通过。
3. **活跃宿主仍需完整重启**：`lib/index.js`、`service.js`、`run-store.js` 等宿主侧模块只在启动时加载；仅刷新页面不会替换后端。当前活跃进程仍为旧后端，完整重启 DSH 后重新核验工具注册、`/token2biq/state` 与新后端行为。
4. **官方源码比对可条件跳过**：`test/api-contract.test.js` 仅在 `DSH_OFFICIAL_SRC` 指向官方解包源码时执行比对，未设置时 `t.skip`。跳过不等于通过，需在具备官方源码的环境补跑。
5. **远程 CI 未在本机执行**：`.github/workflows/ci.yml` 矩阵（Node 20/22/24 × Ubuntu/Windows）已加入，但未在本机执行；`npm run check`、`npm test`、`npm run test:smoke`、`npm run pack:check` 与 `git diff --check` 已在最终静止树通过。

### 未覆盖项

- [ ] 已登录 GUI 的真实浏览器端到端（当前 live URL 401）。
- [ ] 完整重启 DSH 后新后端产物生效。
- [ ] 设置 `DSH_OFFICIAL_SRC` 后补跑官方源码契约比对。

最终发布（commit/push）由 Lead 执行；`analysis/` 与截图保留在本地，不纳入版本库。

## 结果记录规则

每次最终回归应记录命令、退出码、通过/失败/跳过数量、跳过原因、运行时版本、隔离证据和Git提交或工作区版本。局部专项测试结果与最终全量结果分开；不要沿用早期25/25等旧数值。

当前最终结果以 [审查台账](AUDIT-2026-11-16.md) 的已收到回执为准。本文的 250/249/0/1、34/34 专项、四组 smoke 与四视口证据均来自最终静止树；未覆盖项单独列出，不据此宣称真实 GUI 或重启后行为已通过。
