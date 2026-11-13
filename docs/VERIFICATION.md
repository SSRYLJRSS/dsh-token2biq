# Token 2b IQ 验证记录

本文件记录 `dsh-token2biq` 在交付时的可复现验证证据与残余步骤。

## 一、可复现命令

```bash
cd F:/deepseekwork/multi-agent-orch/dsh-token2biq

# 静态语法
for f in lib/*.js; do node --check "$f" || exit 1; done

# 单元 + 集成（纯逻辑，内存 store，不依赖宿主）
node --test test/orchestrator.test.js test/budget-guard.test.js \
           test/receipts.test.js test/service.integration.test.js

# 装载冒烟：宿主入口 + web 路由 + client 槽位注册
node test/smoke-load.mjs

# 工具注册分支冒烟：临时 @deepseek-ai/dsh-tools 桩件驱动 defineTool
node test/smoke-tool.mjs
```

## 二、结果摘要

| 检查 | 结果 | 覆盖点 |
| --- | --- | --- |
| `node --check lib/*.js` | 全部通过 | 语法 |
| 单元 + 集成 | 25 / 25 | PLANS 数据、classify、预算边界(80%/100%)、回执校验、S1 全链路、字符估算、预算熔断、S2→S3 闸门升级、Auto→S3、报告导出 |
| `smoke-load.mjs` | 11 / 11 | host `apply()` 可装载；`/token2biq` 前缀路由应答 `state`/`mode`/`export`；client 脚本在 `__ModuleLoader__` 下装载；`main`(keyed `key=token2biq`)、`sidebar.panellist`(list `id=token2biq`+图标)、`conversation.input.left`(list 紧凑下拉) 均正确注册 |
| `smoke-tool.mjs` | 9 / 9 | `defineTool` 分支：`token2biq` 工具注册、参数属性表(`ParameterSchemaSpec`)、`output.schema={type:'json'}`、`execute` 返回 content 块、`render` 返回 ContentBlock[] |

## 三、依据的运行时契约（已对照真实插件核对）

- **Slots**（`cordis_inspect_query client/Slots.listSubTree`）：
  - `main` 为 keyed，注册项只接受 `{ key }`；占用键 `conversation/lingshu/plugins/schedules/dsh-market` 等。
  - `sidebar.panellist` 为 list，注册项 `{ id, order?, label? }`，且其 `id` 用于寻址同名 `main` 键；单元格 ownerProps 为 `{ size, active }`（需渲染图标）。
  - 本插件：sidebar `id=token2biq` ↔ main `key=token2biq`；已修正早期“sidebar 未传组件”的缺陷。
- **工具注册**（对照已安装 `@furongjun1999/dsh-memory`）：
  - `import { defineTool } from '@deepseek-ai/dsh-tools'`（宿主 asar 提供的 optional peer，惰性导入 + 失败降级）。
  - `defineTool({ name, description, parameters:ParameterSchemaSpec, output:{schema:{type:'json'},render}, execute(args,exec)=>{content} })`，经 `ctx.tools.register(def)` 注册。

## 四、安装状态

- `plugin_manager install_bundle target=link:F:/deepseekwork/multi-agent-orch/dsh-token2biq` 成功：
  - `packageResult.exitCode=0`，`+ dsh-token2biq 0.1.0 <- F:\deepseekwork\multi-agent-orch\dsh-token2biq`
  - `bundle.enabled=true`，`application=restart-required`，`reason=no-hmr`
- desktop profile `dsh.profile.bundles` 已包含 `dsh-token2biq`（位于末尾）。
- `node_modules/dsh-token2biq` 为指向工程目录的符号链接。

## 五、残余步骤（需用户执行）

宿主 JS 只在 **启动时** 装载（`no-hmr`），无法在本进程内热加载，因此“在真实 GUI 里看到面板并跑通端到端”需重启 DSH：

1. 完全退出并重开 DeepSeek Harness。
2. 左侧栏出现「Token 2b IQ」图标，点击进入三视图面板且无报错（即 `/token2biq/state` 生效）。
3. 切换档位 → 让模型调用 `token2biq action=start` → 看板出现阶段/代理卡片、台账出现 token 进度 → `record`/`finish` 后与裁决联动。

如重启后面板异常，优先检查：
- profile 启动日志中是否有 `[token2biq] loaded, mode=...`；
- 浏览器控制台是否有 `/token2biq/state` 404（路由未注册＝宿主未加载）；
- 侧栏图标是否渲染（`sidebar.panellist` 组件为 `Token2bIQIcon`）。

## 六、UI 修复（第二轮，m00452 反馈）

针对「面板盖满整窗、无退出键、布局乱、开关要放到输入框下方」的反馈，仅改 `lib/client.js`（宿主不变，刷新页面即可）：

1. **退出/返回**：主面板左上角新增 `← 返回对话`、右上角新增 `×`，均调用 `layout.selectPanel(null)` 回到会话；点击打开后再关闭不会锁死界面。
2. **布局根因修复**：根容器由 `position:absolute; inset:0` 改为 `height:100%` 纵向 flex（仿 dshmarket 的 `.panelHost`：`box-sizing:border-box;height:100%;padding-top:calc(18px+var(--dsh-frame-top-clearance,0px))`），不再覆盖侧栏/顶栏。
3. **视觉统一**：改用 DSH 设计令牌（`--dsw-alias-label-*/border-l2/bg-layer-*/brand/state-*`，带回退），明暗主题自适应；看板与台账改为响应式两列、窄屏自动上下堆叠。
4. **（已被第三轮取代）** 原「输入框下方 composer dock 控制条」改为输入框工具行内的紧凑下拉，见第七节。

## 七、UI 修复（第三轮，m00574 反馈：太丑/太长/位置不对）

用户指出下方那条太长占位、不该用开关，应仿「完全权限 / 跟随默认」放在输入框上方的工具行、用下拉选择。据此再次重做 `lib/client.js` 的输入区控件：

1. **改位置**：从 `conversation.composer.dock`（输入卡下方）迁到 `conversation.input.left`——即「完全权限 / 自动继续 / 跟随默认」所在的 composer 工具行，`order:10` 靠左。
2. **改交互**：整条长控件换成**单个紧凑下拉**（`⚡ + 选择框 + ▾`，高 26px、宽约 80px），外观对齐「跟随默认」那类 pill：`appearance:none` 去原生边框、圆角 8px、`--dsw-alias-bg-layer-2` 底、`border-l2` 边。
3. **选项**：`关闭 / 自动 / 普通 / 进阶 / 大改`；选「关闭」= 本次不启用（icon 变灰），选其他即启用并 `POST /token2biq/mode`。启用状态按会话记 `localStorage`。
4. 去掉原来的开关、分段按钮与「面板›」按钮（面板仍可从左侧栏图标打开），彻底消除占位与割裂感。
5. 验证：`node --check` OK；`smoke-load` 11/11（断言改为 `conversation.input.left`）；单测 25/25；`smoke-tool` 9/9。

> 客户端代码按 DEV_GUIDE §9 可“刷新即生效”（HMR/refresh）；若强刷 `Ctrl+Shift+R` 后面板仍是旧样，请完整重启一次 DSH（宿主侧客户端代码在启动时打包）。当前运行实例已确认 `/token2biq/state` 返回 200 与正确档位数据。

## 八、UI 修复（第四轮，m00631 反馈：去 emoji / 加 IQ 前缀 / 原生下拉看不清）

用户指出：控件不要放 emoji（AI 味重）；前面加两个大写字母 `IQ` 表明是本模块；原生 `<select>` 弹出层在白底下看不清。据此重做输入区控件：

1. **去 emoji**：移除 `⚡`，改为纯文字 `IQ`。
2. **加前缀**：控件显示为 `IQ 自动 ▾`——`IQ` 为 700 字重标签，点明是 Token 2b IQ 模块。
3. **自研下拉**：废弃原生 `<select>`，改为受控自定义菜单（`position:fixed`，按按钮 `getBoundingClientRect` 定位，避开发送器 overflow 裁剪）。菜单底色 `--dsw-alias-bg-layer-3`（回退 `#303034` 实色）+ `border-l2` + 阴影，选项文字 `--dsw-alias-label-primary`，hover 高亮 `bg-layer-2`，当前项品牌色加 `✓`——深/浅色主题下均可读。
4. 选项仍为 `关闭 / 自动 / 普通 / 进阶 / 大改`；选「关闭」= 本次不启用（数值变灰），选其他即 `POST /token2biq/mode`；点击外部/滚动/缩放自动收起。
5. 验证：`node --check lib/client.js` OK；`smoke-load` 11/11；单测 25/25；`smoke-tool` 9/9。

> 该轮同样只改 `lib/client.js`；需重开一次 DSH 生效（客户端代码启动时打包，运行实例无 dev:web 热更）。

> 修复（m00672）：下拉只剩「关闭」一项——原因是 `position:fixed` 菜单被发送器祖先的 `overflow:hidden` 裁剪，只剩首项可见。改为 `ReactDOM.createPortal(menu, document.body)` 渲染到 body 根部，彻底跳出裁剪；并用 `bottom: window.innerHeight - rect.top + 6` 锚定向上展开（适配底部输入区），`maxHeight:70vh; overflowY:auto`，5 个选项全部可见。

## 九、可行性与 token 审计 + 面板重构（第五轮，m00704）

1. **可运行性（真实宿主探针）**：对运行中的 `http://127.0.0.1:59673/token2biq` 用 Node fetch 完整跑通 S2 流水线——`action=start`→`record(generate)`→`record(review FAIL)`→`record(review PASS)`→`record(verify PASS)`→`finish PASS`；最终 `/state` 显示 stages `plan:0,generate:1,review:2,verify:1`、spent=4040、verdict=PASS。结论：**插件端到端可用**；此前面板空是因为没有任何回合真正调用过 `token2biq`（面板只展示运行数据）。
2. **token 开销审计与精简**：旧工具 schema ≈3197 字节（描述 970B + 参数 2227B）。精简为 3 行描述 + 17 个短参数（去掉 role/brief/logs/byJudge，缩短 desc），实测 **1429 字节**（描述 254B + 参数 1175B），降幅约 55%；新增 `action=help` 按需返回字段说明，避免长说明常驻 schema。
3. **真实 token 观测**：宿主新增 `ctx.on('llm/stream', ...)`，捕获每次模型调用的 `{type:'usage'}` 分片，`service.noteUsage(usage, sessionId)` 按会话累计；`/token2biq/state` 的 `liveUsage` 暴露全局 + 各会话用量，无运行也能显示真实数字。
4. **面板重构为仪表盘**：顶部 4 张指标卡（当前档位/运行数/预算占用/实时 token）；档位条；看板空态改为“三步开始 + 排查提示”；右栏运行台账 + 实时 token 观测表；底部“只编排不执行”说明。

验证：`node --check lib/*.js` 全 OK；单测 25/25；`smoke-load` 11/11；`smoke-tool` 9/9；`node -e` 验证 `noteUsage` 聚合（150+15=165）与 `action=help` 正常。**本轮改了宿主 `lib/index.js`、`lib/service.js` 与 `lib/client.js`，必须完整重启 DSH 才生效。**

## 十、工具注册修复：link: 插件不依赖宿主内部包（本轮）

- **现象**：面板与 HTTP `/token2biq/action` 正常，但 agent 可调用工具清单里没有 `token2biq`（工具调用 0/3 失败），只能退回 HTTP 等价调用。
- **根因**：`lib/index.js` 早期用 `await import('@deepseek-ai/dsh-tools')` 动态取 `defineTool`。该包只存在于宿主 `app.asar` 内部（profile `node_modules/@deepseek-ai` 与 `app.asar.unpacked/dsh/node_modules/@deepseek-ai` 均无此目录），link: 插件动态解析失败 `ERR_MODULE_NOT_FOUND` → `defineTool=null` → 跳过 `ctx.tools.register`，只剩面板 + HTTP 分支。
- **修复**：改用「原生工具定义对象」直接 `ctx.tools.register(toolDef)`，**完全不依赖** `@deepseek-ai/dsh-tools`。形状参考已装插件 `@changfenhuang/dsh-genui`（`createRenderUiTool()`）与 billion-context：`{ name, description, parameters:<完整 JSON Schema>, output:{ schema:{type:'string'}, render(_a,v)=>[{type:'text',text:String(v)}] }, async execute(args){ return 字符串 } }`。参数改为完整 `type:'object'` JSON Schema（`properties` + `required:['action']` + `additionalProperties:false`）。
- **验证**：`test/smoke-tool.mjs` 重写为「无桩」测试（断言源码不 import `@deepseek-ai/dsh-tools`、并校验 name / parameters JSON Schema / output.schema / execute 返回 / render 返回 ContentBlock[]）→ **11/11**；单测 25/25；`smoke-load` 11/11；`smoke-usage` 5/5。
- **生效条件**：本轮改的是宿主 `lib/index.js`，**必须完整重启 DSH**；重启后 `cordis Host Tool.listTools` 应出现 `token2biq`，即可在对话中真正调用工具跑工作流。

## 十一、对照宿主 `ToolDefinition` 契约复核（无重启验证）

- 用 `cordis_inspect_query`（host `Service.listService({service:'tools'})`）取到权威 `ToolDefinition` 接口：
  ```
  interface ToolSchema { deferLoading?: true; name: string; description: string; parameters: Record<string, unknown>; }
  interface ToolOutputDefinition { readonly schema: JsonSchemaNode; render(args, value): ContentBlock[]; presentationMeta?(args, value): JsonValue; }
  interface ToolDefinition extends ToolSchema {
    readonly output: ToolOutputDefinition;
    execute(args, exec: ToolRunContext): Promise<unknown>;
    timeoutMs?; isConcurrencySafe?(args); presentCall?; presentResult?;
  }
  ```
- 我的 `toolDef` 逐项对齐：`name:'token2biq'`、`description`、`parameters`={完整 JSON Schema，type:'object' + properties + required:['action'] + additionalProperties:false}（满足 `Record<string,unknown>`，与 genui 完全相同）、`output.schema={type:'string'}`（= `JsonSchemaNode`）、`output.render→[{type:'text',text}]`、`async execute(args)=>string`（满足 `Promise<unknown>`）。可选字段 `timeoutMs/isConcurrencySafe/presentCall/presentResult` 全部省略——均为可选。
- **参照已装可用插件 `@changfenhuang/dsh-genui/lib/index.js:6307 createRenderUiTool()`**：其 `parameters: RENDER_UI_PARAMETERS` 正是 `{type:'object',properties,required,additionalProperties:false}`（第 6163-6194 行），`output.schema = RENDER_UI_OUTPUT_SCHEMA = {type:'string'}`（第 6196 行），`async execute(args){ return '...'.join("\n") }`。**形状与我的工具定义逐字一致**，而 genui 的 render_ui 确已在本机工具清单中可用 ⇒ 证明该形状会被 `ctx.tools.register` 正常接受。
- 结论：**工具注册代码已按权威接口 + 可用参考实现双重核对，逻辑上必然注册成功**；剩下的只是「宿主进程仍加载旧 index.js」，需一次完整重启把新文件载入。
- 本轮同步把 `test/smoke-tool.mjs` 加严为 13 项契约断言（含 execute/render 为函数、parameters JSON Schema、files 数组、output.schema string、execute(start) 返回串含 S1+runId、render 返回 ContentBlock[]）。

## 十二、最后一轮：真实宿主注册确认 + 面板 UI 打磨

### 12.1 工具已在真实宿主注册（重启后实测，决定性证据）
- DSH 完整重启后（GUI http://127.0.0.1:63685）。
- `cordis_inspect_query` host `Tool.listTools` 的返回中**明确出现** `name:"token2biq"`，description 为 3 行精简版，parameters 为完整 JSON Schema（required:['action']、action 枚举含 start/record/finish/pause/resume/export/list/mode/state/help、files/testsRun 为 string 数组、additionalProperties:false）。→ 修复（原生定义对象，不依赖 @deepseek-ai/dsh-tools）生效。
- HTTP 复测：`POST /token2biq/action {action:'help'}` → 200 ok（新 service 已加载）；`GET /token2biq/state` → mode=Auto、含 liveUsage。

### 12.2 面板 UI 打磨（符合“不拥挤 / 一眼看到 / 少操作”）
- **流水线看板**：从「固定 172px 横向列 + 横向滚动」改为**响应式卡片网格**（`grid-template-columns: repeat(auto-fill, minmax(210px,1fr))`）。每个阶段一张卡片，随窗口宽度自动换行，不再需要横向滚动、不会把 S3 的 7 个阶段挤成一排。
- **档位条**：从 4 张高卡片压缩为**分段胶囊**（`档位  Auto·自动 / S1·普通 / S2·进阶 / S3·大改`），一行可见，描述改悬停提示。
- 其余：指标卡自适应换行；左看板/右台账在窄屏自动堆叠；`←`/`×` 关闭按钮保留；无 emoji；配色走 `--dsw-alias-*`。
- 验证：`node --check lib/client.js` OK；`smoke-load` 11/11（仍注册 main keyed / sidebar / conversation.input.left）。

### 12.3 生效方式
- 打开面板前**刷新一次页面**（Ctrl+R）；若浏览器缓存了旧 bundle 未变，则完整重启一次 DSH。宿主 `lib/index.js` 未再改动，无需重装。
