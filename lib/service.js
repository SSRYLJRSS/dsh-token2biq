// Token2bIQService —— 插件宿主侧核心：档位状态 + 编排决策 + 台账/看板数据 + 工具动作分发。
// 复用优先（DEV_GUIDE §0）：本服务只做“状态 + 计划 + 展示 + 记账”，实际代理执行由主模型调用
// 现有 subagent / workflow / team_task_* 原语完成，再通过 token2biq 工具回传回执。
import { RunStore } from './run-store.js';
import { SettingsStore, effectiveForceTeam } from './settings.js';
import {
  generatePlan, normalizeMode, nextMode, MODES, MODE_META, STAGE_LABEL,
  PLANS, buildTeamPlaybook, buildRoster, classifyDetailed,
} from './orchestrator.js';
import { validateReceiptByStage } from './receipts.js';
import { buildReport } from './report.js';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
function estTokens(s) {
  const len = Array.from(String(s || '')).length;
  return Math.max(1, Math.ceil(len / 4));
}
function defaultRole(kind) {
  return ({
    plan: 'planner', research: 'researcher', generate: 'worker', review: 'reviewer',
    judge: 'judge', verify: 'verifier', redteam: 'red-team', regression: 'verifier',
  })[kind] || 'worker';
}

// 阶段“有效状态”：优先从任务派生，避免历史数据 stage.status 永远停在 running/pending。
function effStageStatus(kind, run) {
  const ts = (run.tasks || []).filter((t) => t.kind === kind);
  if (ts.length) {
    if (ts.some((t) => t.status === 'failed')) return 'failed';
    if (ts.every((t) => t.status === 'done')) return 'done';
    return 'running';
  }
  const st = (run.stages || []).find((s) => s.kind === kind);
  if (run.status === 'done') return 'skipped';
  return (st && st.status) || 'pending';
}

export function normalizeConfig(config = {}) {
  return {
    defaultMode: normalizeMode(config.defaultMode || 'Auto'),
    stateFile: config.stateFile || null,
    settingsFile: config.settingsFile || null,
  };
}

export class Token2bIQService {
  constructor(config = {}) {
    // 先读设置，使「默认档位/预算」可由设置文件覆盖（未显式传参时）。
    this.settings = new SettingsStore({ file: config.settingsFile });
    const s0 = this.settings.get();
    this.config = normalizeConfig({
      ...config,
      defaultMode: config.defaultMode != null ? config.defaultMode : s0.defaultMode,
    });
    this.store = new RunStore({ file: this.config.stateFile });
    // 恢复上次运行档位（持久化在 state.mode）；没有则回退默认档。修复「重启后档位静默重置」。
    this.mode = normalizeMode(this.store.getMode() || this.config.defaultMode);
    this.currentRunId = null;   // 当前活动运行：llm/stream 的真实用量按它归集
    this.sessionPrefs = new Map(); // 会话级开关/档位：{ enabled:boolean, mode:string }（由输入框「IQ」下拉写入）
    this._lastUsageFlush = 0;   // 真实用量写盘节流
    // 实时 token 观测：由 index.js 里的 llm/stream 监听器喂入，按会话聚合。
    this.live = {
      startedAt: Date.now(), updatedAt: 0, requests: 0,
      inputTokens: 0, outputTokens: 0, total: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      sessions: Object.create(null),
    };
  }

  // 累计一次模型调用的 token 用量（宿主 llm/stream 的 usage 分片）。
  noteUsage(usage = {}, sessionId) {
    // 插件自身的 Auto 分类调用不计入「实时 token」（否则会把路由开销算进用户用量）。
    if (this._classifying > 0) return;
    if (!usage || typeof usage !== 'object') return;
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    const inc = (t) => {
      t.inputTokens += n(usage.inputTokens);
      t.outputTokens += n(usage.outputTokens);
      t.cacheReadTokens += n(usage.cacheReadTokens);
      t.cacheWriteTokens += n(usage.cacheWriteTokens);
      t.reasoningTokens += n(usage.reasoningTokens);
      const tt = Number.isFinite(Number(usage.totalTokens)) && Number(usage.totalTokens) > 0
        ? Number(usage.totalTokens)
        : n(usage.inputTokens) + n(usage.outputTokens);
      t.total += tt;
      t.requests += 1;
    };
    inc(this.live);
    this.live.updatedAt = Date.now();
    const sid = sessionId != null ? String(sessionId) : '_unknown';
    if (!this.live.sessions[sid]) {
      this.live.sessions[sid] = {
        inputTokens: 0, outputTokens: 0, total: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0,
      };
    }
    inc(this.live.sessions[sid]);
    // 会话表上限，避免长期运行无限增长（OPTIMIZATION F11）。
    const keys = Object.keys(this.live.sessions);
    if (keys.length > 64) {
      keys.map((k) => [k, this.live.sessions[k].total])
        .sort((a, b) => a[1] - b[1])
        .slice(0, keys.length - 64)
        .forEach(([k]) => { delete this.live.sessions[k]; });
    }
    // 真实用量归集到「当前活动运行」：宿主 usage 分片不带 runId，只能按活动运行归集。
    // 近似性：运行期间同进程内所有调用都会计入该运行（含该任务派生的队员会话），面板标注「实测·含同进程」。
    const rid = this.currentRunId;
    if (rid) {
      const run = this.store.getRun(rid);
      if (run && run.status !== 'done' && !run.paused) {
        this.store.addRealUsage(rid, usage);
        const now = Date.now();
        if (now - (this._lastUsageFlush || 0) > 2000) {
          try { this.store.flush(); } catch { /* ignore */ }
          this._lastUsageFlush = now;
        }
      } else if (run && (run.status === 'done' || run.paused)) {
        this.currentRunId = null;
      }
    }
  }

  liveView() {
    const { sessions, ...global } = this.live;
    const list = Object.keys(sessions)
      .map((id) => ({ id, ...sessions[id] }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
    return { ...global, sessions: list };
  }

  getMode() { return this.mode; }

  setMode(mode) {
    this.mode = normalizeMode(mode);
    try { this.store.setMode(this.mode); } catch { /* 持久化失败不影响内存态 */ }
    return this.mode;
  }

  // ---- 会话级开关：真正控制「本会话是否启用插件」与「本会话默认档位」----
  setSessionPref(sessionId, patch = {}) {
    const sid = sessionId != null ? String(sessionId) : '';
    if (!sid) return { ok: false, error: '缺 sessionId' };
    const cur = this.sessionPrefs.get(sid) || { enabled: true, mode: null };
    if (typeof patch.enabled === 'boolean') cur.enabled = patch.enabled;
    if (patch.mode != null && patch.mode !== '__off') cur.mode = normalizeMode(patch.mode);
    if (!this.sessionPrefs.has(sid) && this.sessionPrefs.size >= 256) {
      const first = this.sessionPrefs.keys().next().value;
      this.sessionPrefs.delete(first);
    }
    this.sessionPrefs.set(sid, cur);
    // 会话档位选择也落盘到全局 mode（store.mode）：否则宿主重启后「IQ」下拉选择丢失、
    // 系统提示退回无锁定档，P0 的「锁定档 MUST start」在重启后失效。
    if (patch.mode != null && patch.mode !== '__off' && cur.enabled !== false) {
      try { this.setMode(cur.mode); } catch { /* 持久化失败不影响内存态 */ }
    }
    // 档位/开关变更后，通知宿主侧重新渲染该会话 agent 的 token2biq 提示段（让档位真正注入系统提示）。
    try { if (typeof this.onSessionPrefChanged === 'function') this.onSessionPrefChanged(sid, cur); } catch { /* ignore */ }
    return { ok: true, sessionId: sid, pref: cur };
  }

  getSessionPref(sessionId) {
    const sid = sessionId != null ? String(sessionId) : '';
    if (!sid) return null;
    return this.sessionPrefs.get(sid) || null;
  }

  _sessionIdOf(ctxInfo) {
    try {
      const a = ctxInfo && ctxInfo.agent;
      return (a && a.session && (a.session.id || a.session.sessionId))
        || (ctxInfo && ctxInfo.sessionId) || null;
    } catch { return null; }
  }

  updateConfig(patch = {}) {
    if (patch.defaultMode != null) this.config.defaultMode = normalizeMode(patch.defaultMode);
    return this.publicConfig();
  }

  publicConfig() {
    return { defaultMode: this.config.defaultMode };
  }

  getSettings() { return this.settings.get(); }

  // 更新并持久化设置；只刷新 defaultMode（供新运行/新会话的默认值），不改动当前会话正在用的档位，
  // 否则用户在设置页改任意一项都会把已选档位重置回默认值（旧缺陷）。
  updateSettings(patch = {}) {
    const s = this.settings.update(patch);
    this.config.defaultMode = s.defaultMode;
    return s;
  }

  planFor(mode, goal) {
    return generatePlan(mode || this.mode, { goal });
  }

  start({ goal, mode, resolvedMode, autoDecision, candidates, acceptance, spec, constraints } = {}) {
    const plan = generatePlan(mode || this.mode, { goal, resolvedMode });
    const run = this.store.createRun({ goal, plan, mode: plan.requestedMode });
    this.currentRunId = run.id;
    run.candidates = Math.min(5, Math.max(1, Math.floor(Number(candidates) || 1)));
    run.spec = run.spec || null;
    // 允许在 start 直接给出验收标准（解决 S1 无 plan/research 阶段时 strict 无法产生 spec 的死锁）。
    if (spec || acceptance) {
      run.spec = { summary: spec || '', acceptance: acceptance || spec || '', constraints: constraints || '', at: Date.now() };
    }
    if (autoDecision) run.autoDecision = autoDecision;
    if (autoDecision || run.candidates > 1 || run.spec) this.store.flush();
    const settings = this.settings.get();
    const forceActive = effectiveForceTeam(settings, plan.mode);
    const playbook = buildTeamPlaybook(plan, { ...settings, forceTeam: forceActive, rolePools: settings.rolePools, multiReview: plan.mode === 'S4' });
    const teamHint = forceActive
      ? `（本档 ${plan.mode} 已开启强制联动：record 必须带 teamTaskId/owner，否则会被拒收）`
      : '';
    const autoHint = autoDecision
      ? `（Auto 判定→${plan.mode}，依据：${autoDecision.decidedBy === 'llm' ? '模型复核' : autoDecision.decidedBy === 'heuristic' ? '关键词（有把握）' : '关键词兜底'}${autoDecision.reason ? '，' + autoDecision.reason : ''}）`
      : '';
    const strictHint = settings.pipelineGate === 'strict'
      ? '（严格流水线：进入 generate 前须有 spec——可在 action=start 传 acceptance，或先 record 一个 plan 阶段；verify/regression 须带 testsRun；多候选须让 judge 带 selectedCandidate；否则 record/finish 会被拒收）'
      : '';
    return {
      ok: true,
      run: this.store.summary(run),
      plan,
      playbook,
      roster: buildRoster(plan, playbook),
      orchestrated: false,
      candidates: run.candidates || 1,
      pipelineGate: settings.pipelineGate,
      autoDecision: autoDecision || null,
      forceTeam: forceActive,
      forceTeamSetting: settings.forceTeam,
      stages: run.stages.map((s) => ({ kind: s.kind, label: STAGE_LABEL[s.kind] || s.kind, status: s.status })),
      next: '按 playbook.steps 用官方 Agent Teams 执行（spawn_teammate/team_task_create/send_message/wait_agent）；每完成一个阶段调用 token2biq action=record 回传回执（带 teamTaskId/owner）。全部完成后 action=finish。' + autoHint + teamHint + strictHint,
    };
  }

  // Auto 混合判定：关键词先筛；拿不准时调用低思考模型复核（classifier 由宿主注入）；失败则回退关键词。
  async autoDecide(goal = '') {
    const det = classifyDetailed(goal);
    if (det.confident) return { ...det, decidedBy: 'heuristic', reason: '' };
    if (typeof this.classifier === 'function') {
      try {
        const j = await this.classifier(goal);
        if (j && ['S1', 'S2', 'S3'].includes(j.tier)) {
          return { tier: j.tier, score: det.score, confident: true, decidedBy: 'llm', worthTeam: j.worthTeam, reason: j.reason || '' };
        }
      } catch { /* 回退 */ }
    }
    return { ...det, decidedBy: 'fallback', reason: '模型判断不可用，按关键词兜底' };
  }

  // 供工具/HTTP 的 start 调用：Auto 走混合判定，其余档位直通；有 Team 运行时则真·主动建团。
  async startWithAuto(args = {}, ctxInfo = null) {
    // 会话级开关：本会话被「IQ」下拉关掉时，拒绝起编排（真正生效，而非前端显示）。
    const sid = this._sessionIdOf(ctxInfo);
    const pref = sid ? this.getSessionPref(sid) : null;
    if (pref && pref.enabled === false) {
      return { ok: false, disabled: true, error: '本会话已关闭 Token 2b IQ（在输入框「IQ」下拉改成「自动/档位」即可开启）', hint: '这是按会话生效的开关：关闭后该会话内 token2biq 不会启动任何编排/团队。' };
    }
    // 本会话锁定档位（S1/S2/S3）强制优先，忽略调用方传入的异档（修复评审 issue #6）：
    // 工具描述历史上写死 mode=Auto，会让用户选定的 S3 被自动分类顶掉。
    const lockedTier = (pref && ['S1', 'S2', 'S3', 'S4'].includes(pref.mode)) ? pref.mode : null;
    let useMode = args.mode;
    let modeOverride = null;
    if (lockedTier) {
      if (args.mode != null && normalizeMode(args.mode) !== lockedTier) modeOverride = { requested: args.mode, locked: lockedTier };
      useMode = lockedTier;
    } else if (useMode == null && pref && pref.enabled !== false && pref.mode) {
      useMode = pref.mode;
    }
    const requested = normalizeMode(useMode != null ? useMode : this.mode);
    let base;
    if (requested !== 'Auto') base = this.start({ ...args, mode: useMode });
    else {
      const decision = await this.autoDecide(args.goal || '');
      base = this.start({ ...args, mode: 'Auto', resolvedMode: decision.tier, autoDecision: decision });
    }
    try { if (lockedTier) base.lockedMode = lockedTier; if (modeOverride) base.modeOverride = modeOverride; } catch { /* ignore */ }
    // 真·主动：若调用方是 Team Lead 且宿主提供 agentTeams，则由插件直接创建队员与共享任务板。
    if (ctxInfo && ctxInfo.agentTeams && ctxInfo.agent) {
      try {
        const created = await this.autoSpawn(base.run.id, base.roster, ctxInfo);
        if (created) {
          base.orchestrated = true;
          base.created = created;
          const nMembers = (created.members || []).filter((x) => !x.error).length;
          const nMemberErr = (created.members || []).filter((x) => x.error).length;
          const nTasks = (created.tasks || []).filter((x) => x.taskId).length;
          const memberLine = nMembers
            ? ('已创建 ' + nMembers + ' 名常驻队员，可用 send_message 派活 / wait_agent 等结果 / team_task_list 看板')
            : (nMemberErr
              ? ('常驻队员创建失败 ' + nMemberErr + ' 个（见 created.members[].error），请改用 subagent 或重试')
              : '本次没有常驻队员（阶段均指定了模型或为空），请由你按 roster 顺序执行或用 subagent 执行');
          base.next = '插件已按档位建共享任务板' + (nTasks ? ('（' + nTasks + ' 个任务）') : '') + '；' + memberLine
            + '；每完成一个阶段 token2biq action=record（带 teamTaskId/owner），全部完成 action=finish。'
            + (created.cappedNote ? '（' + created.cappedNote + '）' : '');
          if (Array.isArray(created.modelRouting) && created.modelRouting.length) {
            base.next += ' 以下阶段指定了模型，须由 Lead 用 subagent 工具显式传 provider/model 执行，执行后 team_task_update complete 对应共享任务，并在 record 时带 model：' + created.modelRouting.map((m) => m.stage + '=' + m.model + (m.taskId ? '(' + m.taskId + ')' : '')).join('、') + '。';
          }
        }
      } catch (e) {
        base.orchestrated = false;
        base.orchestrationError = String((e && e.message) || e);
      }
    }
    return base;
  }

  // 主动编排核心：为每个阶段建共享任务（链式依赖），再为前 maxAgents 个阶段 spawn 常驻队员。
  // 仅当调用方是 Lead（agentTeams.tryMembership(agent).role==='lead'）才动手，否则返回 null（回退纯计划）。
  async autoSpawn(runId, roster, { agentTeams, agent, signal } = {}) {
    const run = this.store.getRun(runId);
    if (!run || !Array.isArray(roster) || !roster.length) return null;
    let m = null;
    try { m = agentTeams.tryMembership(agent); } catch { m = null; }
    if (!m || m.role !== 'lead') return null;
    const maxAgents = Math.max(1, (run.plan && run.plan.maxAgents) || 1);
    // 先判定「哪些阶段由模型路由（不 spawn 队友）」，用于任务依赖链与 spawn 预算。
    const routedStages = new Set(roster.filter((r) => !!r.model).map((r) => r.stage));
    // 幂等：重复 start 时复用同名常驻队员，避免宿主 TEAM_MEMBER_NAME_TAKEN（同队固定队名撞车）。
    let priorRows = [];
    try { const lm = await agentTeams.listMembers(agent); priorRows = Array.isArray(lm) ? lm : (lm && Array.isArray(lm.members) ? lm.members : (lm && Array.isArray(lm.rows) ? lm.rows : [])); } catch { priorRows = []; }
    const priorByName = new Map();
    for (const pm of priorRows) { if (pm && pm.name) priorByName.set(pm.name, pm); }
    const tasks = [];
    const taskIdByStage = {};
    for (let i = 0; i < roster.length; i += 1) {
      const r = roster[i];
      // blockedBy：串到最近一个「非模型」前驱阶段的任务。模型阶段由 Lead 亲自用 subagent 执行，
      // 不作为硬门禁，避免下游队友因上游无人 claim 而永久 blocked（评审 issue #3）。
      let blockedBy;
      for (let j = i - 1; j >= 0; j -= 1) {
        const pj = roster[j];
        if (routedStages.has(pj.stage)) continue;
        if (taskIdByStage[pj.stage]) blockedBy = [taskIdByStage[pj.stage]];
        break;
      }
      try {
        const view = await agentTeams.createTask(agent, {
          subject: ('[' + run.mode + '] ' + r.subject).slice(0, 200),
          description: this._stageDescription(run, r).slice(0, 16384),
          ...(blockedBy ? { blockedBy } : {}),
          ...(r.writeScopes && r.writeScopes.length ? { writeScopes: r.writeScopes } : {}),
        });
        if (view && view.id) taskIdByStage[r.stage] = view.id;
        tasks.push({ stage: r.stage, subject: r.subject, taskId: view && view.id });
      } catch (e) {
        tasks.push({ stage: r.stage, subject: r.subject, error: String((e && e.message) || e) });
      }
    }
    // 模型路由：覆盖整份 roster（不受 maxAgents 窗口限制，修复评审 issue #1——超窗口的模型阶段不再被静默丢弃）。
    // 按 roster 下标取各自 taskId，保证 S4 并行多审同一 stage 的多条子步骤各绑各的任务（不塌缩到最后一个）。
    const modelRouting = roster.map((r, idx) => ({ r, idx })).filter((x) => !!x.r.model).map((x) => ({ stage: x.r.stage, model: x.r.model, taskId: (tasks[x.idx] && tasks[x.idx].taskId) || taskIdByStage[x.r.stage] || null, role: x.r.role }));
    // 仅对「非模型阶段」spawn 队友，最多 maxAgents 个；模型阶段改由 Lead 用 subagent 执行，不占常驻名额。
    const members = [];
    let spawnBudget = maxAgents;
    for (const r of roster) {
      if (spawnBudget <= 0) break;
      if (routedStages.has(r.stage)) continue;
      spawnBudget -= 1;
      const prior = priorByName.get(r.name);
      if (prior) { members.push({ stage: r.stage, name: r.name, target: prior.name, status: prior.status || 'reused' }); continue; }
      try {
        const res = await agentTeams.spawnTeammate(agent, {
          name: r.name,
          description: (run.mode + '·' + r.role + '·' + r.subject).slice(0, 120),
          prompt: [{ type: 'text', text: this._spawnPrompt(run, r, taskIdByStage[r.stage]) }],
          context: 'fresh',
          provider: 'spawn',
          signal,
        });
        const member = res && res.member ? res.member : res;
        members.push({ stage: r.stage, name: r.name, target: (member && (member.target || member.name)) || r.name, status: (member && member.status) || 'provisioning' });
      } catch (e) {
        members.push({ stage: r.stage, name: r.name, error: String((e && e.message) || e) });
      }
    }
    run.orchestrated = true;
    run.teamTasks = tasks;
    run.roster = roster.map((r) => ({ stage: r.stage, role: r.role, name: r.name }));
    run.modelRouting = modelRouting; // 持久化，供 action=state / runView 查看（修复评审 issue #7）
    try { this.store.flush(); } catch { /* ignore */ }
    const nonModelCount = roster.length - routedStages.size;
    const notes = [];
    if (nonModelCount > maxAgents) notes.push('非模型阶段 ' + nonModelCount + ' > maxAgents ' + maxAgents + '，仅前 ' + maxAgents + ' 个建了常驻队员，其余任务留在板上由 Lead/队员接续');
    if (modelRouting.length) notes.push(modelRouting.length + ' 个阶段指定了模型，改由 Lead 用 subagent(provider/model) 执行（不占常驻队员名额；执行后请 team_task_update complete 对应共享任务）');
    const cappedNote = notes.join('；');
    return { maxAgents, tasks, members, modelRouting, cappedNote };
  }

  _stageDescription(run, r) {
    const lines = [
      'Token 2b IQ 运行 ' + run.id + ' · 阶段「' + r.stage + '」（' + r.role + '）',
      '目标：' + (run.goal || ''),
      '判据：' + (r.doneWhen || ''),
      (r.writeScopes && r.writeScopes.length) ? ('写域：' + r.writeScopes.join('、')) : '写域：未声明（默认串行 / 只读）',
      '完成后：team_task_update complete，并 send_message 给 lead 回执 {stage, files, diffSummary, verdict, issues}。',
    ];
    return lines.join('\n');
  }

  _spawnPrompt(run, r, taskId) {
    const lines = [
      '你是 Token 2b IQ 运行 ' + run.id + ' 的「' + r.stage + '」阶段队员（角色 ' + r.role + '）。',
      '总目标：' + (run.goal || ''),
      '你的共享任务：' + (taskId || '(见 team_task_list)') + '（subject: ' + r.subject + '）',
      '完成判据：' + (r.doneWhen || ''),
      ...(r.independent ? ['你是独立评委（盲审）：只能依据产物与验收标准裁决，不得参考执行者的推理过程/聊天记录；输出 {verdict:PASS|FAIL, issues, evidence}。'] : []),
      (r.writeScopes && r.writeScopes.length) ? ('只可改动：' + r.writeScopes.join('、')) : '不要写入声明外的文件。',
      '步骤：team_task_list 找到你的任务 → 若 ready 就 claim → 执行 → team_task_update complete → send_message 给 lead 回执 {stage, files, diffSummary, verdict, issues}。',
      '若任务被 blocked，只做只读准备并等待 lead 指令，不要抢跑。',
    ];
    return lines.join('\n');
  }

  // 异步动作分发：start 需要 await（Auto 判定 + 可选主动建团），其余复用同步 handleTool。
  handleToolAsync(args = {}, ctxInfo = null) {
    const action = String(args.action || '').toLowerCase();
    if (action === 'start') return this.startWithAuto(args, ctxInfo);
    return this.handleTool(args);
  }

  record(args = {}) {
    const runId = args.runId;
    let run = this.store.getRun(runId);
    if (!run) return { ok: false, error: `找不到运行 ${runId}，请先 action=start` };
    if (run.status === 'done') return { ok: false, error: `运行已结束（${run.status}），不能再 record；如需继续请新建运行。` };
    if (run.paused) return { ok: false, error: '运行已暂停，请先 action=resume 再 record。' };
    const kind = args.stage || 'generate';

    // 强制联动官方 Agent Teams：按设置与档位判定（默认 S2/S3 强制、S1 不强制），
    // 开启时回执必须绑定共享任务与队员，确保真的走了团队而非单代理。
    const st = this.settings.get();
    if (effectiveForceTeam(st, run.mode) && (!args.teamTaskId || !args.owner)) {
      return {
        ok: false,
        error: `强制联动已开启（${run.mode}）：record 必须带 teamTaskId（共享任务 id）与 owner（队员 target）。`,
        hint: '先用 team_task_create 建共享任务、spawn_teammate 建队员，再按 playbook 执行并回传。也可用 token2biq action=settings {"forceTeam":"off"} 或面板「设置」把「强制联动」改为「从不」/「仅 S2/S3」。',
        forceTeam: st.forceTeam,
      };
    }

    // 严格流水线硬门禁（pipelineGate=strict）：把"流程纪律"从建议变成强制。
    if (st.pipelineGate === 'strict') {
      if (kind === 'generate' && !run.spec) {
        return { ok: false, error: '严格流水线：进入实现(generate)前必须先完成 spec/plan 并给出验收标准', hint: '可在 action=start 时传 acceptance（验收标准），或先 record 一个 plan 阶段并带 summary/acceptance，再 record generate。' };
      }
      if (kind === 'generate' && (run.candidates || 1) > 1 && !args.candidateId) {
        return { ok: false, error: `多候选模式：generate 的 record 必须带 candidateId（1..${run.candidates}）`, hint: '每个候选单独 record 并带 candidateId，供 judge 打分择优。' };
      }
      if (kind === 'judge' && (run.candidates || 1) > 1 && !args.selectedCandidate) {
        return { ok: false, error: '多候选模式：judge 的 record 必须带 selectedCandidate（选中的候选）', hint: 'judge 依得分选出最佳候选，record 带 selectedCandidate 与 rationale。' };
      }
      const hasTests = Array.isArray(args.testsRun) ? args.testsRun.length > 0 : !!String(args.testsRun || '').trim();
      if ((kind === 'verify' || kind === 'regression') && !hasTests) {
        return { ok: false, error: '严格流水线：验证(verify/regression)必须带非空的 testsRun 证据（实际执行的测试命令）', hint: '先真的跑测试，record 带 testsRun（如 ["node --test"]）；不通过不许交付。' };
      }
    }

    // 设置落地（部分，硬校验）：模型白名单 / 评审跨厂商——仅当调用方上报 model 时才能判定。
    if (args.model) {
      const allow = Array.isArray(st.allowModels) ? st.allowModels : [];
      if (allow.length && !allow.includes(args.model)) {
        return { ok: false, error: `模型 ${args.model} 不在允许白名单内`, hint: `允许的模型：${allow.join('、')}（设置→模型白名单）。` };
      }
      if (['review', 'judge', 'redteam'].includes(kind) && st.requireDifferentVendor && run.generateModel) {
        const gp = String(run.generateModel).split('::')[0];
        const rp = String(args.model).split('::')[0];
        if (gp && rp && gp === rp) {
          return { ok: false, error: `评审模型与生成模型同厂商（${gp}），已开启「评审必须不同厂商」`, hint: '换一个不同 provider 的评审模型，或在设置里关闭「必须不同厂商」。' };
        }
      }
    }

    // 独立评委（independentReview）：review/judge/redteam 必须由「非执行者」的独立代理裁决，执行者自评一律拒收。
    if (st.independentReview && ['review', 'judge', 'redteam'].includes(kind)) {
      if (!args.owner) {
        return { ok: false, error: '独立评委已开启：review/judge/redteam 的 record 必须带 owner（独立评委 target）。', hint: '先 spawn 一个独立评委代理，再由它给出裁决；执行者不能自评。' };
      }
      const workerOwners = new Set((run.tasks || []).filter((t) => t.kind === 'generate' && t.owner).map((t) => t.owner));
      if (workerOwners.has(args.owner)) {
        return { ok: false, error: `独立评委已开启：owner「${args.owner}」是本次 generate 的执行者，不能自评。`, hint: '换一个独立的评委代理（不同 target）给出 PASS/FAIL，或在设置里关闭「独立评委」。' };
      }
    }

    // 按阶段组装回执（把各阶段可能用到的字段都带上，由 validateReceiptByStage 按 kind 取子集）
    const receipt = {
      files: args.files, diffSummary: args.diffSummary, testsRun: args.testsRun,
      status: args.status, notes: args.notes,
      verdict: args.verdict, issues: args.issues, evidence: args.evidence,
      rationale: args.rationale, summary: args.summary,
      candidateId: args.candidateId, selectedCandidate: args.selectedCandidate,
      testsPassed: args.testsPassed,
      findings: args.findings, sources: args.sources, logs: args.logs,
    };
    const v = validateReceiptByStage(kind, receipt);
    if (!v.ok) return { ok: false, error: '回执校验失败', errors: v.errors, hint: 'generate 需 files+diffSummary；research/plan 需 summary 或 diffSummary；review/judge/redteam 需 verdict(PASS|FAIL)，FAIL 需 issues；verify/regression 需 verdict，FAIL 需 evidence。' };

    // 规范流水线：在 spec/plan/research 阶段捕获「验收标准/摘要」作为 run.spec（供 strict 门禁判定）。
    if (['plan', 'research'].includes(kind) && (args.acceptance || args.summary || args.diffSummary)) {
      run.spec = {
        summary: args.summary || args.diffSummary || '',
        acceptance: args.acceptance || args.summary || args.diffSummary || '',
        constraints: args.constraints || '',
        at: Date.now(),
      };
      try { this.store.flush(); } catch { /* ignore */ }
    }

    const warnings = [];
    if (!(run.stages || []).some((s) => s.kind === kind)) {
      warnings.push(`阶段 ${kind} 不在本运行计划内（当前计划：${(run.plan.stages || []).join('/')}），已作为额外任务记录`);
    }

    // token：优先采用调用方上报；缺省按字符/4 估算并标注
    let tin = num(args.tokensIn), tout = num(args.tokensOut), estimated = false;
    if (tin === 0 && tout === 0) {
      const est = estTokens(JSON.stringify(args));
      tin = Math.ceil(est * 0.6);
      tout = est - tin;
      if (tout < 0) tout = 0;
      estimated = true;
    }

    // 有 verdict 的阶段（review/verify/judge/redteam/regression）由 verdict 决定成败；其余看 status。
    const status = v.value.verdict
      ? (v.value.verdict === 'PASS' ? 'done' : 'failed')
      : (v.value.status || 'done');

    const task = this.store.addTask(runId, {
      stage: kind, role: args.role || defaultRole(kind), brief: args.brief || '',
      status, receipt: v.value, tokensIn: tin, tokensOut: tout,
      teamTaskId: args.teamTaskId, owner: args.owner, model: args.model,
    });
    // 阶段状态推进：本步完成即置 done / 失败置 failed（否则看板会永远停在 running）。
    // 并行多审（S4）：review/judge/redteam 同一阶段可能有多条回执（每候选一条），需按“任一 FAIL 即失败”聚合。
    if (task) {
      const isReviewKind = ['review', 'judge', 'redteam'].includes(kind);
      if (isReviewKind) {
        const latest = this.store.getRun(runId);
        const sameKind = ((latest && latest.tasks) || []).filter((t) => t.kind === kind);
        const anyFail = sameKind.some((t) => t.receipt && t.receipt.verdict === 'FAIL');
        this.store.setStageStatus(runId, kind, anyFail ? 'failed' : (status === 'failed' ? 'failed' : 'done'));
      } else {
        this.store.setStageStatus(runId, kind, status === 'failed' ? 'failed' : 'done');
      }
    }

    let review = null;
    if (kind === 'review') {
      review = this.store.addReview(runId, {
        targetTaskId: args.targetTaskId, reviewerRole: args.role || 'reviewer',
        verdict: v.value.verdict, issues: v.value.issues, evidence: v.value.evidence,
      });
    }

    run = this.store.getRun(runId);
    const paused = !!run.paused;

    // 闸门升级：S1/S2 连续 2 次评审 FAIL → 真正切到上一档的计划与阶段（不只是记录）
    let escalate = null;
    if (kind === 'review' && v.value.verdict === 'FAIL') {
      const r2 = this.store.getRun(runId);
      if ((r2.failStreak || 0) >= 2 && (r2.mode === 'S1' || r2.mode === 'S2')) {
        const from = r2.mode;            // 必须在 applyEscalation 之前取，否则共享引用已被改成新档
        const to = nextMode(from);
        if (to !== from) {
          const newPlan = generatePlan(to, { goal: run.goal });
          const added = newPlan.stages.filter((k) => !(r2.plan.stages || []).includes(k));
          this.store.applyEscalation(runId, { from, to, reason: `连续 ${r2.failStreak} 次评审 FAIL，自动上调档位`, plan: newPlan });
          escalate = {
            from, to,
            reason: `连续 ${r2.failStreak} 次 FAIL，闸门升级 ${from}→${to}，按新档位补足阶段。`,
            addedStages: added,
            costWeight: newPlan.costWeight,
          };
        }
      }
    }

    return {
      ok: true,
      task: this.taskView(task),
      review: review ? this.reviewView(review) : null,
      paused,
      estimatedTokens: estimated,
      escalate,
      warnings,
    };
  }

  finish({ runId, verdict, rationale, byJudge } = {}) {
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, error: `找不到运行 ${runId}` };
    // verdict 必填：缺省不再静默记成 FAIL（P2-6）。
    if (verdict == null || String(verdict).trim() === '') {
      return { ok: false, error: 'finish 需要 verdict（PASS 或 FAIL）', hint: '传 PASS 表示交付，FAIL 表示放弃/失败。' };
    }
    // 幂等：已结束的运行不允许重复 finish 覆盖裁决（P2-8）。
    if (run.status === 'done') {
      return { ok: false, error: '该运行已结束，不能重复 finish', hint: '如需重跑请新建运行。', verdict: run.verdict };
    }
    // 严格流水线硬门禁：必须已完成验证（带 testsRun 证据、PASS）才能收尾；多候选须 judge 择优。
    const stf = this.settings.get();
    if (stf.pipelineGate === 'strict') {
      const verified = (run.tasks || []).some((t) => (t.kind === 'verify' || t.kind === 'regression') && t.status === 'done' && t.receipt && t.receipt.verdict === 'PASS' && ((Array.isArray(t.receipt.testsRun) && t.receipt.testsRun.length > 0) || t.receipt.testsPassed === true));
      if (!verified) {
        return { ok: false, error: '严格流水线：finish 前必须有完成的验证(verify/regression)，且 verdict=PASS 并带 testsRun 证据', hint: '先 record verify（带 testsRun 与 PASS），再 finish。' };
      }
      if ((run.candidates || 1) > 1) {
        const judged = (run.tasks || []).some((t) => t.kind === 'judge' && t.receipt && t.receipt.selectedCandidate);
        if (!judged) return { ok: false, error: '多候选模式：finish 前 judge 必须带 selectedCandidate 选出最佳', hint: '先 record judge 带 selectedCandidate。' };
      }
    }
    const final = String(verdict || '').toUpperCase() === 'PASS' ? 'PASS' : 'FAIL';
    const vd = this.store.setVerdict(runId, { final, byJudge: byJudge || (['S3', 'S4'].includes(run.mode) ? 'judge' : 'verifier'), rationale: rationale || '' });
    // 收尾：未开始阶段记为 skipped，进行中阶段记为 done，避免完成后看板仍显示“进行中”
    const done = this.store.getRun(runId);
    (done.stages || []).forEach((s) => {
      if (s.status === 'pending') this.store.setStageStatus(runId, s.kind, 'skipped');
      else if (s.status === 'running') this.store.setStageStatus(runId, s.kind, 'done');
    });
    if (this.currentRunId === runId) this.currentRunId = null;
    return { ok: true, verdict: vd, run: this.store.summary(this.store.getRun(runId)) };
  }

  setPaused(runId, paused) {
    const r = this.store.getRun(runId);
    if (!r) return { ok: false, error: `找不到运行 ${runId}` };
    this.store.setPaused(runId, !!paused, !!paused ? '手动暂停' : '');
    if (paused) { if (this.currentRunId === runId) this.currentRunId = null; }
    else if (r.status !== 'done') this.currentRunId = runId;
    return { ok: true, run: this.store.summary(this.store.getRun(runId)) };
  }

  exportReport(runId) {
    let r = runId ? this.store.getRun(runId) : null;
    if (!r) {
      const list = this.store.listRuns();
      r = list.length ? this.store.getRun(list[0].id) : null;
    }
    return buildReport(r);
  }

  deleteRun(runId) {
    const r = this.store.getRun(runId);
    if (!r) return { ok: false, error: `找不到运行 ${runId}` };
    this.store.remove(runId);
    if (this.currentRunId === runId) this.currentRunId = null; // 防用量归集指向已删运行（P2-7）
    return { ok: true, deleted: runId };
  }

  state(runId) {
    // 历史可能很长：面板只回传最近 40 条摘要，避免每次轮询序列化全量（性能/内存）。
    const runs = this.store.listRuns(40);
    const currentId = runId || (runs[0] && runs[0].id);
    const run = currentId ? this.store.getRun(currentId) : null;
    return {
      mode: this.mode,
      modes: MODES.map((m) => ({ name: m, ...MODE_META[m] })),
      config: this.publicConfig(),
      settings: this.settings.get(),
      runs,
      liveUsage: this.liveView(),
      current: run ? this.runView(run) : null,
    };
  }

  runView(r) {
    const spent = (r.ledger.totalIn || 0) + (r.ledger.totalOut || 0);
    const stages = r.stages.map((s) => ({
      kind: s.kind,
      label: STAGE_LABEL[s.kind] || s.kind,
      status: effStageStatus(s.kind, r),
      tasks: r.tasks.filter((t) => t.kind === s.kind).map((t) => this.taskView(t)),
    }));
    const knownKinds = new Set(r.stages.map((s) => s.kind));
    const orphans = r.tasks.filter((t) => !knownKinds.has(t.kind)).map((t) => this.taskView(t));
    if (orphans.length) stages.push({ kind: 'other', label: STAGE_LABEL.other, status: 'running', tasks: orphans });
    return {
      id: r.id,
      mode: r.mode,
      requestedMode: r.requestedMode,
      goal: r.goal,
      status: r.status,
      paused: r.paused,
      pauseReason: r.pauseReason,
      plan: r.plan,
      stages,
      reviews: r.reviews.slice(-30).map((rv) => this.reviewView(rv)),
      verdict: r.verdict,
      ledger: { ...r.ledger, spent },
      real: r.real ? { ...r.real } : null,
      generateModel: r.generateModel || null,
      candidates: r.candidates || 1,
      spec: r.spec || null,
      orchestrated: !!r.orchestrated,
      teamTasks: Array.isArray(r.teamTasks) ? r.teamTasks.slice() : [],
      modelRouting: Array.isArray(r.modelRouting) ? r.modelRouting.slice() : [],
      escalations: r.escalations,
      failStreak: r.failStreak,
      autoDecision: r.autoDecision || null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  taskView(t) {
    if (!t) return null;
    const rc = t.receipt || {};
    return {
      id: t.id,
      kind: t.kind,
      role: t.role,
      status: t.status,
      teamTaskId: t.teamTaskId || null,
      owner: t.owner || null,
      model: t.model || null,
      tokens: (t.tokensIn || 0) + (t.tokensOut || 0),
      tokensIn: t.tokensIn,
      tokensOut: t.tokensOut,
      summary: rc.summary || rc.diffSummary || rc.verdict || rc.notes || '',
      verdict: rc.verdict || null,
      files: rc.files || [],
      issues: rc.issues || [],
    };
  }

  reviewView(rv) {
    if (!rv) return null;
    return { id: rv.id, reviewerRole: rv.reviewerRole, verdict: rv.verdict, issues: rv.issues, evidence: rv.evidence, createdAt: rv.createdAt };
  }

  // ---- 工具 / HTTP 动作分发 ----
  handleTool(args = {}) {
    const action = String(args.action || '').toLowerCase();
    try {
      switch (action) {
        case 'start': return this.start({ goal: args.goal, mode: args.mode });
        case 'record': return this.record(args);
        case 'finish': return this.finish({ runId: args.runId, verdict: args.verdict, rationale: args.rationale, byJudge: args.byJudge });
        case 'pause': return this.setPaused(args.runId, args.paused !== false);
        case 'resume': return this.setPaused(args.runId, false);
        case 'export': return { ok: true, markdown: this.exportReport(args.runId) };
        case 'list': return { ok: true, runs: this.store.listRuns() };
        case 'delete': return this.deleteRun(args.runId);
        case 'mode': return { ok: true, mode: this.setMode(args.mode) };
        case 'map': {
          const plan = this.planFor(args.mode || this.mode, args.goal);
          const settings = this.settings.get();
          const forceActive = effectiveForceTeam(settings, plan.mode);
          return { ok: true, playbook: buildTeamPlaybook(plan, { ...settings, forceTeam: forceActive, rolePools: settings.rolePools, multiReview: plan.mode === 'S4' }) };
        }
        case 'state': return { ok: true, state: this.state(args.runId) };
        case 'settings':
          return (args.settings && typeof args.settings === 'object')
            ? { ok: true, settings: this.updateSettings(args.settings) }
            : { ok: true, settings: this.getSettings(), hint: '在面板「设置」里改模型/评审策略/白名单/强制联动；或用 HTTP POST /token2biq/settings。' };
        case 'help': return {
          ok: true,
          usage: [
            'Token 2b IQ 编排控制器（只做档位/计划/记账/展示；执行由官方 Agent Teams 完成：spawn_teammate / team_task_* / send_message / wait_agent）。',
            '流程：',
            '1) action=start, goal, mode=S1|S2|S3|S4|Auto → 返回 plan + playbook（每阶段角色/并行/writeScopes/团队规则）。',
            '2) 按 playbook.steps 用 Agent Teams 执行；每完成一步 action=record, runId, stage, 回执字段，并带 teamTaskId(共享任务id)/owner(队员target)：',
            '   generate: files[]+diffSummary(+testsRun[])；research/plan: summary 或 diffSummary（files 可选）；',
            '   review/judge/redteam: verdict(PASS|FAIL)，FAIL 需 issues[]；verify/regression: verdict，FAIL 需 evidence[]。',
            '   可选 tokensIn/tokensOut（缺省按字符估算，仅参考）；可选 model（provider::model），用于白名单/跨厂商校验。',
            '   面板的「真实 token」来自宿主 llm/stream 实时统计，自动归集到当前活动运行，无需手动上报。',
            '3) action=finish, runId, verdict=PASS|FAIL, rationale。',
            '其它：action=map 只取团队执行手册；state/export/list/mode/pause/resume/delete。',
          ].join('\n'),
        };
        default:
          return {
            ok: false,
            error: `未知动作: ${args.action}`,
            actions: ['start', 'record', 'finish', 'pause', 'resume', 'export', 'list', 'mode', 'state', 'settings', 'delete', 'map', 'help'],
          };
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }
}
