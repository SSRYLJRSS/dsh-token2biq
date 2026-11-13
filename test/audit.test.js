// 第五轮审查的回归测试：listRuns 上限、分类调用不污染实时 token、map 带上设置。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { RunStore } from '../lib/run-store.js';
import { Token2bIQService } from '../lib/service.js';
import { generatePlan } from '../lib/orchestrator.js';

function tmp(name) {
  return path.join(os.tmpdir(), `t2biq-audit-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
function mkService() {
  return new Token2bIQService({ stateFile: tmp('state.json'), settingsFile: tmp('settings.json') });
}

test('listRuns(limit) 只返回最近的 N 条摘要', () => {
  const store = new RunStore({ file: tmp('runs.json') });
  for (let i = 0; i < 3; i++) store.createRun({ goal: 'g' + i, plan: generatePlan('S1', { goal: 'g' + i }), mode: 'S1' });
  assert.equal(store.listRuns().length, 3);
  assert.equal(store.listRuns(2).length, 2);
  assert.equal(store.listRuns(40).length, 3);
});

test('分类调用期间的 usage 不计入实时 token', () => {
  const svc = mkService();
  svc._classifying = 1;
  svc.noteUsage({ totalTokens: 100, inputTokens: 60, outputTokens: 40 }, 's1');
  assert.equal(svc.live.total, 0, '分类中应忽略');
  svc._classifying = 0;
  svc.noteUsage({ totalTokens: 100, inputTokens: 60, outputTokens: 40 }, 's1');
  assert.equal(svc.live.total, 100, '分类结束应正常累计');
});

test('action=map 把设置（roleModels/forceTeam）带进团队手册', () => {
  const svc = mkService();
  svc.updateSettings({ roleModels: { generate: 'magpie::workbuddy/deepseek-v4.1-flash' }, forceTeam: 'on' });
  const r = svc.handleTool({ action: 'map', mode: 'S2' });
  assert.equal(r.ok, true);
  assert.equal(r.playbook.modelPlan.roleModels.generate, 'magpie::workbuddy/deepseek-v4.1-flash');
  assert.equal(r.playbook.requireTeam, true);
});
