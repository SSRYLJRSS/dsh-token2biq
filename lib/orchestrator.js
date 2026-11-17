// Token 2b IQ 编排策略 —— 纯数据 + 纯函数，无副作用，可单测。
// 5 档位：S1 轻量 / S2 标准 / S3 完整 / S4 完整加强 / Auto 自动。设计依据 DEV_GUIDE §3。

export const MODES = ['Auto', 'S1', 'S2', 'S3', 'S4'];

// 并行多审：S4 下评审/裁决/红队按角色池拆成每模型一个子步骤，最多取池前 N 个。
export const MAX_PARALLEL_REVIEWS = 5;

// 档位元信息，供 UI 与工具描述展示。
export const MODE_META = {
  Auto: { name: 'Auto', label: '自动', desc: '按任务复杂度自动选档（轻量启发式分类）', maxAgents: 0 },
  S1: { name: 'S1', label: '轻量', desc: '轻量：1 个执行代理 + 轻量验证', maxAgents: 1 },
  S2: { name: 'S2', label: '标准', desc: '多代理分视角 + 多轮互审 + 独立验证', maxAgents: 3 },
  S3: { name: 'S3', label: '完整', desc: '完整核心 5 阶段：研究 + 计划 + 实现 + 评审 + 验证', maxAgents: 5 },
  S4: { name: 'S4', label: '完整加强', desc: '完整加强 7 阶段双路评审（review 双模型并行），任一评审 FAIL 即该阶段 FAIL', maxAgents: 8 },
};

// 各档位流水线（纯数据）：stages 阶段序列；reviewRounds 互审轮数；budgetX 相对成本权重（档位角色数代理，仅展示）。
export const PLANS = {
  S1: { maxAgents: 1, stages: ['generate', 'verify'], coreStages: ['generate', 'verify'], optionalStages: [], reviewRounds: 1, budgetX: 2 },
  S2: { maxAgents: 3, stages: ['plan', 'generate', 'review', 'verify'], coreStages: ['plan', 'generate', 'review', 'verify'], optionalStages: [], reviewRounds: 3, budgetX: 5 },
  S3: { maxAgents: 5, stages: ['research', 'plan', 'generate', 'review', 'judge', 'redteam', 'regression'], coreStages: ['research', 'plan', 'generate', 'review', 'regression'], optionalStages: ['judge', 'redteam'], reviewRounds: 3, budgetX: 10 },
  S4: { maxAgents: 8, stages: ['research', 'plan', 'generate', 'review', 'judge', 'redteam', 'regression'], coreStages: ['research', 'plan', 'generate', 'review', 'judge', 'redteam', 'regression'], optionalStages: [], reviewRounds: 3, budgetX: 16 },
};

// 阶段中文名，供 UI 展示。
export const STAGE_LABEL = {
  research: '研究', plan: '计划', generate: '生成', review: '评审',
  judge: '裁决', verify: '验证', redteam: '红队', regression: '回归', other: '其他',
};

const ALIASES = {
  auto: 'Auto', '自动': 'Auto', '普通': 'S1', '进阶': 'S2', '大改': 'S3', '轻量': 'S1', '标准': 'S2', '完整': 'S3', '完整加强': 'S4',
  s1: 'S1', s2: 'S2', s3: 'S3', s4: 'S4',
};

// 归一化档位名（容忍大小写 / 中文别名）。无法识别时回退 Auto。
export function normalizeMode(mode) {
  if (mode == null || mode === '') return 'Auto';
  const s = String(mode).trim();
  if (s === 'Auto' || s.toLowerCase() === 'auto') return 'Auto';
  if (PLANS[s]) return s;
  const al = ALIASES[s] || ALIASES[s.toLowerCase()];
  return al || 'Auto';
}

const BIG_SIGNALS = ['架构', '重构', '整个', '整个项目', '系统', '多文件', '迁移', '大改', '重写', '改造', '端到端', 'refactor', 'architecture', 'rewrite', 'migrate', 'multiple files', 'whole', 'redesign', 'end-to-end'];
const SMALL_SIGNALS = ['小', '单个', '修复', 'bug', 'typo', '简单', '改一个', '一行', 'one file', 'fix', 'small', 'minor', 'quick'];

// 轻量启发式分类器：纯函数、确定性。返回 'S1' | 'S2' | 'S3'。
export function classify(goal = '') {
  return classifyDetailed(goal).tier;
}

// 详细分类：除档位外给出「是否拿得准」——用于 Auto 混合模式。
// 有把握（明显小 / 明显大）直接定档；拿不准（中间地带）交给模型复核。
export function classifyDetailed(goal = '') {
  const text = String(goal || '');
  const g = text.toLowerCase();
  let big = 0, small = 0;
  for (const k of BIG_SIGNALS) if (g.includes(k)) big++;
  for (const k of SMALL_SIGNALS) if (g.includes(k)) small++;
  const len = Array.from(text).length;
  let score = big * 2 - small;
  if (len > 400) score += 2; else if (len > 150) score += 1; else if (len < 40) score -= 1;
  const tier = score >= 3 ? 'S3' : score >= 1 ? 'S2' : 'S1';
  const confident = score <= -1 || score >= 3; // 中间 0..2 视为拿不准
  return { tier, score, confident };
}

// 解析档位（处理 Auto）→ 实际执行档 S1/S2/S3。
export function resolveMode(mode, goal = '') {
  const m = normalizeMode(mode);
  return m === 'Auto' ? classify(goal) : m;
}

// 生成执行计划：档位决定「参与角色/阶段数量」，是控制 token 消耗的粗粒度手段（不设硬预算）。
export function generatePlan(mode, opts = {}) {
  const requested = normalizeMode(mode);
  const resolved = requested === 'Auto'
    ? (PLANS[opts.resolvedMode] ? opts.resolvedMode : classify(opts.goal || ''))
    : requested;
  const p = PLANS[resolved];
  const risk = opts.risk === 'high' || opts.risk === 'strict';
  const coreStages = Array.isArray(p.coreStages) ? p.coreStages : p.stages;
  const optionalStages = Array.isArray(p.optionalStages) ? p.optionalStages : [];
  const stages = (risk && optionalStages.length) ? [...p.stages] : [...coreStages];
  // risk=high 且展开可选阶段时，让 maxAgents 至少容纳全部阶段数（S3 high 7 阶段→7 条 briefing），上限 8。
  const maxAgents = (risk && optionalStages.length)
    ? Math.min(8, Math.max(p.maxAgents, stages.length))
    : p.maxAgents;
  return {
    requestedMode: requested,
    mode: resolved,
    label: MODE_META[resolved].label,
    maxAgents,
    stages,
    coreStages: [...coreStages],
    optionalStages: [...optionalStages],
    reviewRounds: p.reviewRounds,
    costWeight: p.budgetX, // 相对成本权重（S1×2 / S2×5 / S3×10 / S4×16），仅展示，不设上限
    stageCount: stages.length,
    risk: risk ? 'high' : 'normal',
    classified: requested === 'Auto',
  };
}

// ---- 思考强度（reasoning effort）解析 ----
export const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// 各档位「阶段 → 建议强度」；default 为该档兜底。
export const MODE_ROLE_EFFORT = {
  S1: { generate: 'high', review: 'high', verify: 'high', default: 'high' },
  S2: { plan: 'high', generate: 'high', review: 'high', verify: 'high', default: 'high' },
  S3: { research: 'high', plan: 'high', generate: 'high', review: 'high', judge: 'xhigh', redteam: 'high', verify: 'high', regression: 'high', default: 'high' },
  S4: { research: 'high', plan: 'xhigh', generate: 'high', review: 'xhigh', judge: 'xhigh', redteam: 'xhigh', verify: 'high', regression: 'high', default: 'high' },
};

function matrixEffort(mode, stage) {
  const m = MODE_ROLE_EFFORT[mode] || MODE_ROLE_EFFORT.S2;
  return m[stage] || m.default || 'medium';
}

// 解析某阶段某模型应采用的思考强度：
// 1) 设置按模型 > 按角色 > 默认（auto/空回落档位矩阵）。2) 模型不支持 reasoning → null（调用方省略参数）。
// 3) 首选不在可选 efforts 时，按 EFFORT_ORDER 向下找最近；再 defaultEffort；最后 efforts[0]。
export function resolveEffort(opts = {}) {
  const { mode, stage, role, modelRef, modelMeta, settings } = opts || {};
  // 强度统一成字符串 id（兼容纯字符串与 {id}/{name} 对象两种形态）。
  const asId = (v) => (typeof v === 'string' ? v : (v && (v.id || v.effort || v.name)) ? String(v.id || v.effort || v.name) : null);
  const s = (settings && settings.reasoning) ? settings.reasoning : null;
  let preferred = null;
  if (s) {
    if (modelRef && s.byModel && typeof s.byModel === 'object' && s.byModel[modelRef]) preferred = s.byModel[modelRef];
    else if (role && s.byRole && typeof s.byRole === 'object' && s.byRole[role]) preferred = s.byRole[role];
    else if (s.default && s.default !== 'auto') preferred = s.default;
  }
  preferred = asId(preferred);
  if (!preferred || preferred === 'auto') preferred = matrixEffort(mode, stage);
  const meta = (modelMeta && modelRef) ? modelMeta[modelRef] : null;
  const reasoning = meta && meta.reasoning ? meta.reasoning : null;
  // 真实宿主目录用 reasoning.supportedEfforts（旧字段 efforts 兼容兜底）；字段错配会让所有强度设置整体失效。
  const rawEfforts = reasoning && Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts : (reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : []);
  // efforts 可能是字符串数组，也可能是 {id/name} 对象数组；统一成字符串 id。
  const effortIds = rawEfforts.map(asId).filter(Boolean);
  if (!effortIds.length) return null; // 该模型无思考强度能力 → 省略 reasoning_effort
  if (effortIds.includes(preferred)) return preferred;
  const pi = EFFORT_ORDER.indexOf(preferred);
  if (pi >= 0) {
    for (let i = pi - 1; i >= 0; i--) { if (effortIds.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i]; }
  }
  const def = asId(reasoning.defaultEffort || reasoning.default);
  if (def && effortIds.includes(def)) return def;
  return effortIds[0];
}

// 闸门升级：连续 FAIL 时上调一档（S1→S2→S3；S3/Auto 不再上调）。
export function nextMode(mode) {
  const m = normalizeMode(mode);
  if (m === 'S1') return 'S2';
  if (m === 'S2') return 'S3';
  return m;
}

export function isMode(mode) {
  return MODES.includes(String(mode));
}

// ---- 与官方 Agent Teams 对接：把阶段流水线映射成「团队执行手册」 ----
// token2biq 只出「做什么/为什么/花多少」，真正的执行由 Agent Teams 原语完成：
//   subagent（建队员，可显式传 provider/model）· team_task_create（建共享任务）· send_message（派活/steer）
//   · wait_agent（等结果）· list_agents / interrupt_agent（管理）· team_task_*（任务板）
// 每个阶段 => 一个共享任务 + 一个承担该角色的队员；record 时回传 teamTaskId 与 owner 完成「任务板↔台账」绑定。
export const STAGE_TEAM = {
  research: { role: 'researcher', parallel: 'fan-out', subject: '调研：<目标>的现状/约束/证据', doneWhen: '输出调研结论与证据（不写源码）', writeScopes: [] },
  plan: { role: 'planner', parallel: 'serial', subject: '计划：任务分解 + 验收标准 + 风险', doneWhen: '输出可执行的任务分解与验收标准', writeScopes: [] },
  generate: { role: 'worker', parallel: 'serial', subject: '实现：<子任务>', doneWhen: '产出改动文件 + diffSummary + 测试结果', writeScopes: [] },
  review: { role: 'reviewer', parallel: 'serial', subject: '评审：审查 generate 产物', doneWhen: 'verdict=PASS，或 FAIL + issues', writeScopes: [] },
  judge: { role: 'judge', parallel: 'serial', subject: '裁决：汇总评审与红队结论', doneWhen: 'verdict=PASS|FAIL + rationale', writeScopes: [] },
  redteam: { role: 'red-team', parallel: 'serial', subject: '红队：对抗式挑错', doneWhen: 'verdict + issues/evidence', writeScopes: [] },
  verify: { role: 'verifier', parallel: 'serial', subject: '验证：独立复验产物', doneWhen: 'verdict + evidence', writeScopes: [] },
  regression: { role: 'verifier', parallel: 'serial', subject: '回归：全量测试复跑', doneWhen: 'verdict + evidence', writeScopes: [] },
};

// 官方 agent-team 默认 maxMembers=8（含 Lead）。并行 fan-out 必须落在此上限内。
export const TEAM_MAX_MEMBERS = 8;

// 由已生成的 plan 构造团队执行手册。纯函数、无副作用。
// options: { rolePools, allowModels, independentReview, multiReview, parallelReviews, forceTeam, pipelineGate, writeScopes }
//   rolePools/allowModels 里的模型引用格式为 `provider::model`（见 settings.parseModelRef）。
export function buildTeamPlaybook(plan, options = {}) {
  const opt = options && typeof options === 'object' ? options : {};
  const allowModels = Array.isArray(opt.allowModels) ? opt.allowModels : [];
  const rolePools = (opt.rolePools && typeof opt.rolePools === 'object') ? opt.rolePools : {};
  const modelMeta = (opt.modelMeta && typeof opt.modelMeta === 'object') ? opt.modelMeta : {};
  const settings = (opt.settings && typeof opt.settings === 'object') ? opt.settings : null;
  const multiReview = opt.multiReview === true;
  const paraCount = Math.max(1, Math.min(MAX_PARALLEL_REVIEWS, Math.round(Number(opt.parallelReviews) || 3)));
  // 允许调用方按阶段声明写域（F13）：generate 并行时必须互不重叠，否则会互相覆盖。
  const wsOverride = (opt.writeScopes && typeof opt.writeScopes === 'object') ? opt.writeScopes : {};
  const REVIEW_KINDS = new Set(['review', 'judge', 'redteam']);
  const filteredModels = [];
  const stages = (plan && plan.stages) || [];
  const steps = []; let _idx = 0;
  for (const kind of stages) {
    const t = STAGE_TEAM[kind] || { role: 'worker', parallel: 'serial', subject: kind, doneWhen: '产出回执', writeScopes: [] };
    const isRev = REVIEW_KINDS.has(kind);
    const pool = Array.isArray(rolePools[kind]) ? rolePools[kind].filter(Boolean) : [];
    const wrapScopes = (Array.isArray(wsOverride[kind]) ? wsOverride[kind] : t.writeScopes).slice();
    const mk = (extra) => {
      const stepModel = extra && extra.model ? extra.model : null;
      // 解析强度用「显式角色池模型 || 默认模型」；但 steps[].model 仍只保留角色池显式模型（不把默认模型写进路由）。
      const effortRef = stepModel || opt.defaultModel || null;
      // role 传阶段键 kind（不是 t.role），使 settings.reasoning.byRole['generate'] 等按角色覆盖真正生效；resolveEffort 对外 role 参数保持兼容。
      const effort = resolveEffort({ mode: plan && plan.mode, stage: kind, role: kind, modelRef: effortRef, modelMeta, settings });
      return { index: _idx++, kind, label: STAGE_LABEL[kind] || kind, role: t.role, parallel: t.parallel, subject: t.subject, doneWhen: t.doneWhen, writeScopes: wrapScopes.slice(), recordStage: kind, independentReview: !!(opt.independentReview && isRev), effort, ...extra };
    };
    // 多审仅 S4 且 kind==='review'：角色池有多个候选时拆成“每模型一个并行子步骤”，models 取 min(paraCount,2)。
    if (kind === 'review' && multiReview && plan && plan.mode === 'S4' && pool.length >= 2) {
      // 并行拆分同样走 allowModels 白名单：不在白名单的候选过滤掉并记入提示。
      const allowed = pool.filter((m) => !allowModels.length || allowModels.includes(m));
      if (allowModels.length) for (const m of pool) { if (!allowModels.includes(m)) filteredModels.push(m); }
      const models = allowed.slice(0, Math.min(paraCount, 2));
      if (models.length >= 2) {
        for (let ci = 0; ci < models.length; ci++) {
          steps.push(mk({ parallel: true, model: models[ci], multiReview: true, candidateIndex: ci + 1, candidateCount: models.length,
            subject: t.subject + '（并行多审 ' + (ci + 1) + '/' + models.length + '）' }));
        }
        continue;
      }
      // allowed 不足 2 → 落到下面的单步分支（单步分支自身有允许过滤）
    }
    let model = pool.length ? String(pool[0]) : null; // 角色池首项
    if (model && allowModels.length && !allowModels.includes(model)) { filteredModels.push(model); model = null; }
    steps.push(mk({ model }));
  }
  const fanout = steps.filter((s) => s.parallel === 'fan-out').length;
  const genStep = steps.find((s) => s.kind === 'generate');
  const modelPlan = {
    rolePools: Object.fromEntries(
      Object.entries(rolePools).map(([k, v]) => [k, Array.isArray(v) ? v.slice() : []])
    ),
    multiReview,
    parallelReviews: paraCount,
    allowModels: allowModels.slice(),
  };
  const rules = [
    '执行用官方 Agent Teams：Lead 用 subagent 按 briefing 的 delegation（含 reasoning_effort）逐项起队员，team_task_create 建共享任务；模型阶段用 subagent 显式传 provider/model/reasoning_effort（subagent_fork 不支持模型选择），record 时带上同一个 model 供白名单校验。',
    '每个共享任务完成后由队员 team_task_update complete（带 teamTaskId 与 revision）；Lead 用 token2biq action=record（带 teamTaskId/owner/model）记账，全部阶段完成 action=finish。',
    `generate 默认串行（同 cwd、无文件锁）；并行时各任务 writeScopes 必须互不重叠。本档 ${stages.length} 阶段、最多 ${plan ? plan.maxAgents : 0} 个并行代理（fan-out=${fanout}，上限 ${TEAM_MAX_MEMBERS} 含 Lead）。`,
  ];
  if (steps.some((s) => s.multiReview)) rules.push('完整加强双路评审：review 配了多个候选模型时，用每个模型并行各审一遍（subagent 并发）；任一评审 FAIL 即该阶段 FAIL。');
  if (genStep && !genStep.writeScopes.length) rules.push('注意：generate 阶段未声明 writeScopes——默认串行执行（同 cwd、无文件锁）；若要并行，请为各任务声明互不重叠的 writeScopes。');
  if (opt.forceTeam) rules.push('强制联动（forceTeam）：每个阶段 record 必须带 teamTaskId 与 owner，否则拒收。');
  if (opt.pipelineGate === 'strict') rules.push('严格流水线（pipelineGate=strict）：进入 generate 前须有 spec/plan（含 acceptance）；verify/regression 须带 testsRun 证据且 PASS；多候选择优须 judge 带 selectedCandidate。');
  if (filteredModels.length) rules.push('白名单已过滤以下不在允许列表内的模型（已回退默认）：' + Array.from(new Set(filteredModels)).join('、'));
  return {
    plan,
    pipelineGate: opt.pipelineGate === 'strict' ? 'strict' : 'off',
    maxMembers: TEAM_MAX_MEMBERS,
    maxAgents: plan ? plan.maxAgents : 0,
    costWeight: plan ? plan.costWeight : 0,
    requireTeam: opt.forceTeam === true,
    steps,
    roles: steps.map((s) => s.role),
    modelPlan,
    rules,
  };
}

// 由 plan + playbook 生成「团队花名册」：每个阶段一个常驻队员 + 一个共享任务。纯函数、可单测。
// 队员命名：`<kind>-<role>`（kebab、去重）；blockedByStage 表达阶段间的天然依赖链。
export function buildRoster(plan, playbook, opts = {}) {
  const steps = (playbook && playbook.steps) || [];
  const runId = String((opts && opts.runId) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const suffix = runId ? runId.slice(-8) : '';
  const used = new Set();
  return steps.map((s, i) => {
    const base = String(s.kind + '-' + s.role)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const rooted = suffix ? (base || ('worker-' + i)) + '-' + suffix : (base || ('worker-' + i));
    let name = rooted;
    let k = 2;
    while (used.has(name)) { name = rooted + '-' + k; k += 1; }
    used.add(name);
    return {
      stage: s.kind,
      role: s.role,
      name,
      subject: s.subject,
      doneWhen: s.doneWhen,
      writeScopes: Array.isArray(s.writeScopes) ? s.writeScopes.slice() : [],
      model: s.model || null,
      effort: s.effort || null,
      parallel: s.parallel,
      independent: !!s.independentReview,
      blockedByStage: i > 0 ? steps[i - 1].kind : null,
    };
  });
}

// 角色化系统提示段文本（供 index.js 注入到 Team 代理的 systemPrompt.section）。
// lead：主动编排（大任务先 token2biq start）；teammate：执行/回执。纯函数、可单测。
// opts.mode：本会话当前档位（S1/S2/S3/S4/Auto）。显式 S1/S2/S3/S4 = 用户已锁定档位，
// 此时系统提示必须硬性要求「先 start 建团」，不得再用「小任务直接做」把编排跳过。
export function buildPolicy(role, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const enabled = o.enabled !== false;
  const mode = normalizeMode(o.mode != null ? o.mode : '');
  const locked = ['S1', 'S2', 'S3', 'S4'].includes(mode);
  if (role === 'lead') {
    if (!enabled) {
      return 'Token 2b IQ 已在「IQ」下拉关闭：本会话不要启动任何编排/团队，也不要调用 token2biq start；按普通模式直接完成任务即可。';
    }
    const head = locked
      ? [
          'Token 2b IQ（主动编排）已启用：本会话档位已锁定为 ' + mode + '（' + ((MODE_META[mode] && MODE_META[mode].label) || mode) + '）。',
          '硬性纪律：任务再小，开始前 MUST 先调用 token2biq action=start {mode:"' + mode + '"} 建共享任务板并拿 created.briefing，再用 subagent 按 briefing 起队员（含 reasoning_effort）；禁止单干。仅当 start 明确返回 degraded=no-orchestration / 宿主无 agentTeams（建不出任务板）时，才可按 playbook.steps 直接执行，并在回执中记录降级原因。',
          '每阶段由队员 team_task_update complete；你用 token2biq action=record 记账、action=finish 收尾；不要轮询 wait_agent。',
        ]
      : [
          'Token 2b IQ（主动编排）已启用：用额外 token 换取任务成功率与准确性。',
          '遇到「非小」任务（多文件 / 多步 / 需评审 / 架构或迁移 / 高风险改动），不要单干：先调用 token2biq action=start（mode=Auto 即可）建共享任务板并拿到 created.briefing，再用 subagent 按 briefing 逐项起队员（含 reasoning_effort）。',
          '小任务（单点改动 / 问答 / 一次读文件）不要起团队，直接做。目标是「花该花的 token，把正确率与可靠性买回来」。',
          '每阶段完成由队员 team_task_update complete；你用 action=record 记账、action=finish 收尾。不要轮询 wait_agent。',
        ];
    return head.join('\n');
  }
  return [
    '你是 Token 2b IQ 的阶段队员。',
    '在共享任务板 claim 分给你的任务（team_task_update claim），只改 writeScopes 内文件，完成后 team_task_update complete。',
    '最终回答即回执 JSON {stage, files, diffSummary, verdict, issues}，不要 send_message；遇 blocked/failed 立即停止后续改动，在回执 notes 写清原因并等 lead。',
  ].join('\n');
}
