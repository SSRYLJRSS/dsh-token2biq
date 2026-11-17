# Token 2b IQ 0.6.0 优化说明

0.6.0 针对大版本后「token 约 2×、速度约 2× 慢」做回归修复，同时把「思考强度」做成可配置项。原则：**不牺牲质量、旧测试与旧配置保持兼容**。本文件是面向使用者的摘要；实现细节以 [OPTIMIZATION-0.6-SPEC.md](OPTIMIZATION-0.6-SPEC.md) 为准。

## 1. 档位重排：更少的代理与阶段

| 档位 | 参与代理上限 | 阶段流程 | 相对成本权重 |
| --- | ---: | --- | ---: |
| **S1 轻量** | 1 | generate → verify（2 阶段，1 代理） | ×2 |
| **S2 标准** | 3 | plan → generate → review → verify（4 阶段） | ×5 |
| **S3 完整** | 5 | 核心 5 阶段：research → plan → generate → review → regression；高风险追加 judge / redteam（完整 7 阶段） | ×10 |
| **S4 完整加强** | 8 | 完整 7 阶段：research → plan → generate → review → judge → redteam → regression；评审双路并行 | ×16 |

- **S1** 收敛为「生成 → 验证」两阶段、单代理，砍掉单独的评审环节——小任务不再为形式化的互审买单。
- **S3** 默认只跑核心 5 阶段（research / plan / generate / review / regression）；只有 `action=start` 显式传 `risk: "high"`（或 `strict`）才追加 `judge / redteam`（`regression` 在核心，始终执行）。计划通过 `generatePlan` 返回 `optionalStages / risk / stageCount`，高风险才进入可选阶段。
- **S4** 完整 7 阶段；其中「评审双路」指 **仅 `review` 阶段**由两个独立模型并行盲审（`min(parallelReviews, 已选模型数, 2)`），任一 FAIL 即该阶段 FAIL；其它阶段不并行。评审总步数 ≤ 7。

## 2. 思考强度（reasoning effort）

设置模型升到 `version: 3`，新增：

```json
{ "reasoning": { "default": "auto", "byRole": {}, "byModel": {} } }
```

- `default`：`auto` 或小写档位 id（`off / minimal / low / medium / high / xhigh / max`）。
- `byRole`：仅限 8 个角色键（research / plan / generate / review / judge / verify / redteam / regression）。
- `byModel`：键为 `provider::model`，值为档位 id。
- `SettingsStore.update` 对 `reasoning` 深合并：`default` 覆盖；`byRole` / `byModel` 各自浅合并，未提交的键保留。
- 设置面板保存时 payload 带 `reasoningReplace: true`，服务端整体替换 `reasoning`，以支持清除已删除的角色/模型覆盖；API 默认仍是深合并。

### 默认 auto 矩阵（`MODE_ROLE_EFFORT`）

未在角色/模型上覆盖时，按档位与角色查表：

| 档位 | 研究 | 计划 | 生成 | 评审 | 裁决 | 红队 | 验证 | 回归 | 其它(默认) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | — | — | low | low | — | — | off | — | low |
| S2 | — | high | high | low | — | — | low | — | medium |
| S3 | high | high | high | medium | high | high | low | low | medium |
| S4 | high | high | high | high | high | high | low | medium | high |

### 解析与降档（`resolveEffort`）

优先级：**按模型 > 按角色 > 全局默认 > 档位×角色矩阵**。

- 模型目录标记无 reasoning 能力（`efforts` 为空）→ 返回 `null`，调用方**省略** `reasoning_effort` 参数，照常调用、不报错。
- 首选档不在模型可选档内 → 按 `EFFORT_ORDER`（`off → minimal → low → medium → high → xhigh → max`）**向下就近降档**，再退回该模型默认档。

### 落地位置

`buildTeamPlaybook`、`buildRoster` 与 `briefing` 的 delegation 会带上 `reasoning_effort`（无则省略），`modelRouting` 带 `effort`；Lead 按此在 `subagent(...)` 处传参。

## 3. 提示词与返回瘦身

为压低固定开销，0.6.0 精简了注入文本：

- `TOOL_DESCRIPTION` 收敛到约 5 行，删除 `send_message / wait_agent / team_task_list` 监督表述，保留 `start → briefing → record → finish`。
- `_stageDescription` ≤ 500 字、`_spawnPrompt` ≤ 400 字；队员最终回答即回执，去掉多余轮询。
- `buildPolicy`：Lead ≤ 3（锁定）/4 行、队员 ≤ 3 行，去 `wait_agent` 轮询、保留「回执」。
- `record` 返回结构瘦身；`state` 动作对 runs/tasks/events 做截断。

## 4. 面板

设置新增「思考强度」页：默认策略摘要、当前档位、生成 high·评审 medium·验证 low 预览、全局默认下拉、8 角色覆盖表、按模型覆盖列表（模型不支持时显示「不支持思考强度」）。保存 payload 始终带 `reasoning`。

## 5. 兼容与验收

- 旧 `settings.json`（version 2）自动补齐 `reasoning` 并按 version 3 规整，无需手改。
- 不支持 reasoning 的模型不传 `reasoning_effort`；S4 实际代理步数 ≤ 8（review 双路，其余阶段单步）；花名册名字带 run 后缀，跨 run 不重名。
- `npm run ci`（check + test + pack:check）全绿。
