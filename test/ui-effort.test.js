// 0.6.0：client 设置界面新增「思考强度」页与 reasoning payload 的静态检查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');

test('effort：常量与归一化函数齐全', () => {
  for (const token of ['V3_EFFORT_ORDER', 'V3_EFFORT_LABELS', 'V3_EFFORT_OPTIONS_GENERIC', 'V3_EFFORT_MATRIX', 'v3DefaultReasoning', 'v3NormalizeReasoning']) {
    assert.ok(src.includes(token), '缺少 ' + token);
  }
});

test('effort：矩阵与编排层一致（高地板：S3 review=high/judge=xhigh；S4 default=high）', () => {
  assert.match(src, /S3:\s*\{[^}]*review:\s*'high'[^}]*judge:\s*'xhigh'/);
  assert.match(src, /S4:\s*\{[^}]*default:\s*'high'/);
  assert.match(src, /S1:\s*\{[^}]*verify:\s*'high'/);
});

test('effort：导航含「思考强度」页，支持 model/effort/advanced', () => {
  assert.ok(src.includes('思考强度'));
  assert.match(src, /p\.page === 'effort'/);
  assert.match(src, /navBtn\('effort'/);
});

test('effort：页面结构、样式类与可访问性', () => {
  for (const token of ['t2biq-v3-effort-hero', 't2biq-v3-effort-table', 't2biq-v3-effort-badge', 't2biq-v3-effort-model-row', '不支持思考强度', '默认思考强度', '按模型覆盖']) {
    assert.ok(src.includes(token), '缺少 ' + token);
  }
  assert.match(src, /role:\s*'tabpanel'/);
  assert.match(src, /role:\s*'columnheader'/);
  assert.ok(src.includes('aria-selected'));
});

test('effort：v3BuildPayload / v3DefaultDraft / v3ToDraft 均接入 reasoning', () => {
  assert.match(src, /function v3BuildPayload/);
  assert.match(src, /reasoning:\s*v3NormalizeReasoning\(draft && draft\.reasoning\)/);
  assert.match(src, /reasoning:\s*v3DefaultReasoning\(\)/);
  assert.match(src, /reasoning:\s*v3NormalizeReasoning\(s\.reasoning\)/);
});

test('effort：v3BuildPayload 带 reasoningReplace:true（面板保存为整体替换）', () => {
  // 回归：面板保存必须声明整体替换，否则删除的角色/模型覆盖会被后端深合并保留。
  assert.match(src, /reasoning:\s*v3NormalizeReasoning\(draft && draft\.reasoning\),\s*reasoningReplace:\s*true/);
});
