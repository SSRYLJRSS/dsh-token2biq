// 0.6.1：_spawnPrompt 稳定前缀（宿主 prompt 缓存）+ 长度上限回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';

function mk() {
  const f = path.join(os.tmpdir(), 't2biq-cache-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const svc = new Token2bIQService({ stateFile: null, settingsFile: f });
  svc.updateSettings({ forceTeam: 'off' });
  return svc;
}
const role = { stage: 'generate', role: 'worker', subject: 'g', doneWhen: '产出改动文件 + diffSummary + 测试结果' };
const SEP = '\n---\n';

test('_spawnPrompt：同角色不同 goal/taskId，static 前缀逐字节一致，动态尾部不同', () => {
  const svc = mk();
  const run1 = svc.start({ goal: '任务甲：把列表分页改成游标分页', mode: 'S3' }).run;
  const run2 = svc.start({ goal: '任务乙：修一个跨文件 bug 并补测试', mode: 'S3' }).run;
  const p1 = svc._spawnPrompt(run1, role, 'task-1', 1);
  const p2 = svc._spawnPrompt(run2, role, 'task-2', 3);
  assert.ok(p1.includes(SEP) && p2.includes(SEP), '必须含 --- 分隔');
  const pre1 = p1.slice(0, p1.indexOf(SEP));
  const pre2 = p2.slice(0, p2.indexOf(SEP));
  assert.equal(pre1, pre2, 'static 前缀必须逐字节一致');
  assert.notEqual(p1.slice(p1.indexOf(SEP)), p2.slice(p2.indexOf(SEP)), '动态尾部必须不同');
  assert.ok(p1.includes('task-1') && p2.includes('task-2'));
});

test('_spawnPrompt ≤400 且含 taskId/revision/claim/回执约束；_stageDescription ≤500', () => {
  const svc = mk();
  const run = svc.start({ goal: '把用户列表分页改成游标分页并补测试，涉及多文件', mode: 'S3' }).run;
  const prompt = svc._spawnPrompt(run, role, 'task-42', 2);
  assert.ok(prompt.length <= 400, 'spawnPrompt 实际 ' + prompt.length);
  assert.ok(prompt.includes('task-42') && prompt.includes('revision=2'));
  assert.match(prompt, /claim → 执行 → team_task_update complete/);
  assert.ok(prompt.includes('不要 send_message'));
  const desc = svc._stageDescription(run, { stage: 'generate', role: 'worker', doneWhen: '产出改动', writeScopes: ['lib/a.js'] }, 5);
  assert.ok(desc.length <= 500, 'stageDescription 实际 ' + desc.length);
  assert.ok(desc.includes('revision=5'));
  assert.ok(desc.includes('不要 send_message'));
});

// P1-4：最坏输入下四要素齐全且仍 ≤400；stageDescription 六段齐全且 ≤500。
test('P1-4：spawnPrompt 最坏输入 ≤400 且 writeScopes/doneWhen/回执/阻塞停止四要素齐全', () => {
  const svc = mk();
  const longGoal = '目标'.repeat(200);
  const run = { id: 'run_x', goal: longGoal, stages: [{ kind: 'generate' }] };
  const r = {
    stage: 'generate', role: 'worker',
    doneWhen: '产出改动文件 + diffSummary + 完整测试结果 + 覆盖边界',
    writeScopes: ['src/a/**', 'src/b/**', 'src/c/**', 'src/d/**', 'docs/**'],
  };
  const p = svc._spawnPrompt(run, r, 'task-' + 'x'.repeat(80), 1234567);
  assert.ok(p.length <= 400, 'spawnPrompt 实际 ' + p.length);
  assert.match(p, /写域 src\/a/, 'writeScopes 必须出现');
  assert.match(p, /产出改动文件/, 'doneWhen 必须出现');
  assert.match(p, /回执 \{stage,files,diffSummary,verdict,issues\}/, '回执 JSON 字段必须出现');
  assert.match(p, /blocked\/failed 停止/, 'blocked/failed 停止条件必须出现');
});

test('P1-4：stageDescription 覆盖 任务/目标/写域/判据/流程/回执 且 ≤500', () => {
  const svc = mk();
  const run = { id: 'run_y', goal: '重构' };
  const desc = svc._stageDescription(run, { stage: 'generate', role: 'worker', doneWhen: '产出改动', writeScopes: ['src/a/**'] }, 5);
  assert.ok(desc.length <= 500);
  for (const k of ['任务：', '目标：', '写域：', '判据：', '流程：', '回执：']) assert.ok(desc.includes(k), '缺少 ' + k);
});
