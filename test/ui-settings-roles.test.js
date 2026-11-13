// 设置界面：每角色一行（8 角色）+ 完整加强档，且无全局白名单墙。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('client.js: rolePools 驱动 8 角色模型池 + 完整加强，无白名单墙', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  assert.ok(src.includes('rolePools'), '缺少 rolePools');
  for (const r of ['研究', '计划', '生成', '评审', '裁决', '验证', '红队', '回归']) {
    assert.ok(src.includes(r), '缺少角色：' + r);
  }
  assert.ok(src.includes('完整加强'), '缺少「完整加强」档位');
  assert.ok(!src.includes("modelChips('allowModels'"), '白名单墙未删除');
  assert.ok(!src.includes('不勾=不限制'), '仍存在「不勾=不限制」白名单文案');
});
