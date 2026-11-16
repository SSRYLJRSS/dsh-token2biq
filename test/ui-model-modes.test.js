// 设置面板：两种用法（全员普通 / 强规划+普通执行）可一键切换，且每角色有大白话说明。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSettings, DEFAULT_SETTINGS } from '../lib/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = () => fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');

test('settings: strongModel/normalModel 合法保留、非法归 null', () => {
  const ok = normalizeSettings({ strongModel: 'magpie::glm-5', normalModel: 'magpie::mimo' });
  assert.equal(ok.strongModel, 'magpie::glm-5');
  assert.equal(ok.normalModel, 'magpie::mimo');
  const bad = normalizeSettings({ strongModel: 'not-a-ref', normalModel: 12345 });
  assert.equal(bad.strongModel, null);
  assert.equal(bad.normalModel, null);
  assert.equal(normalizeSettings({}).strongModel, null, '默认应为 null（未设置）');
  assert.equal(DEFAULT_SETTINGS.normalModel, null, '默认应为 null（未设置）');
});

test('client.js: 三档模式切换 + 每角色大白话', () => {
  const src = clientSrc();
  for (const label of ['全员普通', '强规划 + 普通执行', '自定义']) {
    assert.ok(src.includes(label), '缺少模式：' + label);
  }
  assert.ok(src.includes('applyMode'), '缺少一键套用逻辑');
  assert.ok(src.includes('curMode'), '缺少当前模式反推');
  assert.ok(src.includes('strongModel') && src.includes('normalModel'), '缺少强/普通模型选择器');
  for (const hint of ['查资料、摸清现状', '拆任务、定方案', '写代码、写文档', '挑毛病', '多个方案里拍板', '跑测试、看结果', '故意找茬', '检查有没有改坏']) {
    assert.ok(src.includes(hint), '缺少角色说明：' + hint);
  }
});

test('client.js: 模式按钮高亮可读 + 强/普通同模型告警', () => {
  const src = clientSrc();
  // 白字实底在浅色主题下看不见——必须用浅底 + brand 描边。
  assert.ok(!src.includes("background: C.brand, color: '#fff'"), '仍在用白字实底（浅色主题看不清）');
  assert.ok(src.includes('color-mix'), '高亮未使用浅底 color-mix');
  assert.ok(src.includes('✓ '), '缺少当前模式勾选标记');
  // 强模型与普通模型相同 → 两种用法等价，必须拦下并提示。
  assert.ok(src.includes('strongEqNormal'), '缺少「强模型==普通模型」守卫');
  assert.ok(src.includes('强规划 + 普通执行」需要强模型和普通模型不同'), '缺少同模型时的明确提示');
});
