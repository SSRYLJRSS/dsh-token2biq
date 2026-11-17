import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeSettings, SettingsStore, parseModelRef, DEFAULT_SETTINGS } from '../lib/settings.js';
import { buildTeamPlaybook, generatePlan } from '../lib/orchestrator.js';
import { Token2bIQService } from '../lib/service.js';

const ROLE_KEYS = ['research', 'plan', 'generate', 'review', 'judge', 'verify', 'redteam', 'regression'];

test('parseModelRef: 解析 provider::model', () => {
  assert.deepEqual(parseModelRef('magpie::workbuddy/deepseek-v4.1-flash'), { provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash' });
  assert.equal(parseModelRef('bad'), null);
  assert.equal(parseModelRef(null), null);
  assert.equal(parseModelRef('::x'), null);
});

test('normalizeSettings: version=3、8 个 rolePools key 与默认值', () => {
  const s = normalizeSettings({});
  assert.equal(s.version, 3);
  assert.equal(s.defaultMode, 'Auto');
  assert.equal(s.forceTeam, 'auto');
  assert.deepEqual(s.allowModels, []);
  assert.equal(s.parallelReviews, 3);
  assert.equal(s.pipelineGate, 'off');
  assert.equal(s.independentReview, false);
  assert.equal(s.tokenBudget, 0);
  assert.deepEqual(Object.keys(s.rolePools).sort(), ROLE_KEYS.slice().sort());
  for (const k of ROLE_KEYS) assert.deepEqual(s.rolePools[k], []);
  assert.equal('baseBudgetTokens' in s, false);
  assert.equal('strongModel' in s, false);
  assert.equal('normalModel' in s, false);
  assert.equal('reviewModels' in s, false);
  assert.equal('maxReviewers' in s, false);
  assert.equal('requireDifferentVendor' in s, false);
  const s2 = normalizeSettings({ defaultMode: 'S9', forceTeam: true });
  assert.equal(s2.defaultMode, 'Auto');
  assert.equal(s2.forceTeam, 'on');
});

test('normalizeSettings: legacy roleModels/reviewModels 迁移矩阵', () => {
  const s = normalizeSettings({
    roleModels: { review: 'a::b', generate: 'bad', judge: null },
    reviewModels: ['x::y', 'oops'],
    strongModel: 'ignored::strong',
    normalModel: 'ignored::normal',
    allowModels: ['m::n'],
  });
  assert.deepEqual(s.rolePools.review, ['x::y']);
  assert.deepEqual(s.rolePools.judge, ['x::y']);
  assert.deepEqual(s.rolePools.redteam, ['x::y']);
  assert.equal(s.roleModels.review, 'x::y');
  assert.equal(s.roleModels.generate, null);
  assert.deepEqual(s.allowModels, ['m::n']);
  assert.equal('reviewModels' in s, false);
  assert.equal('strongModel' in s, false);
  assert.equal('normalModel' in s, false);
});

test('normalizeSettings: 显式 rolePools 优先于旧值，含显式清空 []', () => {
  const s = normalizeSettings({ roleModels: { generate: 'g::gen', review: 'r::rev' }, rolePools: { generate: [], review: ['a::A', 'b::B'] } });
  assert.deepEqual(s.rolePools.generate, []);
  assert.deepEqual(s.rolePools.review, ['a::A', 'b::B']);
  assert.equal(s.roleModels.generate, null);
  assert.equal(s.roleModels.review, 'a::A');
});

test('SettingsStore: rolePools 落盘、roleModels 不持久化', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-set-'));
  const file = path.join(dir, 'settings.json');
  const st = new SettingsStore({ file });
  st.update({ defaultMode: 'S2', rolePools: { review: ['a::b', 'c::d'] } });
  st.update({ rolePools: { judge: ['j::x'] } });
  const reload = new SettingsStore({ file });
  const v = reload.get();
  assert.equal(v.defaultMode, 'S2');
  assert.deepEqual(v.rolePools.review, ['a::b', 'c::d']);
  assert.deepEqual(v.rolePools.judge, ['j::x']);
  assert.equal(v.roleModels.review, 'a::b');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal('roleModels' in raw, false);
  for (const key of ROLE_KEYS) assert.ok(key in raw.rolePools);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SettingsStore: 旧 roleModels 调用仍兼容，但写入后已转成 rolePools', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-set2-'));
  const file = path.join(dir, 'settings.json');
  const st = new SettingsStore({ file });
  st.update({ roleModels: { generate: 'p::one' } });
  assert.deepEqual(st.get().rolePools.generate, ['p::one']);
  st.update({ rolePools: { generate: [] } });
  assert.deepEqual(st.get().rolePools.generate, []);
  assert.equal(st.get().roleModels.generate, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizeSettings: 单代理角色截断 1 个，评审类保留最多 5 个', () => {
  const s = normalizeSettings({ rolePools: { generate: ['a::1', 'b::2', 'c::3'], review: ['a::1', 'b::2', 'c::3', 'd::4', 'e::5', 'f::6'] } });
  assert.deepEqual(s.rolePools.generate, ['a::1']);
  assert.equal(s.roleModels.generate, 'a::1');
  assert.deepEqual(s.rolePools.review, ['a::1', 'b::2', 'c::3', 'd::4', 'e::5']);
});

test('normalizeSettings: parallelReviews 默认 3 / 0→1 / 9→5 / 非法→3', () => {
  assert.equal(normalizeSettings({}).parallelReviews, 3);
  assert.equal(normalizeSettings({ parallelReviews: 0 }).parallelReviews, 1);
  assert.equal(normalizeSettings({ parallelReviews: 9 }).parallelReviews, 5);
  assert.equal(normalizeSettings({ parallelReviews: 'abc' }).parallelReviews, 3);
  assert.equal(normalizeSettings({ parallelReviews: null }).parallelReviews, 3);
  assert.equal(normalizeSettings({ parallelReviews: 4 }).parallelReviews, 4);
});

test('buildTeamPlaybook: 只用 rolePools，modelPlan 暴露 8 键 rolePools', () => {
  const plan = generatePlan('S2');
  const pb = buildTeamPlaybook(plan, {
    rolePools: { generate: ['g::gen'], review: ['p1::m1', 'p2::m2'] },
    allowModels: ['g::gen', 'p1::m1'],
    parallelReviews: 2,
  });
  assert.equal(pb.steps.find((s) => s.kind === 'generate').model, 'g::gen');
  assert.equal(pb.steps.find((s) => s.kind === 'review').model, 'p1::m1');
  assert.deepEqual(pb.modelPlan.rolePools.generate, ['g::gen']);
  assert.deepEqual(pb.modelPlan.rolePools.review, ['p1::m1', 'p2::m2']);
  assert.ok(!pb.rules.some((r) => r.includes('不同厂商')));
});

test('buildTeamPlaybook: 白名单外的 rolePool 模型退回默认并提示', () => {
  const plan = generatePlan('S2');
  const pb = buildTeamPlaybook(plan, { rolePools: { generate: ['B::b'] }, allowModels: ['A::a'] });
  assert.equal(pb.steps.find((s) => s.kind === 'generate').model, null);
  assert.ok(pb.rules.some((r) => r.includes('白名单已过滤')));
});

test('service.updateSettings: 档位/强制联动即时生效且 rolePools 可持久化', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-svc-'));
  const settingsFile = path.join(dir, 'settings.json');
  const svc = new Token2bIQService({ stateFile: null, settingsFile });
  assert.equal(svc.getSettings().forceTeam, 'auto');
  svc.updateSettings({ defaultMode: 'S1', forceTeam: true, rolePools: { review: ['a::b'] } });
  assert.equal(svc.publicConfig().defaultMode, 'S1');
  assert.equal(svc.getMode(), 'Auto');
  assert.equal(svc.planFor('S1', 'x').costWeight, 2);
  assert.equal(svc.planFor('S1', 'x').budget, undefined);
  const svc2 = new Token2bIQService({ stateFile: null, settingsFile });
  assert.equal(svc2.getSettings().forceTeam, 'on');
  assert.deepEqual(svc2.getSettings().rolePools.review, ['a::b']);
  assert.equal(svc2.getSettings().roleModels.review, 'a::b');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DEFAULT_SETTINGS: version=3 且不再含旧字段', () => {
  assert.equal(DEFAULT_SETTINGS.version, 3);
  for (const key of ROLE_KEYS) assert.ok(key in DEFAULT_SETTINGS.rolePools);
  for (const key of ['strongModel', 'normalModel', 'reviewModels', 'maxReviewers', 'requireDifferentVendor']) assert.equal(key in DEFAULT_SETTINGS, false);
});
