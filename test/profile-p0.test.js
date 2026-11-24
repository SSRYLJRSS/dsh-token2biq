// P0 新增：任务画像(AI 分类) + 策略矩阵配平阶段。纯函数与集成两层覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';
import { detectTaskType, applyProfileToPlan, generatePlan } from '../lib/orchestrator.js';

function mk(over = {}) {
  const f = path.join(os.tmpdir(), 't2biq-p0-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const s = new Token2bIQService({ stateFile: null, settingsFile: f });
  s.updateSettings({ forceTeam: 'off', pipelineGate: 'auto', ...over });
  return s;
}

test('detectTaskType: 否定语境不误判为代码', () => {
  assert.equal(detectTaskType('调查 token2biq 插件兼容性，只读调查不改代码'), 'investigation');
  assert.equal(detectTaskType('帮我调查这个插件会不会冲突'), 'investigation');
  assert.equal(detectTaskType('只读评估，无需修改任何文件'), 'investigation');
  assert.equal(detectTaskType('分析这个模块'), 'investigation');
});

test('detectTaskType: 真实代码动作仍判 code', () => {
  assert.equal(detectTaskType('实现登录功能并修复重试 bug'), 'code');
  assert.equal(detectTaskType('重构整个系统'), 'code');
  assert.equal(detectTaskType('全面复盘并优化 dsh-token2biq 插件'), 'code');
  assert.equal(detectTaskType('不修改源码，但要新增一个接口'), 'code');
});

test('detectTaskType: 空/无关回退 code', () => {
  assert.equal(detectTaskType(''), 'code');
  assert.equal(detectTaskType('随便看看'), 'code');
});

test('applyProfileToPlan: 代码 simple/medium 配平且保留验收阶段', () => {
  const p3 = generatePlan('S3', { goal: 'x', taskType: 'code' });
  const simple = applyProfileToPlan(p3, { complexity: 'simple' });
  assert.ok(simple.stages.includes('generate'));
  assert.ok(simple.stages.includes('verify') || simple.stages.includes('regression'));
  assert.ok(!simple.stages.includes('research'));
  assert.ok(simple.stages.length < p3.stages.length);
  const med = applyProfileToPlan(p3, { complexity: 'medium' });
  assert.ok(med.stages.includes('review'));
  assert.ok(med.stages.length < p3.stages.length);
});

test('applyProfileToPlan: 调查 simple 无 generate、保留 synth 与验收', () => {
  const inv = generatePlan('S3', { goal: 'x', taskType: 'investigation' });
  const simple = applyProfileToPlan(inv, { complexity: 'simple' });
  assert.ok(!simple.stages.includes('generate'));
  assert.ok(simple.stages.includes('synth'));
  assert.ok(simple.stages.includes('verify') || simple.stages.includes('regression'));
});

test('applyProfileToPlan: complex/缺省/无 profile 不裁剪', () => {
  const p3 = generatePlan('S3', { goal: 'x', taskType: 'code' });
  assert.deepEqual(applyProfileToPlan(p3, { complexity: 'complex' }).stages, p3.stages);
  assert.deepEqual(applyProfileToPlan(p3, null).stages, p3.stages);
  assert.deepEqual(applyProfileToPlan(p3, { taskType: 'code' }).stages, p3.stages);
});

test('startWithAuto: 锁定 S3 时用模型画像判调查并配平', async () => {
  const s = mk();
  s.classifier = async () => ({ tier: 'S3', taskType: 'investigation', complexity: 'simple', risk: 'low', worthTeam: true, reason: 'r' });
  const res = await s.startWithAuto({ goal: '调查并回顾这个插件的兼容性，不改代码', mode: 'S3' }, {});
  assert.equal(res.ok, true);
  assert.equal(res.taskType, 'investigation');
  assert.ok(!res.plan.stages.includes('generate'));
  assert.ok(res.plan.stages.includes('synth'));
});

test('startWithAuto: 显式 taskType 覆盖模型画像', async () => {
  const s = mk();
  s.classifier = async () => ({ tier: 'S3', taskType: 'investigation', complexity: 'simple', risk: 'low', worthTeam: true });
  const res = await s.startWithAuto({ goal: 'x', mode: 'S3', taskType: 'code' }, {});
  assert.equal(res.taskType, 'code');
  assert.ok(res.plan.stages.includes('generate'));
});

test('start: 直接传 profile.complexity 也能配平', () => {
  const s = mk();
  const res = s.start({ goal: 'x', mode: 'S3', taskType: 'code', profile: { taskType: 'code', complexity: 'simple', risk: 'low' } });
  assert.ok(res.plan.stages.includes('generate'));
  assert.ok(res.plan.stages.length < 5);
});

test('startWithAuto: 模型判 doc 任务等同调查（无 generate 成稿）', async () => {
  const s = mk();
  s.classifier = async () => ({ tier: 'S2', taskType: 'doc', complexity: 'simple', risk: 'low', worthTeam: false });
  const res = await s.startWithAuto({ goal: '整理一份兼容性总结报告', mode: 'S2' }, {});
  assert.equal(res.taskType, 'investigation');
  assert.ok(!res.plan.stages.includes('generate'));
});

test('detectTaskType: 只/仅/别 不作否定，真实代码任务不回退（评审回归用例）', () => {
  assert.equal(detectTaskType('分析后只修改一个文件'), 'code');
  assert.equal(detectTaskType('分别实现登录与注册两个模块并分析性能'), 'code');
  assert.equal(detectTaskType('分析这个模块并特别优化性能'), 'code');
});

test('detectTaskType: 远距离否定仍判 investigation', () => {
  assert.equal(detectTaskType('评估插件兼容性，没有必要修改任何代码'), 'investigation');
});

test('applyProfileToPlan: 高风险不裁剪（保留红队/裁决）', () => {
  const p = generatePlan('S3', { goal: 'x', taskType: 'code', risk: 'high' });
  const r = applyProfileToPlan(p, { complexity: 'simple', risk: 'high' });
  assert.deepEqual(r.stages, p.stages);
});
