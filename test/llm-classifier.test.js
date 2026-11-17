// P2-2：makeLlmClassifier 导出、去掉 magpie 硬编码回退、取不到默认模型时返回 null。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLlmClassifier } from '../lib/index.js';

function fakeCtx(sel, withLlm) {
  return {
    get(k) {
      if (k === 'agentDefaultModel') return sel === undefined ? null : { currentSelection: () => sel };
      if (k === 'llm') return withLlm ? { stream() { throw new Error('stream should not be called'); } } : null;
      return null;
    },
  };
}

test('makeLlmClassifier 已导出，且函数体不再包含 magpie 硬编码回退', () => {
  assert.equal(typeof makeLlmClassifier, 'function');
  assert.ok(!makeLlmClassifier.toString().includes('magpie'), '不得硬编码 magpie 回退');
});

test('agentDefaultModel 不可用 / 无 llm → 分类器返回 null（回退关键词）', async () => {
  const c1 = makeLlmClassifier(fakeCtx(null, true), () => {}, null);
  assert.equal(await c1('x'), null);
  const c2 = makeLlmClassifier(fakeCtx(undefined, true), () => {}, null);
  assert.equal(await c2('x'), null);
  const c3 = makeLlmClassifier(fakeCtx({ provider: 'p', model: 'm' }, false), () => {}, null);
  assert.equal(await c3('x'), null);
});
