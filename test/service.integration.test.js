import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';

function mem() {
  // 用临时 settings 文件，避免读写真实 DSH 设置；测试默认关掉强制联动（forceTeam='off'）。
  const svc = new Token2bIQService({ stateFile: null, settingsFile: path.join(os.tmpdir(), 't2biq-int-' + process.pid + '.json') });
  svc.updateSettings({ forceTeam: 'off' });
  return svc;
}

test('S1 全链路：生成→盲审→验证→裁决（内存 store）', () => {
  const svc = mem();
  const start = svc.start({ goal: '给函数加日志', mode: 'S1' });
  assert.equal(start.ok, true);
  assert.equal(start.run.mode, 'S1');
  assert.deepEqual(start.stages.map((s) => s.kind), ['generate', 'review', 'verify']);
  const runId = start.run.id;

  const g = svc.record({ runId, stage: 'generate', role: 'worker', files: ['a.js'], diffSummary: '加了日志行', testsRun: ['node --test'], tokensIn: 1000, tokensOut: 500 });
  assert.equal(g.ok, true);
  assert.equal(g.paused, false);

  const rv = svc.record({ runId, stage: 'review', role: 'reviewer', verdict: 'PASS', evidence: ['diff 合理'], tokensIn: 300, tokensOut: 100 });
  assert.equal(rv.ok, true);

  const vf = svc.record({ runId, stage: 'verify', role: 'verifier', verdict: 'PASS', evidence: ['node --test 通过'], tokensIn: 200, tokensOut: 50 });
  assert.equal(vf.ok, true);

  const fin = svc.finish({ runId, verdict: 'PASS', rationale: '全部通过' });
  assert.equal(fin.ok, true);
  assert.equal(fin.verdict.final, 'PASS');

  const st = svc.state(runId);
  assert.equal(st.current.verdict.final, 'PASS');
  assert.equal(st.current.ledger.spent, 1000 + 500 + 300 + 100 + 200 + 50);
  assert.equal(st.current.stages.find((s) => s.kind === 'generate').tasks.length, 1);
});

test('回执校验：非法回执被拒', () => {
  const svc = mem();
  const runId = svc.start({ goal: 'x', mode: 'S1' }).run.id;
  const bad = svc.record({ runId, stage: 'generate', files: [], diffSummary: '' });
  assert.equal(bad.ok, false);
  assert.ok(Array.isArray(bad.errors));
});

test('token 缺省 → 估算并标注', () => {
  const svc = mem();
  const runId = svc.start({ goal: 'x', mode: 'S1' }).run.id;
  const r = svc.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'ok' });
  assert.equal(r.ok, true);
  assert.equal(r.estimatedTokens, true);
  assert.ok(r.task.tokens > 0);
});

test('闸门升级：S2 连续 2 次评审 FAIL → 上调 S3', () => {
  const svc = mem();
  const runId = svc.start({ goal: '重构系统', mode: 'S2' }).run.id;
  svc.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'v1' });
  const f1 = svc.record({ runId, stage: 'review', role: 'reviewer', verdict: 'FAIL', issues: ['边界未覆盖'] });
  assert.equal(f1.escalate, null);
  const f2 = svc.record({ runId, stage: 'review', role: 'reviewer', verdict: 'FAIL', issues: ['仍缺测试'] });
  assert.ok(f2.escalate);
  assert.equal(f2.escalate.from, 'S2');
  assert.equal(f2.escalate.to, 'S3');
});

test('Auto：大任务开档为 S3', () => {
  const svc = mem();
  const start = svc.start({ goal: '重构整个项目架构并迁移多文件模块', mode: 'Auto' });
  assert.equal(start.run.mode, 'S3');
  assert.equal(start.run.requestedMode, 'Auto');
});

test('导出报告含目标与台账', () => {
  const svc = mem();
  const runId = svc.start({ goal: '导出验证任务', mode: 'S1' }).run.id;
  svc.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'ok', tokensIn: 10, tokensOut: 5 });
  const md = svc.exportReport(runId);
  assert.match(md, /Token 2b IQ 报告/);
  assert.match(md, /导出验证任务/);
  assert.match(md, /Token 台账/);
});

test('start(S3) 返回团队执行手册 playbook', () => {
  const svc = mem();
  const start = svc.start({ goal: '重构整个项目架构并迁移多文件模块', mode: 'S3' });
  assert.equal(start.run.mode, 'S3');
  assert.ok(start.playbook && Array.isArray(start.playbook.steps));
  assert.equal(start.playbook.steps.length, 7);
  assert.deepEqual(start.playbook.steps.map((s) => s.kind),
    ['research', 'plan', 'generate', 'review', 'judge', 'redteam', 'regression']);
  assert.equal(start.playbook.maxMembers, 8);
  assert.deepEqual(start.playbook.steps.map((s) => s.role),
    ['researcher', 'planner', 'worker', 'reviewer', 'judge', 'red-team', 'verifier']);
});

test('S3 非代码阶段（research/plan/judge/redteam）免 files 即可记录', () => {
  const svc = mem();
  const runId = svc.start({ goal: 'audit', mode: 'S3' }).run.id;
  assert.equal(svc.record({ runId, stage: 'research', summary: '调研结论：三点风险' }).ok, true);
  assert.equal(svc.record({ runId, stage: 'plan', summary: '计划：拆成 3 个子任务' }).ok, true);
  assert.equal(svc.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: '实现' }).ok, true);
  assert.equal(svc.record({ runId, stage: 'review', verdict: 'PASS', evidence: ['ok'] }).ok, true);
  assert.equal(svc.record({ runId, stage: 'judge', verdict: 'PASS', rationale: '通过' }).ok, true);
  const rt = svc.record({ runId, stage: 'redteam', verdict: 'FAIL', issues: ['注入风险'] });
  assert.equal(rt.ok, true);
  assert.equal(rt.task.status, 'failed'); // 有 verdict 的阶段由 verdict 定成败
});

test('record 持久化 teamTaskId / owner 并与任务板对应', () => {
  const svc = mem();
  const runId = svc.start({ goal: 'x', mode: 'S1' }).run.id;
  const r = svc.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'ok', teamTaskId: 'tt_42', owner: 'worker-1' });
  assert.equal(r.ok, true);
  assert.equal(r.task.teamTaskId, 'tt_42');
  assert.equal(r.task.owner, 'worker-1');
  const st = svc.state(runId);
  const task = st.current.stages.find((s) => s.kind === 'generate').tasks[0];
  assert.equal(task.teamTaskId, 'tt_42');
  assert.equal(task.owner, 'worker-1');
});

test('闸门升级是真升级：S2 连续 2 次 FAIL 后 arch 变为 S3 且补足阶段', () => {
  const svc = mem();
  const runId = svc.start({ goal: '重构系统', mode: 'S2' }).run.id;
  svc.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'v1' });
  svc.record({ runId, stage: 'review', verdict: 'FAIL', issues: ['i1'] });
  const f2 = svc.record({ runId, stage: 'review', verdict: 'FAIL', issues: ['i2'] });
  assert.ok(f2.escalate);
  assert.equal(f2.escalate.from, 'S2');
  assert.equal(f2.escalate.to, 'S3');
  assert.deepEqual(f2.escalate.addedStages, ['research', 'judge', 'redteam', 'regression']);
  const st = svc.state(runId);
  assert.equal(st.current.mode, 'S3');
  assert.deepEqual(st.current.stages.map((s) => s.kind).slice().sort(),
    ['generate', 'judge', 'plan', 'redteam', 'regression', 'research', 'review', 'verify'].sort());
});

test('action=map 只返回团队手册', () => {
  const svc = mem();
  const out = svc.handleTool({ action: 'map', mode: 'S2', goal: 'x' });
  assert.equal(out.ok, true);
  assert.equal(out.playbook.plan.mode, 'S2');
  assert.deepEqual(out.playbook.roles, ['planner', 'worker', 'reviewer', 'verifier']);
});

test('强制联动：forceTeam 开启后 record 缺 teamTaskId/owner 被拒', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-force-'));
  const svc = new Token2bIQService({ stateFile: null, settingsFile: path.join(dir, 's.json') });
  svc.updateSettings({ forceTeam: true });
  const runId = svc.start({ goal: 'x', mode: 'S1' }).run.id;
  const bad = svc.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'ok' });
  assert.equal(bad.ok, false);
  assert.equal(bad.forceTeam, 'on');
  const good = svc.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'ok', teamTaskId: 'tt_1', owner: 'worker-1' });
  assert.equal(good.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('强制联动 auto：S2 未绑定被拒、S1 放行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-auto-'));
  const svc = new Token2bIQService({ stateFile: null, settingsFile: path.join(dir, 's.json') });
  const r2 = svc.start({ goal: 'x', mode: 'S2' }).run.id;
  const s2 = svc.record({ runId: r2, stage: 'generate', files: ['a.js'], diffSummary: 'ok' });
  assert.equal(s2.ok, false);
  const s2ok = svc.record({ runId: r2, stage: 'generate', files: ['a.js'], diffSummary: 'ok', teamTaskId: 'tt', owner: 'w' });
  assert.equal(s2ok.ok, true);
  const r1 = svc.start({ goal: 'y', mode: 'S1' }).run.id;
  const s1 = svc.record({ runId: r1, stage: 'generate', files: ['b.js'], diffSummary: 'ok' });
  assert.equal(s1.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 无关键词命中、长度 40–150 的中性中文任务 → 关键词拿不准，应交给模型复核
const AMBIG = '请把当前这个文件里的若干个函数按顺序通读一遍，并逐条告诉我每个函数大致在做什么事情、有没有潜在问题';

test('Auto 混合模式：关键词拿不准时用注入分类器复核，失败则回退', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-hybrid-'));
  const svc = new Token2bIQService({ stateFile: null, settingsFile: path.join(dir, 's.json') });
  svc.updateSettings({ forceTeam: 'off' });
  let called = 0;
  svc.classifier = async () => { called++; return { tier: 'S3', reason: '模型判大' }; };
  const small = await svc.autoDecide('修一个 typo，简单');
  assert.equal(small.tier, 'S1');
  assert.equal(small.decidedBy, 'heuristic');
  assert.equal(called, 0); // 明显任务不调模型
  const amb = await svc.autoDecide(AMBIG);
  assert.equal(amb.decidedBy, 'llm');
  assert.equal(amb.tier, 'S3');
  assert.equal(called, 1);
  svc.classifier = async () => null; // 模型失败
  const fb = await svc.autoDecide(AMBIG);
  assert.equal(fb.decidedBy, 'fallback');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Auto 混合模式：startWithAuto 采用复核档位并记录 autoDecision', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-hybrid2-'));
  const svc = new Token2bIQService({ stateFile: null, settingsFile: path.join(dir, 's.json') });
  svc.updateSettings({ forceTeam: 'off' });
  svc.classifier = async () => ({ tier: 'S2', reason: '中等' });
  const out = await svc.startWithAuto({ goal: AMBIG, mode: 'Auto' });
  assert.equal(out.ok, true);
  assert.equal(out.plan.mode, 'S2');
  assert.equal(out.plan.requestedMode, 'Auto');
  assert.equal(out.autoDecision.decidedBy, 'llm');
  const st = svc.state(out.run.id);
  assert.equal(st.current.autoDecision.tier, 'S2');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S4 并行多审：rolePools.review 两个候选 → playbook/roster 两个 review 条目', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-s4m-'));
  try {
    const svc = new Token2bIQService({ stateFile: null, settingsFile: path.join(dir, 's.json') });
    svc.updateSettings({ forceTeam: 'off', rolePools: { review: ['a::A', 'b::B'] } });
    const start = svc.start({ goal: 'x', mode: 'S4' });
    assert.equal(start.plan.mode, 'S4');
    const revSteps = start.playbook.steps.filter((s) => s.kind === 'review');
    assert.equal(revSteps.length, 2);
    assert.deepEqual(revSteps.map((s) => s.model), ['a::A', 'b::B']);
    assert.ok(revSteps.every((s) => s.parallel === true && s.multiReview === true));
    assert.equal(start.roster.filter((r) => r.stage === 'review').length, 2);
    // 非 S4 不拆：S3 同 rolePools 仍单条 review
    const s3 = svc.start({ goal: 'x', mode: 'S3' });
    assert.equal(s3.playbook.steps.filter((s) => s.kind === 'review').length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S4 并行多审阶段状态聚合：任一 FAIL → failed，全 PASS → done', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-s4agg-'));
  try {
    const svc = new Token2bIQService({ stateFile: null, settingsFile: path.join(dir, 's.json') });
    svc.updateSettings({ forceTeam: 'off', rolePools: { review: ['a::A', 'b::B'] } });
    const runId = svc.start({ goal: 'x', mode: 'S4' }).run.id;
    assert.equal(svc.record({ runId, stage: 'review', role: 'reviewer', verdict: 'PASS', model: 'a::A', evidence: ['ok'] }).ok, true);
    assert.equal(svc.state(runId).current.stages.find((s) => s.kind === 'review').status, 'done');
    assert.equal(svc.record({ runId, stage: 'review', role: 'reviewer', verdict: 'FAIL', model: 'b::B', issues: ['发现漏洞'] }).ok, true);
    assert.equal(svc.state(runId).current.stages.find((s) => s.kind === 'review').status, 'failed');

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-s4agg2-'));
    try {
      const svc2 = new Token2bIQService({ stateFile: null, settingsFile: path.join(dir2, 's.json') });
      svc2.updateSettings({ forceTeam: 'off', rolePools: { review: ['a::A', 'b::B'] } });
      const rid2 = svc2.start({ goal: 'x', mode: 'S4' }).run.id;
      svc2.record({ runId: rid2, stage: 'review', verdict: 'PASS', model: 'a::A', evidence: ['ok1'] });
      svc2.record({ runId: rid2, stage: 'review', verdict: 'PASS', model: 'b::B', evidence: ['ok2'] });
      assert.equal(svc2.state(rid2).current.stages.find((s) => s.kind === 'review').status, 'done');
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

