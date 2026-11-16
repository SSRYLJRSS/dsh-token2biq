// 强制联动 × 团队不可用 的死锁回归：record 必须能完成，而不是永远要求 teamTaskId。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2b-ft-'));
  return new Token2bIQService({ stateFile: null, settingsFile: path.join(dir, 'settings.json') });
}

test('forceTeam=on + 官方团队不可用 → 自动降级，record 不被死锁', async () => {
  const svc = mk();
  svc.settings.update({ forceTeam: 'on', pipelineGate: 'off' });
  // 没有 ctxInfo.agentTeams：等价于官方「整体协同」关闭。
  const started = await svc.startWithAuto({ goal: '死锁回归', mode: 'S4' }, null);
  assert.equal(started.ok, true);
  assert.equal(started.forceTeam, false, '团队不可用时必须降级，不能继续强制');
  assert.ok(started.forceTeamDowngraded, '降级原因必须显式回传');
  const rec = svc.record({ runId: started.run.id, stage: 'plan', summary: '做完' });
  assert.equal(rec.ok, true, '降级后 record 必须能通过，否则就是死锁：' + JSON.stringify(rec));
});

test('forceTeam=on + 团队不可用时不再声称「强制联动已开启」', async () => {
  const svc = mk();
  svc.settings.update({ forceTeam: 'on', pipelineGate: 'off' });
  const started = await svc.startWithAuto({ goal: '文案回归', mode: 'S4' }, null);
  assert.ok(!/已开启强制联动：record 必须带/.test(started.next), '降级后仍宣称强制开启会误导 Lead');
  assert.ok(/自动降级/.test(started.next), '必须说明已降级');
});

test('老运行（无 forceTeam 字段）仍按设置+档位判定', async () => {
  const svc = mk();
  svc.settings.update({ forceTeam: 'on', pipelineGate: 'off' });
  const started = await svc.startWithAuto({ goal: '兼容', mode: 'S4' }, null);
  const run = svc.store.getRun(started.run.id);
  delete run.forceTeam; // 模拟修复前创建的运行
  const rec = svc.record({ runId: started.run.id, stage: 'plan', summary: 'x' });
  assert.equal(rec.ok, false, '无字段时应回退实时判定（forceTeam=on 且缺 teamTaskId → 拒收）');
  assert.ok(/强制联动已开启/.test(rec.error || ''), '回退路径的错误文案应保持原样');
});
