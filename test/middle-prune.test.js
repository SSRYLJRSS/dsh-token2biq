// 0.6.1：compactToolResult 非 JSON/数组分支的中段截断（middlePrune）回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactToolResult } from '../lib/index.js';

const MARK = '...[middle pruned]...';

test('middlePrune：非 JSON 且 >8192 → head4096 + marker21 + tail1024 = 5141', () => {
  const long = 'a'.repeat(9000);
  const out = compactToolResult(long);
  assert.equal(MARK.length, 21);
  assert.equal(out.length, 4096 + MARK.length + 1024);
  assert.equal(out.length, 5141);
  assert.ok(out.includes(MARK));
});

test('middlePrune：非 JSON 但 ≤8192 → 原样返回（JSON 字符串）', () => {
  const short = 'b'.repeat(100);
  assert.equal(compactToolResult(short), JSON.stringify(short));
});

test('middlePrune：数组（非对象）超限也走中段截断', () => {
  const arr = new Array(2000).fill('x'.repeat(8));
  assert.ok(JSON.stringify(arr).length > 8192);
  const out = compactToolResult(arr);
  assert.equal(out.length, 5141);
  assert.ok(out.includes(MARK));
});
