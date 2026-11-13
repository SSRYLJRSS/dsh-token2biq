// 2026-11-06 复盘修复的回归测试：
//   1) 真实用量按「活动运行」归集（修「记录完全是坏的/估算当真实」）
//   2) 档位持久化（修「重启后静默重置」）
//   3) 旧快照迁移（预算字段/阶段状态/real 字段）
//   4) 设置落地：模型白名单 + 评审跨厂商 硬校验
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore } from '../lib/run-store.js';
import { Token2bIQService } from '../lib/service.js';
import { generatePlan, buildTeamPlaybook } from '../lib/orchestrator.js';

function tmp(name) {
  return path.join(os.tmpdir(), `t2biq-rf-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
function mkSvc(opts = {}) {
  const svc = new Token2bIQService({ stateFile: opts.stateFile || null, settingsFile: tmp('s.json') });
  svc.updateSettings({ forceTeam: 'off' });
  return svc;
}

test('真实用量：llm/stream usage 归集到当前活动运行，finish 后停止归集', () => {
  const svc = mkSvc();
  const runId = svc.start({ goal: '真实用量测试', mode: 'S1' }).run.id;
  svc.noteUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }, 'sess-A');
  svc.noteUsage({ inputTokens: 40, outputTokens: 10, totalTokens: 50 }, 'sess-B');
  let r = svc.state(runId).current;
  assert.equal(r.real.total, 200);
  assert.equal(r.real.requests, 2);
  assert.equal(r.real.input, 140);
  // summary 也应有 realSpent
  assert.equal(svc.state().runs.find((x) => x.id === runId).realSpent, 200);

  svc.finish({ runId, verdict: 'PASS' });
  svc.noteUsage({ inputTokens: 999, outputTokens: 1, totalTokens: 1000 }, 'sess-C');
  r = svc.state(runId).current;
  assert.equal(r.real.total, 200, 'finish 后的调用不应再计入该运行');
});

test('回执估算与真实用量分离：缺省 token 仍是估算，real 不受影响', () => {
  const svc = mkSvc();
  const runId = svc.start({ goal: '估算测试', mode: 'S1' }).run.id;
  const rec = svc.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'ok' });
  assert.equal(rec.estimatedTokens, true);           // 仍是估算
  assert.ok(rec.task.tokens > 0);
  assert.equal(svc.state(runId).current.real.total, 0); // real 未被估算污染
});

test('档位持久化：setMode 写入 state，重启后沿用', () => {
  const file = tmp('state.json');
  const svc = new Token2bIQService({ stateFile: file, settingsFile: tmp('s.json') });
  assert.equal(svc.getMode(), 'Auto');
  svc.setMode('S3');
  const svc2 = new Token2bIQService({ stateFile: file, settingsFile: tmp('s.json') });
  assert.equal(svc2.getMode(), 'S3', '重启应恢复上次选择的档位');
});

test('旧快照迁移：预算字段→costWeight、阶段状态派生、补 real', () => {
  const file = tmp('legacy.json');
  const legacy = {
    version: 1,
    runs: {
      run_old: {
        id: 'run_old',
        mode: 'S2',
        requestedMode: 'S2',
        goal: '旧任务',
        status: 'done',
        createdAt: 1,
        updatedAt: 2,
        plan: { mode: 'S2', stages: ['plan', 'generate', 'review', 'verify'], budget: 250000, baseBudgetTokens: 50000, budgetX: 5 },
        stages: [
          { id: 's1', kind: 'plan', status: 'running' },
          { id: 's2', kind: 'generate', status: 'pending' },
        ],
        // 实际 plan 阶段有任务但 stage.status 停在 running/pending（历史 bug）
        tasks: [
          { id: 't1', kind: 'plan', status: 'done', tokensIn: 1, tokensOut: 1 },
          { id: 't2', kind: 'generate', status: 'done', tokensIn: 1, tokensOut: 1 },
        ],
        reviews: [],
        verdict: { final: 'PASS' },
        ledger: { runId: 'run_old', totalIn: 574, totalOut: 380, stages: {} },
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(legacy), 'utf8');
  const store = new RunStore({ file });
  const r = store.getRun('run_old');
  assert.equal(r.plan.costWeight, 5);
  assert.equal('budget' in r.plan, false);
  assert.equal('baseBudgetTokens' in r.plan, false);
  assert.ok(r.real && r.real.total === 0);
  const st = Object.fromEntries(r.stages.map((s) => [s.kind, s.status]));
  assert.equal(st.plan, 'done', '有 done 任务的阶段应派生为 done');
  assert.equal(st.generate, 'done');
  // summary.realSpent 存在且为 0（旧数据没有真实用量）
  assert.equal(store.summary(r).realSpent, 0);
  assert.equal(store.summary(r).spent, 954);
});

test('设置落地：模型白名单在 record 上报 model 时硬校验', () => {
  const svc = mkSvc();
  svc.updateSettings({ allowModels: ['providerA::m1'], forceTeam: 'off' });
  const runId = svc.start({ goal: '白名单', mode: 'S1' }).run.id;
  const bad = svc.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'x', model: 'providerB::m2' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /白名单/);
  const ok = svc.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'x', model: 'providerA::m1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.task.model, 'providerA::m1');
});

test('设置落地：评审必须不同厂商（仅当上报 model 时）', () => {
  const svc = mkSvc();
  svc.updateSettings({ requireDifferentVendor: true, forceTeam: 'off' });
  const runId = svc.start({ goal: '跨厂商', mode: 'S1' }).run.id;
  svc.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'x', model: 'p::gen' });
  const same = svc.record({ runId, stage: 'review', verdict: 'PASS', evidence: ['ok'], model: 'p::rev' });
  assert.equal(same.ok, false, '同厂商评审应被拒');
  assert.match(same.error, /同厂商/);
  const diff = svc.record({ runId, stage: 'review', verdict: 'PASS', evidence: ['ok'], model: 'q::rev' });
  assert.equal(diff.ok, true, '不同厂商评审放行');
});

test('未上报 model 时不做白名单/跨厂商拦截（保持向后兼容）', () => {
  const svc = mkSvc();
  svc.updateSettings({ allowModels: ['providerA::m1'], forceTeam: 'off' });
  const runId = svc.start({ goal: '兼容', mode: 'S1' }).run.id;
  const ok = svc.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'x' });
  assert.equal(ok.ok, true);
});

test('generatePlan 不再产出 budget 字段，costWeight 仍为档位权重', () => {
  const p = generatePlan('S2');
  assert.equal(p.costWeight, 5);
  assert.equal(p.budget, undefined);
  assert.equal(p.baseBudgetTokens, undefined);
});

test('团队手册：可按阶段声明 writeScopes，未声明时 generate 给出并行安全提示', () => {
  const p = generatePlan('S2');
  const gen0 = buildTeamPlaybook(p).steps.find((s) => s.kind === 'generate');
  assert.deepEqual(gen0.writeScopes, []);
  assert.ok(buildTeamPlaybook(p).rules.some((r) => r.includes('未声明 writeScopes')));
  const pb = buildTeamPlaybook(p, { writeScopes: { generate: ['src/a/**', 'src/b/**'] } });
  const gen1 = pb.steps.find((s) => s.kind === 'generate');
  assert.deepEqual(gen1.writeScopes, ['src/a/**', 'src/b/**']);
  assert.ok(!pb.rules.some((r) => r.includes('未声明 writeScopes')));
});
