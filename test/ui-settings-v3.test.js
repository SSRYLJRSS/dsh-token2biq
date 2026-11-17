// Production V3：client 设置界面结构与禁用旧文案的静态检查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');

test('V3 client: 两页设置与角色表/选择器/保存条结构', () => {
  for (const token of ['SettingsForm', 'SettingsView', 'V3_ROLE_KEYS', 'v3BuildPayload', 't2biq-v3-nav', 't2biq-v3-role-table', 't2biq-v3-picker-mask', 't2biq-v3-savebar', 't2biq-v3-switch']) {
    assert.ok(src.includes(token), '缺少 ' + token);
  }
  assert.ok(src.includes('主模型'));
  assert.ok(src.includes('跟随主对话'));
  assert.ok(src.includes('模型目录'));
  assert.ok(src.includes('全部恢复跟随主对话'));
  assert.ok(src.includes('保存设置'));
});

test('V3 client: 8 个角色与职责文案齐全', () => {
  for (const role of ['研究', '计划', '生成', '评审', '裁决', '验证', '红队', '回归']) assert.ok(src.includes(role), '缺少角色：' + role);
  for (const duty of ['查资料、摸清现状', '拆任务、定方案', '写代码、写文档', '挑毛病', '多个方案里拍板', '跑测试、看结果', '故意找茬', '检查有没有改坏']) assert.ok(src.includes(duty), '缺少职责：' + duty);
});

test('V3 client: 高级页字段与严格门禁/独立评委文案', () => {
  for (const token of ['新会话默认档位', '强制用团队', 'S4 并行审模型数', '严格流程', '独立评委', '进入实现前必须有', 'testsRun', 'selectedCandidate', '必须由执行者之外的代理完成']) assert.ok(src.includes(token), '缺少 ' + token);
});

test('V3 client: 旧强/普通模型与跨厂商文案全部清除', () => {
  for (const banned of ['strongModel', 'normalModel', 'reviewModels', 'maxReviewers', 'requireDifferentVendor', '全员普通', '强规划', '不同厂商', '评审模型池', '厂商', 'applyMode', 'curMode', 'strongEqNormal']) assert.ok(!src.includes(banned), '残留禁用词：' + banned);
});

test('V3 client: 保存 payload 永远带 8 个 rolePools key 与五个高级字段', () => {
  assert.match(src, /function v3BuildPayload/);
  assert.ok(src.includes('rolePools,'));
  assert.ok(src.includes('defaultMode: draft.defaultMode'));
  assert.ok(src.includes('forceTeam: draft.forceTeam'));
  assert.ok(src.includes('parallelReviews: draft.parallelReviews'));
  assert.ok(src.includes('pipelineGate: draft.pipelineGate'));
  assert.ok(src.includes('independentReview: draft.independentReview'));
});
