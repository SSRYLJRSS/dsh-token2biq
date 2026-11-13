// 设置界面：保留「高级设置」折叠，旧评审池墙/白名单墙已删除。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('client.js: 设置简化（保留高级折叠；无评审池墙）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  assert.ok(src.includes('高级设置'), '缺少「高级设置」折叠标题');
  assert.ok(!src.includes('评审模型池'), '仍存在评审模型池');
});
