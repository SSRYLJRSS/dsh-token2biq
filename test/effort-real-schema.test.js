// 0.6.1：真实宿主目录字段（reasoning.supportedEfforts / defaultEffort）解析回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffort } from '../lib/orchestrator.js';

const REF = 'p::deepseek-v4.1-flash';
const meta = (reasoning) => ({ [REF]: { reasoning } });

test('真实宿主：S2/generate deepseek-v4.1-flash => high（supportedEfforts 生效，不再是 null）', () => {
  const modelMeta = meta({ supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high' });
  assert.equal(resolveEffort({ mode: 'S2', stage: 'generate', role: 'generate', modelRef: REF, modelMeta }), 'high');
});

test('真实宿主：xhigh 目标在 low/high/max 模型上按 EFFORT_ORDER 自动降为 high', () => {
  const modelMeta = meta({ supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high' });
  assert.equal(resolveEffort({ mode: 'S4', stage: 'plan', role: 'plan', modelRef: REF, modelMeta }), 'high');
  assert.equal(resolveEffort({ mode: 'S3', stage: 'judge', role: 'judge', modelRef: REF, modelMeta }), 'high');
});

test('真实宿主：仅 defaultEffort、无 supportedEfforts 的旧模型 => null（省略参数吃宿主默认）', () => {
  const modelMeta = meta({ defaultEffort: 'medium' });
  assert.equal(resolveEffort({ mode: 'S2', stage: 'generate', role: 'generate', modelRef: REF, modelMeta }), null);
});

test('兼容：旧字段 reasoning.efforts 仍可解析', () => {
  const modelMeta = meta({ efforts: ['low', 'high'] });
  assert.equal(resolveEffort({ mode: 'S2', stage: 'generate', role: 'generate', modelRef: REF, modelMeta }), 'high');
});

test('对象数组 supportedEfforts 也取 id', () => {
  const modelMeta = meta({ supportedEfforts: [{ id: 'low' }, { id: 'high' }] });
  assert.equal(resolveEffort({ mode: 'S2', stage: 'generate', role: 'generate', modelRef: REF, modelMeta }), 'high');
});
