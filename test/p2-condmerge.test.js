// P2：条件合并 plan→spec（低复杂度 code 且已给 acceptance 时省略 plan）。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';

function mk() {
  const f = path.join(os.tmpdir(), 't2biq-merge-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const s = new Token2bIQService({ stateFile: null, settingsFile: f });
  s.updateSettings({ forceTeam: 'off' });
  return s;
}

test('P2 条件合并：code/simple + acceptance → 省略 plan，保留 generate 与验收', () => {
  const s = mk();
  const res = s.start({ goal: 'x', mode: 'S3', taskType: 'code', acceptance: '可交付', profile: { taskType: 'code', complexity: 'simple', risk: 'low' } });
  assert.ok(!res.plan.stages.includes('plan'), '已给 acceptance 时不应再有 plan');
  assert.ok(res.plan.stages.includes('generate'));
  assert.ok(res.plan.stages.includes('regression') || res.plan.stages.includes('verify'));
  assert.equal(res.plan.planMerged, true);
});

test('P2 条件合并：code/simple 但无 acceptance → 保留 plan（防 strict 无 spec 死锁）', () => {
  const s = mk();
  const res = s.start({ goal: 'x', mode: 'S3', taskType: 'code', profile: { taskType: 'code', complexity: 'simple', risk: 'low' } });
  assert.ok(res.plan.stages.includes('plan'), '无 spec 时必须保留 plan');
});

test('P2 条件合并：complex 不裁剪，plan 保留', () => {
  const s = mk();
  const res = s.start({ goal: 'x', mode: 'S3', taskType: 'code', acceptance: 'a', profile: { taskType: 'code', complexity: 'complex', risk: 'low' } });
  assert.ok(res.plan.stages.includes('plan'));
});
