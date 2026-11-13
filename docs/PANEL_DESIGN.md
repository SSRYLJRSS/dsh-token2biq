# Token 2b IQ 面板设计：同类插件调研与取舍

> 目标（m00704）：面板要展示「用户的真实运行数据」，而不是空壳；同时保持启动词/结构精简。本文件记录调研结论与最终落地。

## 一、同类插件在面板里放什么

| 插件 | 面板形态 | 展示的真实数据 | 可借鉴点 |
|---|---|---|---|
| dshmarket（灵书插件市场） | 左侧导航 + 卡片网格 + 详情 | 插件清单、安装状态徽标、版本、搜索/筛选、详情 | 面板宿主 `panelHost` 布局、语义化 token、空态引导、三行式页头（eyebrow + 标题 + 副标题） |
| dsh-cost-meter | 统计页 | 会话成本列表、每回合成本、input/output/cacheRead/cacheWrite/reasoning 用量、上下文构成、当天/热门会话 | 数字带单位、缺失显示 `—`、刷新节流、指标卡 |
| dsh-ops | 运维面板 | 状态卡、活动列表、配置项 | 状态优先、列表化 |
| dsh-pet | 小组件 | 轻量状态/动画 | 低干扰、常驻 |
| billion-context | 工具 + 面板 | 压缩/上下文统计 | 工具返回文本规整 |

## 二、Token 2b IQ 面板最终结构

1. **页头**：`TOKEN 2B IQ · SELF-ORCHESTRATION`（eyebrow）+ `自洽多代理编排`（h1）+ 一句副标题说明「只编排不执行」。
2. **指标卡（4 张）**：当前档位 / 运行数 / 预算占用（环）/ 实时 token（来自 `llm/stream` 的 `liveUsage`）。
3. **档位条**：`Auto / S1 普通 / S2 进阶 / S3 大改` 四张卡，点击即 `POST /token2biq/mode`。
4. **流水线看板（左）**：按阶段 `plan → generate → review → verify`（S3 含 research/judge/redteam/regression）分列；每张 AgentTask 卡显示 role / 状态 / 一行回执 / token。
5. **运行台账（右）**：分阶段 token 汇总表 + 与预算对比；另有「实时 token」按会话表。
6. **空态**：没有运行时不空白——给出「三步开始」+ 排查提示（而不是无意义 0）。
7. **底部说明**：`只编排不执行 · 实际执行交给现有 subagent / workflow`。

## 三、数据来源（真实、非伪造）

- `run-store`：`runs / stages / tasks / reviews / ledger / verdict / escalations`。
- `llm/stream` 瀑布监听：每次模型调用 `{type:'usage'}` → `service.noteUsage(usage, sessionId)` 按会话累计 → `state.liveUsage`。
- `budget-guard.checkBudget(spent, budget)`：`ok / warn(≥80%) / exceeded(≥100%)` 三档，触发暂停与提示。

## 四、设计纪律

- 不使用 emoji；配色全部走 `--dsw-alias-*` 语义 token（深/浅主题自适应）。
- 缺失值显示 `—` 而非 0；仅可视时拉取（focus / visibilitychange / 可视 4s 节流），不重轮询。
- 客户端控件为「IQ + 自研主题化下拉」（`关闭/自动/普通/进阶/大改`），挂 `conversation.input.left`，与「完全权限」同一工具行。
