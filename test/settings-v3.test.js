// Production V3：单配置文件模型设置的数据模型 / 迁移 / 持久化清洗。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeSettings, SettingsStore, emptyRolePools, DEFAULT_SETTINGS } from '../lib/settings.js';

const KEYS = ['research', 'plan', 'generate', 'review', 'judge', 'verify', 'redteam', 'regression'];

test('V3 默认值：version=3、rolePools 八键、旧字段全部不存在', () => {
  const s = normalizeSettings({});
  assert.equal(s.version, 3);
  assert.deepEqual(Object.keys(s.rolePools).sort(), KEYS.slice().sort());
  for (const k of KEYS) assert.deepEqual(s.rolePools[k], []);
  for (const legacy of ['strongModel', 'normalModel', 'reviewModels', 'maxReviewers', 'requireDifferentVendor']) assert.equal(legacy in s, false);
  assert.equal(s.defaultMode, 'Auto');
  assert.equal(s.forceTeam, 'auto');
  assert.equal(s.parallelReviews, 3);
  assert.equal(s.pipelineGate, 'off');
  assert.equal(s.independentReview, false);
  assert.equal(s.autoProvision, true);
  assert.equal(s.provisionProfile, null);
  assert.deepEqual(DEFAULT_SETTINGS.rolePools, emptyRolePools());
});

test('V3 迁移：显式 rolePools 优先，显式空 [] 不被旧值复活', () => {
  const s = normalizeSettings({
    rolePools: { review: [], generate: [] },
    roleModels: { review: 'r::old', generate: 'g::old', plan: 'p::one' },
    reviewModels: ['x::1', 'x::2'],
  });
  assert.deepEqual(s.rolePools.review, []);
  assert.deepEqual(s.rolePools.generate, []);
  assert.deepEqual(s.rolePools.plan, ['p::one'], '无显式池的非评审角色仍从旧 roleModels 迁移');
  assert.deepEqual(s.rolePools.judge, ['x::1', 'x::2'], '无显式池的评审角色走 reviewModels');
  assert.equal(s.roleModels.review, null);
});

test('V3 迁移：旧 reviewModels 排序且最多 5 个；单代理角色最多 1 个', () => {
  const s = normalizeSettings({
    roleModels: { generate: 'g::1', plan: 'p::1' },
    reviewModels: ['z::9', 'a::1', 'm::5', 'b::2', 'c::3', 'd::4'],
  });
  assert.deepEqual(s.rolePools.review, ['a::1', 'b::2', 'c::3', 'd::4', 'm::5']);
  assert.deepEqual(s.rolePools.judge, ['a::1', 'b::2', 'c::3', 'd::4', 'm::5']);
  assert.deepEqual(s.rolePools.redteam, ['a::1', 'b::2', 'c::3', 'd::4', 'm::5']);
  assert.deepEqual(s.rolePools.generate, ['g::1']);
  assert.deepEqual(s.rolePools.plan, ['p::1']);
});

test('V3 持久化：写盘只有 §2.1 字段，roleModels 不落盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-v3-'));
  const file = path.join(dir, 'settings.json');
  try {
    const store = new SettingsStore({ file });
    store.update({
      rolePools: { review: ['a::A', 'b::B'], generate: ['c::C'] },
      defaultMode: 'S3',
      forceTeam: 'on',
      parallelReviews: 4,
      pipelineGate: 'strict',
      independentReview: true,
      tokenBudget: 1234,
      allowModels: ['a::A'],
      autoProvision: false,
      provisionProfile: 'work',
    });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.version, 3);
    assert.equal('roleModels' in raw, false);
    assert.deepEqual(raw.rolePools.review, ['a::A', 'b::B']);
    assert.equal(raw.defaultMode, 'S3');
    assert.equal(raw.forceTeam, 'on');
    assert.equal(raw.parallelReviews, 4);
    assert.equal(raw.pipelineGate, 'strict');
    assert.equal(raw.independentReview, true);
    assert.equal(raw.tokenBudget, 1234);
    assert.deepEqual(raw.allowModels, ['a::A']);
    assert.equal(raw.autoProvision, false);
    assert.equal(raw.provisionProfile, 'work');
    const reload = new SettingsStore({ file });
    assert.deepEqual(reload.get().rolePools.review, ['a::A', 'b::B']);
    assert.equal(reload.get().roleModels.review, 'a::A');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('V3 update：rolePools 局部更新保留其他角色，roleModels 派生正确', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-v3b-'));
  const file = path.join(dir, 'settings.json');
  try {
    const store = new SettingsStore({ file });
    store.update({ rolePools: { review: ['a::A', 'b::B'] } });
    store.update({ rolePools: { judge: ['j::J'], review: [] } });
    const s = store.get();
    assert.deepEqual(s.rolePools.review, []);
    assert.deepEqual(s.rolePools.judge, ['j::J']);
    assert.equal(s.roleModels.review, null);
    assert.equal(s.roleModels.judge, 'j::J');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('V3 emptyRolePools 每次返回独立数组', () => {
  const a = emptyRolePools();
  const b = emptyRolePools();
  a.review.push('x::y');
  assert.deepEqual(b.review, []);
  assert.deepEqual(emptyRolePools().review, []);
});
