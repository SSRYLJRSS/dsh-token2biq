// Token2bIQService —— 插件宿主侧核心：档位状态 + 编排决策 + 台账/看板数据 + 工具动作分发。
// 复用优先（DEV_GUIDE §0）：本服务只做“状态 + 计划 + 展示 + 记账”，实际代理执行由主模型调用
// 现有 subagent / workflow / team_task_* 原语完成，再通过 token2biq 工具回传回执。
import { RunStore } from './run-store.js';
import { SettingsStore, effectiveForceTeam, parseModelRef } from './settings.js';
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
  // 用 .length（UTF-16 码元）近似即可：Array.from 会按码点展开成数组，
  // 10MB 回执（大 diff / 长日志）会瞬时分配上千万元素并同步阻塞事件循环。
  const len = String(s || '').length;
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
    // 以「最新一条回执」为准：review 重试通过后阶段必须自愈成 done，
    // 否则历史上任意一次 FAIL 会把看板永久粘死在 failed，与任务回执自相矛盾。
    const lastFail = ts.map((t) => t.status === 'failed').lastIndexOf(true);
    if (lastFail === ts.length - 1) return 'failed'; // 最新一次仍失败
    // 最后一次失败之后全部通过 → 自愈为 done（历史那几条 FAIL 不再粘住阶段）
    if (lastFail >= 0) return ts.slice(lastFail + 1).every((t) => t.status === 'done') ? 'done' : 'running';
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
    // 先记下「设置层」的强制意图；startWithAuto 会在确认团队真的可用后再决定是否生效，
    // 否则会和 record 的硬门禁形成死锁（要求 teamTaskId，却一条任务都建不出来）。
    run.forceTeam = forceActive;
    // 立刻落盘：否则进程在首次 record 前重启，S4 运行会丢字段、回退实时判定 → 重新上闸。
    if (forceActive) { try { this.store.flush(); } catch { /* ignore */ } }
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
      next: '按 playbook.steps 用官方 Agent Teams 执行（subagent 起队员 / team_task_create 建共享任务 / send_message 派活 / wait_agent 等结果）；每完成一个阶段调用 token2biq action=record 回传回执（带 teamTaskId/owner）。全部完成后 action=finish。' + autoHint + teamHint + strictHint,
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
    // 本会话锁定档位（S1/S2/S3/S4）强制优先，忽略调用方传入的异档（修复评审 issue #6）：
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
        const created = await this.autoBoard(base.run.id, base.roster, ctxInfo);
        if (created && created.ok !== false) {
          base.orchestrated = true;
          base.created = created;
          const nTasks = (created.tasks || []).filter((x) => x.taskId).length;
          const nTaskErr = (created.tasks || []).filter((x) => x.error).length;
          const nBrief = (created.briefing || []).length;
          base.next = '插件已按档位建共享任务板' + (nTasks ? ('（' + nTasks + ' 个任务）') : '')
            + (nBrief
              ? ('；' + nBrief + ' 个阶段需要常驻队员：用 subagent 工具按 created.briefing[i].delegation 起队员（description/name/prompt 直接照抄）')
              : '；本次没有常驻队员（阶段均指定了模型或为空），请由你按 roster 顺序执行或用 subagent 执行')
            + '；每完成一个阶段 token2biq action=record（带 teamTaskId/owner），全部完成 action=finish。'
            + (nTaskErr ? '（' + nTaskErr + ' 个任务建档失败，见 created.tasks[].error）' : '')
            + (created.cappedNote ? '（' + created.cappedNote + '）' : '');
          if (Array.isArray(created.modelRouting) && created.modelRouting.length) {
            base.next += ' 以下阶段指定了模型，须用 subagent 工具按 provider/model 显式执行（若工具报 "model selection is disabled"，说明宿主未开 tool-subagent.modelSelection，见插件 cordis.patch.yml），执行后 team_task_update complete 对应共享任务，并在 record 时带 model：' + created.modelRouting.map((m) => m.stage + '=' + (m.provider && m.modelName ? (m.provider + ' + ' + m.modelName) : m.model) + (m.taskId ? '(' + m.taskId + ')' : '')).join('、') + '。';
          }
        } else if (created && created.reason) {
          // 「未知」不等于「没有常驻队员」：把真实原因说出来，别再伪装成正常态。
          base.orchestrated = false;
          base.degraded = 'no-orchestration';
          base.orchestrationError = created.reason;
          base.next = '未建任务板：' + created.reason + '。已回退为纯计划，请按 playbook.steps 直接执行（无需 subagent）。';
          try { console.warn('[token2biq] ' + base.next); } catch { /* ignore */ }
        }
      } catch (e) {
        base.orchestrated = false;
        base.degraded = 'no-orchestration';
        base.orchestrationError = String((e && e.message) || e);
      }
    }
    // 降级必须显式可见（UPGRADE §D6）：调用方不该靠正则匹配 next 中文文案才知道有没有建团。
    if (base.orchestrated === true) base.degraded = null;
    else if (!base.degraded) base.degraded = (ctxInfo && ctxInfo.agentTeams) ? 'no-orchestration' : 'no-team';
    // 强制联动 × 团队不可用 = 死锁：record 永远要求 teamTaskId，但一条共享任务都建不出来，
    // 运行永远无法完成。团队没建成时自动降级为「仅提示」，并把原因显式带回调用方。
    if (base.orchestrated !== true && base.forceTeam === true) {
      base.forceTeam = false;
      base.forceTeamDowngraded = base.degraded || 'no-team';
      // start() 在还不知道团队是否可用时就写了「已开启强制联动」——降级时必须撤掉，否则自相矛盾。
      base.next = String(base.next || '').replace(/（本档 [^）]*已开启强制联动[^）]*）/g, '');
      // playbook 才是模型真正读的指令集：不一起改，模型会同时收到「必须建团队」和「不必建团队」。
      try {
        if (base.playbook && typeof base.playbook === 'object') {
          base.playbook = {
            ...base.playbook,
            requireTeam: false,
            rules: (Array.isArray(base.playbook.rules) ? base.playbook.rules : [])
              .filter((x) => !/强制联动|teamTaskId/.test(String(x))),
          };
        }
      } catch { /* 改不动也不影响主流程 */ }
      try {
        const r2 = this.store.getRun(base.run.id);
        if (r2) {
          r2.forceTeam = false;
          // 降级原因必须落到运行上：面板 / action=state / 导出报告都要能查到为什么没建团。
          r2.degraded = base.degraded || 'no-team';
          r2.orchestrationError = base.orchestrationError || null;
          this.store.flush();
        }
      } catch { /* 持久化失败不影响本次降级 */ }
      base.next += '（⚠ 强制联动已自动降级：本次没有可用的团队任务板，record 不再要求 teamTaskId/owner。想恢复强制，请先在输入框开启 Agent Teams 再重新 start。）';
    }
    return base;
  }

  // 主动编排核心（0.2.2-rc.3 契约）：只建共享任务板 + 产出可执行的派活简报，**不再 spawn**。
  // 判定 Lead：agentTeams.isEnabled(agent) 且 subagents.rootOf(agent) === agent；
  // 任一不满足（非 Team 成员 / 已脱离团队的独立恢复子智能体）返回 null，回退纯计划。
  async autoBoard(runId, roster, { agentTeams, subagents, agent } = {}) {
    const run = this.store.getRun(runId);
    if (!run || !Array.isArray(roster) || !roster.length) return { ok: false, reason: '运行不存在或没有可派活的阶段' };
    if (!agentTeams || typeof agentTeams.isEnabled !== 'function' || typeof agentTeams.createTask !== 'function') {
      return { ok: false, reason: '宿主未提供 agentTeams.createTask（DSH 版本不匹配？）' };
    }
    let enabled = false;
    try { enabled = agentTeams.isEnabled(agent); } catch (e) { return { ok: false, reason: 'agentTeams.isEnabled 抛错：' + String((e && e.message) || e) }; }
    if (!enabled) return { ok: false, reason: '当前 agent 未开启 Agent Teams（agentTeams.isEnabled=false）' };
    if (subagents && typeof subagents.rootOf === 'function') {
      try { if (subagents.rootOf(agent) !== agent) return { ok: false, reason: '当前 agent 不是 Team 根（subagents.rootOf !== agent）' }; } catch (e) { return { ok: false, reason: 'subagents.rootOf 抛错（身份已脱离团队？）：' + String((e && e.message) || e) }; }
    }
    const maxAgents = Math.max(1, (run.plan && run.plan.maxAgents) || 1);
    // P3 成本闸门：playbook 承诺「80% 收敛 / 100% 熔断」，这里把它落到建板上。
    // 只有显式设了 tokenBudget 才生效（默认 0=不限），保证向后兼容。
    const budget = Number((this.settings.get() || {}).tokenBudget) || 0;
    const spentTokens = ((run.ledger && run.ledger.totalIn) || 0) + ((run.ledger && run.ledger.totalOut) || 0);
    const budgetGate = budget > 0
      ? { spent: spentTokens, budget, percent: Math.round((spentTokens / budget) * 100), level: spentTokens >= budget ? 'hard' : (spentTokens / budget >= 0.8 ? 'soft' : 'ok') }
      : null;
    const capabilityProbe = {
      teamTasks: typeof agentTeams.createTask === 'function',
      leadGate: !!(subagents && typeof subagents.rootOf === 'function'),
      writeScopesDeclared: roster.some((r) => Array.isArray(r.writeScopes) && r.writeScopes.length > 0),
    };
    if (budgetGate && budgetGate.level === 'hard') {
      // 熔断：预算已用尽，不再新建任何任务，让 Lead 收口而不是继续烧钱。
      run.budgetGate = budgetGate;
      run.capabilities = capabilityProbe;
      try { this.store.flush(); } catch { /* ignore */ }
      return {
        maxAgents, tasks: [], briefing: [], modelRouting: [],
        cappedNote: '预算已用尽（' + budgetGate.percent + '%），已熔断：不再新建任务，请 action=finish 收口',
        ok: true, degraded: true, capabilities: capabilityProbe, budgetGate,
      };
    }
    // 先判定「哪些阶段由模型路由（不 spawn 队友）」，用于任务依赖链与 spawn 预算。
    const routedStages = new Set(roster.filter((r) => !!r.model).map((r) => r.stage));
    const tasks = [];
    const taskIdByStage = {};
    // P1：只对「明确未创建」的瞬时错误退避重试。createTask 不是幂等的——
    // 超时/未知错误直接重试会在任务板上留重复任务，所以只放行可判定的错误码。
    const RETRYABLE = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|UNAVAILABLE|overload|rate.?limit|\b5\d\d\b/i;
    const withRetry = async (fn, attempts = 3) => {
      let last;
      for (let i = 0; i < attempts; i += 1) {
        try { return await fn(); } catch (e) {
          last = e;
          const code = String((e && (e.code || e.message)) || e);
          if (!RETRYABLE.test(code) || i === attempts - 1) throw e;
          await new Promise((res) => setTimeout(res, 150 * (i + 1)));
        }
      }
      throw last;
    };
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
        const view = await withRetry(() => agentTeams.createTask(agent, {
          subject: ('[' + run.mode + '] ' + this._fillGoal(r.subject, run.goal)).slice(0, 200),
          description: this._stageDescription(run, r).slice(0, 16384),
          ...(blockedBy ? { blockedBy } : {}),
          ...(r.writeScopes && r.writeScopes.length ? { writeScopes: r.writeScopes } : {}),
        }));
        if (view && view.id) taskIdByStage[r.stage] = view.id;
        tasks.push({ stage: r.stage, subject: this._fillGoal(r.subject, run.goal), taskId: view && view.id });
      } catch (e) {
        tasks.push({ stage: r.stage, subject: this._fillGoal(r.subject, run.goal), error: String((e && e.message) || e) });
      }
    }
    // 模型路由：覆盖整份 roster（不受 maxAgents 窗口限制，修复评审 issue #1——超窗口的模型阶段不再被静默丢弃）。
    // 按 roster 下标取各自 taskId，保证 S4 并行多审同一 stage 的多条子步骤各绑各的任务（不塌缩到最后一个）。
    // 额外给出拆好的 provider/modelName：next 要求 Lead「显式传 provider/model」，
    // 只给合并引用（provider::model）会让它自己猜怎么切——猜错就静默走默认模型，强模型等于没配上。
    // model 保持合并引用不变（既有契约，report.js 与 test/tier-policy.test.js 都依赖它）。
    const modelRouting = roster.map((r, idx) => ({ r, idx })).filter((x) => !!x.r.model).map((x) => {
      const parsed = parseModelRef(x.r.model);
      return {
        stage: x.r.stage,
        model: x.r.model,
        provider: parsed ? parsed.provider : null,
        modelName: parsed ? parsed.model : x.r.model,
        taskId: (tasks[x.idx] && tasks[x.idx].taskId) || taskIdByStage[x.r.stage] || null,
        role: x.r.role,
      };
    });
    // 派活简报：只对「非模型阶段」生成，最多 maxAgents 条；每条是一份可直接喂给 subagent 工具的委派参数。
    // 模型阶段改由 Lead 用 subagent(provider/model) 执行，不占常驻名额。
    const briefing = roster.filter((r) => !routedStages.has(r.stage)).slice(0, maxAgents).map((r) => ({
      stage: r.stage,
      role: r.role,
      name: r.name,
      taskId: taskIdByStage[r.stage] || null,
      handoff: this._handoff(run, r.stage).items,
      delegation: {
        description: (run.mode + '·' + r.role + '·' + this._fillGoal(r.subject, run.goal)).slice(0, 120),
        name: r.name,
        ...(r.model ? { model: r.model } : {}),
        prompt: this._spawnPrompt(run, r, taskIdByStage[r.stage]),
      },
    }));
    run.orchestrated = true;
    run.capabilities = capabilityProbe;
    run.budgetGate = budgetGate;
    run.teamTasks = tasks;
    run.roster = roster.map((r) => ({ stage: r.stage, role: r.role, name: r.name }));
    run.modelRouting = modelRouting; // 持久化，供 action=state / runView 查看
    run.briefing = briefing;         // 派活简报：面板与 action=state 都能直接看到
    try { this.store.flush(); } catch { /* ignore */ }
    const nonModelCount = roster.length - routedStages.size;
    const notes = [];
    if (nonModelCount > maxAgents) notes.push('非模型阶段 ' + nonModelCount + ' > maxAgents ' + maxAgents + '，仅前 ' + maxAgents + ' 个进了派活简报，其余任务留在板上由 Lead/成员接续');
    // 模型路由的说明由 startWithAuto 统一追加（带 stage=model 明细），这里不重复。
    const cappedNote = notes.join('；');
    const capabilities = capabilityProbe;
    if (budgetGate && budgetGate.level === 'soft') notes.push('预算已用 ' + budgetGate.percent + '%：进入收敛，不再新增阶段，优先完成在办任务');
    const cappedNote2 = notes.join('；');
    return { ok: true, maxAgents, tasks, briefing, modelRouting, cappedNote: cappedNote2, degraded: false, capabilities, budgetGate };
  }

  // 兼容 0.4.x 内部调用点：名字保留，语义已改为「只建板 + 出简报」。
  autoSpawn(runId, roster, info) {
    return this.autoBoard(runId, roster, info);
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

  // 把阶段模板里的占位符换成实际目标摘要。
  // 否则任务板上显示的是字面「<目标>」，队员得自己猜，面板也不好看。
  _fillGoal(text, goal) {
    const g = String(goal || '').replace(/\s+/g, ' ').trim();
    if (!g) return String(text || '');
    const short = g.length > 60 ? (g.slice(0, 60) + '…') : g;
    return String(text || '').replace(/<目标>/g, short).replace(/<子任务>/g, short);
  }

  // P2 结构化交接：把上游已完成阶段的产物摘要带给下游队员，
  // 避免「每个阶段从零推理」——这是多代理协作最常见的隐性成本。
  _handoff(run, stage) {
    const order = (run && run.plan && Array.isArray(run.plan.stages)) ? run.plan.stages : [];
    const idx = order.indexOf(stage);
    const before = idx < 0 ? [] : order.slice(0, idx);
    const done = ((run && run.tasks) || []).filter((t) => t && before.includes(t.stage) && (t.status === 'done' || t.verdict));
    const items = done.map((t) => ({
      stage: t.stage,
      files: Array.isArray(t.files) ? t.files : [],
      diffSummary: t.diffSummary || '',
      verdict: t.verdict || null,
      issues: Array.isArray(t.issues) ? t.issues : [],
    }));
    const openIssues = items.flatMap((i) => i.issues.map((x) => (typeof x === 'string' ? x : (x && (x.message || x.msg)) || JSON.stringify(x))));
    const text = items.length
      ? ('上游已完成：' + items.map((i) => i.stage + (i.verdict ? ('(' + i.verdict + ')') : '') + (i.files.length ? (' 改 ' + i.files.slice(0, 5).join(',')) : '')).join('；')
        + (openIssues.length ? ('\n未关闭问题：' + openIssues.slice(0, 8).join('；')) : ''))
      : '上游尚未产出（你是首个阶段或上游未回执），按判据自行推进。';
    return { items, openIssues, text };
  }

  _spawnPrompt(run, r, taskId) {
    const lines = [
      '你是 Token 2b IQ 运行 ' + run.id + ' 的「' + r.stage + '」阶段队员（角色 ' + r.role + '）。',
      '总目标：' + (run.goal || ''),
      '你的共享任务：' + (taskId || '(见 team_task_list)') + '（subject: ' + this._fillGoal(r.subject, run.goal) + '）',
      '完成判据：' + (r.doneWhen || ''),
      '交接（上游产物）：' + this._handoff(run, r.stage).text,
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
    if (!runId) return { ok: false, error: '缺少 runId：请先 action=start，再传它返回的 run.id（形如 run_xxx）' };
    if (!run) return { ok: false, error: `找不到运行 ${runId}，请先 action=start` };
    if (run.status === 'done') return { ok: false, error: `运行已结束（${run.status}），不能再 record；如需继续请新建运行。` };
    if (run.paused) return { ok: false, error: '运行已暂停，请先 action=resume 再 record。' };
    const kind = args.stage || 'generate';

    // 强制联动官方 Agent Teams：按设置与档位判定（默认 S2/S3/S4 强制、S1 不强制），
    // 开启时回执必须绑定共享任务与队员，确保真的走了团队而非单代理。
    const st = this.settings.get();
    // 以「开跑时团队是否真的可用」为准：不可用时 startWithAuto 已把 run.forceTeam 降级为 false。
    // 老运行没有该字段，回退按设置+档位实时判定，保持原有行为。
    const enforceTeam = (typeof run.forceTeam === 'boolean') ? run.forceTeam : effectiveForceTeam(st, run.mode);
    if (enforceTeam && (!args.teamTaskId || !args.owner)) {
      return {
        ok: false,
        error: `强制联动已开启（${run.mode}）：record 必须带 teamTaskId（共享任务 id）与 owner（队员 target）。`,
        hint: '门禁以「开跑时团队是否可用」为准（run.forceTeam 快照），改设置只影响新运行。当前运行请：① 补 teamTaskId/owner 后重试；或 ② 用 action=finish 收口放弃。',
        // 同时回传「实时设置」与「本次运行快照」：只回设置会出现 {error:"已开启", forceTeam:"off"}
        // 这种自打脸的响应，只回 true 又丢掉用户改没改设置的线索。
        forceTeam: st.forceTeam,
        runForceTeam: run.forceTeam,
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
    // 回执只允许落终态：记成 running/pending 会让「任务=running、阶段=done」永久打架
    // （effStageStatus 从任务派生 → 看板永远显示进行中，finish 也修不回来）。
    const requestedStatus = v.value.verdict
      ? (v.value.verdict === 'PASS' ? 'done' : 'failed')
      : (v.value.status || 'done');
    if (requestedStatus !== 'done' && requestedStatus !== 'failed') {
      warnings.push('record 的 status="' + requestedStatus + '" 不是终态，已按 done 记录（一条回执代表一步已完成；要暂停请用 action=pause）');
    }
    const status = requestedStatus === 'failed' ? 'failed' : 'done';

    const task = this.store.addTask(runId, {
      stage: kind, role: args.role || defaultRole(kind), brief: args.brief || '',
      status, receipt: v.value, tokensIn: tin, tokensOut: tout, estimated,
      teamTaskId: args.teamTaskId, owner: args.owner, model: args.model,
    });
    if (this.store.lastFlushError) warnings.push(`回执已记录但未持久化（写盘失败：${this.store.lastFlushError}），重启后可能丢失`);
    // 阶段状态推进：本步完成即置 done / 失败置 failed（否则看板会永远停在 running）。
    // 并行多审（S4）：review/judge/redteam 同一阶段可能有多条回执（每候选一条），需按“任一 FAIL 即失败”聚合。
    if (task) {
      const isReviewKind = ['review', 'judge', 'redteam'].includes(kind);
      if (isReviewKind) {
        const latest = this.store.getRun(runId);
        const sameKind = ((latest && latest.tasks) || []).filter((t) => t.kind === kind);
        // 同样以最新一条回执为准（重试自愈优先）。S4 并行多审若需「任一 FAIL 即失败」，
        // 由 Lead 在 action=finish 用最终 verdict 收口，而不是让阶段状态永久粘死。
        const lastTask = sameKind[sameKind.length - 1];
        const lastFail = !!(lastTask && lastTask.receipt && lastTask.receipt.verdict === 'FAIL');
        this.store.setStageStatus(runId, kind, (lastFail || status === 'failed') ? 'failed' : 'done');
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
    if (!runId) return { ok: false, error: '缺少 runId：请先 action=start，再传它返回的 run.id（形如 run_xxx）' };
    if (!run) return { ok: false, error: `找不到运行 ${runId}` };
    // verdict 必填：缺省不再静默记成 FAIL（P2-6）。
    if (verdict == null || String(verdict).trim() === '') {
      return { ok: false, error: 'finish 需要 verdict（PASS 或 FAIL）', hint: '传 PASS 表示交付，FAIL 表示放弃/失败。' };
    }
    // 幂等：已结束的运行不允许重复 finish 覆盖裁决（P2-8）。
    if (run.status === 'done') {
      return { ok: false, error: '该运行已结束，不能重复 finish', hint: '如需重跑请新建运行。', verdict: run.verdict };
    }
    // 暂停中的运行不允许直接收尾：否则会留下 status=done + paused=true 的矛盾态，且 setPaused 之后拒绝修复。
    if (run.paused) {
      return { ok: false, error: '运行处于暂停状态，不能 finish', hint: '先 action=resume 恢复，再 finish（或直接 delete 放弃这次运行）。' };
    }
    // 严格流水线硬门禁：必须已完成验证（带 testsRun 证据、PASS）才能收尾；多候选须 judge 择优。
    const stf = this.settings.get();
    if (stf.pipelineGate === 'strict') {
      // testsPassed === false 必须一票否决：旧的 `||` 让「测试全红」也算通过，「不通过不许交付」形同虚设。
      const verified = (run.tasks || []).some((t) => (t.kind === 'verify' || t.kind === 'regression') && t.status === 'done' && t.receipt && t.receipt.verdict === 'PASS' && t.receipt.testsPassed !== false && ((Array.isArray(t.receipt.testsRun) && t.receipt.testsRun.length > 0) || t.receipt.testsPassed === true));
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
    const out = { ok: true, verdict: vd, run: this.store.summary(this.store.getRun(runId)) };
    if (this.store.lastFlushError) out.persistWarning = `裁决已记录但未持久化（写盘失败：${this.store.lastFlushError}）`;
    return out;
  }

  setPaused(runId, paused) {
    if (!runId) return { ok: false, error: '缺少 runId：请先 action=start，再传它返回的 run.id（形如 run_xxx）' };
    const r = this.store.getRun(runId);
    if (!r) return { ok: false, error: `找不到运行 ${runId}` };
    // 已结束不可再暂停/恢复：否则 pause→resume 会把 status 从 done 复活成 running，
    // 绕过 record/finish 的「已结束不可再写」门禁，二次 finish 还会静默覆盖原裁决。
    if (r.status === 'done') return { ok: false, error: '该运行已结束（done），不能再暂停/恢复' };
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
    if (!runId) return { ok: false, error: '缺少 runId：请先 action=start，再传它返回的 run.id（形如 run_xxx）' };
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
      // 设置写盘失败必须可见（门禁静默翻转比报错更危险）。
      settingsPersisted: !this.settings.lastSaveError,
      settingsSaveError: this.settings.lastSaveError || null,
      // 快照损坏/自动恢复/淘汰也必须可见，别让历史在无声中消失。
      stateLoadError: this.store.lastLoadError || null,
      stateRecoveredFrom: this.store.lastRecovered || null,
      statePruned: this.store.lastPruned || null,
      runs,
      liveUsage: this.liveView(),
      current: run ? this.runView(run) : null,
    };
  }

  runView(r) {
    const spent = (r.ledger.totalIn || 0) + (r.ledger.totalOut || 0);
    // P3 可观测性：预算闸门在面板/action=state 上直接可见（0=不限）。
    // 熔断点在 autoBoard：一旦进入 hard 就不再新建任务，让 Lead 收口。
    const budgetTokens = Number((this.settings.get() || {}).tokenBudget) || 0;
    const budgetGate = budgetTokens > 0
      ? { spent, budget: budgetTokens, percent: Math.round((spent / budgetTokens) * 100), level: spent >= budgetTokens ? 'hard' : (spent / budgetTokens >= 0.8 ? 'soft' : 'ok') }
      : null;
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
      // 工具侧 action=state 读的是 cur.tasks / cur.taskCount，这里必须暴露，
      // 否则 state 永远显示 0 个任务（历史缺陷：只有 stages 没有 tasks）。
      tasks: r.tasks.map((t) => this.taskView(t)),
      // 状态跃迁审计流（最近 30 条）：出问题能直接看「谁在什么时候改了状态」。
      events: Array.isArray(r.events) ? r.events.slice(-30) : [],
      reviews: r.reviews.slice(-30).map((rv) => this.reviewView(rv)),
      verdict: r.verdict,
      ledger: { ...r.ledger, spent },
      real: r.real ? { ...r.real } : null,
      generateModel: r.generateModel || null,
      // 降级必须可观测：否则面板/报告只能看到 orchestrated:false，看不到原因。
      // 注意别叫 forceTeam——那会和设置里的字符串（'on'/'off'/'auto'）撞名，把设置值覆盖成布尔。
      degraded: r.degraded || null,
      orchestrationError: r.orchestrationError || null,
      forceTeamActive: typeof r.forceTeam === 'boolean' ? r.forceTeam : null,
      candidates: r.candidates || 1,
      spec: r.spec || null,
      orchestrated: !!r.orchestrated,
      capabilities: r.capabilities || null,
      budgetGate,
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
      // 入参叫 stage、出参叫 kind 会让调用方「传了却在返回里搜不到」；两个键都回显。
      stage: t.kind,
      // record 会把 diffSummary 折进 summary（见回执构造），两者取先有的那个。
      diffSummary: rc.diffSummary || rc.summary || '',
      estimated: t.estimated === true,
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
        // 同步入口做不了团队可用性判定（autoBoard 是 async）：统一委托 startWithAuto。
        // 否则这里起出来的运行 run.forceTeam 恒为 true 却没有任务板 —— 原始死锁会原地复现。
        case 'start': return this.startWithAuto({ goal: args.goal, mode: args.mode });
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
            'Token 2b IQ 编排控制器（只做档位/计划/记账/展示；执行由官方 Agent Teams 完成：subagent / team_task_* / send_message / wait_agent）。',
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
