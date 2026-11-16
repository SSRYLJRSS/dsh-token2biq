// 强制联动降级后的可观测性回归：playbook / run / runView 三处必须口径一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2b-ft2-'));
  return new Token2bIQService({ stateFile: null, settingsFile: path.join(dir, 'settings.json') });
}

test('降级后 playbook 不再要求建团队', async () => {
  const svc = mk();
  svc.settings.update({ forceTeam: 'on', pipelineGate: 'off' });
  const started = await svc.startWithAuto({ goal: 'x', mode: 'S4' }, null);
  assert.equal(started.playbook.requireTeam, false);
  assert.ok(!started.playbook.rules.some((r) => /强制联动|teamTaskId/.test(String(r))),
    'playbook.rules 里残留「必须建团队」会让模型收到互斥指令');
});

test('降级原因落到运行上，runView 可观测', async () => {
  const svc = mk();
  svc.settings.update({ forceTeam: 'on', pipelineGate: 'off' });
  const started = await svc.startWithAuto({ goal: 'x', mode: 'S4' }, null);
  const run = svc.store.getRun(started.run.id);
  assert.equal(run.degraded, 'no-team');
  assert.equal(run.forceTeam, false);
  const view = svc.runView(run);
  assert.equal(view.degraded, 'no-team', '面板/报告必须能查到为什么没建团');
  assert.equal(view.forceTeamActive, false);
});

test('record 拒收时不再回传自相矛盾的 forceTeam', () => {
  const svc = mk();
  svc.settings.update({ forceTeam: 'on', pipelineGate: 'off' });
  const s = svc.start({ goal: 'x', mode: 'S4' }); // 同步 start：intent=true
  const rec = svc.record({ runId: s.run.id, stage: 'plan', summary: 'x' });
  assert.equal(rec.ok, false);
  assert.equal(rec.forceTeam, 'on', 'forceTeam 回传实时设置（保持既有契约）');
  assert.equal(rec.runForceTeam, true, 'runForceTeam 回传本次运行快照，二者不一致时用户能看出「改设置只影响新运行」');
  assert.ok(/快照/.test(rec.hint || ''), 'hint 必须说明「改设置只影响新运行」');
});
test('modelRouting 必须拆出 provider/model（只给合并引用等于强模型没配上）', async () => {
  const svc = mk();
  svc.settings.update({
    strongModel: 'magpie-responses::gptmengluo/gpt-6-astra',
    normalModel: 'magpie::wps-lingxi/deepseek-v4.1-flash',
    forceTeam: 'auto', pipelineGate: 'off',
  });
  const agent = { id: 'agent_lead' };
  const ctx = { agent, agentTeams: { isEnabled: () => true, createTask: async () => ({ id: 'tt_1' }) }, subagents: { rootOf: () => agent } };
  const a = await svc.startWithAuto({ goal: 'p', mode: 'S4' }, ctx);
  const plan = a.created.modelRouting.find((m) => m.stage === 'plan');
  assert.equal(plan.provider, 'magpie-responses');
  assert.equal(plan.model, 'gptmengluo/gpt-6-astra');
  assert.equal(plan.ref, 'magpie-responses::gptmengluo/gpt-6-astra');
  assert.ok(String(a.next).includes('magpie-responses + gptmengluo/gpt-6-astra'), 'next 必须直接给出可用的 provider/model');
});
