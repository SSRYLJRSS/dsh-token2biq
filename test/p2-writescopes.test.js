// P2：writeScopes 暴露——调用方可按阶段声明写域，透传到 playbook.steps（并行 fanout 安全基础）。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';

function mk() {
  const f = path.join(os.tmpdir(), 't2biq-ws-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const s = new Token2bIQService({ stateFile: null, settingsFile: f });
  s.updateSettings({ forceTeam: 'off' });
  return s;
}

test('P2 writeScopes：per-stage 写域透传到 playbook.steps', () => {
  const s = mk();
  const res = s.start({ goal: 'x', mode: 'S3', taskType: 'code', acceptance: 'a', writeScopes: { generate: ['src/a.js', 'src/b.js'] } });
  const g = res.playbook.steps.find((st) => st.kind === 'generate');
  assert.ok(g, '应有 generate 步骤');
  assert.deepEqual(g.writeScopes, ['src/a.js', 'src/b.js']);
});

test('P2 writeScopes：非法值被忽略（回退为数组默认）', () => {
  const s = mk();
  const res = s.start({ goal: 'x', mode: 'S3', taskType: 'code', acceptance: 'a', writeScopes: { generate: 'not-array' } });
  const g = res.playbook.steps.find((st) => st.kind === 'generate');
  assert.ok(Array.isArray(g.writeScopes), 'writeScopes 必须仍是数组');
});
