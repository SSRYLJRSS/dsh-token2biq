// 核心审计回归 —— 把 core-audit 复现出的「非存储」缺陷钉成测试，防止再次回归。
//
// 覆盖：
//  · P2 交接读到真实回执形状（task.receipt），并行评审任一 FAIL 即 FAIL
//  · strict 门禁：验证 PASS 之后又 FAIL / 重新实现，不能再交付；FAIL 收口必须放行
//  · 多候选：candidateId 必须是 1..N、judge 最新回执必须 PASS 且已择优
//  · testsRun 有 ok:false 时不得算 testsPassed=true
//  · record 幂等：同 teamTaskId+相同回执不重复记账，失败后的新尝试必须放行
//  · 设置：只改 roleModels 连续两次都要生效；显式 settingsFile=null 走内存
//  · S4 并行多审：FAIL 不能被另一条 PASS 抹成 done；同 slot 重试可自愈
//  · 预算闸门读真实用量（real）优先于回执台账（ledger）
//  · 阶段依赖 DAG：模型路由阶段不再被跳过；同阶段互不阻塞；下游依赖整组
//  · 派活提示明确「ready 不会自动开工」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Token2bIQService } from '../lib/service.js';
import { validateVerifyReceipt } from '../lib/receipts.js';
import { attemptSlot, latestPerSlot } from '../lib/stage-state.js';

let seq = 0;
function mk() {
  const sf = join(tmpdir(), 't2biq-ca-' + process.pid + '-' + Date.now() + '-' + seq++ + '.json');
  return new Token2bIQService({ stateFile: null, settingsFile: sf });
}

function makeFakeTeam({ enabled = true } = {}) {
  let n = 0;
  const calls = [];
  return {
    calls,
    isEnabled: () => enabled,
    createTask: async (_agent, req) => {
      calls.push(req);
      return { id: 'task-' + (++n), revision: 1, status: 'pending', subject: req.subject, blockedBy: req.blockedBy || [] };
    },
  };
}

// ---- P2 交接 ----

test('P2 交接：真实 task.receipt 形状也能汇总（旧实现恒为空）', () => {
  const s = mk();
  const run = {
    plan: { stages: ['research', 'generate'] },
    tasks: [
      { kind: 'research', status: 'done', receipt: { kind: 'research', summary: '调研结论', files: ['doc.md'], issues: [] } },
      { kind: 'generate', status: 'pending', receipt: null },
    ],
  };
  const h = s._handoff(run, 'generate');
  assert.equal(h.items.length, 1);
  assert.equal(h.items[0].stage, 'research');
  assert.deepEqual(h.items[0].files, ['doc.md']);
  assert.equal(h.items[0].diffSummary, '调研结论');
  assert.ok(h.text.includes('research'));
  assert.ok(!h.text.includes('上游尚未产出'));
});

test('P2 交接：并行评审任一 FAIL → 整体 FAIL，不被另一条 PASS 覆盖', () => {
  const s = mk();
  const run = {
    plan: { stages: ['review', 'verify'] },
    tasks: [
      { kind: 'review', owner: 'rev-a', status: 'failed', receipt: { verdict: 'FAIL', issues: ['空指针'] } },
      { kind: 'review', owner: 'rev-b', status: 'done', receipt: { verdict: 'PASS', issues: [] } },
    ],
  };
  const h = s._handoff(run, 'verify');
  assert.equal(h.items[0].verdict, 'FAIL');
  assert.deepEqual(h.openIssues, ['空指针']);
});

// ---- strict 门禁 ----

test('strict：验证 PASS 之后又 FAIL，finish(PASS) 必须拒；finish(FAIL) 必须放行', () => {
  const s = mk();
  s.updateSettings({ pipelineGate: 'strict', forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  s.record({ runId: run.id, stage: 'plan', status: 'done', summary: '验收：x' });
  s.record({ runId: run.id, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'impl' });
  s.record({ runId: run.id, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: [{ cmd: 'node --test', ok: true }] });
  // 严格模式下验证必须带 testsRun 证据（即使 FAIL）。
  s.record({ runId: run.id, stage: 'verify', status: 'done', verdict: 'FAIL', evidence: ['3 条用例失败'], testsRun: [{ cmd: 'node --test', ok: false }] });
  const f = s.finish({ runId: run.id, verdict: 'PASS' });
  assert.equal(f.ok, false, '历史 PASS 不能给后续 FAIL 背书');
  assert.match(f.error, /验证|verify/);
  // 失败收口不能被门禁拦住，否则失败运行永远无法结束。
  const give = s.finish({ runId: run.id, verdict: 'FAIL', rationale: '放弃' });
  assert.equal(give.ok, true);
});

test('strict：重新实现后，旧的验证 PASS 不再算数', () => {
  const s = mk();
  s.updateSettings({ pipelineGate: 'strict', forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  s.record({ runId: run.id, stage: 'plan', status: 'done', summary: '验收：x' });
  s.record({ runId: run.id, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'v1' });
  s.record({ runId: run.id, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: [{ cmd: 'node --test', ok: true }] });
  s.record({ runId: run.id, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'v2 改坏了' });
  const f = s.finish({ runId: run.id, verdict: 'PASS' });
  assert.equal(f.ok, false, '验证必须发生在新产物之后');
});

test('strict 多候选：judge 最新回执 FAIL 时 finish(PASS) 必须拒', () => {
  const s = mk();
  s.updateSettings({ pipelineGate: 'strict', forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2', candidates: 2 });
  s.record({ runId: run.id, stage: 'plan', status: 'done', summary: '验收：x' });
  s.record({ runId: run.id, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'c1', candidateId: 1 });
  s.record({ runId: run.id, stage: 'generate', status: 'done', files: ['b.js'], diffSummary: 'c2', candidateId: 2 });
  s.record({ runId: run.id, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: [{ cmd: 'node --test', ok: true }] });
  s.record({ runId: run.id, stage: 'judge', status: 'done', verdict: 'FAIL', issues: ['c1 更差'], selectedCandidate: 2 });
  const f = s.finish({ runId: run.id, verdict: 'PASS' });
  assert.equal(f.ok, false, 'FAIL 的 judge 不能替人放行');
});

test('多候选：candidateId 必须是已记录过的候选', () => {
  const s = mk();
  s.updateSettings({ pipelineGate: 'strict', forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2', candidates: 2 });
  s.record({ runId: run.id, stage: 'plan', status: 'done', summary: '验收：x' });
  const bad = s.record({ runId: run.id, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'c9', candidateId: 999 });
  assert.equal(bad.ok, false);
  s.record({ runId: run.id, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'c1', candidateId: 1 });
  const j = s.record({ runId: run.id, stage: 'judge', status: 'done', verdict: 'PASS', selectedCandidate: 2 });
  assert.equal(j.ok, false, '不能择优一个不存在的候选');
  assert.match(j.error, /selectedCandidate/);
});

// ---- 回执 ----

test('verify 回执：testsRun 里有 ok:false 时不得算 testsPassed=true', () => {
  const v = validateVerifyReceipt({
    verdict: 'PASS',
    evidence: ['x'],
    testsPassed: true, // 调用方最容易犯的错：手写 testsPassed:true 盖掉红测试
    testsRun: [{ cmd: 'node --test', ok: true }, { cmd: 'lint', ok: false }],
  });
  // 任一失败即失败：矛盾回执（PASS + 失败用例）必须拒收，而不是放行。
  assert.equal(v.ok, false);
  assert.match(v.errors.join('；'), /矛盾|未通过/);
  assert.equal(v.value.testsPassed, false, '有失败用例必须一票否决');
  const all = validateVerifyReceipt({ verdict: 'PASS', evidence: ['x'], testsRun: [{ cmd: 'node --test', ok: true }] });
  assert.equal(all.value.testsPassed, true);
});

test('record：同 teamTaskId 的相同回执幂等，不重复记账', () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  const args = { runId: run.id, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'impl', teamTaskId: 'task-1' };
  const r1 = s.record(args);
  assert.equal(r1.ok, true);
  const n1 = s.store.getRun(run.id).tasks.length;
  const r2 = s.record(args);
  assert.equal(r2.ok, true);
  assert.equal(r2.idempotent, true);
  assert.equal(s.store.getRun(run.id).tasks.length, n1, '重复回执不得重复记账');
});

test('record：同 teamTaskId 失败后修复的新尝试必须放行', () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  const base = { runId: run.id, stage: 'generate', files: ['a.js'], teamTaskId: 'task-1' };
  assert.equal(s.record({ ...base, status: 'failed', notes: '编译失败' }).ok, true);
  const fixed = s.record({ ...base, status: 'done', diffSummary: '修好了' });
  assert.equal(fixed.ok, true, '同任务失败后的新尝试不能被幂等门禁挡住');
  assert.equal(fixed.idempotent, undefined);
  assert.equal(s.store.getRun(run.id).tasks.length, 2);
});

test('幂等：PASS→FAIL→重新 PASS（回执与首条相同）必须作为新验证生效', () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  const pass = { runId: run.id, stage: 'review', verdict: 'PASS', issues: [], teamTaskId: 'task-r' };
  const fail = { runId: run.id, stage: 'review', verdict: 'FAIL', issues: ['回归'], teamTaskId: 'task-r' };
  assert.equal(s.record(pass).ok, true);
  assert.equal(s.record(fail).ok, true);
  const again = s.record(pass); // 与首条 PASS 完全同内容
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, undefined, '不能被首条 PASS 判成重复而拒收');
  const view = s.runView(s.store.getRun(run.id));
  assert.equal(view.stages.find((x) => x.kind === 'review').status, 'done', '修好后必须自愈');
});

test('幂等：产物更新后同样的验证命令必须重新生效（finish 放行）', () => {
  const s = mk();
  s.updateSettings({ pipelineGate: 'strict', forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  s.record({ runId: run.id, stage: 'plan', status: 'done', summary: '验收：x' });
  s.record({ runId: run.id, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'v1' });
  const verify = { runId: run.id, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: [{ cmd: 'node --test', ok: true }], teamTaskId: 'task-v' };
  assert.equal(s.record(verify).ok, true);
  s.record({ runId: run.id, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'v2' });
  const re = s.record(verify); // 同命令、同回执
  assert.equal(re.ok, true);
  assert.equal(re.idempotent, undefined, '新产物之后的验证不能被旧回执顶账');
  assert.equal(s.finish({ runId: run.id, verdict: 'PASS' }).ok, true);
});

test('并发删除：record 时 addTask 先 remove → 返回 ok:false 且不抛', () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  const orig = s.store.addTask.bind(s.store);
  s.store.addTask = (...a) => { s.store.remove(run.id); return orig(...a); };
  const r = s.record({ runId: run.id, stage: 'plan', status: 'done', summary: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /已被删除/);
});

test('并发删除：finish 时 setVerdict 后 remove → 返回 ok:false 且不抛', () => {
  const s = mk();
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  const orig = s.store.setVerdict.bind(s.store);
  s.store.setVerdict = (...a) => { const v = orig(...a); s.store.remove(run.id); return v; };
  const f = s.finish({ runId: run.id, verdict: 'FAIL', rationale: '放弃' });
  assert.equal(f.ok, false);
  assert.match(f.error, /已被删除/);
});

test('并发删除：setPaused 后 remove → 返回 ok:false 且不抛（summary 不炸）', () => {
  const s = mk();
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  const orig = s.store.setPaused.bind(s.store);
  s.store.setPaused = (...a) => { const v = orig(...a); s.store.remove(run.id); return v; };
  const p = s.setPaused(run.id, true);
  assert.equal(p.ok, false);
  assert.match(p.error, /已被删除/);
});

test('start：落盘失败必须 warning，不能假成功', () => {
  const s = mk();
  s.store.flush = () => { s.store.lastFlushError = 'EPERM'; };
  const res = s.start({ goal: 'x', mode: 'S2', acceptance: '必须可恢复' });
  assert.equal(res.ok, true, '运行仍在内存里，ok 保持 true');
  assert.match(String(res.persistWarning || ''), /未持久化/);
});

test('noteUsage：活动运行被删除后必须清 currentRunId', () => {
  const s = mk();
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  s.currentRunId = run.id;
  s.store.remove(run.id);
  s.noteUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  assert.equal(s.currentRunId, null);
});

// ---- 设置 ----

test('settings：只改 rolePools 连续两次都要生效（不被旧 roleModels 遮回）', () => {
  const s = mk();
  s.updateSettings({ rolePools: { generate: ['p::one'] } });
  assert.equal(s.settings.get().roleModels.generate, 'p::one');
  s.updateSettings({ rolePools: { generate: ['p::two'] } });
  assert.equal(s.settings.get().roleModels.generate, 'p::two', '第二次更新不能被旧池遮回去');
  assert.deepEqual(s.settings.get().rolePools.generate, ['p::two']);
});

test('settings：显式 settingsFile=null 走内存，不写默认文件', () => {
  const s = new Token2bIQService({ stateFile: null, settingsFile: null });
  assert.equal(s.settings.file, null);
  s.updateSettings({ defaultMode: 'S3' });
  assert.equal(s.settings.file, null);
  assert.equal(s.settings.lastSaveError, null);
  assert.equal(s.settings.get().defaultMode, 'S3');
});

// ---- S4 并行多审的阶段聚合 ----

test('S4 并行多审：review FAIL + 另一条 PASS → 阶段必须 failed', () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  s.record({ runId: run.id, stage: 'review', verdict: 'FAIL', issues: ['缺边界用例'], owner: 'rev-a' });
  s.record({ runId: run.id, stage: 'review', verdict: 'PASS', issues: [], owner: 'rev-b' });
  const view = s.runView(s.store.getRun(run.id));
  const st = view.stages.find((x) => x.kind === 'review');
  assert.equal(st.status, 'failed', '任一评审 FAIL 即阶段 FAIL，不能被另一条 PASS 抹平');
});

test('S4 并行多审：同一 slot 重试通过 → 阶段自愈为 done', () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  s.record({ runId: run.id, stage: 'review', verdict: 'FAIL', issues: ['x'], owner: 'rev-a' });
  s.record({ runId: run.id, stage: 'review', verdict: 'PASS', issues: [], owner: 'rev-a' });
  const view = s.runView(s.store.getRun(run.id));
  assert.equal(view.stages.find((x) => x.kind === 'review').status, 'done');
});

// ---- 预算 ----

test('预算闸门：真实用量（real）优先于回执台账（ledger）', () => {
  const s = mk();
  s.updateSettings({ tokenBudget: 100 });
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  run.real = { total: 1000, input: 600, output: 400 };
  const view = s.runView(run);
  assert.equal(view.budgetGate.spent, 1000);
  assert.equal(view.budgetGate.percent, 1000, 'percent 是百分比：1000/100 = 1000%');
  assert.equal(view.budgetGate.level, 'hard');
  run.real = { total: 85 };
  assert.equal(s.runView(run).budgetGate.level, 'soft');
  run.real = { total: 10 };
  assert.equal(s.runView(run).budgetGate.level, 'ok');
});

// ---- 阶段依赖 DAG ----

test('DAG：模型路由阶段不再被跳过；同阶段互不阻塞；下游依赖整组', async () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S3' });
  const roster = [
    { stage: 'generate', role: 'worker', subject: 'g', model: 'p::m' }, // 模型路由阶段
    { stage: 'review', role: 'reviewer', subject: 'r1' },
    { stage: 'review', role: 'reviewer', subject: 'r2' },               // 同阶段并行多审
    { stage: 'verify', role: 'verifier', subject: 'v' },
  ];
  const team = makeFakeTeam();
  const res = await s.autoBoard(run.id, roster, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.ok, true);
  // autoBoard 在 createTask 请求里下发 blockedBy，tasks[] 只回 taskId —— 断言看请求体。
  const [g, r1, r2, v] = team.calls;
  const ids = res.tasks.map((t) => t.taskId);
  assert.ok(!g.blockedBy || g.blockedBy.length === 0, '首个阶段无前驱');
  assert.deepEqual(r1.blockedBy, [ids[0]], '模型路由阶段必须参与依赖，不能被跳过');
  assert.deepEqual(r2.blockedBy, [ids[0]], '同阶段并行多审互不阻塞');
  assert.deepEqual(v.blockedBy, [ids[1], ids[2]], '下游依赖上游整组任务');
});

test('派活提示：≤400 字符、带 taskId/revision 与 claim→执行→complete，不指示 send_message 汇报', () => {
  const s = mk();
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  const prompt = s._spawnPrompt(run, { stage: 'generate', role: 'worker', subject: 'g', doneWhen: '产出改动' }, 'task-1', 3);
  assert.ok(prompt.length <= 400, '派活提示必须 ≤400 字符，实际 ' + prompt.length);
  assert.ok(prompt.includes('task-1'), '必须带上任务 id');
  assert.ok(prompt.includes('revision=3'), '必须带上 revision');
  assert.ok(prompt.includes('claim → 执行 → team_task_update complete'), '必须给出 claim→执行→complete 流程');
  assert.ok(prompt.includes('不要 send_message'), '必须明确不要 send_message 汇报');
});

// ---- 严收尾 / 评审身份 / 回执幂等 / 异步入口 ----

test('strict finish：当前有效 review 为 FAIL 必须拒绝交付，同 slot 最新 PASS 才恢复', () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off', pipelineGate: 'strict' });
  const { run } = s.start({ goal: 'x', mode: 'S3', acceptance: '可恢复' });
  const rid = run.id;
  s.record({ runId: rid, stage: 'generate', files: ['a.js'], diffSummary: '实现', teamTaskId: 'G1', owner: 'w' });
  s.record({ runId: rid, stage: 'verify', verdict: 'PASS', testsRun: [{ cmd: 'node --test', ok: true }], teamTaskId: 'V1', owner: 'v' });
  s.record({ runId: rid, stage: 'review', verdict: 'FAIL', issues: ['边界用例缺失'], teamTaskId: 'R1', owner: 'rev' });
  const fin = s.finish({ runId: rid, verdict: 'PASS' });
  assert.equal(fin.ok, false, '当前有效 review=FAIL 时不得交付');
  assert.match(String(fin.error), /review/);
  // 同一 slot 重新评审 PASS（内容不同 = 新尝试）→ 恢复交付
  s.record({ runId: rid, stage: 'review', verdict: 'PASS', evidence: ['已补边界用例'], teamTaskId: 'R1', owner: 'rev' });
  assert.equal(s.finish({ runId: rid, verdict: 'PASS' }).ok, true, '同 slot 最新 PASS 应恢复交付');
});

test('S4：review/judge/redteam 缺 teamTaskId/owner 必须拒收', () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off', pipelineGate: 'loose' });
  const { run } = s.start({ goal: 'x', mode: 'S4', acceptance: 'a' });
  for (const stage of ['review', 'judge', 'redteam']) {
    const r = s.record({ runId: run.id, stage, verdict: 'PASS' });
    assert.equal(r.ok, false, stage + ' 缺身份必须拒收');
    assert.match(String(r.error), /S4/);
  }
  const ok = s.record({ runId: run.id, stage: 'review', verdict: 'PASS', teamTaskId: 'T1', owner: 'r1' });
  assert.equal(ok.ok, true);
});

test('stage-state：缺 teamTaskId/owner 的历史任务用 task.id 兜底成独立 slot', () => {
  assert.equal(attemptSlot({ id: 'task-1' }), 'id:task-1');
  assert.equal(attemptSlot({ teamTaskId: 'T', owner: 'o' }), 'task:T');
  assert.equal(attemptSlot({ owner: 'o' }), 'owner:o');
  const latest = latestPerSlot([{ id: 'a', status: 'failed' }, { id: 'b', status: 'done' }]);
  assert.equal(latest.length, 2, '无身份的历史回执不能合并成同一个 slot');
  assert.equal(latestPerSlot([{ teamTaskId: 'T', status: 'failed' }, { teamTaskId: 'T', status: 'done' }]).length, 1);
});

test('幂等：generate T1→T2 后重放 T1 完全回执不得新增第三条', () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  const g1 = { runId: run.id, stage: 'generate', files: ['a.js'], diffSummary: 'T1', teamTaskId: 'G', owner: 'w' };
  s.record(g1);
  s.record({ ...g1, diffSummary: 'T2' });
  const replay = s.record(g1);
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true, '重放旧产物应幂等');
  assert.equal(s.store.getRun(run.id).tasks.filter((t) => t.kind === 'generate').length, 2);
});

test('幂等：review FAIL→PASS 后重放旧 FAIL 不得把阶段翻回 failed', () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  const f = { runId: run.id, stage: 'review', verdict: 'FAIL', issues: ['x'], teamTaskId: 'R', owner: 'rev' };
  const p = { runId: run.id, stage: 'review', verdict: 'PASS', evidence: ['ok'], teamTaskId: 'R', owner: 'rev' };
  s.record(f);
  s.record(p);
  assert.equal(s.runView(s.store.getRun(run.id)).stages.find((x) => x.kind === 'review').status, 'done');
  const replay = s.record(f);
  assert.equal(replay.idempotent, true);
  assert.equal(s.runView(s.store.getRun(run.id)).stages.find((x) => x.kind === 'review').status, 'done', '重放旧 FAIL 不能反转阶段');
});

test('入口：handleToolAsync 全量透传 start 参数；同步 handleTool start 给明确指引', async () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off' });
  const out = await s.handleToolAsync({ action: 'start', goal: 'x', mode: 'S3', candidates: 2, acceptance: '必须可恢复' });
  assert.equal(out.ok, true);
  assert.equal(out.candidates, 2, 'candidates 必须透传到 start');
  const run = s.store.getRun(out.run.id);
  assert.equal(run.candidates, 2);
  assert.equal(run.spec.acceptance, '必须可恢复', 'acceptance 必须透传到 start');
  const sync = s.handleTool({ action: 'start', goal: 'y', mode: 'S2' });
  assert.equal(sync.ok, false, '同步入口不能返回半截 Promise');
  assert.match(String(sync.error), /异步|handleToolAsync/);
});

test('非S4无身份：review FAIL→PASS 必须自愈 done（合成 __seq__ 序列槽），重放旧 FAIL 幂等', () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  const view = () => s.runView(s.store.getRun(run.id)).stages.find((x) => x.kind === 'review').status;
  s.record({ runId: run.id, stage: 'review', verdict: 'FAIL', issues: ['x'] });
  assert.equal(view(), 'failed');
  s.record({ runId: run.id, stage: 'review', verdict: 'PASS', evidence: ['已修复'] });
  assert.equal(view(), 'done', '无身份重试必须落同一 __seq__ 槽并自愈');
  const replay = s.record({ runId: run.id, stage: 'review', verdict: 'FAIL', issues: ['x'] });
  assert.equal(replay.idempotent, true, '重放旧 FAIL 必须幂等');
  assert.equal(view(), 'done', '重放旧 FAIL 不能反转阶段');
});

test('S4：owner-only 并行评审（rev-a FAIL + rev-b PASS）必须被接受且聚合 failed', () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S4', acceptance: 'a' });
  const a = s.record({ runId: run.id, stage: 'review', verdict: 'FAIL', issues: ['缺边界'], owner: 'rev-a' });
  assert.equal(a.ok, true, 'owner-only 评审必须被接受：' + (a.error || ''));
  const b = s.record({ runId: run.id, stage: 'review', verdict: 'PASS', evidence: ['ok'], owner: 'rev-b' });
  assert.equal(b.ok, true);
  const st = s.runView(s.store.getRun(run.id)).stages.find((x) => x.kind === 'review');
  assert.equal(st.status, 'failed', '另一条 PASS 不能抹平 FAIL');
});

test('幂等：多候选 generate 完全重放返回 idempotent，不新增任务', () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2', candidates: 2, acceptance: 'a' });
  const g = { runId: run.id, stage: 'generate', files: ['a.js'], diffSummary: 'c1', candidateId: 1, teamTaskId: 'G', owner: 'w' };
  const first = s.record(g);
  assert.equal(first.ok, true, '首条候选记录必须成功：' + (first.error || ''));
  const replay = s.record(g);
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true, '完全相同重放必须幂等，而不是报 candidateId 已记录');
  assert.equal(s.store.getRun(run.id).tasks.filter((t) => t.kind === 'generate').length, 1);
});

test('R1：双实例 stale finish 不得覆盖先提交裁决（另一实例已收口）', () => {
  const sf = join(tmpdir(), 't2biq-r1-' + process.pid + '-' + Date.now() + '.json');
  const sfa = join(tmpdir(), 't2biq-r1s-' + process.pid + '-' + Date.now() + '.json');
  const A = new Token2bIQService({ stateFile: sf, settingsFile: sfa });
  const { run } = A.start({ goal: 'x', mode: 'S2' });
  // B 在 A 收口之前加载：B 内存里 run 仍是 running（stale）。
  const B = new Token2bIQService({ stateFile: sf, settingsFile: sfa });
  assert.equal(A.finish({ runId: run.id, verdict: 'FAIL' }).ok, true);
  const fb = B.finish({ runId: run.id, verdict: 'PASS' });
  assert.equal(fb.ok, false, 'stale 实例必须拒收');
  assert.match(String(fb.error), /另一实例已收口/);
  assert.equal(fb.verdict, 'FAIL', '必须回报实际 final 字符串');
  assert.equal(fb.run && fb.run.verdict, 'FAIL');
  assert.equal(fb.run.status, 'done');
  // 磁盘仍是先提交的 FAIL
  const C = new Token2bIQService({ stateFile: sf, settingsFile: sfa });
  assert.equal(C.store.getRun(run.id).verdict.final, 'FAIL');
});

test('R2：新 generate 后第一次相同 verify 作为新验证，紧接着重放幂等（verify 只新增一次）', () => {
  const s = mk();
  s.updateSettings({ forceTeam: 'off' });
  const { run } = s.start({ goal: 'x', mode: 'S2' });
  s.record({ runId: run.id, stage: 'generate', files: ['a.js'], diffSummary: 'v1', teamTaskId: 'G', owner: 'w' });
  const v = { runId: run.id, stage: 'verify', verdict: 'PASS', testsRun: [{ cmd: 'node --test', ok: true }], teamTaskId: 'V', owner: 'v' };
  assert.equal(s.record(v).ok, true);
  s.record({ runId: run.id, stage: 'generate', files: ['a.js', 'b.js'], diffSummary: 'v2', teamTaskId: 'G', owner: 'w' });
  const first = s.record(v);
  assert.equal(first.ok, true);
  assert.equal(first.idempotent, undefined, '早于最新产物的相同回执必须作为新验证');
  const before = JSON.parse(JSON.stringify(s.store.getRun(run.id).ledger.stages.verify));
  const replay = s.record(v);
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true, '与最新一条完全相同必须幂等');
  assert.equal(s.store.getRun(run.id).tasks.filter((t) => t.kind === 'verify').length, 2, 'verify 任务只新增一次');
  assert.deepEqual(s.store.getRun(run.id).ledger.stages.verify, before, 'verify ledger 只新增一次');
});
