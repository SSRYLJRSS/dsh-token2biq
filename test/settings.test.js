import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeSettings, SettingsStore, parseModelRef } from '../lib/settings.js';
import { buildTeamPlaybook, generatePlan } from '../lib/orchestrator.js';
import { Token2bIQService } from '../lib/service.js';

test('parseModelRef: 解析 provider::model', () => {
  assert.deepEqual(parseModelRef('magpie::workbuddy/deepseek-v4.1-flash'), { provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash' });
  assert.equal(parseModelRef('bad'), null);
  assert.equal(parseModelRef(null), null);
  assert.equal(parseModelRef('::x'), null);
});

test('normalizeSettings: 默认值与夹取', () => {
  const s = normalizeSettings({});
  assert.equal(s.defaultMode, 'Auto');
  assert.equal(s.forceTeam, 'auto');
  assert.equal(s.requireDifferentVendor, true);
  assert.equal(s.maxReviewers, 2);
  assert.deepEqual(s.allowModels, []);
  assert.equal('baseBudgetTokens' in s, false); // 预算字段已移除
  const s2 = normalizeSettings({ defaultMode: 'S9', forceTeam: true, maxReviewers: 99 });
  assert.equal(s2.defaultMode, 'Auto');
  assert.equal(s2.forceTeam, 'on');
  assert.equal(s2.maxReviewers, 5);
});

test('normalizeSettings: roleModels 迁移进 rolePools，reviewModels 归一置空', () => {
  const s = normalizeSettings({
    roleModels: { review: 'a::b', generate: 'bad', judge: null },
    reviewModels: ['x::y', 'oops'],
    allowModels: ['m::n'],
  });
  assert.deepEqual(s.rolePools.review, ['x::y']); // I3：评审类优先用旧 reviewModels（排序）
  assert.equal(s.roleModels.review, 'x::y');       // 执行取池首项
  assert.equal(s.roleModels.generate, null);       // 非法引用被丢弃
  assert.deepEqual(s.reviewModels, []);            // 评审池统一清空
  assert.deepEqual(s.allowModels, ['m::n']);       // 白名单字段保留
});

test('SettingsStore: 落盘 + roleModels 浅合并', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-set-'));
  const file = path.join(dir, 'settings.json');
  const st = new SettingsStore({ file });
  st.update({ defaultMode: 'S2', roleModels: { review: 'a::b' } });
  st.update({ roleModels: { judge: 'c::d' } });
  const reload = new SettingsStore({ file });
  const v = reload.get();
  assert.equal(v.defaultMode, 'S2');
  assert.equal(v.roleModels.review, 'a::b');
  assert.equal(v.roleModels.judge, 'c::d');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildTeamPlaybook: 评审池轮转 + 白名单过滤', () => {
  const plan = generatePlan('S2'); // plan/generate/review/verify
  const pb = buildTeamPlaybook(plan, {
    roleModels: { generate: 'g::gen', review: 'r::own' },
    reviewModels: ['p1::m1', 'p2::m2'],
    maxReviewers: 2,
    allowModels: ['g::gen', 'p1::m1'],
    requireDifferentVendor: true,
  });
  const gen = pb.steps.find((s) => s.kind === 'generate');
  const rev = pb.steps.find((s) => s.kind === 'review');
  assert.equal(gen.model, 'g::gen');
  assert.equal(rev.model, 'p1::m1');
  assert.ok(pb.rules.some((r) => r.includes('不同厂商')));
  assert.deepEqual(pb.modelPlan.reviewModels, ['p1::m1', 'p2::m2']);
});

test('buildTeamPlaybook: 白名单外的 roleModel 退回默认', () => {
  const plan = generatePlan('S1');
  const pb = buildTeamPlaybook(plan, { roleModels: { generate: 'g::gen' }, allowModels: ['x::y'] });
  assert.equal(pb.steps.find((s) => s.kind === 'generate').model, null);
});

test('service.updateSettings: 档位/强制联动即时生效且可持久化', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-svc-'));
  const settingsFile = path.join(dir, 'settings.json');
  const svc = new Token2bIQService({ stateFile: null, settingsFile });
  assert.equal(svc.getSettings().forceTeam, 'auto');
  svc.updateSettings({ defaultMode: 'S1', forceTeam: true, roleModels: { review: 'a::b' } });
  assert.equal(svc.publicConfig().defaultMode, 'S1'); // 默认档位更新
  assert.equal(svc.getMode(), 'Auto');                // 但当前会话正在用的档位不被重置（修复点）
  assert.equal(svc.planFor('S1', 'x').costWeight, 2); // 无 budget 字段
  assert.equal(svc.planFor('S1', 'x').budget, undefined);
  // 持久化：重新构造可读到
  const svc2 = new Token2bIQService({ stateFile: null, settingsFile });
  assert.equal(svc2.getSettings().forceTeam, 'on');
  assert.equal(svc2.getSettings().roleModels.review, 'a::b');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizeSettings: maxReviewers 夹到 [1,5]（0/负数夹到 1，超上限夹到 5，缺省=2）', () => {
  assert.equal(normalizeSettings({ maxReviewers: 0 }).maxReviewers, 1);
  assert.equal(normalizeSettings({ maxReviewers: -3 }).maxReviewers, 1);
  assert.equal(normalizeSettings({ maxReviewers: 9 }).maxReviewers, 5);
  assert.equal(normalizeSettings({}).maxReviewers, 2);
});

test('normalizeSettings: parallelReviews 默认 3 / 0→1 / 9→5 / 非法→3', () => {
  assert.equal(normalizeSettings({}).parallelReviews, 3);
  assert.equal(normalizeSettings({ parallelReviews: 0 }).parallelReviews, 1);
  assert.equal(normalizeSettings({ parallelReviews: 9 }).parallelReviews, 5);
  assert.equal(normalizeSettings({ parallelReviews: 'abc' }).parallelReviews, 3);
  assert.equal(normalizeSettings({ parallelReviews: null }).parallelReviews, 3);
  assert.equal(normalizeSettings({ parallelReviews: 4 }).parallelReviews, 4);
});

test('normalizeSettings: 单代理角色 rolePools 多值截断为 1 个（首项），评审类保留多值', () => {
  const s = normalizeSettings({ rolePools: { generate: ['a::1', 'b::2', 'c::3'], review: ['a::1', 'b::2'] } });
  assert.deepEqual(s.rolePools.generate, ['a::1']);
  assert.equal(s.roleModels.generate, 'a::1');
  assert.deepEqual(s.rolePools.review, ['a::1', 'b::2']);
});

test('buildTeamPlaybook: 白名单外的模型被过滤时 push warning rule', () => {
  const plan = generatePlan('S2'); // 含 generate 阶段
  const pb = buildTeamPlaybook(plan, {
    roleModels: { generate: 'B::b' },
    allowModels: ['A::a'],
  });
  assert.equal(pb.steps.find((s) => s.kind === 'generate').model, null);
  assert.ok(pb.rules.some((r) => r.includes('白名单已过滤')), '应包含「白名单已过滤」warning');
});
