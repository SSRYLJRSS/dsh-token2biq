// 0.6.0：服务层提示词瘦身（_spawnPrompt ≤400 / _stageDescription ≤500）与回执瘦身契约。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';

function mk() {
  const file = path.join(os.tmpdir(), 't2biq-thin-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const svc = new Token2bIQService({ stateFile: null, settingsFile: file });
  svc.updateSettings({ forceTeam: 'off' });
  return { svc, file };
}

test('_spawnPrompt ≤400 字符且含 taskId/revision/claim 流程', () => {
  const { svc, file } = mk();
  try {
    const run = svc.start({ goal: '把用户列表分页改成游标分页并补测试，涉及多文件', mode: 'S3' }).run;
    const prompt = svc._spawnPrompt(run, { stage: 'generate', role: 'worker', subject: 'g', doneWhen: '产出改动文件 + diffSummary + 测试结果' }, 'task-42', 2);
    assert.ok(prompt.length <= 400, '实际 ' + prompt.length);
    assert.ok(prompt.includes('task-42'));
    assert.ok(prompt.includes('revision=2'));
    assert.match(prompt, /claim → 执行 → team_task_update complete/);
  } finally { fs.rmSync(file, { force: true }); }
});

test('_stageDescription ≤500 字符且含 revision/流程/回执', () => {
  const { svc, file } = mk();
  try {
    const run = svc.start({ goal: '把用户列表分页改成游标分页并补测试，涉及多文件', mode: 'S3' }).run;
    const desc = svc._stageDescription(run, { stage: 'generate', role: 'worker', doneWhen: '产出改动', writeScopes: ['lib/a.js'] }, 5);
    assert.ok(desc.length <= 500, '实际 ' + desc.length);
    assert.ok(desc.includes('revision=5'));
    assert.ok(desc.includes('claim → 执行 → team_task_update complete'));
    assert.ok(desc.includes('不要 send_message'));
  } finally { fs.rmSync(file, { force: true }); }
});

test('record 返回 task 仅含精简键（id/kind/role/status/stage/verdict/tokens/teamTaskId/owner/model）', () => {
  const { svc, file } = mk();
  try {
    const runId = svc.start({ goal: 'x', mode: 'S2' }).run.id;
    const r = svc.record({ runId, stage: 'generate', files: ['a.js'], diffSummary: 'ok', tokensIn: 10, tokensOut: 5, teamTaskId: 'tt_1', owner: 'w1' });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.task).sort(),
      ['id', 'kind', 'model', 'owner', 'role', 'stage', 'status', 'teamTaskId', 'tokens', 'verdict'].sort());
  } finally { fs.rmSync(file, { force: true }); }
});
