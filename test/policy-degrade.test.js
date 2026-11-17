// P1-3：锁定档位保留 MUST 先 start / 禁止单干，但去掉绝对化「禁止直接改文件」，补充降级执行口径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicy } from '../lib/orchestrator.js';

test('P1-3：lead 锁定档保留 MUST start + 禁止单干，去掉绝对禁改，并给出降级口径', () => {
  const p = buildPolicy('lead', { mode: 'S3' });
  assert.match(p, /MUST 先调用 token2biq action=start/);
  assert.match(p, /禁止单干/);
  assert.ok(!/禁止单干或直接改文件/.test(p), '不再绝对禁止直接改文件');
  assert.match(p, /no-orchestration/, '必须说明 degraded=no-orchestration 才可直接执行');
  assert.match(p, /降级原因/, '必须要求记录降级原因');
});

test('P1-3：teammate 明确 blocked/failed 停止、写 notes、等 lead', () => {
  const t = buildPolicy('teammate');
  assert.match(t, /blocked\/failed/);
  assert.match(t, /notes/);
  assert.match(t, /等 lead/);
});
