// 第一期：rolePools 角色池设置 + S4「完整加强」档位。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSettings, SettingsStore } from '../lib/settings.js';
import os from 'node:os';
import { PLANS, MODE_META } from '../lib/orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('normalizeSettings: roleModels 单值迁移进 rolePools，roleModels=首项', () => {
  const s = normalizeSettings({ roleModels: { generate: 'g::gen', review: 'r::rev' } });
  assert.deepEqual(s.rolePools.generate, ['g::gen']);
  assert.deepEqual(s.rolePools.review, ['r::rev']);
  assert.equal(s.roleModels.generate, 'g::gen');
});

test('normalizeSettings: rolePools 多值保留，roleModels[k] 取池首项', () => {
  const s = normalizeSettings({ rolePools: { review: ['a::1', 'b::2', 'c::3'], generate: ['g::gen'] } });
  assert.deepEqual(s.rolePools.review, ['a::1', 'b::2', 'c::3']);
  assert.equal(s.roleModels.review, 'a::1');
  assert.equal(s.roleModels.generate, 'g::gen');
});

test('normalizeSettings: allowModels 默认 []，reviewModels 归一置空', () => {
  const s = normalizeSettings({});
  assert.deepEqual(s.allowModels, []);
  assert.deepEqual(s.reviewModels, []);
});

test('旧 reviewModels 迁移进评审类角色池（排序后），roleModels=首项', () => {
  const s = normalizeSettings({ reviewModels: ['p::2', 'p::1'] });
  assert.deepEqual(s.rolePools.review, ['p::1', 'p::2']);
  assert.deepEqual(s.rolePools.judge, ['p::1', 'p::2']);
  assert.deepEqual(s.rolePools.redteam, ['p::1', 'p::2']);
  assert.equal(s.roleModels.review, 'p::1');
});

test('S4 档位定义：PLANS.S4 含 review/judge/redteam，MODE_META.S4=完整加强', () => {
  assert.ok(PLANS.S4, '缺少 PLANS.S4');
  for (const st of ['review', 'judge', 'redteam']) assert.ok(PLANS.S4.stages.includes(st), 'S4 缺少阶段 ' + st);
  assert.equal(PLANS.S4.maxAgents, 8);
  assert.equal(MODE_META.S4.label, '完整加强');
});

test('迁移优先级：旧 reviewModels 非空时统一给 review/judge/redteam（优先于 roleModels 单值）', () => {
  const s = normalizeSettings({ roleModels: { generate: 'g::gen', review: 'r::rev' }, reviewModels: ['a::A', 'b::B'] });
  assert.deepEqual(s.rolePools.review, ['a::A', 'b::B']);
  assert.deepEqual(s.rolePools.judge, ['a::A', 'b::B']);
  assert.deepEqual(s.rolePools.redteam, ['a::A', 'b::B']);
  assert.notDeepEqual(s.rolePools.review, ['r::rev']);
  assert.equal(s.roleModels.generate, 'g::gen'); // 非评审角色仍按 roleModels 单值迁移
});

test('显式清空角色池（[]）不被旧 roleModels 复活', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-rp-'));
  const file = path.join(dir, 's.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ roleModels: { generate: 'g::gen' } }));
    const store = new SettingsStore({ file });
    assert.deepEqual(store.get().rolePools.generate, ['g::gen']); // 迁移兜底先生效
    const s = store.update({ rolePools: { generate: [] } });
    assert.deepEqual(s.rolePools.generate, []);
    assert.equal(s.roleModels.generate, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
