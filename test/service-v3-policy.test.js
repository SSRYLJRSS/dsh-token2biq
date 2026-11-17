// Production V3：service 不再做跨厂商校验，保留白名单与独立评委校验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';

function svc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-v3svc-'));
  return { dir, s: new Token2bIQService({ stateFile: null, settingsFile: path.join(dir, 'settings.json') }) };
}

test('V3：同 provider 评审允许，service 不再返回 modelRoutingWarning', () => {
  const { dir, s } = svc();
  try {
    s.updateSettings({ forceTeam: 'off', allowModels: ['p::gen', 'p::rev', 'q::rev'] });
    const start = s.start({ goal: 'x', mode: 'S2' });
    assert.equal('modelRoutingWarning' in start, false);
    const runId = start.run.id;
    assert.equal(s.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'x', model: 'p::gen' }).ok, true);
    assert.equal(s.record({ runId, stage: 'review', verdict: 'PASS', evidence: ['ok'], model: 'p::rev' }).ok, true);
    assert.equal(s.record({ runId, stage: 'review', verdict: 'PASS', evidence: ['ok'], model: 'q::rev' }).ok, true);
    assert.equal('modelRoutingWarning' in s.runView(s.store.getRun(runId)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('V3：allowModels 白名单仍然硬校验', () => {
  const { dir, s } = svc();
  try {
    s.updateSettings({ forceTeam: 'off', allowModels: ['p::gen'] });
    const runId = s.start({ goal: 'x', mode: 'S2' }).run.id;
    const bad = s.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'x', model: 'q::bad' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /白名单/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('V3：independentReview 仍要求独立 owner，执行者不能自评', () => {
  const { dir, s } = svc();
  try {
    s.updateSettings({ forceTeam: 'off', independentReview: true });
    const runId = s.start({ goal: 'x', mode: 'S2' }).run.id;
    s.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'x', owner: 'worker-1' });
    const self = s.record({ runId, stage: 'review', verdict: 'PASS', evidence: ['ok'], owner: 'worker-1' });
    assert.equal(self.ok, false);
    assert.match(self.error, /独立评委/);
    const independent = s.record({ runId, stage: 'review', verdict: 'PASS', evidence: ['ok'], owner: 'reviewer-1' });
    assert.equal(independent.ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('V3：旧 requireDifferentVendor 输入被忽略，不再拦截同厂商', () => {
  const { dir, s } = svc();
  try {
    s.updateSettings({ forceTeam: 'off', requireDifferentVendor: true });
    assert.equal('requireDifferentVendor' in s.getSettings(), false);
    const runId = s.start({ goal: 'x', mode: 'S1' }).run.id;
    s.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'x', model: 'p::gen' });
    const r = s.record({ runId, stage: 'review', verdict: 'PASS', evidence: ['ok'], model: 'p::rev' });
    assert.equal(r.ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
