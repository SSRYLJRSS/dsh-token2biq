// 设置 V3：模型从角色池读取，主模型只跟随主对话，不再有强/普通双模型与三档一键套用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSettings, DEFAULT_SETTINGS } from '../lib/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = () => fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');

test('settings: 旧 strongModel/normalModel 不再保留', () => {
  const s = normalizeSettings({ strongModel: 'magpie::glm-5', normalModel: 'magpie::mimo' });
  assert.equal('strongModel' in s, false);
  assert.equal('normalModel' in s, false);
  assert.equal('strongModel' in DEFAULT_SETTINGS, false);
  for (const k of ['research', 'plan', 'generate', 'review', 'judge', 'verify', 'redteam', 'regression']) assert.ok(k in s.rolePools);
});

test('client.js: V3 8 角色 + 大白话职责', () => {
  const src = clientSrc();
  assert.ok(src.includes('t2biq-v3-role-table'));
  assert.ok(src.includes('rolePools'));
  for (const hint of ['查资料、摸清现状', '拆任务、定方案', '写代码、写文档', '挑毛病', '多个方案里拍板', '跑测试、看结果', '故意找茬', '检查有没有改坏']) assert.ok(src.includes(hint), '缺少角色说明：' + hint);
  for (const label of ['研究', '计划', '生成', '评审', '裁决', '验证', '红队', '回归']) assert.ok(src.includes(label), '缺少角色：' + label);
});

test('client.js: 旧三档模式/同模型守卫已删除，改用两页 V3', () => {
  const src = clientSrc();
  for (const banned of ['applyMode', 'curMode', 'strongEqNormal', '全员普通', '强规划', '强模型==普通模型', '不同厂商', '自定义']) assert.ok(!src.includes(banned), '残留旧实现：' + banned);
  assert.ok(src.includes('t2biq-v3-nav'));
  assert.ok(src.includes('模型'));
  assert.ok(src.includes('高级'));
});
