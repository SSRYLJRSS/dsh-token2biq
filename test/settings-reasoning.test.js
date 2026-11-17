// 0.6.0：思考强度设置的数据模型 / 归一化 / 深合并。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEffort, normalizeReasoning, normalizeSettings, SettingsStore, DEFAULT_SETTINGS } from '../lib/settings.js';

test('normalizeEffort: 合法 id 小写保留，其余一律 auto', () => {
  assert.equal(normalizeEffort('auto'), 'auto');
  assert.equal(normalizeEffort('HIGH'), 'high');
  assert.equal(normalizeEffort('xhigh'), 'xhigh');
  assert.equal(normalizeEffort('  medium '), 'medium');
  assert.equal(normalizeEffort(''), 'auto');
  assert.equal(normalizeEffort('Auto'), 'auto');
  assert.equal(normalizeEffort('1bad'), 'auto');        // 不能以数字开头
  assert.equal(normalizeEffort('has space'), 'auto');
  assert.equal(normalizeEffort('x'.repeat(40)), 'auto'); // 超长
  assert.equal(normalizeEffort(123), 'auto');
  assert.equal(normalizeEffort(null), 'auto');
});

test('normalizeReasoning: default 全量；byRole 仅合法角色且非 auto；byModel 仅合法模型引用且非 auto', () => {
  const r = normalizeReasoning({
    default: 'HIGH',
    byRole: { generate: 'low', review: 'auto', bogus: 'high' },
    byModel: { 'a::b': 'max', 'bad-ref': 'high', 'c::d': 'auto' },
  });
  assert.equal(r.default, 'high');
  assert.deepEqual(r.byRole, { generate: 'low' }); // review=auto 被丢弃；bogus 非角色
  assert.deepEqual(r.byModel, { 'a::b': 'max' });  // 非法引用 + auto 被丢弃
});

test('normalizeReasoning: 非对象输入回退空配置', () => {
  assert.deepEqual(normalizeReasoning(undefined), { default: 'auto', byRole: {}, byModel: {} });
  assert.deepEqual(normalizeReasoning(null), { default: 'auto', byRole: {}, byModel: {} });
  assert.deepEqual(normalizeReasoning('x'), { default: 'auto', byRole: {}, byModel: {} });
});

test('normalizeSettings: 默认带 reasoning 且版本 3', () => {
  const s = normalizeSettings({});
  assert.equal(s.version, 3);
  assert.deepEqual(s.reasoning, { default: 'auto', byRole: {}, byModel: {} });
  assert.deepEqual(DEFAULT_SETTINGS.reasoning, { default: 'auto', byRole: {}, byModel: {} });
  const s2 = normalizeSettings({ reasoning: { default: 'high', byRole: { plan: 'high' }, byModel: { 'p::m': 'max' } } });
  assert.equal(s2.reasoning.default, 'high');
  assert.equal(s2.reasoning.byRole.plan, 'high');
  assert.equal(s2.reasoning.byModel['p::m'], 'max');
});

test('SettingsStore.update: reasoning 深合并（default 覆盖、byRole/byModel 浅合并且未提交键保留）', () => {
  const st = new SettingsStore({ file: null });
  st.update({ reasoning: { default: 'high', byRole: { generate: 'low' } } });
  st.update({ reasoning: { byRole: { review: 'medium' }, byModel: { 'a::b': 'max' } } });
  let r = st.get().reasoning;
  assert.equal(r.default, 'high');                                    // 未提交 default → 保留
  assert.deepEqual(r.byRole, { generate: 'low', review: 'medium' });  // 合并
  assert.deepEqual(r.byModel, { 'a::b': 'max' });
  // 只提交 default：byRole/byModel 不动
  st.update({ reasoning: { default: 'low' } });
  r = st.get().reasoning;
  assert.equal(r.default, 'low');
  assert.deepEqual(r.byRole, { generate: 'low', review: 'medium' });
  assert.deepEqual(r.byModel, { 'a::b': 'max' });
});

test('SettingsStore.update: reasoningReplace=true 整体替换（清除旧覆盖）且不落 reasoningReplace 字段', () => {
  const st = new SettingsStore({ file: null });
  st.update({ reasoning: { default: 'high', byRole: { generate: 'low' }, byModel: { 'a::b': 'max' } } });
  let r = st.get().reasoning;
  assert.deepEqual(r.byRole, { generate: 'low' });
  assert.deepEqual(r.byModel, { 'a::b': 'max' });
  // 整体替换：即便只提交空 byRole/byModel，也清除既有覆盖（面板保存语义）
  st.update({ reasoning: { default: 'auto', byRole: {}, byModel: {} }, reasoningReplace: true });
  r = st.get().reasoning;
  assert.deepEqual(r, { default: 'auto', byRole: {}, byModel: {} });
  assert.equal('reasoningReplace' in st.get(), false);
  // 普通深合并行为保留（非 reasoningReplace）
  st.update({ reasoning: { byRole: { plan: 'high' } } });
  assert.deepEqual(st.get().reasoning.byRole, { plan: 'high' });
});
