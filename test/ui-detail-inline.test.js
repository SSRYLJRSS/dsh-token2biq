// F9 回归：运行记录卡片目标文本「详情/收起」就地展开，不再依赖悬浮 title。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('client.js: RunItem 目标可展开（runGoalOpen + setExpanded），且已移除 title 悬浮', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  assert.ok(src.includes('runGoalOpen'), '缺少 runGoalOpen 样式');
  assert.ok(src.includes('setExpanded'), '缺少展开状态 setExpanded');
  assert.ok(!src.includes('title: run.goal'), '仍存在 title: run.goal 悬浮提示');
});
