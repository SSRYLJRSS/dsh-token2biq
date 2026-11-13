// RunStore —— 运行状态与 8 实体持久化。纯内存 + 可选 JSON 快照原子写。
// 实体：Run / Stage / AgentTask / Review / Verdict / TokenLedger（Config/Mode 由 service 管理）。
import fs from 'node:fs';
import path from 'node:path';

let _seq = 0;
let _flushSeq = 0;
function uid(prefix) {
  _seq = (_seq + 1) % 1e6;
  return prefix + '_' + Date.now().toString(36) + '_' + _seq.toString(36);
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
function hashBrief(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export class RunStore {
  constructor(opts = {}) {
    this.file = opts.file || null; // JSON 快照路径；null 则纯内存
    this.state = { runs: {}, version: 1 };
    if (this.file) this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.runs) { this.state = data; this._migrate(); this.flush(); }
    } catch {
      /* 首次运行或文件损坏 → 空状态 */
    }
  }

  // 旧快照迁移（OPTIMIZATION F4）：补齐缺失字段、移除已废弃的预算字段、按任务派生阶段状态。
  // 幂等：重复执行结果一致；不会丢历史任务/回执。
  _migrate() {
    this.state.version = 2;
    if (this.state.mode == null) this.state.mode = null;
    const runs = this.state.runs || {};
    for (const r of Object.values(runs)) {
      if (!r.ledger) r.ledger = { runId: r.id, totalIn: 0, totalOut: 0, stages: {} };
      if (!Array.isArray(r.tasks)) r.tasks = [];
      if (!Array.isArray(r.reviews)) r.reviews = [];
      if (!Array.isArray(r.escalations)) r.escalations = [];
      if (!r.real || typeof r.real !== 'object') r.real = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, requests: 0 };
      if (r.generateModel === undefined) r.generateModel = null;
      if (r.plan && typeof r.plan === 'object') {
        if (r.plan.costWeight == null && r.plan.budgetX != null) r.plan.costWeight = r.plan.budgetX;
        delete r.plan.budget; delete r.plan.baseBudgetTokens; delete r.plan.budgetX;
      }
      for (const st of (r.stages || [])) {
        const ts = (r.tasks || []).filter((t) => t.kind === st.kind);
        if (ts.length) {
          st.status = ts.some((t) => t.status === 'failed') ? 'failed'
            : ts.every((t) => t.status === 'done') ? 'done' : 'running';
        } else if (r.status === 'done' && (st.status === 'pending' || st.status === 'running')) {
          st.status = 'skipped';
        }
      }
    }
  }

  getMode() { return this.state.mode || null; }
  setMode(mode) { this.state.mode = mode || null; this.flush(); return this.state.mode; }

  flush() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 临时文件名带 pid+序号：避免多进程/并发 flush 抢同一个 .tmp 导致文件损坏（F10 部分缓解）。
      const tmp = this.file + '.' + process.pid + '.' + (++_flushSeq) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try { console.warn('[token2biq] run-store flush 失败：' + ((e && e.message) || e)); } catch { /* ignore */ }
    }
  }

  createRun({ goal, plan, mode }) {
    const id = uid('run');
    const now = Date.now();
    const run = {
      id,
      mode: plan.mode,
      requestedMode: mode || plan.mode,
      goal: goal || '',
      status: 'running',
      createdAt: now,
      updatedAt: now,
      plan: { ...plan },
      stages: plan.stages.map((kind, i) => ({ id: uid('st'), runId: id, kind, index: i, status: 'pending', updatedAt: now })),
      tasks: [],
      reviews: [],
      verdict: null,
      ledger: { runId: id, totalIn: 0, totalOut: 0, stages: {} },
      // 真实用量：由宿主 llm/stream 的 usage 分片按「活动运行」归集（见 service.noteUsage）。
      // 与 ledger（回执上报/字符估算）区分开，避免把估算当成真实消耗。
      real: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, requests: 0 },
      generateModel: null,
      paused: false,
      pauseReason: '',
      escalations: [],
      failStreak: 0,
    };
    this.state.runs[id] = run;
    this.flush();
    return run;
  }

  getRun(id) {
    return this.state.runs[id] || null;
  }

  listRuns(limit) {
    const arr = Object.values(this.state.runs).sort((a, b) => b.createdAt - a.createdAt);
    const lim = Number(limit) > 0 ? Math.floor(limit) : arr.length;
    return arr.slice(0, lim).map((r) => this.summary(r));
  }

  summary(r) {
    const spent = (r.ledger.totalIn || 0) + (r.ledger.totalOut || 0);
    return {
      id: r.id,
      mode: r.mode,
      requestedMode: r.requestedMode,
      goal: r.goal,
      status: r.status,
      verdict: r.verdict ? r.verdict.final : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      spent,
      realSpent: r.real ? (r.real.total || 0) : 0,
      costWeight: (r.plan && r.plan.costWeight) || 0,
      paused: r.paused,
      autoDecision: r.autoDecision || null,
    };
  }

  setStageStatus(runId, kind, status) {
    const r = this.getRun(runId);
    if (!r) return null;
    const st = r.stages.find((s) => s.kind === kind);
    if (st) { st.status = status; st.updatedAt = Date.now(); }
    r.updatedAt = Date.now();
    this.flush();
    return st;
  }

  addTask(runId, { stage, role, brief, status, receipt, tokensIn, tokensOut, teamTaskId, owner, model }) {
    const r = this.getRun(runId);
    if (!r) return null;
    const st = r.stages.find((s) => s.kind === stage);
    const t = {
      id: uid('task'),
      runId,
      stageId: st ? st.id : null,
      kind: stage,
      role: role || 'worker',
      brief: brief || '',
      briefHash: hashBrief(brief || ''),
      status: status || 'done',
      receipt: receipt || null,
      // 与官方 Agent Teams 共享任务板绑定：teamTaskId=team_task_* 返回的 id；owner=spawn_teammate 返回的 target。
      teamTaskId: teamTaskId || null,
      owner: owner || null,
      model: model || null,
      tokensIn: num(tokensIn),
      tokensOut: num(tokensOut),
      createdAt: Date.now(),
    };
    r.tasks.push(t);
    if (stage === 'generate' && t.model) r.generateModel = t.model;
    this._addTokens(r, stage, t.tokensIn, t.tokensOut);
    if (st && st.status === 'pending') st.status = 'running';
    r.updatedAt = Date.now();
    this.flush();
    return t;
  }

  addReview(runId, { targetTaskId, reviewerRole, verdict, issues, evidence }) {
    const r = this.getRun(runId);
    if (!r) return null;
    const rv = {
      id: uid('rv'),
      runId,
      targetTaskId: targetTaskId || null,
      reviewerRole: reviewerRole || 'reviewer',
      verdict: verdict || 'FAIL',
      issues: issues || [],
      evidence: evidence || [],
      createdAt: Date.now(),
    };
    r.reviews.push(rv);
    r.failStreak = rv.verdict === 'FAIL' ? (r.failStreak || 0) + 1 : 0;
    r.updatedAt = Date.now();
    this.flush();
    return rv;
  }

  // 真实用量归集（宿主 usage 分片）。只改内存，flush 由调用方节流，避免每个分片都写盘。
  addRealUsage(runId, usage = {}) {
    const r = this.getRun(runId);
    if (!r) return null;
    if (!r.real) r.real = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, requests: 0 };
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    r.real.input += n(usage.inputTokens);
    r.real.output += n(usage.outputTokens);
    r.real.cacheRead += n(usage.cacheReadTokens);
    r.real.cacheWrite += n(usage.cacheWriteTokens);
    const tt = Number.isFinite(Number(usage.totalTokens)) && Number(usage.totalTokens) > 0
      ? Number(usage.totalTokens)
      : n(usage.inputTokens) + n(usage.outputTokens);
    r.real.total += tt;
    r.real.requests += 1;
    r.updatedAt = Date.now();
    return r.real;
  }

  recordTokens(runId, stage, tin, tout) {
    const r = this.getRun(runId);
    if (!r) return null;
    this._addTokens(r, stage, num(tin), num(tout));
    r.updatedAt = Date.now();
    this.flush();
    return r.ledger;
  }

  _addTokens(r, stage, tin, tout) {
    r.ledger.totalIn += tin;
    r.ledger.totalOut += tout;
    const k = stage || 'other';
    if (!r.ledger.stages[k]) r.ledger.stages[k] = { in: 0, out: 0 };
    r.ledger.stages[k].in += tin;
    r.ledger.stages[k].out += tout;
  }

  setVerdict(runId, { final, byJudge, rationale }) {
    const r = this.getRun(runId);
    if (!r) return null;
    r.verdict = {
      id: uid('vd'),
      runId,
      final: final || 'FAIL',
      byJudge: byJudge || 'judge',
      rationale: rationale || '',
      createdAt: Date.now(),
    };
    r.status = 'done';
    r.updatedAt = Date.now();
    this.flush();
    return r.verdict;
  }

  setStatus(runId, status) {
    const r = this.getRun(runId);
    if (!r) return null;
    r.status = status;
    r.updatedAt = Date.now();
    this.flush();
    return r;
  }

  setPaused(runId, paused, reason) {
    const r = this.getRun(runId);
    if (!r) return null;
    r.paused = !!paused;
    r.pauseReason = reason || '';
    if (paused) r.status = 'paused';
    else if (r.status === 'paused') r.status = 'running';
    r.updatedAt = Date.now();
    this.flush();
    return r;
  }

  addEscalation(runId, { from, to, reason }) {
    const r = this.getRun(runId);
    if (!r) return null;
    r.escalations.push({ from, to, reason: reason || '', at: Date.now() });
    r.failStreak = 0;
    r.updatedAt = Date.now();
    this.flush();
    return r;
  }

  // 真正的闸门升级：不只是记录，而是把 run 切到新档位的计划与阶段（保留既有任务历史）。
  applyEscalation(runId, { from, to, reason, plan }) {
    const r = this.getRun(runId);
    if (!r) return null;
    r.escalations.push({ from, to, reason: reason || '', at: Date.now() });
    r.failStreak = 0;
    r.mode = to;
    if (plan) {
      r.plan = { ...r.plan, ...plan, requestedMode: r.requestedMode };
      const have = new Set(r.stages.map((s) => s.kind));
      const wanted = new Set(plan.stages);
      plan.stages.forEach((kind) => {
        if (!have.has(kind)) r.stages.push({ id: uid('st'), runId, kind, index: r.stages.length, status: 'pending', updatedAt: Date.now() });
      });
      // 升级后不再存在于新计划里的旧阶段（如 S2 的 verify 升级到 S3）标为 skipped，避免看板卡在进行中。
      for (const st of r.stages) {
        if (!wanted.has(st.kind) && st.status === 'pending') st.status = 'skipped';
      }
    }
    r.updatedAt = Date.now();
    this.flush();
    return r;
  }

  remove(runId) {
    delete this.state.runs[runId];
    this.flush();
  }
}
