// Token2bIQService —— 插件宿主侧核心：档位状态 + 编排决策 + 台账/看板数据 + 工具动作分发。
// 复用优先（DEV_GUIDE §0）：本服务只做“状态 + 计划 + 展示 + 记账”，实际代理执行由主模型调用
// 现有 subagent / workflow / team_task_* 原语完成，再通过 token2biq 工具回传回执。
import { RunStore } from './run-store.js';
import { SettingsStore, effectiveForceTeam, effectivePipelineGate, parseModelRef } from './settings.js';
import {
  generatePlan, normalizeMode, nextMode, MODES, MODE_META, STAGE_LABEL,
  PLANS, buildTeamPlaybook, buildRoster, classifyDetailed, resolveTaskType, applyProfileToPlan,
} from './orchestrator.js';
import { validateReceiptByStage, testsProven } from './receipts.js';
import { buildReport } from './report.js';
import { aggregateStageStatus, effStageStatus, latestPerSlot, REVIEW_KINDS } from './stage-state.js';

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
    plan: 'planner', research: 'researcher', generate: 'worker', synth: 'synthesizer', review: 'reviewer',
    judge: 'judge', verify: 'verifier', redteam: 'red-team', regression: 'verifier',
  })[kind] || 'worker';
}

// 阶段「有效状态」的聚合逻辑已抽到 ./stage-state.js（纯函数，可单测）：
// 每个执行 slot 取最新回执，再「任一失败即失败」——S4 并行多审下
// [A=FAIL, B=PASS] 不能被 B 的 PASS 抹成 done。

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
    this.currentRunId = null;   // 当前活动运行：llm/stream 的真实用量按它归集（无会话映射时的兜底）
    // 会话 → 运行：宿主 usage 分片不带 runId，但带 sessionId。多会话并行时按会话精确归集，
    // 避免「A 会话跑 S3」的 token 被算进同时在跑的 B 运行（旧实现只有一个全局指针）。
    this.runSessions = new Map();
    this.provisionStatus = null; // 首次/手动自动配置宿主的结果（启动失败必须在 state 可见，不能只进日志）
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
  noteUsage(usage = {}, sessionId, classifyToken = null) {
    // 插件自身的 Auto 分类调用不计入「实时 token」（否则会把路由开销算进用户用量）。
    // 只跳过携带分类 token 的那一条流；全局计数会误伤分类期间其它并发流。
    if (classifyToken && this._classifyingTokens && this._classifyingTokens.has(classifyToken)) return;
    // 兼容旧调用/旧测试：插件运行时不再设置 _classifying，只有显式置位时才走旧行为。
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
    // 真实用量归集：优先按「会话 → 运行」精确匹配（并发运行不再互相串账）；
    // 没有映射时退回全局活动运行（旧行为，面板标注「实测·含同进程」）。
    let rid = this.runSessions.get(sid) || null;
    if (rid) {
      const mapped = this.store.getRun(rid);
      if (!mapped || mapped.status === 'done' || mapped.paused) { this.runSessions.delete(sid); rid = null; }
    }
    if (!rid) rid = this.currentRunId;
    if (rid) {
      const run = this.store.getRun(rid);
      if (run && run.status !== 'done' && !run.paused) {
        this.store.addRealUsage(rid, usage);
        const now = Date.now();
        if (now - (this._lastUsageFlush || 0) > 2000) {
          try { this.store.flush(); } catch { /* ignore */ }
          this._lastUsageFlush = now;
        }
      } else if (!run || run.status === 'done' || run.paused) {
        // 运行被删除同样要清指针，否则后续 usage 一直往不存在的 run 上写。
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

  // 更新并持久化设置；只刷新 defaultMode（新运行/新会话的默认值），不动当前会话已选档位。
  updateSettings(patch = {}) {
    const s = this.settings.update(patch);
    this.config.defaultMode = s.defaultMode;
    return s;
  }

  planFor(mode, goal, taskType) {
    // map / 预览路径也要按任务类型出计划，否则面板看到的阶段和实际跑的不一致。
    const tt = taskType != null ? taskType : (this.settings.get().taskType);
    return generatePlan(mode || this.mode, { goal, taskType: tt });
  }

  start({ goal, mode, resolvedMode, autoDecision, candidates, acceptance, spec, constraints, risk, modelMeta, defaultModel, taskType, profile, sessionId } = {}) {
    const settings0 = this.settings.get();
    // P0 任务画像优先于关键词：显式 taskType > profile.taskType > 设置 > 关键词兜底。
    const profileTaskType = profile && (profile.taskType === 'code' || profile.taskType === 'investigation') ? profile.taskType : null;
    const taskTypeInput = taskType != null ? taskType : (profileTaskType != null ? profileTaskType : settings0.taskType);
    // 任务类型在 start 时就定死并落到 run 上：后续 record/finish 的门禁都读这一份快照，
    // 避免中途改设置让同一次运行的门禁行为前后不一致。
    const resolvedTaskType = resolveTaskType(taskTypeInput, goal || '');
    // 风险：显式 risk 优先，其次画像 risk=high（用于是否展开 judge/redteam）。
    const effRisk = risk != null ? risk : (profile && profile.risk === 'high' ? 'high' : undefined);
    let plan = generatePlan(mode || this.mode, { goal, resolvedMode, risk: effRisk, taskType: resolvedTaskType });
    // P0 策略矩阵：按画像复杂度在档位上限内配平阶段数（仅在提供 profile 时触发，向后兼容）。
    if (profile) plan = applyProfileToPlan(plan, profile);
    const run = this.store.createRun({ goal, plan, mode: plan.requestedMode });
    run.taskType = resolvedTaskType;
    this.currentRunId = run.id;
    if (sessionId) {
      const sid = String(sessionId);
      if (this.runSessions.size >= 256 && !this.runSessions.has(sid)) {
        const first = this.runSessions.keys().next().value;
        this.runSessions.delete(first);
      }
      this.runSessions.set(sid, run.id);
    }
    run.candidates = Math.min(5, Math.max(1, Math.floor(Number(candidates) || 1)));
    run.spec = run.spec || null;
    // 允许在 start 直接给出验收标准（解决 S1 无 plan/research 阶段时 strict 无法产生 spec 的死锁）。
    if (spec || acceptance) {
      run.spec = { summary: spec || '', acceptance: acceptance || spec || '', constraints: constraints || '', at: Date.now() };
    }
    if (autoDecision) run.autoDecision = autoDecision;
    if (autoDecision || run.candidates > 1 || run.spec || run.taskType) this.store.flush();
    const settings = settings0;
    const forceActive = effectiveForceTeam(settings, plan.mode);
    // 先记下「设置层」的强制意图；startWithAuto 会在确认团队真的可用后再决定是否生效，
    // 否则会和 record 的硬门禁形成死锁（要求 teamTaskId，却一条任务都建不出来）。
    run.forceTeam = forceActive;
    // 立刻落盘：否则进程在首次 record 前重启，S4 运行会丢字段、回退实时判定 → 重新上闸。
    if (forceActive) { try { this.store.flush(); } catch { /* ignore */ } }
    const effGate = effectivePipelineGate(settings, run);
    const playbook = buildTeamPlaybook(plan, {
      rolePools: settings.rolePools,
      parallelReviews: settings.parallelReviews,
      allowModels: settings.allowModels,
      independentReview: settings.independentReview,
      forceTeam: forceActive,
      pipelineGate: effGate,
      multiReview: plan.mode === 'S4',
      modelMeta: modelMeta || {},
      defaultModel: defaultModel || null,
      settings,
    });
    const teamHint = forceActive
      ? `（本档 ${plan.mode} 已开启强制联动：record 必须带 teamTaskId/owner，否则会被拒收）`
      : '';
    const autoHint = autoDecision
      ? `（Auto 判定→${plan.mode}，依据：${autoDecision.decidedBy === 'llm' ? '模型复核' : autoDecision.decidedBy === 'heuristic' ? '关键词（有把握）' : '关键词兜底'}${autoDecision.reason ? '，' + autoDecision.reason : ''}）`
      : '';
    const strictHint = effGate === 'strict'
      ? (resolvedTaskType === 'investigation'
        ? '（严格流水线·调查任务：无需 generate；synth 成稿后须有 verify/regression 且带 testsRun 才能 finish(PASS)；多候选须 judge 择优）'
        : '（严格流水线：进入 generate 前须有 spec——可在 action=start 传 acceptance，或先 record 一个 plan 阶段；verify/regression 须带 testsRun；多候选须让 judge 带 selectedCandidate；否则 record/finish 会被拒收）')
      : '';
    return {
      ok: true,
      run: this.store.summary(run),
      plan,
      playbook,
      roster: buildRoster(plan, playbook, { runId: run.id }),
      orchestrated: false,
      candidates: run.candidates || 1,
      pipelineGate: settings.pipelineGate,
      taskType: resolvedTaskType,
      autoDecision: autoDecision || null,
      forceTeam: forceActive,
      forceTeamSetting: settings.forceTeam,
      stages: run.stages.map((s) => ({ kind: s.kind, label: STAGE_LABEL[s.kind] || s.kind, status: s.status })),
      // 落盘失败必须显式告警：否则进程重启后运行凭空消失，而调用方以为已创建。
      persistWarning: this.store.lastFlushError ? `运行已创建但未持久化（写盘失败：${this.store.lastFlushError}），重启后会丢失` : null,
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
          const profT = (j.taskType === 'investigation' || j.taskType === 'doc') ? 'investigation' : (j.taskType === 'code' ? 'code' : null);
          const prof = (profT || j.complexity || j.risk)
            ? { taskType: profT, complexity: j.complexity || null, risk: j.risk || null }
            : null;
          return { tier: j.tier, score: det.score, confident: true, decidedBy: 'llm', worthTeam: j.worthTeam, reason: j.reason || '', profile: prof };
        }
      } catch { /* 回退 */ }
    }
    return { ...det, decidedBy: 'fallback', reason: '模型判断不可用，按关键词兜底' };
  }

  // P0：让模型给「任务画像」（type/complexity/risk），用于选流水线与配平阶段；失败/无模型回退关键词。
  async resolveProfile(goal = '') {
    if (typeof this.classifier !== 'function') return null;
    let j = null;
    try { j = await this.classifier(goal); } catch { return null; }
    if (!j) return null;
    const taskType = (j.taskType === 'investigation' || j.taskType === 'doc') ? 'investigation' : j.taskType === 'code' ? 'code' : null;
    const complexity = ['simple', 'medium', 'complex'].includes(j.complexity) ? j.complexity : null;
    const risk = ['low', 'medium', 'high'].includes(j.risk) ? j.risk : null;
    if (!taskType && !complexity && !risk) return null;
    return { taskType, complexity, risk };
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
    // start 前探测模型目录：记录每个模型的 reasoning 能力（供 resolveEffort 夹取/降级），失败静默吞掉。
    let modelMeta = null;
    let defaultModel = (ctxInfo && ctxInfo.defaultModel) || null;
    if (ctxInfo && typeof ctxInfo.modelCatalog === 'function') {
      try {
        const cat = await ctxInfo.modelCatalog();
        if (cat && Array.isArray(cat.groups)) {
          modelMeta = {};
          for (const g of cat.groups) {
            if (!g || !Array.isArray(g.models)) continue;
            for (const m of g.models) {
              if (!m || !m.id) continue;
              modelMeta[g.id + '::' + m.id] = { reasoning: m.reasoning || null };
            }
          }
        }
        const d = cat && cat.default;
        if (d) {
          const prov = d.provider || d.group || d.groupId || d.providerId;
          const mid = d.model || d.id || d.modelId;
          if (prov && mid) defaultModel = prov + '::' + mid;
        }
      } catch { /* 模型目录不可用则按无 reasoning 降级 */ }
    }
    let base;
    const runSid = this._sessionIdOf(ctxInfo);
    // P0 任务画像：无显式 taskType 且设置为 auto 时，让模型给一次画像（type/complexity/risk）。
    // 与 autoDecide 不重复调用：锁定档位只在这里取画像；Auto 档复用 decision.profile。
    const wantProfile = args.taskType == null && (this.settings.get().taskType == null || this.settings.get().taskType === 'auto');
    if (requested !== 'Auto') {
      let profile = args.profile || null;
      if (!profile && wantProfile) profile = await this.resolveProfile(args.goal || '');
      base = this.start({ ...args, mode: useMode, profile, modelMeta, defaultModel, sessionId: runSid });
    } else {
      const decision = await this.autoDecide(args.goal || '');
      const profile = args.profile || (decision && decision.profile) || null;
      base = this.start({ ...args, mode: 'Auto', resolvedMode: decision.tier, autoDecision: decision, profile, modelMeta, defaultModel, sessionId: runSid });
    }
    try { if (lockedTier) base.lockedMode = lockedTier; if (modeOverride) base.modeOverride = modeOverride; } catch { /* ignore */ }
    // 真·主动：若调用方是 Team Lead 且宿主提供 agentTeams，则由插件直接创建队员与共享任务板。
    if (ctxInfo && ctxInfo.agentTeams && ctxInfo.agent) {
      try {
        const created = await this.autoBoard(base.run.id, base.roster, ctxInfo);
        if (created && created.ok !== false) {
          const realTasks = (created.tasks || []).filter((x) => x && x.taskId);
          if (!realTasks.length) {
            // 预算硬熔断（预算已用尽）会返回 ok:true 但 tasks 为空：不能谎报 orchestrated:true，
            // 否则 record 永远要求 teamTaskId 而板上一条任务都没有 → 死锁。
            base.orchestrated = false;
            base.degraded = 'no-orchestration';
            base.orchestrationError = created.reason || null;
            base.created = created;
            base.next = '未建任务板：' + (created.reason || '预算已用尽，未新建任务') + '。已回退为纯计划，请按 playbook.steps 直接执行（无需 subagent），并在回执中记录降级原因。';
            try { console.warn('[token2biq] ' + base.next); } catch { /* ignore */ }
          } else {
            base.orchestrated = true;
            base.created = created;
            // 部分建档失败要在 startWithAuto 上直接可见（否则 Lead 只看到 orchestrated:true）。
            if (created.degraded) {
              base.degraded = created.degraded;
              base.orchestrationError = created.orchestrationError || null;
            }
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
          }
        } else if (created && created.reason) {
          // 「未知」不等于「没有常驻队员」：把真实原因说出来，别再伪装成正常态。
          base.orchestrated = false;
          base.degraded = 'no-orchestration';
          base.orchestrationError = created.reason;
          // 建档明细仍要回传：哪几个阶段失败、错在哪，是 Lead 决定重试/降级的唯一依据。
          base.created = created;
          base.next = '未建任务板：' + created.reason + '。已回退为纯计划，请按 playbook.steps 直接执行（无需 subagent），并在回执中记录降级原因。';
          try { console.warn('[token2biq] ' + base.next); } catch { /* ignore */ }
        }
      } catch (e) {
        base.orchestrated = false;
        base.degraded = 'no-orchestration';
        base.orchestrationError = String((e && e.message) || e);
      }
    }
    // 降级必须显式可见（UPGRADE §D6）：调用方不该靠正则匹配 next 中文文案才知道有没有建团。
    if (base.orchestrated === true && !base.degraded) base.degraded = null;
    else if (!base.degraded) base.degraded = (ctxInfo && ctxInfo.agentTeams) ? 'no-orchestration' : 'no-team';
    // 强制联动 × 团队不可用 = 死锁：record 永远要求 teamTaskId，但一条共享任务都建不出来，
    // 运行永远无法完成。团队没建成时自动降级为「仅提示」，并把原因显式带回调用方。
    if ((base.orchestrated !== true || base.degraded) && base.forceTeam === true) {
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
    // P1：start 返回体瘦身——仅在完整建团（orchestrated=true、全部任务有 taskId 且无降级）时执行；
    // 无团队/降级/部分失败/预算熔断的回退路径必须保留完整 playbook.steps（含 subject/doneWhen/writeScopes），供 Lead 直接按 steps 执行。
    const realTasks = (base.created && Array.isArray(base.created.tasks) ? base.created.tasks : []).filter((t) => t && t.taskId);
    const teamBuilt = base.orchestrated === true && realTasks.length > 0 && !base.degraded;
    if (teamBuilt) {
      try {
        if (base.playbook && Array.isArray(base.playbook.steps)) {
          base.playbook = { ...base.playbook, steps: base.playbook.steps.map((s) => ({ kind: s.kind, role: s.role, parallel: s.parallel, effort: s.effort, model: s.model })) };
        }
        if (Array.isArray(base.roster)) {
          base.roster = base.roster.map((r) => ({ stage: r.stage, role: r.role, name: r.name, model: r.model, effort: r.effort }));
        }
      } catch { /* 瘦身失败不影响主流程 */ }
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
    // 闸门统一读 _budgetGate：真实用量（real）优先，回退回执台账（ledger）。
    const budgetGate = this._budgetGate(run);
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
    const taskIdByStage = {};     // stage -> 该阶段最后一个任务 id（模型路由 / 简报用）
    const taskIdsByStage = {};    // stage -> 该阶段全部任务 id（真正的依赖边）
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
      // blockedBy：依赖「上一个不同阶段」的全部任务（S4 并行多审是整组），同阶段互不阻塞。
      // 被模型路由的阶段同样上板、由 Lead 用 subagent 执行，不能跳过——否则下游永远 ready。
      let blockedBy;
      for (let j = i - 1; j >= 0; j -= 1) {
        const pj = roster[j];
        if (pj.stage === r.stage) continue; // 同阶段（并行多审）互不阻塞
        const ids = taskIdsByStage[pj.stage];
        if (ids && ids.length) { blockedBy = ids.slice(); break; }
      }
      try {
        const view = await withRetry(() => agentTeams.createTask(agent, {
          subject: ('[' + run.mode + '] ' + this._fillGoal(r.subject, run.goal)).slice(0, 200),
          description: this._stageDescription(run, r, null).slice(0, 500),
          ...(blockedBy ? { blockedBy } : {}),
          ...(r.writeScopes && r.writeScopes.length ? { writeScopes: r.writeScopes } : {}),
        }));
        // 没有 id 等于没建档：不能算成功，否则板上是「假任务」，没人会去做。
        if (!view || !view.id) throw new Error('createTask 未返回任务 id（共享任务板未建立）');
        taskIdByStage[r.stage] = view.id;
        (taskIdsByStage[r.stage] = taskIdsByStage[r.stage] || []).push(view.id);
        tasks.push({ stage: r.stage, subject: this._fillGoal(r.subject, run.goal), taskId: view.id, revision: view.revision, owner: r.name });
      } catch (e) {
        tasks.push({ stage: r.stage, subject: this._fillGoal(r.subject, run.goal), error: String((e && e.message) || e) });
      }
    }
    // 建档后尽量用 getTask 回填「真实 revision」（createTask 返回值可能不带 revision 或是旧值）。
    // 宿主没有 getTask 时，简报里的 taskRevision 不可靠——在 notes 里显式提示先 team_task_get 校验，绝不静默错绑。
    let revisionHint = '';
    if (typeof agentTeams.getTask === 'function') {
      for (const t of tasks) {
        if (!t.taskId) continue;
        try {
          // rc.5 官方契约 getTask(caller,id)：caller 必须与上面 createTask 同源（同一个 agent 引用），
          // 少传 caller 时 rootOf(字符串) 必抛 SubagentError，revision 回填永远失效（FIX-1/ID-1）。
          const view2 = await agentTeams.getTask(agent, t.taskId);
          if (view2 && view2.revision != null) t.revision = view2.revision;
        } catch (e) { try { console.warn('[token2biq] taskRevision 回填失败（保留 createTask revision）：' + String((e && e.message) || e)); } catch { /* ignore */ } }
      }
    } else if (tasks.some((t) => t.taskId)) {
      revisionHint = '宿主无 agentTeams.getTask：简报 taskRevision 可能不是最新，执行前先用 team_task_get 校验 revision';
    }
    // 模型路由：覆盖整份 roster（不受 maxAgents 窗口限制，修复评审 issue #1——超窗口的模型阶段不再被静默丢弃）。
    // 按 roster 下标取各自 taskId，保证 S4 并行多审同一 stage 的多条子步骤各绑各的任务（不塌缩到最后一个）。
    // 额外给出拆好的 provider/modelName：next 要求 Lead「显式传 provider/model」，
    // 只给合并引用（provider::model）会让它自己猜怎么切——猜错就静默走默认模型，指定的模型等于没生效。
    // model 保持合并引用不变（既有契约，report.js 与 test/tier-policy.test.js 都依赖它）。
    // 建档失败必须降级：全部失败 → 回退纯计划（否则 lead 以为团队就位，而 record 因缺
    // teamTaskId 被门禁拒，直接死锁）；部分失败 → 显式 partial，别让漏掉的阶段静默消失。
    const failed = tasks.filter((t) => t.error);
    const allFailed = tasks.length > 0 && failed.length === tasks.length;
    const partial = !allFailed && failed.length > 0;
    if (failed.length) {
      run.degraded = allFailed ? 'no-orchestration' : 'partial-orchestration';
      run.orchestrationError = '共享任务板建立失败 ' + failed.length + '/' + tasks.length + '：'
        + failed.map((t) => t.stage + '（' + t.error + '）').join('；');
      run.teamTasks = tasks;
      try { this.store.flush(); } catch { /* ignore */ }
    }
    const modelRouting = roster.map((r, idx) => ({ r, idx })).filter((x) => !!x.r.model).map((x) => {
      const parsed = parseModelRef(x.r.model);
      return {
        stage: x.r.stage,
        model: x.r.model,
        provider: parsed ? parsed.provider : null,
        modelName: parsed ? parsed.model : x.r.model,
        taskId: (tasks[x.idx] && tasks[x.idx].taskId) || taskIdByStage[x.r.stage] || null,
        role: x.r.role,
        effort: x.r.effort || null,
      };
    });
    // 派活简报：只对「非模型阶段」生成，最多 maxAgents 条；每条是一份可直接喂给 subagent 工具的委派参数。
    // 模型阶段改由 Lead 用 subagent(provider/model) 执行，不占常驻名额。
    const briefing = roster.map((r, idx) => ({ r, idx })).filter((x) => !routedStages.has(x.r.stage)).slice(0, maxAgents).map((x) => {
      const r = x.r;
      const tk = tasks[x.idx] || {};
      const tkId = tk.taskId || taskIdByStage[r.stage] || null;
      const tkRev = tk.revision != null ? tk.revision : null;
      return {
        stage: r.stage,
        role: r.role,
        name: r.name,
        taskId: tkId,
        taskRevision: tkRev,
        delegation: {
          description: (run.mode + '·' + r.role + '·' + this._fillGoal(r.subject, run.goal)).slice(0, 120),
          name: r.name,
          ...(r.model ? { model: r.model } : {}),
          ...(r.effort ? { reasoning_effort: r.effort } : {}),
          prompt: this._spawnPrompt(run, r, tkId, tkRev),
        },
      };
    });
    run.orchestrated = !allFailed;
    run.capabilities = capabilityProbe;
    run.budgetGate = budgetGate;
    run.teamTasks = tasks;
    run.roster = roster.map((r) => ({ stage: r.stage, role: r.role, name: r.name }));
    run.modelRouting = modelRouting; // 持久化，供 action=state / runView 查看
    run.briefing = briefing;         // 派活简报：面板与 action=state 都能直接看到
    try { this.store.flush(); } catch { /* ignore */ }
    const nonModelCount = roster.length - routedStages.size;
    const notes = [];
    if (revisionHint) notes.push(revisionHint);
    if (nonModelCount > maxAgents) notes.push('非模型阶段 ' + nonModelCount + ' > maxAgents ' + maxAgents + '，仅前 ' + maxAgents + ' 个进了派活简报，其余任务留在板上由 Lead/成员接续');
    // 模型路由的说明由 startWithAuto 统一追加（带 stage=model 明细），这里不重复。
    const cappedNote = notes.join('；');
    const capabilities = capabilityProbe;
    if (budgetGate && budgetGate.level === 'soft') notes.push('预算已用 ' + budgetGate.percent + '%：进入收敛，不再新增阶段，优先完成在办任务');
    const cappedNote2 = notes.join('；');
    if (allFailed) {
      return {
        ok: false,
        reason: run.orchestrationError,
        maxAgents, tasks, briefing, modelRouting, cappedNote: cappedNote2,
        degraded: 'no-orchestration', capabilities, budgetGate,
      };
    }
    return {
      ok: true, maxAgents, tasks, briefing, modelRouting, cappedNote: cappedNote2,
      degraded: partial ? 'partial-orchestration' : false,
      orchestrationError: run.orchestrationError || null,
      capabilities, budgetGate,
    };
  }

  // 兼容 0.4.x 内部调用点：名字保留，语义已改为「只建板 + 出简报」。
  autoSpawn(runId, roster, info) {
    return this.autoBoard(runId, roster, info);
  }

  _stageDescription(run, r, revision) {
    const goal = String(run.goal || '').replace(/\s+/g, ' ').trim();
    const goalShort = goal.length > 80 ? (goal.slice(0, 80) + '…') : goal;
    const scopes = (r.writeScopes && r.writeScopes.length) ? r.writeScopes.join('、') : '未声明（默认串行 / 只读）';
    const lines = [
      '任务：' + run.id + ' · 阶段 ' + r.stage + '（' + r.role + '）' + (revision != null ? (' · revision=' + revision) : ' · revision 见任务板'),
      '目标：' + goalShort,
      '写域：' + scopes,
      '判据：' + (r.doneWhen || ''),
      '流程：claim → 执行 → team_task_update complete。',
      '回执：{stage, files, diffSummary, verdict(PASS|FAIL), issues}；不要 send_message；blocked/failed 停止并写 notes 等 lead。',
    ];
    return lines.join('\n').slice(0, 500);
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
    // 回执存在 task.receipt 里（RunStore.addTask 的入参是 {stage, receipt}），
    // 旧的 t.stage / t.files / t.diffSummary / t.verdict 读的是「回执对象」的形状，
    // 在真实任务上恒为 undefined —— 于是交接永远是「上游尚未产出」，下游每次从零推理。
    // 现在两者都认（兼容历史快照），并按阶段聚合到「每个执行 slot 的最新一条」。
    const asView = (t) => {
      const rc = (t && t.receipt) || {};
      return {
        stage: t.stage || t.kind || '',
        files: Array.isArray(rc.files) ? rc.files : (Array.isArray(t.files) ? t.files : []),
        diffSummary: rc.diffSummary || rc.summary || t.diffSummary || '',
        verdict: rc.verdict || t.verdict || null,
        issues: Array.isArray(rc.issues) ? rc.issues : (Array.isArray(t.issues) ? t.issues : []),
      };
    };
    const items = before.map((kind) => {
      const attempts = latestPerSlot(((run && run.tasks) || []).filter((t) => t && (t.stage || t.kind) === kind));
      // 回执可能落在 t.receipt 里（真实任务）或平铺在任务上（历史快照），两处都要认。
      const arrived = attempts.filter((t) => t.status === 'done' || t.verdict || (t.receipt && t.receipt.verdict));
      if (!arrived.length) return null;
      const views = arrived.map(asView);
      return {
        stage: kind,
        files: [...new Set(views.flatMap((x) => x.files))].slice(0, 5),
        diffSummary: views.map((x) => x.diffSummary).filter(Boolean).join('；'),
        // 任一并行评审 FAIL 即整体 FAIL，不能被另一条的 PASS 覆盖。
        verdict: views.some((x) => x.verdict === 'FAIL') ? 'FAIL' : (views[0].verdict || null),
        issues: views.flatMap((x) => x.issues).slice(0, 5),
      };
    }).filter(Boolean);
    const openIssues = items.flatMap((i) => i.issues.map((x) => (typeof x === 'string' ? x : (x && (x.message || x.msg)) || JSON.stringify(x))));
    const text = items.length
      ? ('上游已完成：' + items.map((i) => i.stage + (i.verdict ? ('(' + i.verdict + ')') : '') + (i.files.length ? (' 改 ' + i.files.slice(0, 5).join(',')) : '')).join('；')
        + (openIssues.length ? ('\n未关闭问题：' + openIssues.slice(0, 5).join('；')) : ''))
      : '上游尚未产出（你是首个阶段或上游未回执），按判据自行推进。';
    return { items, openIssues: openIssues.slice(0, 5), text: text.slice(0, 400) };
  }

  _spawnPrompt(run, r, taskId, revision) {
    // 稳定前缀：所有 worker 逐字节一致，便于宿主 prompt 缓存命中；'---' 之后才是动态行。
    // 硬约束（writeScopes/doneWhen/回执 JSON/阻塞停止）放在动态行最前，保证即使 400 字符截断也四要素齐全。
    const staticPrefix = '你是 Token 2b IQ 阶段队员：按判据完成工作，只改 writeScopes 内文件。';
    const goal = String(run.goal || '').replace(/\s+/g, ' ').trim();
    const goalShort = goal.length > 30 ? (goal.slice(0, 30) + '…') : goal;
    const doneWhen = String(r.doneWhen || '').slice(0, 40);
    const scopes = (r.writeScopes && r.writeScopes.length) ? r.writeScopes.join('、').slice(0, 40) : '未声明（串行/只读）';
    const handoff = this._handoff(run, r.stage).text;
    const handoffShort = handoff.length > 110 ? (handoff.slice(0, 110) + '…') : handoff;
    // 硬约束逐条短行前置，保证 400 字符截断时 writeScopes/doneWhen/回执 JSON/阻塞停止 全在预算内。
    const lines = [
      '任务 ' + String(taskId || '(见任务板)').slice(0, 24) + (revision != null ? (' · revision=' + revision) : '') + '；先 claim。',
      '流程 claim → 执行 → team_task_update complete；不要 send_message。',
      '角色 ' + r.role + '｜目标 ' + goalShort + '｜判据 ' + doneWhen,
      '写域 ' + scopes,
      '回执 {stage,files,diffSummary,verdict,issues}；blocked/failed 停止并写 notes 等 lead。',
      ...(r.independent ? ['独立盲审：只依据产物与验收标准，输出 {verdict,issues,evidence}。'] : []),
      '交接：' + handoffShort,
    ];
    return (staticPrefix + '\n---\n' + lines.join('\n')).slice(0, 400);
  }

  // 异步动作分发：start 需要 await（Auto 判定 + 可选主动建团），其余复用同步 handleTool。
  // 统一 async：调用方永远拿到 Promise；start 全量透传（candidates/acceptance/spec 等都要进 startWithAuto）。
  async handleToolAsync(args = {}, ctxInfo = null) {
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

    // 候选 id 硬校验：多候选模式下必须落在 1..N 且同一运行内唯一（judge 择优要指向真实候选）。
    const candidateCount = Math.max(1, Number(run.candidates) || 1);
    if (args.candidateId != null && String(args.candidateId).trim() !== '') {
      const rawCid = String(args.candidateId).trim();
      const cid = Number(rawCid);
      if (!Number.isInteger(cid) || cid < 1 || cid > candidateCount) {
        return {
          ok: false,
          error: `candidateId 非法：${rawCid}（必须是 1..${candidateCount} 的整数）`,
          hint: '多候选模式下每个候选单独 record 并带 candidateId；候选数由 action=start 的 candidates 指定。',
        };
      }
      // 唯一性冲突检查放在幂等判定之后：完全相同的多候选 generate 重放应返回 idempotent，
      // 而不是「candidateId 已记录过」——重放不是新候选。
      args = { ...args, candidateId: cid };
    }
    if (kind === 'judge' && candidateCount > 1 && args.selectedCandidate != null && String(args.selectedCandidate).trim() !== '') {
      const sel = String(args.selectedCandidate).trim();
      const known = (run.tasks || [])
        // 调查类任务没有 generate，多候选由 synth 产出（同一份报告的多个版本），这里必须一并收集。
        .filter((t) => (t.kind === 'generate' || t.kind === 'synth') && t.receipt && t.receipt.candidateId != null)
        .map((t) => Number(t.receipt.candidateId));
      const picked = Number(sel);
      if (!Number.isInteger(picked) || !known.includes(picked)) {
        return {
          ok: false,
          error: `selectedCandidate 非法：${sel} 不在已记录的候选里（已记录：${known.length ? known.join('、') : '无'}）`,
          hint: 'judge 只能从已经 record 过 generate 的候选里择优。',
        };
      }
    }

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

    // S4 并行多审：每个评审 slot 一条回执，必须带身份（teamTaskId 优先、owner 兜底）。
    // 缺身份时多条评审会退化进同一个空 slot，互相覆盖成「任一 PASS 即通过」——评审等于没做。
    // 只要求「至少一个身份」：S4 并行评审允许 owner-only（独立评委 target 即 slot）；
    // 强制联动（forceTeam）时两者都必须有，由前面的门禁负责。
    if (run.mode === 'S4' && REVIEW_KINDS.includes(kind) && (!args.teamTaskId && !args.owner)) {
      return {
        ok: false,
        error: `S4 并行多审：${kind} 的 record 必须至少提供 teamTaskId 或 owner（也可两者都提供）`,
        hint: '先为每个评审候选建共享任务（team_task_create）并指派独立评委（subagent），再回执。',
      };
    }

    // 严格流水线硬门禁（pipelineGate=strict / auto）：把"流程纪律"从建议变成强制。
    const effGate = effectivePipelineGate(st, run);
    if (effGate === 'strict') {
      if (kind === 'generate' && !run.spec) {
        return { ok: false, error: '严格流水线：进入实现(generate)前必须先完成 spec/plan 并给出验收标准', hint: '可在 action=start 时传 acceptance（验收标准），或先 record 一个 plan 阶段并带 summary/acceptance，再 record generate。' };
      }
      if ((kind === 'generate' || kind === 'synth') && (run.candidates || 1) > 1 && !args.candidateId) {
        return { ok: false, error: `多候选模式：${kind} 的 record 必须带 candidateId（1..${run.candidates}）`, hint: '每个候选单独 record 并带 candidateId，供 judge 打分择优。' };
      }
      if (kind === 'judge' && (run.candidates || 1) > 1 && !args.selectedCandidate) {
        return { ok: false, error: '多候选模式：judge 的 record 必须带 selectedCandidate（选中的候选）', hint: 'judge 依得分选出最佳候选，record 带 selectedCandidate 与 rationale。' };
      }
      const hasTests = Array.isArray(args.testsRun) ? args.testsRun.length > 0 : !!String(args.testsRun || '').trim();
      if ((kind === 'verify' || kind === 'regression') && !hasTests) {
        return { ok: false, error: '严格流水线：验证(verify/regression)必须带非空的 testsRun 证据（实际执行的测试命令）', hint: '先真的跑测试，record 带 testsRun；不通过不许交付。' };
      }
      // 提前拦住「只报命令名、没有结果」的回执：否则用户会一路走到 finish 才被拒，
      // 而 finish 的报错只说「缺验证证据」，根本看不出是 testsRun 的形状不对。
      // 只对「声称通过」的回执要求通过证据；FAIL 回执本身就是在报告失败（ok:false），必须允许记下来。
      if ((kind === 'verify' || kind === 'regression') && hasTests && String(args.verdict || '').toUpperCase() === 'PASS') {
        const proven = testsProven({ testsRun: args.testsRun, testsPassed: args.testsPassed });
        if (!proven) {
          return {
            ok: false,
            error: '严格流水线：testsRun 必须是「已通过的证据」——每项 { cmd, ok: true }，或用 testsPassed:true 显式声明全部通过',
            hint: '两种写法任选：① testsRun: [{ cmd: "node --test", ok: true }]；② testsRun: ["node --test"] 且附 testsPassed: true。只写字符串命令会被归一成 ok:null，不算通过。',
          };
        }
      }
    }

    // 设置落地（部分，硬校验）：模型白名单 / 独立评委——仅当调用方上报 model 时才能判定白名单。
    if (args.model) {
      const allow = Array.isArray(st.allowModels) ? st.allowModels : [];
      if (allow.length && !allow.includes(args.model)) {
        return { ok: false, error: `模型 ${args.model} 不在允许白名单内`, hint: `允许的模型：${allow.join('、')}（设置→模型白名单）。` };
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

    // 幂等：同一 slot 的「完全相同回执」重复上报不应重复记账（网络重试 / Lead 重放）。
    // slot 口径与 stage-state.attemptSlot 一致：teamTaskId 优先、其次 owner、无身份回落 __seq__+kind。
    // 判据是 slot + 回执内容，而不是任务 id 或时间——「同一任务失败后修复的新尝试」内容不同必然放行。
    {
      const ident = (t) => {
        const tid = String(t.teamTaskId || '').trim();
        const own = String(t.owner || '').trim();
        if (tid) return 'task:' + tid + '\u0000' + own + '\u0000' + String(t.model || '');
        if (own) return 'owner:' + own + '\u0000' + String(t.model || '');
        // 无身份回执：record 会合成 __seq__+kind 序列槽，去重必须用同一口径，否则重放永远不被识别。
        return '__seq__' + kind;
      };
      const target = ident({ teamTaskId: args.teamTaskId, owner: args.owner, model: args.model });
      // 完全相同的回执 = 重放，按「同 slot 最新 + 历史」两段判定：
      //  1) 与最新一条完全相同 → 始终幂等（重放最新回执不重复记账）。
      //  2) generate/research/plan 的同 slot 历史完全相同 → 幂等（T1→T2→重放 T1 不得新增）。
      //  3) verify/regression 的相同回执若早于最新 generate → 作为「针对新产物的新验证」记录，
      //     否则旧 PASS 顶账，新产物永远交付不了。
      //  4) 评审/验证类历史 FAIL 在后续 PASS 之后重放 → 幂等，不得反转阶段；
      //     历史 PASS 在最新 FAIL 之后重放 → 作为纠偏重试生效（PASS→FAIL→PASS 可恢复）。
      //  5) 其它历史重复 → 幂等。若确实需要「同内容再 FAIL」，调用方改 summary/evidence 形成新回执（安全优先）。
      const list = run.tasks || [];
      let lastGenIdx = -1;
      let latest = null;
      let exact = null;
      let exactIdx = -1;
      for (let i = 0; i < list.length; i += 1) {
        const t = list[i];
        if (!t) continue;
        if (t.kind === 'generate') lastGenIdx = i;
        if (t.kind !== kind || ident(t) !== target) continue;
        if (!latest || (Number(t.createdAt) || 0) >= (Number(latest.createdAt) || 0)) latest = t;
        // 取「最后一个相同回执」：新 generate 后第一次相同 verify 仍算新验证（早于产物），
        // 紧接着重放最新那条相同回执则幂等（与最新一条完全相同）。
        if (JSON.stringify(t.receipt || {}) === JSON.stringify(v.value)) { exact = t; exactIdx = i; }
      }
      const failedAttempt = (t) => !!t && (t.status === 'failed' || !!(t.receipt && t.receipt.verdict === 'FAIL'));
      // 验证类：相同回执早于最新产物 = 针对新产物的重跑，必须新记一条。
      const staleVerify = (kind === 'verify' || kind === 'regression') && !!exact && exactIdx < lastGenIdx;
      // 评审/验证类纠偏：历史 PASS 在最新 FAIL 之后重放，作为新尝试生效。
      const correctiveRetry = REVIEW_KINDS.includes(kind) && !!exact && exact !== latest
        && !failedAttempt(exact) && failedAttempt(latest);
      if (exact && !staleVerify && (exact === latest || !correctiveRetry)) {
        return {
          ok: true,
          idempotent: true,
          task: this.taskView(exact),
          review: null,
          paused: !!run.paused,
          estimatedTokens: false,
          escalate: null,
          warnings: ['同一 slot（' + (args.teamTaskId || args.owner || ('__seq__' + kind)) + '）的相同回执已记录过，未重复记账'],
        };
      }
    }

    // 候选唯一性（范围已在前置校验）：同一运行内 candidateId 不得重复占用。
    if ((kind === 'generate' || kind === 'synth') && args.candidateId != null) {
      const cid = Number(args.candidateId);
      const dup = (run.tasks || []).some((t) => t.kind === 'generate' && t.receipt && Number(t.receipt.candidateId) === cid);
      if (dup) {
        return { ok: false, error: `candidateId ${cid} 已记录过（同一运行内候选 id 必须唯一）`, hint: '换一个未使用的编号，或先 action=finish 收口这次运行。' };
      }
    }

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
    // 无身份回执（S1/S2/S3 常无团队任务）：合成 run+stage 级序列槽，
    // 让同一阶段的多次尝试落在同一 slot（重试按「最新一条」自愈），不被 task.id 拆成互不相关的槽。
    if (task && !args.teamTaskId && !args.owner) {
      task.slot = '__seq__' + kind;
      try { this.store.flush(); } catch { /* 落盘失败由下面 lastFlushError 告警 */ }
    }
    if (this.store.lastFlushError) warnings.push(`回执已记录但未持久化（写盘失败：${this.store.lastFlushError}），重启后可能丢失`);
    // 阶段状态：本步完成置 done / 失败置 failed；S4 并行多审按「任一 slot 最新回执失败即失败」聚合，
    // 同一 slot 重试通过则自愈——只认每个 slot 的最新一条，不认数组末位。
    if (task) {
      const latest = this.store.getRun(runId);
      const sameKind = ((latest && latest.tasks) || []).filter((t) => t.kind === kind);
      const agg = aggregateStageStatus(sameKind) || (status === 'failed' ? 'failed' : 'done');
      this.store.setStageStatus(runId, kind, agg);
    }

    let review = null;
    if (kind === 'review') {
      review = this.store.addReview(runId, {
        targetTaskId: args.targetTaskId, reviewerRole: args.role || 'reviewer',
        verdict: v.value.verdict, issues: v.value.issues, evidence: v.value.evidence,
      });
    }

    run = this.store.getRun(runId);
    // 并发删除：addTask/addReview 期间运行可能已被 remove，回读为 null —— 不能在这里崩。
    if (!run || !task) {
      return { ok: false, error: `运行 ${runId} 已被删除，回执未生效`, hint: '请重新 action=start 后再记录。' };
    }
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

    const tv = this.taskView(task);
    return {
      ok: true,
      task: {
        id: tv.id, kind: tv.kind, role: tv.role, status: tv.status, stage: tv.stage,
        verdict: tv.verdict, tokens: tv.tokens, teamTaskId: tv.teamTaskId, owner: tv.owner, model: tv.model,
      },
      review: review ? this.reviewView(review) : null,
      warnings,
      estimatedTokens: estimated,
      escalate,
      paused,
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
    // 只接受 PASS/FAIL（与 record 一致）：旧实现只判非空，'PASSS' 会走到「非 PASS 分支」绕过 strict 门禁，
    // 再被 store 归一化成 FAIL —— 用户以为交付成功，实际记为失败。
    const vcode = String(verdict).trim().toUpperCase();
    if (vcode !== 'PASS' && vcode !== 'FAIL') {
      return { ok: false, error: 'verdict 非法：' + verdict + '（只接受 PASS 或 FAIL）', hint: '传 PASS 表示交付，FAIL 表示放弃/失败。' };
    }
    // 运行结束时清掉会话映射，避免后续 usage 继续往已结束的运行上写。
    for (const [sid, rid] of this.runSessions) { if (rid === runId) this.runSessions.delete(sid); }
    // 幂等：已结束的运行不允许重复 finish 覆盖裁决（P2-8）。
    if (run.status === 'done') {
      return { ok: false, error: '该运行已结束，不能重复 finish', hint: '如需重跑请新建运行。', verdict: run.verdict };
    }
    // 暂停中的运行不允许直接收尾：否则会留下 status=done + paused=true 的矛盾态，且 setPaused 之后拒绝修复。
    if (run.paused) {
      return { ok: false, error: '运行处于暂停状态，不能 finish', hint: '先 action=resume 恢复，再 finish（或直接 delete 放弃这次运行）。' };
    }
    // 严格流水线硬门禁（只约束交付 PASS）：
    //   · 验证必须在最新一次 generate 之后，且每个验证 slot 的最新回执 PASS + testsRun 全绿；
    //   · 每个 judge slot 的最新回执必须 PASS 且已择优；FAIL 收口不设门禁。
    const stf = this.settings.get();
    if (vcode === 'PASS' && effectivePipelineGate(stf, run) === 'strict') {
      const tasks = run.tasks || [];
      // 最新一次产物（generate）的下标；没有 generate 就全量看。
      let genIdx = -1;
      tasks.forEach((t, i) => { if (t.kind === 'generate') genIdx = i; });
      // 每个验证 slot 只认最新一条：some(历史 PASS) 会让「PASS 之后又 FAIL」照样交付。
      const verifyAttempts = latestPerSlot(
        tasks.map((t, i) => ({ t, i }))
          .filter(({ t, i }) => (t.kind === 'verify' || t.kind === 'regression') && i > genIdx)
          .map(({ t }) => t),
      );
      // 验证证据必须“真的通过”：testsPassed===true，或 testsRun 非空且每项 ok===true；
      // 全 ok:null（只报命令名没报结果）与任一 ok:false 都不算通过（旧实现只看非空，可被空结果蒙混）。
      const verified = verifyAttempts.length > 0 && verifyAttempts.every((t) => t.status === 'done' && t.receipt
        && t.receipt.verdict === 'PASS' && testsProven(t.receipt));
      if (!verified) {
        return {
          ok: false,
          error: '严格流水线：finish(PASS) 前必须有完成的验证(verify/regression)，位于最新产物之后，且 verdict=PASS 并带全绿 testsRun 证据',
          hint: '先 record verify（带 testsRun 与 PASS）再 finish；若这次是要放弃/失败收口，请传 verdict=FAIL。',
        };
      }
      // 评审门禁：当前有效回执（每个 slot 最新一条）任一 FAIL → 不得交付；
      // 同一 slot 重新给出 PASS 即恢复（最新一条生效），旧 FAIL 重放不会被当成新结论。
      // 评审类包含 judge：单候选 judge 的 FAIL 也是「当前有效回执 FAIL」，必须阻断 finish(PASS)；
      // 同一 slot 后续给出 PASS 即恢复（最新一条生效），历史 FAIL 重放不会被当成新的结论。
      const reviewLatest = latestPerSlot(tasks.filter((t) => REVIEW_KINDS.includes(t.kind)));
      const badReview = reviewLatest.find((t) => t.status === 'failed' || (t.receipt && t.receipt.verdict === 'FAIL'));
      if (badReview) {
        return {
          ok: false,
          error: `严格流水线：评审阶段 ${badReview.kind} 的当前有效回执为 FAIL，不能交付`,
          hint: '按 issues 修复后让同一评审 slot 重新给出 PASS（同 slot 最新回执生效），或传 verdict=FAIL 放弃。',
        };
      }
      if ((run.candidates || 1) > 1) {
        const judgeLatest = latestPerSlot(tasks.filter((t) => t.kind === 'judge'));
        if (!judgeLatest.length) {
          return { ok: false, error: '多候选模式：finish 前 judge 必须带 selectedCandidate 选出最佳', hint: '先 record judge 带 selectedCandidate。' };
        }
        const bad = judgeLatest.find((t) => !(t.receipt && t.receipt.verdict === 'PASS' && t.receipt.selectedCandidate));
        if (bad) {
          return {
            ok: false,
            error: '多候选模式：judge 裁决未通过（最新回执必须是 PASS 且带 selectedCandidate）',
            hint: '让 judge 重新评审并给出 PASS + selectedCandidate；FAIL 的裁决不能替人放行。',
          };
        }
      }
    }
    const final = String(verdict || '').toUpperCase() === 'PASS' ? 'PASS' : 'FAIL';
    const vd = this.store.setVerdict(runId, { final, byJudge: byJudge || (['S3', 'S4'].includes(run.mode) ? 'judge' : 'verifier'), rationale: rationale || '' });
    // 收尾：未开始阶段记为 skipped，进行中阶段记为 done，避免完成后看板仍显示“进行中”
    const done = this.store.getRun(runId);
    // 并发收口：stale 实例的 setVerdict 被磁盘终态拒绝（返回 null），此时运行仍可回读——
    // 必须在任何阶段归一化 / currentRunId 重置之前返回，否则会顺手改掉对方已定的终态。
    if (!vd && done) {
      return {
        ok: false,
        error: '另一实例已收口，本次未生效',
        verdict: done.verdict && done.verdict.final ? done.verdict.final : null,
        run: this.store.summary(done),
        hint: '该运行已被其他实例 finish（终态不可覆盖）；如需重跑请新建运行。',
      };
    }
    // 并发删除：裁决已写入但回读为 null 时不能假成功（否则调用方以为交付完成）。
    if (!done) return { ok: false, error: `运行 ${runId} 已被删除（裁决已写入但已无法回读）`, hint: '请重新 action=start。' };
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
    // 并发删除：setPaused 之后运行可能已不存在，summary(null) 会抛。
    const after = this.store.getRun(runId);
    if (!after) return { ok: false, error: `运行 ${runId} 已被删除` };
    return { ok: true, run: this.store.summary(after) };
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
      // 自动配置宿主的结果：启动失败也要能在面板/state 里看到（不能只写日志）。
      provisionStatus: this.provisionStatus || null,
      // 快照损坏/自动恢复/淘汰也必须可见，别让历史在无声中消失。
      stateLoadError: this.store.lastLoadError || null,
      stateRecoveredFrom: this.store.lastRecovered || null,
      statePruned: this.store.lastPruned || null,
      runs,
      liveUsage: this.liveView(),
      current: run ? this.runView(run) : null,
    };
  }

  // P3 预算闸门：优先真实用量（real，宿主 usage 归集），回退回执台账（ledger）；0 = 不限。
  _budgetGate(run) {
    const budget = Number((this.settings.get() || {}).tokenBudget) || 0;
    if (!(budget > 0)) return null;
    const ledgerSpent = ((run && run.ledger && run.ledger.totalIn) || 0) + ((run && run.ledger && run.ledger.totalOut) || 0);
    const realSpent = Number((run && run.real && run.real.total) || 0) || 0;
    const spent = realSpent > 0 ? realSpent : ledgerSpent;
    return {
      spent,
      budget,
      ledgerSpent,
      realSpent,
      percent: Math.round((spent / budget) * 100),
      level: spent >= budget ? 'hard' : (spent / budget >= 0.8 ? 'soft' : 'ok'),
    };
  }

  runView(r) {
    const led = (r && r.ledger) || {};
    const spent = (led.totalIn || 0) + (led.totalOut || 0);
    // 预算闸门在面板/action=state 上直接可见；熔断点在 autoBoard（hard 不再新建任务）。
    const budgetGate = this._budgetGate(r);
    // 历史快照 / 刚 start 的运行可能没有 stages/tasks 数组——面板不能因此 500。
    const runTasks = Array.isArray(r.tasks) ? r.tasks : [];
    const stages = (Array.isArray(r.stages) ? r.stages : []).map((s) => ({
      kind: s.kind,
      label: STAGE_LABEL[s.kind] || s.kind,
      status: effStageStatus(s.kind, r),
      tasks: runTasks.filter((t) => t.kind === s.kind).map((t) => this.taskView(t)),
    }));
    const knownKinds = new Set(stages.map((s) => s.kind));
    const orphans = runTasks.filter((t) => !knownKinds.has(t.kind)).map((t) => this.taskView(t));
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
      // action=state 读 cur.tasks / cur.taskCount，必须暴露，否则面板永远 0 个任务。
      tasks: runTasks.map((t) => this.taskView(t)),
      // 状态跃迁审计流（最近 30 条）：出问题能直接看「谁在什么时候改了状态」。
      events: Array.isArray(r.events) ? r.events.slice(-30) : [],
      reviews: (Array.isArray(r.reviews) ? r.reviews : []).slice(-30).map((rv) => this.reviewView(rv)),
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
      // 多候选：回执里必须能查到「第几个候选」与 judge 选中的是哪个，否则择优无法审计。
      candidateId: rc.candidateId == null ? null : rc.candidateId,
      selectedCandidate: rc.selectedCandidate == null ? null : rc.selectedCandidate,
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
        // 同步入口拿不到 Auto 判定/建团结果（startWithAuto 是 async），直接给明确指引，
        // 不要返回半截 Promise 让调用方以为 ok。
        case 'start': return {
          ok: false,
          error: 'start 是异步动作：请走 handleToolAsync（HTTP /token2biq/action 或工具 execute 已统一异步）',
          hint: '同步 handleTool 只服务 record/finish 等同步动作；start 需要 await Auto 判定与任务板建团。',
        };
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
          return { ok: true, playbook: buildTeamPlaybook(plan, { ...settings, forceTeam: forceActive, rolePools: settings.rolePools, multiReview: plan.mode === 'S4', settings }) };
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
            '   可选 tokensIn/tokensOut（缺省按字符估算，仅参考）；可选 model（provider::model），用于白名单校验。',
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
