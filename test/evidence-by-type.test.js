// P1：按类型证据矩阵——调查类 verify 用 evidence（引用核对），代码类仍必须 testsRun。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';

function mk() {
  const f = path.join(os.tmpdir(), 't2biq-evt-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const s = new Token2bIQService({ stateFile: null, settingsFile: f });
  s.updateSettings({ forceTeam: 'off', pipelineGate: 'strict' });
  return s;
}

test('按类型证据：调查类 strict 用 evidence（引用核对）可通过 verify 且能 finish(PASS)', () => {
  const s = mk();
  const st = s.start({ goal: '调查并回顾一段历史对话记录', mode: 'S2', taskType: 'investigation' });
  assert.equal(st.ok, true);
  const runId = st.run.id;
  assert.ok(!st.plan.stages.includes('generate'));
  assert.equal(s.record({ runId, stage: 'research', status: 'done', summary: '调研完成' }).ok, true);
  assert.equal(s.record({ runId, stage: 'synth', status: 'done', files: ['report.md'], diffSummary: '报告成稿' }).ok, true);
  assert.equal(s.record({ runId, stage: 'review', status: 'done', verdict: 'PASS', owner: 'rev-1' }).ok, true);
  const vf = s.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS', evidence: ['来源A：https://example.com', '核对：结论与来源一致'] });
  assert.equal(vf.ok, true, '调查类应允许 evidence 代替 testsRun：' + (vf.error || ''));
  const f = s.finish({ runId, verdict: 'PASS', rationale: '引用核对通过' });
  assert.equal(f.ok, true, '调查类 evidence 应可 finish：' + (f.error || ''));
});

test('按类型证据：代码类 strict 仍必须 testsRun，evidence 不能替代', () => {
  const s = mk();
  const st = s.start({ goal: '实现登录并修复重试 bug', mode: 'S2', taskType: 'code', acceptance: '可交付' });
  const runId = st.run.id;
  assert.equal(s.record({ runId, stage: 'plan', status: 'done', summary: '验收：可交付', acceptance: '有产物' }).ok, true);
  assert.equal(s.record({ runId, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'impl' }).ok, true);
  assert.equal(s.record({ runId, stage: 'review', status: 'done', verdict: 'PASS', owner: 'rev-1' }).ok, true);
  const vf = s.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS', evidence: ['只是引用'] });
  assert.equal(vf.ok, false, '代码类 verify 缺 testsRun 应被拒');
  const vf2 = s.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: [{ cmd: 'node --test', ok: true }] });
  assert.equal(vf2.ok, true);
  const f = s.finish({ runId, verdict: 'PASS', rationale: '测试通过' });
  assert.equal(f.ok, true);
});

test('按类型证据：调查类 verify 既无 evidence 也无 testsRun 仍被拒', () => {
  const s = mk();
  const st = s.start({ goal: '调查并回顾一段历史对话记录', mode: 'S2', taskType: 'investigation' });
  const runId = st.run.id;
  assert.equal(s.record({ runId, stage: 'research', status: 'done', summary: 'ok' }).ok, true);
  assert.equal(s.record({ runId, stage: 'synth', status: 'done', files: ['r.md'], diffSummary: '稿' }).ok, true);
  assert.equal(s.record({ runId, stage: 'review', status: 'done', verdict: 'PASS', owner: 'rev-1' }).ok, true);
  const vf = s.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS' });
  assert.equal(vf.ok, false, '调查类 verify 无 evidence 无 testsRun 应被拒');
});
