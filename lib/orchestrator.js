// Token 2b IQ 编排策略 —— 纯数据 + 纯函数，无副作用，可单测。
// 5 档位：S1 轻量 / S2 标准 / S3 完整 / S4 完整加强 / Auto 自动。设计依据 DEV_GUIDE §3。

export const MODES = ['Auto', 'S1', 'S2', 'S3', 'S4'];

// 并行多审：S4 下评审/裁决/红队按角色池拆成每模型一个子步骤，最多取池前 N 个。
export const MAX_PARALLEL_REVIEWS = 5;

// 档位元信息，供 UI 与工具描述展示。
export const MODE_META = {
  Auto: { name: 'Auto', label: '自动', desc: '按任务复杂度自动选档（轻量启发式分类）', maxAgents: 0 },
  S1: { name: 'S1', label: '轻量', desc: '单代理 + 一轮盲审 + 轻量验证', maxAgents: 1 },
  S2: { name: 'S2', label: '标准', desc: '多代理分视角 + 多轮互审 + 独立验证', maxAgents: 3 },
  S3: { name: 'S3', label: '完整', desc: '研究 + 分片 + 评审团 + 判官 + 红队 + 回归', maxAgents: 6 },
  S4: { name: 'S4', label: '完整加强', desc: '完整 7 阶段；评审/裁决/红队按各角色多候选并行多审（任一 FAIL 即该阶段 FAIL），非评审角色取池首模型', maxAgents: 8 },
};

// 各档位流水线（纯数据）：stages 阶段序列；reviewRounds 互审轮数；budgetX 相对成本权重（档位角色数代理，仅展示）。
export const PLANS = {
  S1: { maxAgents: 1, stages: ['generate', 'review', 'verify'], reviewRounds: 1, budgetX: 2 },
  S2: { maxAgents: 3, stages: ['plan', 'generate', 'review', 'verify'], reviewRounds: 3, budgetX: 5 },
  S3: { maxAgents: 6, stages: ['research', 'plan', 'generate', 'review', 'judge', 'redteam', 'regression'], reviewRounds: 3, budgetX: 10 },
  S4: { maxAgents: 8, stages: ['research', 'plan', 'generate', 'review', 'judge', 'redteam', 'regression'], reviewRounds: 3, budgetX: 16 },
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
  return {
    requestedMode: requested,
    mode: resolved,
    label: MODE_META[resolved].label,
    maxAgents: p.maxAgents,
    stages: [...p.stages],
    reviewRounds: p.reviewRounds,
    costWeight: p.budgetX, // 相对成本权重（S1×2 / S2×5 / S3×10），仅展示，不设上限
    stageCount: p.stages.length,
    classified: requested === 'Auto',
  };
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
//   spawn_teammate（建队员）· team_task_create（建共享任务）· send_message（派活/steer）
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
// options: { roleModels, reviewModels, rolePools, maxReviewers, requireDifferentVendor, allowModels, independentReview, multiReview }
//   roleModels/reviewModels/allowModels 里的模型引用格式为 `provider::model`（见 settings.parseModelRef）。
export function buildTeamPlaybook(plan, options = {}) {
  const opt = options && typeof options === 'object' ? options : {};
  const roleModels = (opt.roleModels && typeof opt.roleModels === 'object') ? opt.roleModels : {};
  const reviewModels = Array.isArray(opt.reviewModels) ? opt.reviewModels : [];
  const allowModels = Array.isArray(opt.allowModels) ? opt.allowModels : [];
  const rolePools = (opt.rolePools && typeof opt.rolePools === 'object') ? opt.rolePools : {};
  const multiReview = opt.multiReview === true;
  const paraCount = Math.max(1, Math.min(MAX_PARALLEL_REVIEWS, Math.round(Number(opt.parallelReviews) || 3)));
  // 允许调用方按阶段声明写域（F13）：generate 并行时必须互不重叠，否则会互相覆盖。
  const wsOverride = (opt.writeScopes && typeof opt.writeScopes === 'object') ? opt.writeScopes : {};
  const requireDifferentVendor = opt.requireDifferentVendor !== false;
  const maxReviewers = Number(opt.maxReviewers) > 0 ? Math.min(5, Number(opt.maxReviewers)) : 2;
  const REVIEW_KINDS = new Set(['review', 'judge', 'redteam']);
  let reviewerCursor = 0;
  const filteredModels = [];
  const stages = (plan && plan.stages) || [];
  const steps = []; let _idx = 0;
  for (const kind of stages) {
    const t = STAGE_TEAM[kind] || { role: 'worker', parallel: 'serial', subject: kind, doneWhen: '产出回执', writeScopes: [] };
    const isRev = REVIEW_KINDS.has(kind);
    const pool = Array.isArray(rolePools[kind]) ? rolePools[kind].filter(Boolean) : [];
    const wrapScopes = (Array.isArray(wsOverride[kind]) ? wsOverride[kind] : t.writeScopes).slice();
    const mk = (extra) => ({ index: _idx++, kind, label: STAGE_LABEL[kind] || kind, role: t.role, parallel: t.parallel, subject: t.subject, doneWhen: t.doneWhen, writeScopes: wrapScopes.slice(), recordStage: kind, independentReview: !!(opt.independentReview && isRev), ...extra });
    // 仅 S4 且评审类且角色池有多个候选时，拆成“每模型一个并行子步骤”，供 Lead 用 subagent 并发各审。
    if (isRev && multiReview && pool.length >= 2) {
      // 并行拆分同样走 allowModels 白名单：不在白名单的候选过滤掉并记入提示。
      const allowed = pool.filter((m) => !allowModels.length || allowModels.includes(m));
      if (allowModels.length) for (const m of pool) { if (!allowModels.includes(m)) filteredModels.push(m); }
      const models = allowed.slice(0, paraCount);
      if (models.length >= 2) {
        for (let ci = 0; ci < models.length; ci++) {
          steps.push(mk({ parallel: true, model: models[ci], multiReview: true, candidateIndex: ci + 1, candidateCount: models.length,
            subject: t.subject + '（并行多审 ' + (ci + 1) + '/' + models.length + '）' }));
        }
        continue;
      }
      // allowed 不足 2 → 落到下面的单步分支（单步分支自身有允许过滤）
    }
    let model = roleModels[kind] ? String(roleModels[kind]) : null;
    if (isRev && reviewModels.length) model = reviewModels[reviewerCursor++ % reviewModels.length];
    if (!model && pool.length) model = pool[0]; // 角色池兜底取首项（非多审分支）
    if (model && allowModels.length && !allowModels.includes(model)) { filteredModels.push(model); model = null; }
    steps.push(mk({ model }));
  }
  const fanout = steps.filter((s) => s.parallel === 'fan-out').length;
  const genStep = steps.find((s) => s.kind === 'generate');
  const modelPlan = {
    roleModels: { ...roleModels },
    reviewModels: reviewModels.slice(),
    rolePools: { ...rolePools },
    multiReview,
    parallelReviews: paraCount,
    maxReviewers,
    requireDifferentVendor,
    allowModels: allowModels.slice(),
  };
  const rules = [
    '执行用官方 Agent Teams：spawn_teammate 建队员、team_task_create 建共享任务、send_message 派活、wait_agent 等结果。',
    '每个共享任务完成后调用 token2biq action=record 回传回执，并带上 teamTaskId（共享任务 id）与 owner（队员 target），使台账与任务板一一对应。',
    'generate 默认串行（同进程共享 cwd、无文件锁）；确需并行时各任务 writeScopes 必须互不重叠。',
    `并行队员数不得超过 maxMembers（${TEAM_MAX_MEMBERS}，含 Lead），本档 maxAgents=${plan ? plan.maxAgents : 0}；fan-out 阶段数=${fanout}。`,
    `本档参与 ${stages.length} 个阶段、最多 ${plan ? plan.maxAgents : 0} 个并行代理——档位越高角色越多、token 越大，这就是控制消耗的粗粒度旋钮（不设硬性上限，避免断任务）。`,
  ];
  if (requireDifferentVendor) rules.push('评审/裁判必须与 generate 使用不同厂商（provider）的模型；同模型自评存在系统性 self-preference，降幻觉有限。');
  if (genStep && !genStep.writeScopes.length) rules.push('注意：generate 阶段未声明 writeScopes——默认串行执行（同 cwd、无文件锁）。若要并行，请为各任务声明互不重叠的 writeScopes。');
  if (modelPlan.reviewModels.length) rules.push(`评审模型池（异构优先，最多 ${maxReviewers} 个）：${modelPlan.reviewModels.join('、')}。`);
  if (steps.some((s) => s.multiReview)) rules.push('完整加强并行多审：评审/裁决/红队配了多个候选模型时，会对同一阶段用每个模型并行各审一遍（各用 subagent 并发执行）；任一评审 FAIL 即该阶段判定 FAIL；裁决阶段须汇总所有评审意见后给出结论。');
  if (opt.forceTeam) rules.push('强制联动已开启（forceTeam）：每个阶段 record 必须带 teamTaskId 与 owner，否则会被拒收——请先用 team_task_create 建共享任务、spawn_teammate 建队员。');
  if (opt.pipelineGate === 'strict') rules.push('严格流水线已开启（pipelineGate=strict）：进入 generate 前必须先完成 spec/plan（含验收标准 acceptance）；verify/regression 必须带 testsRun 证据且 PASS；多候选模式还须 judge 带 selectedCandidate 择优——否则 record/finish 会被硬拒收。');
  // 模型路由：只要本档有任一阶段被指定了 model，就必须用支持模型的 subagent 落执行，
  // 不能用 spawn_teammate（它只传 delegation provider，无法携带 LLM provider/model，会悄悄继承默认模型）。
  if (steps.some((s) => s.model)) rules.push('本档存在被指定 model 的阶段：这些阶段必须由 Lead 用 subagent 工具显式传 provider/model 执行（spawn_teammate 无法指定模型）；执行完必须 team_task_update complete 对应共享任务（否则下游依赖会永久 blocked），并在 token2biq action=record 时带上同一个 model，否则白名单/跨厂商校验无法生效。并行多审的这些子步骤要并发调用 subagent（不要串行）。');
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
export function buildRoster(plan, playbook) {
  const steps = (playbook && playbook.steps) || [];
  const used = new Set();
  return steps.map((s, i) => {
    const base = String(s.kind + '-' + s.role)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    let name = base || ('worker-' + i);
    let k = 2;
    while (used.has(name)) { name = base + '-' + k; k += 1; }
    used.add(name);
    return {
      stage: s.kind,
      role: s.role,
      name,
      subject: s.subject,
      doneWhen: s.doneWhen,
      writeScopes: Array.isArray(s.writeScopes) ? s.writeScopes.slice() : [],
      model: s.model || null,
      parallel: s.parallel,
      independent: !!s.independentReview,
      blockedByStage: i > 0 ? steps[i - 1].kind : null,
    };
  });
}

// 角色化系统提示段文本（供 index.js 注入到 Team 代理的 systemPrompt.section）。
// lead：主动编排（大任务先 token2biq start）；teammate：执行/回执。纯函数、可单测。
// opts.mode：本会话当前档位（S1/S2/S3/Auto）。显式 S1/S2/S3 = 用户已锁定档位，
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
          '硬性纪律：无论任务看起来多小，开始任何实现/修改前，MUST 先调用 token2biq action=start {mode:"' + mode + '"} 建团队（插件会自动创建队员与共享任务板），再按 roster 执行；禁止单干或直接改文件。唯一例外：纯问答 / 只读一次文件。',
        ]
      : [
          'Token 2b IQ（主动编排）已启用：用额外 token 换取任务成功率与准确性。',
          '遇到「非小」任务（多文件 / 多步 / 需评审 / 架构或迁移 / 高风险改动），不要直接单干：先调用工具 token2biq action=start（mode=Auto 即可）。它会按复杂度给出档位，并**直接创建好队员与共享任务板**（返回 roster / created），无需你手动 spawn。',
          '小任务（单点改动 / 问答 / 一次读文件）不要起团队，直接做。目标是「花该花的 token，把正确率与可靠性买回来」，而不是为所有事都堆 agent。',
        ];
    return head.concat([
      '执行阶段：send_message 派活、wait_agent 等结果、team_task_list 看板；每完成一个阶段 token2biq action=record（带 teamTaskId / owner 与回执）记账，全部完成 action=finish。',
      '模型路由：若 playbook.steps 某阶段带 model，则该阶段必须用 subagent 工具显式传 provider/model 执行（spawn_teammate 无法指定模型、只会继承默认模型）；record 时带上同一个 model，供白名单/跨厂商校验。',
      '开工前先 token2biq action=state 核对本会话档位；档位为 S1/S2/S3 时一律走编排，不得自判「小任务」跳过。',
    ]).join('\n');
  }
  return [
    '你是 Token 2b IQ 编排中的一名阶段队员。',
    '在共享任务板上领取分给你的任务（team_task_list / team_task_get / team_task_update claim），严格在任务声明的 writeScopes 内改动，完成后 team_task_update complete。',
    '完成后给 lead 发一条简洁回执 send_message：{stage, files, diffSummary, verdict(PASS|FAIL), issues}，便于 lead 用 token2biq action=record 记账。',
    '任务被 blocked 时不要抢跑：只做只读准备并等待 lead 指令。',
  ].join('\n');
}
