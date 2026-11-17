# Token 2b IQ 档位设计与 reasoning effort 默认策略（2026-11-17）

范围：本文件只做设计结论与实施计划，不改代码、测试或 README。当前档位矩阵与思考强度解析见
[lib/orchestrator.js](../lib/orchestrator.js#L112-L154)、[lib/client.js](../lib/client.js#L267-L282)、
[lib/service.js](../lib/service.js#L291-L314)。文中行号是调查时的位置，后续编辑可能移动。

## 1. 用户问题与结论

问题：Token 2b IQ 的 S1/S2/S3/S4 档位应如何设置各阶段的 reasoning effort？是否应全部默认 high？
哪些阶段适合 xhigh？宿主真实模型是否真的支持这些强度？

结论（bottom line）：

1. **宿主上当前的强度设置全部失效。** 编排层读取的是 `reasoning.efforts`，而真实模型目录用的是
   `reasoning.supportedEfforts` / `reasoning.defaultEffort`，字段名错配导致 `resolveEffort` 对真实模型
   一律返回 `null`，所有按档位/按角色/按模型的强度设置都变成死配置（实际执行回落到宿主默认强度）。
2. **修复字段错配是前提，然后推荐「每个档位都以 high 为地板」的矩阵**：S1–S4 的所有会改变产出或做验收的
   阶段，effort 不低于 high；不再出现 `off`/`low`/`medium` 的产出阶段。
3. **xhigh 只给 S3 的 judge 与 S4 的 plan/review/judge/redteam**（高判断/高对抗/强规划阶段）。模型不支持
   xhigh 时自动向下回退到 high，不需要单独判断。
4. **research 默认 high，可选按角色降到 medium** 以省成本；high 仍是默认地板。
5. **绝不自动用 off/minimal/max。** 特别地：max 在实测中相比 xhigh 反而质量回退，且耗时/成本最高，
   不应作为任何阶段的自动默认。

## 2. 宿主真实模型能力表（18 个模型）

数据来源：宿主 `.workbuddy-catalog.json`（`entries` 数组，每个模型的 `reasoning` 对象）。
关键字段：`reasoning.supports`（是否支持思考）、`reasoning.supportedEfforts`（可选强度列表）、
`reasoning.defaultEffort`（默认强度）、`reasoning.canDisableThinking`。

| 模型 | 可选强度（supportedEfforts） | 默认（defaultEffort） | 备注 |
| --- | --- | --- | --- |
| hy4-preview | high | high | 仅 high |
| hy3 | （无列表，仅默认） | high | 不可选档 |
| hy3-x | （无列表，仅默认） | high | 不可选档 |
| step-5-preview | low, medium, high | high | |
| space-bunny | low, medium, high, xhigh, max | max | **唯一支持 xhigh** |
| deepseek-v4.1-flash | low, high, max | high | 无 medium；当前 workbuddy 主力 |
| glm-5.3 | low, high, max | max | 默认 max |
| glm-5.3-flash | low, high, max | high | |
| glm-5.2 | （无列表，仅默认） | medium | 旧模型，仅默认中 |
| glm-5.1 | （无列表，仅默认） | medium | 旧模型 |
| glm-5v-turbo | （无列表，仅默认） | medium | 旧模型 |
| minimax-m3 | （无列表，仅默认） | medium | |
| minimax-m2.7 | （无列表，仅默认） | medium | |
| kimi-k3-1 | （无列表，仅默认） | medium | |
| kimi-k2.8-preview | low, high, max | high | |
| kimi-k2.7 | （无列表，仅默认） | medium | |
| kimi-k2.6 | （无列表，仅默认） | medium | |
| deepseek-v4-pro | （无列表，仅默认） | high | 不可选档 |

归纳要点：

- **high 是唯一「所有可选档模型都提供」的强度**；xhigh 只有 space-bunny 支持；off/minimal 没有任何模型暴露。
- 有可选强度的模型里，常见组合是 `low/high/max`（deepseek-v4.1-flash、glm-5.3、glm-5.3-flash、kimi-k2.8-preview），
  即 **没有 medium**，选 medium 会被回退到 high/low。
- 旧模型（glm-5.2/5.1/5v-turbo、minimax、kimi-2.6/2.7/k3-1）只暴露 `defaultEffort`，**无可选强度**：给它们「设 high」
  在协议上也无法生效，只能吃模型自身默认（多为 medium）。这类模型的上限靠换模型，不靠调档。
- space-bunny、glm-5.3 默认就是 max，属于「默认已经最高」的少数；其余默认 high 或 medium。

## 3. 字段错配 Bug 与复现

**位置**

- [lib/orchestrator.js:142](../lib/orchestrator.js#L142)：
  `const rawEfforts = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : [];`
- [lib/client.js:650](../lib/client.js#L650)：
  `const efforts = m && m.reasoning && Array.isArray(m.reasoning.efforts) ? m.reasoning.efforts : [];`

**真实宿主目录字段**（见 `.workbuddy-catalog.json`，deepseek-v4.1-flash 例）：

```json
{ "reasoning": { "supports": true, "onlyReasoning": true,
  "supportedEfforts": ["low", "high", "max"],
  "defaultEffort": "high", "canDisableThinking": true } }
```

而 `lib/service.js:303` 是原样把 `m.reasoning` 放进 `modelMeta`：

```js
modelMeta[g.id + '::' + m.id] = { reasoning: m.reasoning || null };
```

所以 `resolveEffort` 在 [lib/orchestrator.js:142](../lib/orchestrator.js#L142) 读到 `reasoning.efforts === undefined` →
`rawEfforts = []` → `effortIds = []` → 命中 [第 145 行](../lib/orchestrator.js#L145) `if (!effortIds.length) return null`。

**复现（node 直接调用，已跑通）**

```text
catalog supportedEfforts= ["low","high","max"] defaultEffort= high
resolveEffort(S2, generate, deepseek-v4.1-flash) => null      // 错误：本应 high
control with reasoning.efforts => "high"                       // 用旧字段名就正常
```

**影响**

- 编排层：每个阶段的 `resolveEffort` 对真实模型都返回 `null`，调用方省略 `reasoning_effort`，
  **实际执行强度 = 宿主 defaultEffort**（如 deepseek-v4.1-flash 就是 high、glm-5.2 就是 medium），
  而按档位矩阵、`settings.reasoning.byRole`、`byModel` 的覆盖全部不生效。
- UI 层：[lib/client.js:650](../lib/client.js#L650) 同样用错字段，导致「按模型覆盖」下拉把
  deepseek-v4.1-flash 等显示为「不支持思考强度」，可选强度被清空。
- 结论：**在真实宿主模型上，所有 UI/设置的思考强度配置都是死开关**。这是必须先修的 P0 级正确性问题。

## 4. 推荐档位矩阵与理由

设计原则：

1. **high 地板**：凡改变产出、做评审/验收的阶段 effort ≥ high。
2. **xhigh 只给判断/对抗/强规划**：不支持时按 `EFFORT_ORDER` 向下回退到 high（现有 [第 147–150 行](../lib/orchestrator.js#L147-L150)
   的下探逻辑在字段修复后即可自动完成 xhigh→high）。
3. **绝不自动 off/minimal/max**：矩阵里不出现这三档；max 只能用户显式覆盖。
4. **research 可降级**：成本敏感场景允许按角色把 research 设 medium，high 仍是默认地板。

推荐矩阵（`MODE_ROLE_EFFORT`）：

| 档位 | research | plan | generate | review | judge | redteam | verify | regression | 兜底 default |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | — | — | high | — | — | — | high | — | high |
| S2 | — | high | high | high | — | — | high | — | high |
| S3 | high | high | high | high | xhigh | high | high | high | high |
| S4 | high | xhigh | high | xhigh | xhigh | xhigh | high | high | high |

（“—”表示该档不含此阶段：S1 只有 generate/verify；S2 没有 research/judge/redteam；S3/S4 无 research 以外差异由档位定义。）

与现状对比（[lib/orchestrator.js:112-117](../lib/orchestrator.js#L112-L117)、[lib/client.js:271-276](../lib/client.js#L271-L276)）：

- S1：`low/review low/verify off/default low` → 改为 `generate high + verify high`，去掉 review、兜底 high。
- S2：`review low/verify low/default medium` → **四个阶段全 high**，兜底 high。
- S3：`review medium / verify low / regression low` → `review high / verify high / regression high`，judge 升 xhigh。
- S4：`plan high → xhigh、review high → xhigh、judge/redteam → xhigh、verify low → high、regression medium → high`。

**为什么这样调（实测证据）**

GPT-6 Sol 基准（同一任务，effort 递增）：

| effort | 质量分 | 成本($) | 耗时(s) |
| --- | --- | --- | --- |
| low | 50.3 | 0.1748 | 98 |
| medium | 51.3 | 0.2708 | 146 |
| high | 54.7 | 0.3874 | 238 |
| xhigh | 61.3 | 0.5817 | 327 |
| max | 57.0 | 0.9845 | 618 |

- high→xhigh 有明显质量增益（54.7→61.3），但成本/耗时约 1.5×/1.4×，所以只给最需要判断力的阶段。
- **max 相比 xhigh 质量回退（57.0 < 61.3），耗时却近 2×、成本 1.7×**，因此绝不自动 max。
- 行业实践：OpenAI/Vellum 指出 **medium 是常规默认、high 用于复杂编码/数学**；FutureSearch 2026 的 150+ 网页
  研究任务中，high 对 4 个模型里的 3 个「等于或差于」更低档，**research 不应默认 xhigh**——这与本矩阵一致：
  research 用 high（可选 medium），xhigh 只用在判断类阶段。

## 5. 实施计划与验收测试

实施（拆成小步、每步可回滚）：

1. **修字段错配（P0，两处）**：`orchestrator.js:142` 与 `client.js:650` 改为
   `const raw = reasoning.supportedEfforts || reasoning.efforts`（保留旧字段兜底），并统一用
   `reasoning.defaultEffort || reasoning.default`。
2. **更新矩阵（两处，保持同步）**：`orchestrator.js:112-117` 的 `MODE_ROLE_EFFORT` 与
   `client.js:271-276` 的 `V3_EFFORT_MATRIX` 一起替换为第 4 节矩阵；建议后续把矩阵抽成单一来源再让
   client 引用，避免两处漂移（本轮仅记录建议，不改结构）。
3. **回退确认**：字段修复后核对 `EFFORT_ORDER` 下探逻辑，确保 xhigh 在 `low/high/max` 模型上落到 high；
   确保矩阵不再产出 off/minimal/max。
4. **UI 文案**：确认 `byModel` 下拉对 deepseek-v4.1-flash 显示 low/high/max 而非「不支持」。

验收测试：

- [ ] 用真实 catalog 的 `reasoning` 对象调用 `resolveEffort({mode:'S2',stage:'generate',modelRef:'...::deepseek-v4.1-flash'})` 返回 `'high'`（不再是 `null`）。
- [ ] `resolveEffort` 对 `xhigh` 目标、模型只支持 `low/high/max` 时返回 `'high'`。
- [ ] 对仅 `defaultEffort: 'medium'`、无 `supportedEfforts` 的旧模型，`resolveEffort` 返回 `null`（省略参数，吃宿主默认 medium），且不报错。
- [ ] 矩阵所有 stage 的取值 ∈ {high, xhigh}，不含 off/minimal/max。
- [ ] UI `byModel` 下拉对 deepseek-v4.1-flash 列出 low/high/max。
- [ ] 现有全量测试（约 250 条）与 `pnpm check`/`pnpm test` 仍通过；不新增对真实 `DSH_HOME` 的写入。

## 6. 明确的非目标 / 风险

- **max 可能回退**：实测 max 质量低于 xhigh，且耗时/成本最高。因此本设计**不把 max 作为任何自动默认**；
  需要时只允许用户显式覆盖。
- **成本**：high 相较 low 约 2.2× 成本（0.3874 vs 0.1748）；xhigh 更高。S3/S4 阶段多、并发高，成本会放大。
  缓解：research 允许按角色降到 medium；不默认 xhigh 给全部阶段。
- **弱模型无法靠 effort 弥补**：旧模型（glm-5.2/5.1/5v-turbo、minimax、kimi-2.6/2.7/k3-1）无可选强度、
  默认 medium，调档无效；其质量上限只能靠更换模型解决，不是 effort 策略能修的。
- **非目标**：本轮不改动调用协议/宿主 API，不引入新的 effort 档，不调整 `EFFORT_ORDER`，
  不做成本预算上限（`costWeight` 仍仅展示），不改 README/测试。
- **依赖前提**：以上收益全部建立在第 5 节第 1 步「字段错配已修」之上；未修之前矩阵调整没有实际效果。
