# Token 2b IQ 架构与维护边界

本文描述当前插件的职责和验证边界。审查与验收状态见 [审查台账](AUDIT-2026-11-16.md)，验证方法见 [验证指南](VERIFICATION.md)。

## 执行模型

插件提供档位策略、任务板、阶段回执、账本和 Web 面板。官方 Agent Teams 提供真实代理执行、共享任务所有权、消息与等待。start 的自动编排部分只创建任务并返回派活简报或模型路由；它不会自行启动子代理。Lead 仍需调用官方 subagent、领取/分配任务、推进依赖、收集结果。官方团队开关与模型授权由官方设置管理：插件通过 [host-integration.js](../lib/host-integration.js) 解析精确活跃根会话并调用官方 `agentTeams.setEnabled`，不复制官方持久化，也不追加 `subagent/model-selection-policy`。

典型流程：start → 建板并返回 briefing/modelRouting → Lead 启动代理 → 队员领取可执行任务并完成 → Lead record 阶段回执 → 验证与 finish。任务就绪不等于队员已经启动，任务完成也不等于插件自动收到阶段回执。

## 模块职责

| 模块 | 对外职责 | 维护约束 |
| --- | --- | --- |
| [index.js](../lib/index.js) | 插件装载、工具定义、HTTP、宿主事件与提示注入 | 宿主契约和权限校验集中在这里；测试不依赖私有包解析 |
| [service.js](../lib/service.js) | start/record/finish、团队建板、设置与查询投影 | 业务动作的统一入口；错误和降级必须真实返回 |
| [orchestrator.js](../lib/orchestrator.js) | 档位、计划、角色、派活说明 | 纯策略数据；计划中的依赖与实际任务板必须一致 |
| [stage-state.js](../lib/stage-state.js) | 阶段有效状态聚合 | 每个执行 slot 取最新回执；任一失败即失败；重试通过可自愈 |
| [host-integration.js](../lib/host-integration.js) | 官方团队开关适配：解析活跃根会话、读取/写入官方 team 状态 | 只调用官方 isEnabled/setEnabled/rootOf；失败返回真实原因，不伪造回滚 |
| [receipts.js](../lib/receipts.js) | 分阶段结构化回执校验 | 研究/计划与代码实现的必填字段不同；矛盾回执直接拒收 |
| [run-store.js](../lib/run-store.js) | Run、阶段、任务、评审、事件和 token 快照 | 文件失败不能伪装为持久化成功；并发快照不等于数据库事务 |
| [settings.js](../lib/settings.js)、[paths.js](../lib/paths.js) | 设置归一、兼容迁移、路径解析 | 保持纯内存哨兵与默认路径区别 |
| [model-routes.js](../lib/model-routes.js) | 模型引用解析、目录整理 | 配置了模型不代表执行时已经使用；目录可见不代表官方授权 |
| [client.js](../lib/client.js) | IQ 控件、运行/设置面板和 HTTP 交互 | 不复制服务端门禁；失败必须反馈，不能只显示乐观成功 |
| [report.js](../lib/report.js) | Markdown 报告投影 | 与状态查询使用相同统计口径 |

## 策略不等于运行时承诺

S1 为 generate/review/verify；S2 增加 plan；S3/S4 为 research/plan/generate/review/judge/redteam/regression。S4 的角色池可产生多个评审执行位置。阶段内并行与阶段间依赖是不同概念：下游必须等待上游整组完成，不能仅依赖最后一个评审。

reviewRounds 当前是计划元数据，并没有自动执行相应轮数的调度循环。不能将其显示或描述为已经完成的互审轮数。maxAgents 是派活规划上限，不能替代宿主对实际并发数的控制。costWeight 是相对权重，不是费用报价。

宿主模型授权由宿主管理。模型目录可见不等于全部模型已获子代理授权；插件不能因保存角色设置而自动扩大权限。官方模型策略采用 first-wins，重复追加不是覆盖配置。插件不追加 `subagent/model-selection-policy`；旧 `applySubagentModelPolicy` 仅作为显式拒绝的兼容导出。

模型白名单、独立评审、strict 门禁和预算提示分别有自己的校验条件。回执中的模型与所有者属于上报信息；单靠上报字段不能证明底层执行确实采用该模型。硬预算检查也不能中断外部已启动的代理或限制宿主全部 token 消耗。

## 状态文件与测试隔离契约

默认宿主路径由 DSH_HOME（未设置时为用户目录下 .dsh）解析。显式路径用于指定独立快照。null 必须保留纯内存含义：默认值只能在参数未提供时选择，不能用 || 或 ?? 把 null 替换成真实用户路径。审查时发现入口与设置存储破坏该语义，修复验收见审查台账。

测试必须再使用临时 DSH_HOME 作为兜底，使任何遗漏默认路径的测试都无法写入真实历史。运行快照和设置快照都要覆盖。测试结束应比较真实快照的哈希和修改时间；只看测试退出码不能证明隔离。

快照写入采用 `.lock` 独占、锁内重读、三方合并、原子 `rename`；合并基线只在成功后前移，失败可重试且不重复计量。删除与淘汰写墓碑，防止旧快照复活。存活 owner 不按年龄过期；死 PID 由 `.reap` 守卫串行回收；owner 未知或不完整时 fail-closed。

该协议要求写入者遵守同一锁规则；不承诺旧版不合作写入者、网络文件系统锁语义或断电fsync持久性。锁owner未知或不完整时拒绝写入，不以年龄阈值擅自删除。不能由“使用临时文件”推导出数据库式事务保证。

## HTTP 入口与授权

`connection.requestRejection` 是唯一授权来源：未认证 401、连接服务缺失或异常 503；拒绝后无条件返回，不进入业务分支。POST 仍要求 `application/json`（415）。`GET /token2biq/host` 只读官方团队状态，`POST /token2biq/host/team` 仅在显式请求时调用官方 setter；两者都不代表页面刷新即可生效。

## token 与会话范围

ledger 为回执上报或字符估算，real/liveUsage 为宿主 usage 事件观测，两者不可相加成一份精确账单。宿主 usage 的运行归集目前依赖进程内活动运行：运行窗口内其他同进程调用可能计入，不能声称逐运行、逐任务或逐代理精确归因。会话维度的观测也不自动建立父子代理到运行的归属关系。

当前会话偏好、全局默认和快照 mode 的实现涉及不同存储层；会话关闭、档位选择及重启后的行为需分别测试。不要从浏览器 localStorage 或全局 mode 推断服务器已经恢复每个会话的开关。

## 装载与验证边界

宿主入口及服务代码通常在启动时装载，源码变更后需要宿主重载/重启。客户端自动更新仅在宿主对应的客户端构建链正在工作时成立；单纯修改源码并刷新不能保证旧 bundle 已被替换。验证必须针对原有 GUI，并记录它是否实际加载本次产物。

离线真实 React fixture（Node vm 中加载 React/ReactDOM）只验证组件逻辑与可访问性，不等于当前 GUI。当前 live URL 未认证时返回 401，不能据此宣称浏览器端到端通过。`DSH_OFFICIAL_SRC` 未设置时官方源码比对会条件跳过，跳过不等于通过。

Node 单元测试、宿主契约 mock、客户端装载 mock 和真实浏览器测试是不同证据。任何一种通过都不能替代另外几种。
