// rc.5 兼容性修复回归（fix-plan FIX-1/FIX-2/FIX-3）：
//   FIX-1  lib/service.js autoBoard 回填 revision 时 getTask(caller, id) 必须带 agent，且失败不静默；
//   FIX-2  lib/index.js action=state 透出 provisionStatus/stateLoadError/stateRecoveredFrom/statePruned
//          与 current.degraded/orchestrationError/teamTasks/modelRouting；
//   FIX-3  compactToolResult 骨架白名单同步上述可观测字段（大结果降级时不被吞）。
// FIX-4（usage 计量）按 fix-plan 明确不修，无用例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Token2bIQService } from '../lib/service.js';
import { apply, compactToolResult } from '../lib/index.js';

let seq = 0;
function svc() {
  const sf = join(tmpdir(), `t2biq-rc5-${process.pid}-${Date.now()}-${seq++}.json`);
  return new Token2bIQService({ stateFile: null, settingsFile: sf });
}

// ---- FIX-1 ----

function makeFakeTeam({ failGetTask = false, failCreate = false } = {}) {
  let n = 0;
  const calls = { createTask: [], getTask: [] };
  return {
    calls,
    isEnabled: () => true,
    createTask: async (_agent, req) => {
      if (failCreate) throw new Error('create boom');
      calls.createTask.push({ agent: _agent, req });
      return { id: 'task-' + (++n), revision: 1, status: 'pending', subject: req.subject, blockedBy: req.blockedBy || [] };
    },
    getTask: async (caller, id) => {
      calls.getTask.push({ caller, id });
      if (failGetTask) throw new Error('getTask boom');
      return { id, revision: 9 };
    },
  };
}

test('FIX-1: getTask 以 createTask 同一个 agent 对象为 caller，revision 回填为宿主最新值', async () => {
  const s = svc();
  const team = makeFakeTeam();
  const agent = { id: 'lead-1' };
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent });
  assert.equal(res.orchestrated, true, '正常路径必须建板');
  assert.ok(team.calls.getTask.length > 0, '必须调用 getTask 回填 revision');
  for (const c of team.calls.getTask) {
    assert.equal(c.caller, agent, 'caller 必须与 createTask 用同一个 agent 对象（非字符串/非缺省）');
    assert.equal(typeof c.caller, 'object');
    assert.ok(c.id, '必须传任务 id');
  }
  const tasks = (res.created && res.created.tasks) || res.tasks || [];
  const withId = tasks.filter((t) => t.taskId);
  assert.ok(withId.length > 0, '必须有带 taskId 的建档行');
  for (const t of withId) assert.equal(t.revision, 9, 'revision 必须回填为 getTask 返回的最新值');
});

test('FIX-1: getTask 抛错时不静默——console.warn 提示且 revision 保留 createTask 值', async () => {
  const s = svc();
  const team = makeFakeTeam({ failGetTask: true });
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
  let res;
  try {
    res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent: { id: 'lead-1' } });
  } finally {
    console.warn = origWarn;
  }
  assert.equal(res.orchestrated, true, '回填失败不能影响建板结果');
  const tasks = (res.created && res.created.tasks) || res.tasks || [];
  for (const t of tasks.filter((x) => x.taskId)) assert.equal(t.revision, 1, '必须保留 createTask 返回的 revision');
  assert.ok(warnings.some((w) => w.includes('taskRevision 回填失败')), '必须 console.warn 而不是静默吞掉，实际告警：' + JSON.stringify(warnings));
});

// ---- FIX-2 ----

function makeCtx() {
  const captured = {};
  const fakeScope = {
    connection: { requestRejection: () => undefined },
    effect(fn) { return fn(); },
    webServer: { register(r) { captured.handler = r.handler; return () => {}; } },
    tools: { register(d) { captured.tool = d; return () => {}; } },
    logger: { info() {} },
    agents: { list: () => [] },
  };
  const ctx = {
    inject(_names, cb) { cb(fakeScope); },
    effect(fn) { return fn(); },
    on() {},
    logger: { info() {} },
    get() { return undefined; },
  };
  return { ctx, captured, fakeScope };
}

test('FIX-2: tool action=state 透出 provisionStatus 等恢复字段与 current.degraded/orchestrationError/teamTasks/modelRouting', async () => {
  // createTask 全部失败 → run.degraded='no-orchestration'，正好让 state 分支的降级透出路径可断言。
  const failTeam = makeFakeTeam({ failCreate: true });
  const { ctx, captured, fakeScope } = makeCtx();
  fakeScope.agentTeams = failTeam;
  apply(ctx, { autoProvision: false, stateFile: null, settingsFile: join(tmpdir(), `t2biq-rc5-state-${process.pid}-${Date.now()}.json`) });
  const tool = captured.tool;
  assert.ok(tool, 'token2biq 工具必须已注册');
  // autoBoard 只在 ctxInfo.agent 存在时才建板（service.startWithAuto 的 Lead 门禁），必须传调用方 agent。
  const startOut = JSON.parse(await tool.execute({ action: 'start', goal: 'x', mode: 'S1' }, { agent: { id: 'lead-1' } }));
  const runId = startOut.run && startOut.run.id;
  assert.ok(runId, 'start 必须返回 run.id');
  const stateOut = JSON.parse(await tool.execute({ action: 'state', runId }, {}));
  // 顶层恢复/配置字段（无故障时应为 null，但键必须存在）
  assert.ok('provisionStatus' in stateOut, '顶层必须透出 provisionStatus');
  assert.ok('stateLoadError' in stateOut, '顶层必须透出 stateLoadError');
  assert.ok('stateRecoveredFrom' in stateOut, '顶层必须透出 stateRecoveredFrom');
  assert.ok('statePruned' in stateOut, '顶层必须透出 statePruned');
  // current 降级/编排错误/团队任务绑定/模型路由
  assert.ok(stateOut.current, 'current 不能为空');
  assert.equal(stateOut.current.degraded, 'no-orchestration', 'current.degraded 必须透出');
  assert.match(String(stateOut.current.orchestrationError), /共享任务板建立失败/, 'current.orchestrationError 必须透出');
  assert.ok(Array.isArray(stateOut.current.teamTasks), 'current.teamTasks 必须透出');
  assert.ok(Array.isArray(stateOut.current.modelRouting), 'current.modelRouting 必须透出');
});

// ---- FIX-3 ----

test('FIX-3: compactToolResult 大 state 降级到骨架层时保留 provisionStatus/stateLoadError/stateRecoveredFrom/statePruned 与 current.degraded/orchestrationError/teamTasks/modelRouting', () => {
  const filler = 'x'.repeat(120);
  const bigState = {
    ok: true,
    mode: 'S3',
    modes: [{ name: 'S3', label: '完整加强' }],
    config: { a: filler },
    settings: { forceTeam: 'auto' },
    provisionStatus: { ok: true, changed: false, at: 1 },
    stateLoadError: null,
    stateRecoveredFrom: null,
    statePruned: null,
    // 足够大，确保第 1 级瘦身仍超限，真正走到第 2 级骨架白名单
    runs: Array.from({ length: 60 }, (_, i) => ({ id: 'run_' + i, mode: 'S3', status: 'done', goal: 'g'.repeat(200), spent: 900, updatedAt: 1 })),
    liveUsage: { input: 1, output: 2 },
    current: {
      id: 'run_59', mode: 'S3', status: 'running',
      degraded: 'partial-orchestration',
      orchestrationError: '共享任务板建立失败 1/4：review（create boom）',
      teamTasks: Array.from({ length: 14 }, (_, i) => ({ stage: 's' + i, taskId: 'task-' + i, revision: i, owner: 'w' + i })),
      modelRouting: Array.from({ length: 14 }, (_, i) => ({ stage: 's' + i, model: 'p::m' + i, provider: 'p', modelName: 'm' + i })),
      tasks: Array.from({ length: 60 }, (_, i) => ({ id: 't' + i, stage: 'research', role: 'researcher', status: 'done', owner: 'w1', model: 'p/m', tokens: 100, summary: filler, files: ['a.js'], issues: [], diffSummary: filler })),
      stages: [{ kind: 'research', label: '调研', status: 'running', tasks: [] }],
      reviews: Array.from({ length: 40 }, (_, i) => ({ id: 'r' + i, verdict: 'PASS', issues: [] })),
    },
    hint: 'h',
  };
  const out = compactToolResult(bigState);
  const parsed = JSON.parse(out);
  assert.ok(out.length <= 8192, '必须压到限额内，实际 ' + out.length);
  assert.deepEqual(parsed.provisionStatus, { ok: true, changed: false, at: 1 }, '骨架层不能丢 provisionStatus');
  assert.ok('stateLoadError' in parsed && 'stateRecoveredFrom' in parsed && 'statePruned' in parsed, '骨架层必须保留 state 恢复字段（键存在，无故障时为 null）');
  assert.equal(parsed.current.degraded, 'partial-orchestration', 'current.degraded 不能丢');
  assert.match(String(parsed.current.orchestrationError), /共享任务板建立失败/, 'current.orchestrationError 不能丢');
  assert.ok(Array.isArray(parsed.current.teamTasks) && parsed.current.teamTasks.length > 0, 'current.teamTasks 不能丢');
  assert.ok(Array.isArray(parsed.current.modelRouting) && parsed.current.modelRouting.length > 0, 'current.modelRouting 不能丢');
});

test('FIX-3 回归: 小结果仍原样返回（不引入额外瘦身副作用）', () => {
  const small = {
    ok: true,
    provisionStatus: { ok: true, changed: false, at: 2 },
    stateLoadError: null,
    stateRecoveredFrom: null,
    statePruned: null,
    current: { id: 'run_1', degraded: null, orchestrationError: null, teamTasks: [], modelRouting: [] },
  };
  assert.equal(compactToolResult(small), JSON.stringify(small));
});
