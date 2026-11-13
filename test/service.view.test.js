// 视图派生 + 删除动作测试（纯内存 store）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';

function mk() {
  const svc = new Token2bIQService({ settingsFile: path.join(os.tmpdir(), 't2biq-view-' + process.pid + '.json') });
  svc.updateSettings({ forceTeam: 'off' });
  return svc;
}

test('stage status 从任务派生：已记录阶段=done，未记录= pending', () => {
  const svc = mk();
  const { run } = svc.start({ goal: '视图派生测试：重构多文件架构', mode: 'S2' });
  svc.record({ runId: run.id, stage: 'generate', files: ['a.js'], diffSummary: 'ok', tokensIn: 10, tokensOut: 5 });
  const c = svc.state(run.id).current;
  const byKind = Object.fromEntries(c.stages.map((s) => [s.kind, s.status]));
  assert.equal(byKind.generate, 'done');
  assert.equal(byKind.plan, 'pending');
  assert.equal(byKind.review, 'pending');
  assert.ok(c.stages.find((s) => s.kind === 'generate').tasks.length === 1);
});

test('finish 后未开始阶段记为 skipped，已记录阶段为 done', () => {
  const svc = mk();
  const { run } = svc.start({ goal: '收尾阶段测试', mode: 'S1' });
  svc.record({ runId: run.id, stage: 'generate', files: ['x'], diffSummary: 'done' });
  svc.record({ runId: run.id, stage: 'review', verdict: 'PASS', evidence: ['ok'] });
  svc.finish({ runId: run.id, verdict: 'PASS', rationale: '完成' });
  const c = svc.state(run.id).current;
  const st = Object.fromEntries(c.stages.map((s) => [s.kind, s.status]));
  assert.equal(st.generate, 'done');
  assert.equal(st.review, 'done');
  assert.equal(st.verify, 'skipped'); // S1 有 verify 阶段但未记录 → skipped
  assert.equal(c.verdict.final, 'PASS');
});

test('runs summary 含 verdict 与 spent', () => {
  const svc = mk();
  const { run } = svc.start({ goal: '摘要测试', mode: 'S1' });
  svc.record({ runId: run.id, stage: 'generate', files: ['f'], diffSummary: 'd', tokensIn: 7, tokensOut: 3 });
  svc.finish({ runId: run.id, verdict: 'PASS' });
  const s = svc.state().runs[0];
  assert.equal(s.verdict, 'PASS');
  assert.equal(s.spent, 10);
});

test('delete 动作：删除已存在运行返回 ok，删除不存在返回错误', () => {
  const svc = mk();
  const { run } = svc.start({ goal: '删除测试', mode: 'S1' });
  assert.equal(svc.deleteRun(run.id).ok, true);
  assert.equal(svc.store.getRun(run.id), null);
  assert.equal(svc.deleteRun('nope').ok, false);
});
