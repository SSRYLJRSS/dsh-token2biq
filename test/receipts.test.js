import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateWorkerReceipt, validateReviewReceipt, validateVerifyReceipt, validateReceiptByStage,
} from '../lib/receipts.js';

test('worker 回执：合法', () => {
  const r = validateWorkerReceipt({ files: ['a.js'], diffSummary: '加了函数', status: 'done', testsRun: ['node --test'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.files, ['a.js']);
  assert.equal(r.value.testsRun[0].cmd, 'node --test');
});

test('worker 回执：缺 files / diffSummary 报错', () => {
  const r = validateWorkerReceipt({ files: [], status: 'done' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 2);
});

test('review 回执：FAIL 必须给 issues', () => {
  const bad = validateReviewReceipt({ verdict: 'FAIL', issues: [] });
  assert.equal(bad.ok, false);
  const good = validateReviewReceipt({ verdict: 'FAIL', issues: ['未覆盖边界'] });
  assert.equal(good.ok, true);
});

test('review 回执：PASS 合法', () => {
  const r = validateReviewReceipt({ verdict: 'pass', evidence: ['测试通过'] });
  assert.equal(r.ok, true);
  assert.equal(r.value.verdict, 'PASS');
});

test('verify 回执：FAIL 必须有证据', () => {
  assert.equal(validateVerifyReceipt({ verdict: 'FAIL', evidence: [] }).ok, false);
  assert.equal(validateVerifyReceipt({ verdict: 'PASS', evidence: ['make test 通过'] }).ok, true);
});

test('按阶段分派', () => {
  assert.equal(validateReceiptByStage('review', { verdict: 'PASS' }).ok, true);
  assert.equal(validateReceiptByStage('verify', { verdict: 'PASS' }).ok, true);
  assert.equal(validateReceiptByStage('generate', { files: ['x'], diffSummary: 'y' }).ok, true);
});

test('research/plan 免 files，但必须有文字结论', () => {
  assert.equal(validateReceiptByStage('research', { summary: '调研：三点风险' }).ok, true);
  assert.equal(validateReceiptByStage('plan', { diffSummary: '拆成 3 步' }).ok, true);
  assert.equal(validateReceiptByStage('research', { files: ['a.md'] }).ok, false);
});

test('judge/redteam 需 verdict，FAIL 需 issues，files 可选', () => {
  assert.equal(validateReceiptByStage('judge', { verdict: 'PASS' }).ok, true);
  assert.equal(validateReceiptByStage('redteam', { verdict: 'FAIL' }).ok, false);
  assert.equal(validateReceiptByStage('redteam', { verdict: 'FAIL', issues: ['x'] }).ok, true);
  assert.equal(validateReceiptByStage('judge', { verdict: 'FAIL', issues: ['y'], files: ['z'] }).ok, true);
});

