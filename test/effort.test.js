// 0.6.0：思考强度解析（resolveEffort）+ 花名册命名 + 团队提示。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEffort, EFFORT_ORDER, MODE_ROLE_EFFORT,
  buildRoster, buildTeamPlaybook, generatePlan, buildPolicy,
} from '../lib/orchestrator.js';

test('EFFORT_ORDER 顺序固定', () => {
  assert.deepEqual(EFFORT_ORDER, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('MODE_ROLE_EFFORT 与 0.6.1 高地板矩阵一致（S1/S3/S4 抽样）', () => {
  assert.equal(MODE_ROLE_EFFORT.S1.generate, 'high');
  assert.equal(MODE_ROLE_EFFORT.S1.verify, 'high');
  assert.equal(MODE_ROLE_EFFORT.S1.default, 'high');
  assert.equal(MODE_ROLE_EFFORT.S3.generate, 'high');
  assert.equal(MODE_ROLE_EFFORT.S3.review, 'high');
  assert.equal(MODE_ROLE_EFFORT.S3.regression, 'high');
  assert.equal(MODE_ROLE_EFFORT.S3.default, 'high');
  assert.equal(MODE_ROLE_EFFORT.S3.judge, 'xhigh');
  assert.equal(MODE_ROLE_EFFORT.S4.review, 'xhigh');
  assert.equal(MODE_ROLE_EFFORT.S4.plan, 'xhigh');
  assert.equal(MODE_ROLE_EFFORT.S4.judge, 'xhigh');
  assert.equal(MODE_ROLE_EFFORT.S4.regression, 'high');
  assert.equal(MODE_ROLE_EFFORT.S4.default, 'high');
  for (const mode of ['S1', 'S2', 'S3', 'S4']) for (const v of Object.values(MODE_ROLE_EFFORT[mode])) assert.ok(v === 'high' || v === 'xhigh', mode + ' 出现非高地板值 ' + v);
});

test('resolveEffort: 模型无 reasoning 能力 → null（调用方省略参数）', () => {
  assert.equal(resolveEffort({ mode: 'S3', stage: 'generate', role: 'worker', modelRef: 'a::B' }), null);
  assert.equal(resolveEffort({ mode: 'S3', stage: 'generate', role: 'worker', modelRef: 'a::B', modelMeta: { 'a::B': { reasoning: null } } }), null);
  assert.equal(resolveEffort({ mode: 'S3', stage: 'generate', role: 'worker', modelRef: 'a::B', modelMeta: { 'a::B': { reasoning: { efforts: [] } } } }), null);
});

test('resolveEffort: 无覆盖时用档位矩阵', () => {
  const modelMeta = { 'a::B': { reasoning: { efforts: ['low', 'medium', 'high'] } } };
  assert.equal(resolveEffort({ mode: 'S3', stage: 'generate', role: 'worker', modelRef: 'a::B', modelMeta }), 'high');
  assert.equal(resolveEffort({ mode: 'S3', stage: 'review', role: 'reviewer', modelRef: 'a::B', modelMeta }), 'high');
  assert.equal(resolveEffort({ mode: 'S3', stage: 'verify', role: 'verifier', modelRef: 'a::B', modelMeta: { 'a::B': { reasoning: { efforts: ['off', 'low'] } } } }), 'low');
});

test('resolveEffort: 模型 efforts 为对象数组时也取 id', () => {
  const modelMeta = { 'a::B': { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } } };
  assert.equal(resolveEffort({ mode: 'S3', stage: 'generate', role: 'worker', modelRef: 'a::B', modelMeta }), 'high');
});

test('resolveEffort: 首选不在 efforts → 按 EFFORT_ORDER 降档到最近可用', () => {
  const settings = { reasoning: { default: 'auto', byRole: { reviewer: 'max' }, byModel: {} } };
  const modelMeta = { 'a::B': { reasoning: { efforts: ['low', 'medium', 'high'] } } };
  // review 角色覆盖 max，但模型只到 high → 降一档 high
  assert.equal(resolveEffort({ mode: 'S3', stage: 'review', role: 'reviewer', modelRef: 'a::B', modelMeta, settings }), 'high');
  // 全局默认 xhigh，模型只有 low/high → 降到 high
  const s2 = { reasoning: { default: 'xhigh', byRole: {}, byModel: {} } };
  assert.equal(resolveEffort({ mode: 'S3', stage: 'verify', role: 'verifier', modelRef: 'a::B', modelMeta: { 'a::B': { reasoning: { efforts: ['low', 'high'] } } }, settings: s2 }), 'high');
});

test('resolveEffort: byModel 优先于 byRole；再降档 defaultEffort / efforts[0]', () => {
  const modelMeta = { 'a::B': { reasoning: { efforts: ['low', 'medium', 'high'] } } };
  const settings = { reasoning: { default: 'auto', byRole: { worker: 'high' }, byModel: { 'a::B': 'low' } } };
  assert.equal(resolveEffort({ mode: 'S3', stage: 'generate', role: 'worker', modelRef: 'a::B', modelMeta, settings }), 'low');
  // 无可降档命中 → defaultEffort
  const meta2 = { 'a::B': { reasoning: { efforts: ['max', 'xhigh'], defaultEffort: 'max' } } };
  assert.equal(resolveEffort({ mode: 'S3', stage: 'generate', role: 'worker', modelRef: 'a::B', modelMeta: meta2 }), 'max');
  // 连 defaultEffort 都没有 → efforts[0]
  const meta3 = { 'a::B': { reasoning: { efforts: ['max'] } } };
  assert.equal(resolveEffort({ mode: 'S3', stage: 'verify', role: 'verifier', modelRef: 'a::B', modelMeta: meta3 }), 'max');
});

test('buildTeamPlaybook: steps 带 effort（模型支持时解析，不支持时 null）', () => {
  const plan = generatePlan('S3');
  const modelMeta = { 'a::A': { reasoning: { efforts: ['low', 'medium', 'high'] } } };
  const pb = buildTeamPlaybook(plan, { rolePools: { generate: ['a::A'] }, modelMeta, defaultModel: 'a::A', settings: { reasoning: { default: 'auto', byRole: {}, byModel: {} } } });
  assert.equal(pb.steps.find((s) => s.kind === 'generate').effort, 'high');
  assert.equal(pb.steps.find((s) => s.kind === 'review').effort, 'high');
  // 未提供 modelMeta → 全部 null（不支持思考强度）
  const pb2 = buildTeamPlaybook(plan, {});
  assert.ok(pb2.steps.every((s) => s.effort === null));
});

test('buildRoster: 名字带 runId 后 8 位，跨 run 不同', () => {
  const plan = generatePlan('S2');
  const pb = buildTeamPlaybook(plan, {});
  const runId = 'run_ABC123xyz789';
  const suffix = runId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-8);
  const roster = buildRoster(plan, pb, { runId });
  assert.equal(roster.length, plan.stages.length);
  for (const r of roster) {
    assert.ok(r.name.endsWith('-' + suffix), r.name + ' 应以 -' + suffix + ' 结尾');
    assert.match(r.name, /^[a-z0-9-]+$/);
    assert.ok('effort' in r);
  }
  const other = buildRoster(plan, pb, { runId: 'run_ZZZ999aaa111' });
  assert.notDeepEqual(roster.map((r) => r.name), other.map((r) => r.name));
});

test('buildPolicy: lead locked 3 行、含 start/record/finish、明确不要轮询 wait_agent', () => {
  const p = buildPolicy('lead', { mode: 'S3' });
  const lines = p.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(p.includes('token2biq'));
  assert.ok(p.includes('action=start'));
  assert.ok(p.includes('record'));
  assert.ok(p.includes('finish'));
  assert.match(p, /不要轮询 wait_agent/);
  // teammate ≤3 行、claim→complete、回执、不要 send_message
  const t = buildPolicy('teammate');
  assert.ok(t.split('\n').length <= 3);
  assert.match(t, /claim/);
  assert.match(t, /回执/);
  assert.match(t, /不要 send_message/);
});

test('buildTeamPlaybook: resolveEffort 用阶段键作 role，byRole 覆盖真实生效', () => {
  // 回归：buildTeamPlaybook 曾把 role 传成 worker/reviewer，导致 byRole 的 generate/review 覆盖失效。
  const plan = generatePlan('S3');
  const settings = { reasoning: { default: 'auto', byRole: { generate: 'low', review: 'low' }, byModel: {} } };
  const modelMeta = { 'a::A': { reasoning: { efforts: ['low', 'medium', 'high'] } } };
  const pb = buildTeamPlaybook(plan, { settings, modelMeta, defaultModel: 'a::A' });
  const gen = pb.steps.find((s) => s.kind === 'generate');
  const rev = pb.steps.find((s) => s.kind === 'review');
  // 若 role 仍为 worker/reviewer，则回落矩阵（generate=high、review=medium）；这里必须是 low。
  assert.equal(gen.effort, 'low');
  assert.equal(rev.effort, 'low');
  assert.equal(gen.role, 'worker'); // 展示用角色仍是 worker，但解析 role 用阶段键
  assert.equal(rev.role, 'reviewer');
});
