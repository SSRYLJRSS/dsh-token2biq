// 旧 modelChips 复选框墙已随「按角色模型池」重构全部移除。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('client.js: modelChips 复选框墙已移除，改由 rolePools 角色池', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  assert.ok(!src.includes('modelChips('), '仍存在 modelChips 复选框墙');
  assert.ok(src.includes('rolePools'), '缺少 rolePools 角色池');
});
