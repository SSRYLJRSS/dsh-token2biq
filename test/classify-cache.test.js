// P1：分类结果缓存（按 goal），避免同一目标重复触发 LLM 画像。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';

function mk() {
  const f = path.join(os.tmpdir(), 't2biq-cache-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const s = new Token2bIQService({ stateFile: null, settingsFile: f });
  s.updateSettings({ forceTeam: 'off' });
  return s;
}

test('分类缓存：同一目标只调用一次 classifier', async () => {
  const s = mk();
  let calls = 0;
  s.classifier = async () => { calls += 1; return { tier: 'S3', taskType: 'code', complexity: 'medium', risk: 'low', worthTeam: true }; };
  await s.startWithAuto({ goal: '实现一个登录功能', mode: 'S3' }, {});
  await s.startWithAuto({ goal: '实现一个登录功能', mode: 'S3' }, {});
  assert.equal(calls, 1, '同一目标第二次应命中缓存');
});

test('分类缓存：无有效信息的结果不缓存（允许重试）', async () => {
  const s = mk();
  let calls = 0;
  s.classifier = async () => { calls += 1; return { tier: null, taskType: null, complexity: null, risk: null, reason: '无' }; };
  await s.startWithAuto({ goal: '实现X', mode: 'S3' }, {});
  await s.startWithAuto({ goal: '实现X', mode: 'S3' }, {});
  assert.equal(calls, 2, '无有效 tier/画像 不应缓存');
});

test('分类缓存：updateSettings 清空缓存', async () => {
  const s = mk();
  let calls = 0;
  s.classifier = async () => { calls += 1; return { tier: 'S3', taskType: 'code', complexity: 'medium', risk: 'low' }; };
  await s.startWithAuto({ goal: '实现Y', mode: 'S3' }, {});
  await s.startWithAuto({ goal: '实现Y', mode: 'S3' }, {});
  assert.equal(calls, 1);
  s.updateSettings({ forceTeam: 'off' });
  await s.startWithAuto({ goal: '实现Y', mode: 'S3' }, {});
  assert.equal(calls, 2, 'updateSettings 后缓存应失效');
});

test('分类缓存：空结果不缓存，允许重试', async () => {
  const s = mk();
  let calls = 0;
  s.classifier = async () => { calls += 1; return calls === 1 ? null : { tier: 'S3', taskType: 'code', complexity: 'simple', risk: 'low' }; };
  await s.startWithAuto({ goal: '实现X', mode: 'S3' }, {});
  await s.startWithAuto({ goal: '实现X', mode: 'S3' }, {});
  assert.equal(calls, 2, 'null 不应被缓存，第二次应重新调用');
});
