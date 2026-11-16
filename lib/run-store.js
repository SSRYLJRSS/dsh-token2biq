// RunStore —— 运行状态与 8 实体持久化。纯内存 + 可选 JSON 快照原子写。
// 实体：Run / Stage / AgentTask / Review / Verdict / TokenLedger（Config/Mode 由 service 管理）。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { aggregateStageStatus } from './stage-state.js';

let _flushSeq = 0;
function uid(prefix) { return prefix + '_' + randomUUID(); }
function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; }
function hashBrief(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); }
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; } // Unknown/EPERM is not evidence of death.
}
function tmpOwnerPid(name, base) {
  const rest = name.slice(base.length, -4);
  if (!/^\d+\.\d+$/.test(rest)) return null;
  const n = Number(rest.split('.')[0]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// JSON 可解析 != 结构合法。runs 必须是「id → run 对象」的映射；否则加载后
// 任何一次 flush 都会抛 Invalid run snapshot，历史运行与回执永久写不回去。
function isSnapshot(data) {
  if (!object(data)) return false;
  if (!object(data.runs)) return false;
  for (const run of Object.values(data.runs)) if (!object(run)) return false;
  if (data.tombstones != null && !object(data.tombstones)) return false;
  return true;
}

// failStreak 的唯一定义：合并后 reviews 末尾连续 FAIL 的条数。
// resetReviewId 是触发闸门升级的那条 FAIL —— 升级会清零连续计数，它之前的 FAIL 不再计入，
// 否则每次合并都会把「已升级」反转回升级前的计数。
function trailingFailStreak(reviews, resetReviewId) {
  if (!Array.isArray(reviews)) return 0;
  let n = 0;
  for (let i = reviews.length - 1; i >= 0; i--) {
    const rv = reviews[i];
    if (!object(rv)) break;
    if (resetReviewId && rv.id === resetReviewId) break;
    if (rv.verdict !== 'FAIL') break;
    n++;
  }
  return n;
}

// Three-way merge against the last successful snapshot. Only locally changed fields
// override disk fields. Independent append-only entities retain their identities;
// scalar conflicts use commit order, not wall-clock timestamps or file mtimes.
function mergeValue(base, mine, theirs) {
  if (equal(mine, base)) return clone(theirs);
  if (equal(theirs, base)) return clone(mine);
  if (object(mine) && object(theirs)) {
    const out = {};
    for (const key of new Set([...Object.keys(base || {}), ...Object.keys(mine), ...Object.keys(theirs)])) {
      const value = mergeValue(base && base[key], mine[key], theirs[key]);
      if (value !== undefined) Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  if (Array.isArray(mine) && Array.isArray(theirs) && [...mine, ...theirs].every(object)) {
    const key = (x) => x.id || JSON.stringify(x);
    const prior = new Map((Array.isArray(base) ? base : []).map(x => [key(x), x]));
    const local = new Map(mine.map(x => [key(x), x]));
    const remote = new Map(theirs.map(x => [key(x), x]));
    return [...new Set([...remote.keys(), ...local.keys()])].map(k => {
      if (!local.has(k)) return clone(remote.get(k));
      if (!remote.has(k)) return clone(local.get(k));
      return mergeValue(prior.get(k), local.get(k), remote.get(k));
    });
  }
  return clone(mine);
}

// ledger and real are additive counters, including direct recordTokens calls.
// The base advances only after rename succeeds, so failed commits can be retried.
function mergeCounters(base = {}, mine = {}, theirs = {}) {
  const out = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    const b = base[key], m = mine[key], t = theirs[key];
    if (typeof m === 'number' || typeof t === 'number') out[key] = (Number(t) || 0) + (Number(m) || 0) - (Number(b) || 0);
    else if (object(m) || object(t)) out[key] = mergeCounters(b || {}, m || {}, t || {});
    else out[key] = mergeValue(b, m, t);
  }
  return out;
}

// 容量上限：快照里最多保留多少个历史运行 / 每个运行多少条事件。
// 不设上限时 runs 会带着 tasks/receipts/reviews 无限膨胀，快照文件迟早拖垮启动。
const MAX_RUNS = 200;
const MAX_EVENTS = 500;

export class RunStore {
  constructor(opts = {}) {
    this.file = opts.file || null; // JSON 快照路径；null 则纯内存
    this.state = { runs: {}, version: 2 };
    this._base = clone(this.state);
    if (this.file) this.load();
  }

  load() {
    let raw;
    try {
      // 先清历史残留：上次进程被杀 / rename 失败会在快照旁留下 *.tmp。
      this._cleanStaleTmp();
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      // 首次运行（ENOENT）是正常的；其余错误必须先备份再重置，否则历史运行/回执会被静默清空。
      if (e && e.code !== 'ENOENT') this._recoverSnapshot(undefined, e);
      return;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      this._recoverSnapshot(raw, e);
      return;
    }
    // 结构非法（runs:null / 数组 / 运行不是对象）同样是损坏快照。旧实现静默跳过，
    // 留下「内存空、磁盘坏」的实例：之后每次 flush 都抛 Invalid run snapshot，历史再也写不回去。
    if (!isSnapshot(data)) {
      this._recoverSnapshot(raw, new Error('Invalid run snapshot structure: runs 必须是 id→run 的对象映射'));
      return;
    }
    try {
      this.state = data;
      this._migrate();
      this._base = clone(this.state);
    } catch (e) {
      this._recoverSnapshot(raw, e);
    }
  }

  // 损坏快照兜底：先备份原始字节（绝不静默清空），再尽力从最近一份 .corrupt-* 恢复。
  // 无论是否找到可用备份，都记住「已检查过的损坏字节」：下一次写入据此覆盖它，
  // 而不是永久失败在 Invalid run snapshot 上。
  _recoverSnapshot(raw, error) {
    this.lastLoadError = (error && error.message) || String(error);
    try { console.warn('[token2biq] 快照损坏，已备份为 .corrupt-*：' + this.file + ' — ' + this.lastLoadError); } catch { /* ignore */ }
    try { fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now()); } catch { /* ignore */ }
    this.state = { runs: {}, version: 2 };
    this._base = clone(this.state);
    this.lastRecovered = undefined;
    if (typeof raw === 'string') this._recoveryRaw = raw;
    // 从最近一份 .corrupt-* 恢复：否则空快照会被下一次 flush 写回，历史运行与回执全部不可逆地消失。
    try {
      const dir = path.dirname(this.file), prefix = path.basename(this.file) + '.corrupt-';
      const cands = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().reverse();
      for (const f of cands) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (isSnapshot(d) && Object.keys(d.runs).length) {
            this.state = d; this._migrate();
            this._base = clone(this.state);
            this._recoveryRaw = raw; // Replace only the exact corrupt bytes we inspected.
            this.lastRecovered = f; this.lastLoadError = null;
            try { console.warn('[token2biq] 已从备份恢复快照：' + f); } catch { /* ignore */ }
            break;
          }
        } catch { /* 换下一份 */ }
      }
    } catch { /* ignore */ }
  }

  // 旧快照迁移（OPTIMIZATION F4）：补齐缺失字段、移除已废弃的预算字段、按任务派生阶段状态。
  // 幂等：重复执行结果一致；不会丢历史任务/回执。
  _migrate(state = this.state) {
    state.version = 2;
    if (state.mode == null) state.mode = null;
    // 删除墓碑：只删内存的话，下一次 _mergeExternal 读到磁盘旧快照会把运行复活。
    if (!state.tombstones || typeof state.tombstones !== 'object') state.tombstones = {};
    const runs = state.runs || {};
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
        // 与 service/stage-state 共用同一套聚合：任一 slot 最新回执失败 → failed，
        // 同 slot 重试通过 → 自愈为 done。旧实现「任一条 failed + 全部 done」会自相矛盾。
        const agg = aggregateStageStatus((r.tasks || []).filter((t) => t.kind === st.kind));
        if (agg) st.status = agg;
        else if (r.status === 'done' && (st.status === 'pending' || st.status === 'running')) {
          st.status = 'skipped';
        }
      }
    }
  }

  getMode() { return this.state.mode || null; }
  setMode(mode) { this.state.mode = mode || null; this.flush(); return this.state.mode; }

  // Must run under the exclusive writer lock. No mtime shortcuts: multiple commits
  // may share a timestamp, and external writers can preserve file timestamps.
  _mergeExternal() {
    let disk, raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); disk = JSON.parse(raw); }
    catch (e) {
      if (e.code === 'ENOENT') disk = { runs: {}, version: 2 };
      else if (this._recoveryRaw !== undefined && raw === this._recoveryRaw) disk = clone(this._base);
      else throw e;
    }
    if (!isSnapshot(disk)) {
      // 只有「load 时已备份过的同一份损坏字节」才允许用本地已知良好状态覆盖；
      // 运行期新出现的未知损坏保持 fail-closed（重启加载会走备份/恢复）。
      if (this._recoveryRaw !== undefined && raw === this._recoveryRaw) disk = clone(this._base);
      else throw new Error('Invalid run snapshot: runs 必须是 id→run 的对象映射');
    }
    this._migrate(disk);
    const base = this._base || { runs: {} };
    const next = mergeValue(base, this.state, disk);
    next.tombstones = { ...(disk.tombstones || {}), ...(this.state.tombstones || {}) };
    next.runs = next.runs || {};
    for (const id of Object.keys(next.runs)) {
      if (Object.hasOwn(next.tombstones, id)) { delete next.runs[id]; continue; }
      const mine = this.state.runs[id], theirs = disk.runs[id];
      if (mine && theirs) {
        const prior = (base.runs || {})[id] || {};
        next.runs[id].ledger = mergeCounters(prior.ledger, mine.ledger, theirs.ledger);
        next.runs[id].real = mergeCounters(prior.real, mine.real, theirs.real);
      }
      const run = next.runs[id];
      run.events = (run.events || []).slice(-MAX_EVENTS);
      // 已提交的 final 不可逆：stale 实例的迟到 setPaused/setVerdict 既不能把 done
      // 改回 paused，也不能用后到的裁决覆盖先提交的 final。
      if (theirs && object(theirs.verdict) && theirs.verdict.final) {
        run.verdict = clone(theirs.verdict);
        run.status = 'done';
        run.paused = false;
        run.pauseReason = '';
        run.statusBeforePause = null;
      }
      // failStreak 是派生值：两个实例各记一次 FAIL，合并后 reviews 已是 2 条，
      // 不能各自把增量 1 撞成 1，必须按合并后的 reviews 重算末尾连续 FAIL。
      run.failStreak = trailingFailStreak(run.reviews, run.failStreakResetReviewId);
    }
    return next;
  }

  flush() {
    if (!this.file) return;
    let tmp = null, locked = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this._acquireLock();
      locked = true;
      const next = this._mergeExternal();
      const pruned = this._prune(MAX_RUNS, next);
      tmp = this.file + '.' + process.pid + '.' + (++_flushSeq) + '.tmp';
      // wx also protects two worker threads sharing a PID and module-local sequence.
      while (fs.existsSync(tmp)) tmp = this.file + '.' + process.pid + '.' + (++_flushSeq) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(tmp, this.file); // Failure leaves the last good snapshot intact.
      tmp = null;
      // Preserve run references returned to callers (start mutates its returned run).
      for (const [id, run] of Object.entries(next.runs)) {
        const existing = this.state.runs[id];
        if (existing) { for (const key of Object.keys(existing)) delete existing[key]; Object.assign(existing, run); next.runs[id] = existing; }
      }
      this.state = next;
      this._base = clone(next);
      this._recoveryRaw = undefined;
      if (pruned) this.lastPruned = { count: pruned, at: Date.now() };
      this.lastFlushError = null;
      return true;
    } catch (e) {
      this.lastFlushError = e.message || String(e);
      try { console.warn('[token2biq] run-store flush 失败：' + this.lastFlushError); } catch { /* ignore */ }
      return false;
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* recover on later startup */ } }
      if (locked) this._releaseLock();
    }
  }

  _lockFile() { return this.file + '.lock'; }

  // Fail closed. A living owner never expires, regardless of clock/mtime. The
  // reaper guard serializes dead-owner removal so a second reaper cannot unlink
  // a newly acquired lock. An incomplete/unknown lock fails safely, not open.
  _acquireLock(timeoutMs = 1000) {
    const file = this._lockFile(), start = Date.now();
    const token = process.pid + ':' + randomUUID();
    let blockedBy = 'unknown owner';
    for (;;) {
      try {
        const fd = fs.openSync(file, 'wx');
        try { fs.writeFileSync(fd, token); }
        catch (e) { fs.closeSync(fd); fs.unlinkSync(file); throw e; }
        fs.closeSync(fd);
        this._lockToken = token;
        return true;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let guard;
        try {
          guard = fs.openSync(file + '.reap', 'wx');
          const rawToken = fs.readFileSync(file, 'utf8');
          const owner = Number(String(rawToken).split(':')[0]);
          if (Number.isSafeInteger(owner) && owner > 0) {
            const alive = pidAlive(owner);
            blockedBy = (alive ? 'live owner pid ' : 'dead owner pid ') + owner;
            if (!alive) fs.unlinkSync(file);
          } else {
            // 空/半写锁可能正被另一个 writer 写入（wx 后 write 前）。绝不按 mtime 猜活锁：
            // 保持 fail-closed，但把原因说清楚，别让调用方以为只是「忙」。
            blockedBy = rawToken ? 'half-written lock (no owner pid)' : 'empty lock (no owner pid)';
          }
        } catch (error) { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error; }
        finally { if (guard !== undefined) { fs.closeSync(guard); fs.unlinkSync(file + '.reap'); } }
        if (Date.now() - start >= timeoutMs) {
          throw new Error('Snapshot writer lock timeout after ' + timeoutMs + 'ms (' + blockedBy + ')');
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }

  _releaseLock() {
    try { if (fs.readFileSync(this._lockFile(), 'utf8') === this._lockToken) fs.unlinkSync(this._lockFile()); }
    catch { /* Never remove a lock we cannot identify as ours. */ }
    this._lockToken = null;
  }

  // 可识别拒绝：不抛异常，返回 null，并留下结构化诊断供调用方/测试断言。
  _reject(op, runId, reason) {
    this.lastRejected = { op, runId, reason, at: Date.now() };
    return null;
  }

  // 只读地看一眼「已提交」快照里的运行：stale 实例据此识别迟到操作。
  // 读不到/读坏了都返回 null —— 让合并阶段的不变量兜底，诊断读取绝不抛。
  _committedRun(runId) {
    if (!this.file) return null;
    let locked = false;
    try {
      this._acquireLock();
      locked = true;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!isSnapshot(data)) return null;
      const run = data.runs[runId];
      return object(run) ? run : null;
    } catch {
      return null;
    } finally {
      if (locked) this._releaseLock();
    }
  }

  _cleanStaleTmp({ graceMs = 60 * 60 * 1000 } = {}) {
    if (!this.file) return 0;
    const dir = path.dirname(this.file), base = path.basename(this.file) + '.';
    let removed = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(base) || !name.endsWith('.tmp')) continue;
        const full = path.join(dir, name), pid = tmpOwnerPid(name, base);
        if (pid != null && pidAlive(pid)) continue;
        try {
          if (Date.now() - fs.statSync(full).mtimeMs < graceMs) continue;
          fs.unlinkSync(full); removed++;
        } catch { /* file changed or is unavailable */ }
      }
    } catch { /* directory absent/unreadable */ }
    return removed;
  }

  // 追加一条运行事件（append-only 审计流）：状态跃迁留痕，出问题不必靠回执反推。
  _ev(runId, kind, detail = {}) {
    const r = this.state.runs[runId];
    if (!r) return null;
    if (!Array.isArray(r.events)) r.events = [];
    const ev = { id: uid('ev'), ts: Date.now(), kind: String(kind || ''), ...detail };
    r.events.push(ev);
    if (r.events.length > MAX_EVENTS) r.events.splice(0, r.events.length - MAX_EVENTS);
    return ev;
  }

  // 淘汰最旧的运行：正在跑/暂停的最后才淘汰，避免「一次归档把活跃运行干掉」。
  _prune(max = MAX_RUNS, state = this.state) {
    const runs = state.runs;
    const ids = Object.keys(runs);
    if (ids.length <= max) return 0;
    const ordered = ids.map((id) => runs[id]).filter(Boolean).sort((a, b) => {
      const ar = a.status === 'running' || a.status === 'paused' ? 1 : 0;
      const br = b.status === 'running' || b.status === 'paused' ? 1 : 0;
      if (ar !== br) return ar - br;
      return (a.updatedAt || 0) - (b.updatedAt || 0);
    });
    const drop = ordered.slice(0, ids.length - max);
    if (!state.tombstones || typeof state.tombstones !== 'object') state.tombstones = {};
    for (const r of drop) {
      delete runs[r.id];
      // 淘汰同样要留墓碑：否则另一个窗口的旧快照会把它合并回来（淘汰形同虚设）。
      state.tombstones[r.id] = Date.now();
    }
    return drop.length;
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
      events: [{ id: uid('ev'), ts: now, kind: 'start', mode, requestedMode: mode }],
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
    this._ev(runId, 'stage', { stage: kind, status });
    this.flush();
    return st;
  }

  addTask(runId, { stage, role, brief, status, receipt, tokensIn, tokensOut, teamTaskId, owner, model, estimated }) {
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
      // 与官方 Agent Teams 共享任务板绑定：teamTaskId=team_task_* 返回的 id；owner=subagent 的 name（即 team_task_update 的 owner 参数）。
      teamTaskId: teamTaskId || null,
      owner: owner || null,
      model: model || null,
      tokensIn: num(tokensIn),
      tokensOut: num(tokensOut),
      // 是否按字符估算（而非调用方实测上报）：报告里必须标注，不能把估算当实测展示。
      estimated: !!estimated,
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
    // failStreak 是派生值：末尾连续 FAIL 的条数（升级后的 FAIL 不再计入）。
    r.failStreak = trailingFailStreak(r.reviews, r.failStreakResetReviewId);
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
    // 裁决一旦提交就是终态：stale 实例的迟到 setVerdict 不得覆盖先提交的 final。
    if (r.verdict && r.verdict.final) return this._reject('setVerdict', runId, 'run-already-finalized');
    const committed = this._committedRun(runId);
    if (committed && committed.verdict && committed.verdict.final) {
      r.verdict = clone(committed.verdict);
      r.status = 'done';
      r.paused = false;
      r.pauseReason = '';
      r.statusBeforePause = null;
      r.updatedAt = Date.now();
      return this._reject('setVerdict', runId, 'run-already-finalized-on-disk');
    }
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
    this._ev(runId, 'verdict', { verdict: r.verdict.final, byJudge: r.verdict.byJudge, reason: r.verdict.rationale });
    this.flush();
    return r.verdict;
  }

  setStatus(runId, status) {
    const r = this.getRun(runId);
    if (!r) return null;
    r.status = status;
    r.updatedAt = Date.now();
    this._ev(runId, 'status', { status });
    this.flush();
    return r;
  }

  setPaused(runId, paused, reason) {
    const r = this.getRun(runId);
    if (!r) return null;
    // 已结束的运行不可再改状态（service.setPaused 已有同样守卫，这里兜底防直接调用）。
    if (r.status === 'done') return this._reject('setPaused', runId, 'run-is-done');
    // 本地快照可能已过期：先看「已提交」的终态。否则 stale 实例 flush 时会把 done 改回 paused。
    const committed = this._committedRun(runId);
    if (committed && committed.status === 'done') {
      r.status = 'done';
      r.paused = false;
      r.pauseReason = '';
      r.statusBeforePause = null;
      if (committed.verdict) r.verdict = clone(committed.verdict);
      r.updatedAt = Date.now();
      return this._reject('setPaused', runId, 'run-is-done-on-disk');
    }
    r.paused = !!paused;
    r.pauseReason = reason || '';
    if (paused) {
      if (r.status !== 'paused') r.statusBeforePause = r.status; // 记住暂停前状态，恢复时不硬编码 running
      r.status = 'paused';
    } else if (r.status === 'paused') {
      r.status = r.statusBeforePause || 'running';
      r.statusBeforePause = null;
    }
    r.updatedAt = Date.now();
    this._ev(runId, paused ? 'pause' : 'resume', { reason: r.pauseReason });
    this.flush();
    return r;
  }

  addEscalation(runId, { from, to, reason }) {
    const r = this.getRun(runId);
    if (!r) return null;
    r.escalations.push({ from, to, reason: reason || '', at: Date.now() });
    r.failStreak = 0;
    const lastReview = (r.reviews || [])[r.reviews.length - 1];
    r.failStreakResetReviewId = lastReview ? lastReview.id : null;
    r.updatedAt = Date.now();
    this._ev(runId, 'escalate', { from, to, reason: reason || '' });
    this.flush();
    return r;
  }

  // 真正的闸门升级：不只是记录，而是把 run 切到新档位的计划与阶段（保留既有任务历史）。
  applyEscalation(runId, { from, to, reason, plan }) {
    const r = this.getRun(runId);
    if (!r) return null;
    r.escalations.push({ from, to, reason: reason || '', at: Date.now() });
    r.failStreak = 0;
    const lastReview = (r.reviews || [])[r.reviews.length - 1];
    r.failStreakResetReviewId = lastReview ? lastReview.id : null;
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
    if (!this.state.runs[runId]) return false;
    delete this.state.runs[runId];
    // 墓碑：只删内存的话，下一次 _mergeExternal 读到磁盘上的旧快照会把它复活。
    if (!this.state.tombstones || typeof this.state.tombstones !== 'object') this.state.tombstones = {};
    this.state.tombstones[runId] = Date.now();
    this.flush();
    return true;
  }
}
