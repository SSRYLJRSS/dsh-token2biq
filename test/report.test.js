// P2-1：report 对 stages/tasks/ledger/reviews/plan/events 缺失做占位兜底，不抛。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../lib/report.js';

test('buildReport：最小/缺失对象不抛，返回字符串', () => {
  for (const input of [undefined, null, {}, { id: 'run_x' }, { id: 'run_x', plan: {}, ledger: {} }, { id: 'run_x', tasks: [], stages: [], reviews: [], events: [] }]) {
    let s;
    assert.doesNotThrow(() => { s = buildReport(input); });
    assert.equal(typeof s, 'string');
  }
});

test('buildReport：半成品（有任务但缺 ledger.stages/plan.stages）也能出报告', () => {
  const s = buildReport({
    id: 'r1', mode: 'S2', status: 'running', plan: {}, ledger: {},
    stages: [{ kind: 'generate', status: 'done' }],
    tasks: [{ kind: 'generate', role: 'worker', status: 'done', receipt: { diffSummary: 'x', files: ['a.js'] }, tokensIn: 1, tokensOut: 1 }],
  });
  assert.match(s, /Token 2b IQ 报告/);
  assert.match(s, /generate/);
  assert.match(s, /合计/);
});

test('buildReport：事件缺 kind 渲染占位 event，不出现 undefined', () => {
  const s = buildReport({ id: 'r2', events: [{ ts: Date.now(), status: 'done' }] });
  assert.match(s, /\*\*event\*\*/);
  assert.ok(!s.includes('undefined'), '不得渲染 undefined');
});
