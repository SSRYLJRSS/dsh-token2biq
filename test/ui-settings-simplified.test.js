// 设置 V3：两页「模型 / 高级」，旧评审池墙/白名单墙/折叠高级设置已删除。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('client.js: V3 两页设置、无评审模型池墙', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  assert.ok(src.includes('t2biq-v3-nav'), '缺少左侧/顶部页签');
  assert.ok(src.includes('t2biq-v3-role-table'), '缺少角色表');
  assert.ok(src.includes('t2biq-v3-savebar'), '缺少保存条');
  assert.ok(src.includes('模型'));
  assert.ok(src.includes('高级'));
  assert.ok(src.includes('pipelineGate'), '缺少严格流程控件');
  assert.ok(src.includes('independentReview'), '缺少独立评委控件');
  assert.ok(src.includes('parallelReviews'), '缺少并行审模型数控件');
  assert.ok(!src.includes('评审模型池'), '仍存在评审模型池');
  assert.ok(!src.includes('高级设置'), '仍存在旧折叠高级设置');
  assert.ok(!src.includes('不勾=不限制'), '仍存在白名单墙文案');
});
