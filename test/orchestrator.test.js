import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMode, classify, classifyDetailed, resolveMode, generatePlan, nextMode, PLANS, MODES, buildTeamPlaybook, MAX_PARALLEL_REVIEWS,
} from '../lib/orchestrator.js';

test('normalizeMode: 别名与大小写', () => {
  assert.equal(normalizeMode('S1'), 'S1');
  assert.equal(normalizeMode('s2'), 'S2');
  assert.equal(normalizeMode('s4'), 'S4');
  assert.equal(normalizeMode('自动'), 'Auto');
  assert.equal(normalizeMode('普通'), 'S1');
  assert.equal(normalizeMode('大改'), 'S3');
  assert.equal(normalizeMode(''), 'Auto');
  assert.equal(normalizeMode('garbage'), 'Auto');
});

test('classify: 小任务→S1，大改→S3，中间→S2', () => {
  assert.equal(classify('修复一个 typo'), 'S1');
  assert.equal(classify('重构整个项目的架构，迁移多文件模块并重写核心系统'), 'S3');
  assert.equal(classify('Please review the existing login page and verify that the button colors, corner radius, hover state, disabled state, focus ring, and mobile touch target all match the design specification, then add visual regression snapshot tests and document the changes in the changelog before submitting.'), 'S2');
});

test('resolveMode: Auto 走分类器', () => {
  assert.equal(resolveMode('Auto', '修复 bug'), 'S1');
  assert.equal(resolveMode('S2', '随便'), 'S2');
});

test('PLANS 数据完整性', () => {
  assert.deepEqual(PLANS.S1.stages, ['generate', 'review', 'verify']);
  assert.deepEqual(PLANS.S3.stages, ['research', 'plan', 'generate', 'review', 'judge', 'redteam', 'regression']);
  assert.deepEqual(PLANS.S4.stages, ['research', 'plan', 'generate', 'review', 'judge', 'redteam', 'regression']);
  assert.equal(PLANS.S2.maxAgents, 3);
  assert.equal(PLANS.S4.maxAgents, 8);
  assert.equal(MODES.length, 5); // 新增 S4「完整加强」
});

test('generatePlan: 档位成本权重与阶段数（无硬预算）', () => {
  const p1 = generatePlan('S1');
  assert.equal(p1.mode, 'S1');
  assert.equal(p1.costWeight, 2);
  assert.equal(p1.stageCount, 3);
  assert.equal(p1.maxAgents, 1);
  assert.equal(p1.budget, undefined); // 预算功能已移除
  const p3 = generatePlan('S3');
  assert.equal(p3.costWeight, 10);
  assert.equal(p3.stageCount, 7);
  assert.equal(p3.maxAgents, 6);
});

test('generatePlan: Auto 记录请求档与实判档', () => {
  const p = generatePlan('Auto', { goal: '重构整个系统' });
  assert.equal(p.requestedMode, 'Auto');
  assert.equal(p.mode, 'S3');
  assert.equal(p.classified, true);
});

test('nextMode: 逐级上调', () => {
  assert.equal(nextMode('S1'), 'S2');
  assert.equal(nextMode('S2'), 'S3');
  assert.equal(nextMode('S3'), 'S3');
});

test('classifyDetailed: 明显小/明显大=有把握，中间地带=拿不准', () => {
  const small = classifyDetailed('修一个 typo，简单');
  assert.equal(small.tier, 'S1');
  assert.equal(small.confident, true);
  const big = classifyDetailed('重构整个项目的认证模块，多文件迁移，端到端改造');
  assert.equal(big.tier, 'S3');
  assert.equal(big.confident, true);
  // 无信号、长度中等（40–150）→ 拿不准（中间 0..2）
  const mid = classifyDetailed('请把当前这个文件里的若干个函数按顺序通读一遍，并逐条告诉我每个函数大致在做什么事情、有没有潜在问题');
  assert.equal(mid.confident, false);
});

test('generatePlan: Auto 可用 resolvedMode 覆盖分类结果（混合模式）', () => {
  const p = generatePlan('Auto', { goal: '帮我看看这个模块', resolvedMode: 'S3' });
  assert.equal(p.requestedMode, 'Auto');
  assert.equal(p.mode, 'S3');
  assert.equal(p.stageCount, 7);
});

test('buildTeamPlaybook: S4 并行多审按角色池拆子步骤，S3 不拆', () => {
  assert.equal(MAX_PARALLEL_REVIEWS, 5);
  const s4 = generatePlan('S4');
  const pb = buildTeamPlaybook(s4, { rolePools: { review: ['a::A', 'b::B', 'c::C'] }, multiReview: true });
  const rev = pb.steps.filter((s) => s.kind === 'review');
  assert.equal(rev.length, 3);
  assert.deepEqual(rev.map((s) => s.model), ['a::A', 'b::B', 'c::C']);
  assert.ok(rev.every((s) => s.parallel === true && s.multiReview === true));
  assert.deepEqual(rev.map((s) => s.candidateIndex), [1, 2, 3]);
  assert.equal(pb.steps.filter((s) => s.kind === 'judge').length, 1); // judge 池为空 → 单条
  assert.ok(pb.modelPlan.multiReview === true);

  const s3 = generatePlan('S3');
  const pb3 = buildTeamPlaybook(s3, { rolePools: { review: ['a::A', 'b::B', 'c::C'] }, multiReview: false });
  const rev3 = pb3.steps.filter((s) => s.kind === 'review');
  assert.equal(rev3.length, 1);
  assert.equal(rev3[0].model, 'a::A');

  // 上限 MAX_PARALLEL_REVIEWS=5（显式 parallelReviews=5）
  const pbCap = buildTeamPlaybook(s4, { rolePools: { review: ['a::1', 'a::2', 'a::3', 'a::4', 'a::5', 'a::6', 'a::7'] }, multiReview: true, parallelReviews: 5 });
  assert.equal(pbCap.steps.filter((s) => s.kind === 'review').length, 5);

  // O1：并行拆分也走 allowModels 白名单（超白名单候选被过滤并出提示）
  const pbAllow = buildTeamPlaybook(s4, { rolePools: { review: ['a::A', 'b::B', 'c::C'] }, allowModels: ['a::A', 'b::B'], multiReview: true });
  const revAllow = pbAllow.steps.filter((s) => s.kind === 'review');
  assert.equal(revAllow.length, 2);
  assert.deepEqual(revAllow.map((s) => s.model), ['a::A', 'b::B']);
  assert.ok(pbAllow.rules.some((r) => r.includes('白名单已过滤') && r.includes('c::C')));
  // 白名单后不足 2 → 落回单步分支
  const pbAllow1 = buildTeamPlaybook(s4, { rolePools: { review: ['a::A', 'c::C'] }, allowModels: ['a::A'], multiReview: true });
  const revAllow1 = pbAllow1.steps.filter((s) => s.kind === 'review');
  assert.equal(revAllow1.length, 1);
  assert.equal(revAllow1[0].model, 'a::A');
});

test('buildTeamPlaybook: S4 parallelReviews 控制并行审数量（3→3、1→单审、池不足不报错）', () => {
  const s4 = generatePlan('S4');
  const five = ['a::1', 'a::2', 'a::3', 'a::4', 'a::5'];
  const pb3 = buildTeamPlaybook(s4, { rolePools: { review: five }, multiReview: true, parallelReviews: 3 });
  const r3 = pb3.steps.filter((s) => s.kind === 'review');
  assert.equal(r3.length, 3);
  assert.equal(r3[0].candidateCount, 3);
  assert.equal(pb3.modelPlan.parallelReviews, 3);

  const pb1 = buildTeamPlaybook(s4, { rolePools: { review: five }, multiReview: true, parallelReviews: 1 });
  const r1 = pb1.steps.filter((s) => s.kind === 'review');
  assert.equal(r1.length, 1); // 不拆分 → 单审
  assert.equal(r1[0].multiReview, undefined);

  const pb2 = buildTeamPlaybook(s4, { rolePools: { review: ['a::1', 'a::2'] }, multiReview: true, parallelReviews: 3 });
  const r2 = pb2.steps.filter((s) => s.kind === 'review');
  assert.equal(r2.length, 2); // 池不足 3 → 用 2，不报错
  assert.equal(r2[0].candidateCount, 2);

  // 非并行分支仍取 pool[0]
  const pbS3 = buildTeamPlaybook(generatePlan('S3'), { rolePools: { review: ['a::1', 'a::2'] }, multiReview: false, parallelReviews: 3 });
  assert.equal(pbS3.steps.filter((s) => s.kind === 'review')[0].model, 'a::1');
});
