// 档位硬触发 + 模型路由 的回归测试（本次修复）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { buildPolicy, generatePlan, buildTeamPlaybook } from '../lib/orchestrator.js';
import { Token2bIQService } from '../lib/service.js';

function svc() {
  const f = path.join(os.tmpdir(), 't2biq-def-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  return new Token2bIQService({ stateFile: null, settingsFile: f });
}
function svcTmp() {
  const f = path.join(os.tmpdir(), 't2biq-tier-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  return new Token2bIQService({ stateFile: null, settingsFile: f });
}

test('buildPolicy: 锁定 S3 时硬性要求先 start、禁止单干；Auto 才允许小任务直接做', () => {
  const locked = buildPolicy('lead', { mode: 'S3' });
  assert.match(locked, /锁定为 S3/);
  assert.match(locked, /MUST 先调用 token2biq action=start \{mode:"S3"\}/);
  assert.match(locked, /禁止单干/);
  assert.match(locked, /subagent/); // 模型路由指引
  const auto = buildPolicy('lead', { mode: 'Auto' });
  assert.match(auto, /小任务/);
  assert.doesNotMatch(auto, /禁止单干/);
});

test('buildTeamPlaybook: 有阶段带 model 时，规则要求用 subagent 执行', () => {
  const plan = generatePlan('S2', {});
  const pb = buildTeamPlaybook(plan, { roleModels: { review: 'magpie::workbuddy/glm-5.3-flash' } });
  assert.ok(pb.steps.some((s) => s.model));
  assert.ok(pb.rules.some((r) => /subagent/.test(r) && /model/.test(r)));
});

test('setSessionPref：档位变更会通知宿主重渲染提示段', () => {
  const s = svc();
  let captured = '';
  s.onSessionPrefChanged = (sid, pref) => { captured = sid + '=' + pref.mode; };
  const r = s.setSessionPref('sess-1', { mode: 'S3' });
  assert.equal(r.ok, true);
  assert.equal(captured, 'sess-1=S3');
});

function makeFakeTeam() {
  let n = 0;
  const calls = { createTask: [], spawn: [] };
  return {
    calls,
    tryMembership: () => ({ role: 'lead' }),
    createTask: async (_a, req) => { calls.createTask.push(req); return { id: 'task-' + (++n), revision: 1, status: 'pending' }; },
    spawnTeammate: async (_a, req) => {
      if (!req || req.provider !== 'spawn') throw new Error('spawnTeammate 必须收到 provider=spawn，实际：' + (req && req.provider));
      calls.spawn.push(req); return { member: { name: req.name, target: req.name, status: 'provisioning' } };
    },
    listMembers: () => [],
  };
}

test('autoSpawn：带 model 的阶段不 spawnTeammate（它无法指定模型），改由 Lead 用 subagent 执行', async () => {
  const s = svc();
  s.updateSettings({ roleModels: { generate: 'magpie::workbuddy/glm-5.3-flash' } });
  const team = makeFakeTeam();
  const res = await s.startWithAuto({ goal: '给某模块加个功能，涉及多文件', mode: 'S2' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, true);
  assert.ok(Array.isArray(res.created.modelRouting) && res.created.modelRouting.some((m) => m.stage === 'generate'));
  // generate 不 spawn：spawn 里的 name 不应包含 generate-worker
  assert.ok(team.calls.spawn.every((r) => !/generate/.test(r.name)), 'generate 阶段不应被 spawnTeammate');
  // next 里明确告知要用 subagent 执行带模型阶段
  assert.match(res.next, /subagent/);
});

test('record(generate) 带 model → run.generateModel 被记录（跨厂商校验可用）', () => {
  const s = svcTmp();
  const r = s.start({ goal: 'x', mode: 'S2' });
  const runId = r.run.id;
  const g = s.record({ runId, stage: 'generate', teamTaskId: 't1', owner: 'w1', files: ['a.js'], diffSummary: '改', status: 'done', model: 'magpie::workbuddy/glm-5.3-flash' });
  assert.equal(g.ok, true);
  assert.equal(s.store.getRun(runId).generateModel, 'magpie::workbuddy/glm-5.3-flash');
  // 评审用同厂商 → 若开启 requireDifferentVendor 则应被拒
  s.updateSettings({ requireDifferentVendor: true });
  const rv = s.record({ runId, stage: 'review', teamTaskId: 't2', owner: 'w2', verdict: 'PASS', model: 'magpie::workbuddy/glm-5.3-flash' });
  assert.equal(rv.ok, false);
  assert.match(rv.error, /同厂商/);
});

test('buildPolicy: enabled=false 时明确要求勿起编排（关闭优先于档位）', () => {
  const p = buildPolicy('lead', { mode: 'S3', enabled: false });
  assert.match(p, /关闭/);
  assert.match(p, /不要启动任何编排/);
  assert.doesNotMatch(p, /MUST 先调用/);
});

test('buildPolicy: 无 opts 与旧版等价（Auto 分支，允许小任务直接做）', () => {
  const p = buildPolicy('lead');
  assert.match(p, /小任务/);
  assert.doesNotMatch(p, /禁止单干/);
});

test('autoSpawn: 超出 maxAgents 窗口的模型阶段也会被 modelRouting 捕获（issue #1）', async () => {
  const s = svc();
  // S3=7 阶段 / maxAgents=6；把「最后一个阶段 regression」配模型（在切片窗口之外）
  s.updateSettings({ roleModels: { regression: 'magpie::workbuddy/glm-5.3-flash' } });
  const team = makeFakeTeam();
  const res = await s.startWithAuto({ goal: '架构级大改', mode: 'S3' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, true);
  assert.ok(res.created.modelRouting.some((m) => m.stage === 'regression'), '窗口外的 regression 必须进 modelRouting');
  // 非模型阶段 6 个 → 应 spawn 6 人
  assert.equal(res.created.members.length, 6);
  assert.equal(team.calls.spawn.length, 6);
});

test('autoSpawn: 全阶段配模型 → members=0 且 next 不谎称已建队员（issue #2）', async () => {
  const s = svc();
  const all = { plan: 'magpie::workbuddy/glm-5.3-flash', generate: 'magpie::workbuddy/glm-5.3-flash', review: 'magpie::workbuddy/glm-5.3-flash', verify: 'magpie::workbuddy/glm-5.3-flash' };
  s.updateSettings({ roleModels: all });
  const team = makeFakeTeam();
  const res = await s.startWithAuto({ goal: '多文件任务', mode: 'S2' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.created.members.length, 0);
  assert.equal(team.calls.spawn.length, 0);
  assert.equal(res.created.modelRouting.length, 4);
  assert.match(res.next, /没有常驻队员/);
});

test('autoSpawn: 被路由阶段不作为下游 blockedBy 硬门禁（issue #3）', async () => {
  const s = svc();
  // S2 阶段 plan,generate,review,verify；给 generate 配模型 → generate 阶段无队员
  s.updateSettings({ roleModels: { generate: 'magpie::workbuddy/glm-5.3-flash' } });
  const team = makeFakeTeam();
  await s.startWithAuto({ goal: '多文件任务', mode: 'S2' }, { agentTeams: team, agent: { id: 'lead-1' } });
  // 任务按 roster 顺序创建：索引 0=plan(task-1)、1=generate(task-2,被路由)、2=review(task-3)、3=verify(task-4)
  const createCalls = team.calls.createTask;
  assert.ok(createCalls.length >= 3);
  // review（索引 2）应依赖 plan(task-1)，跳过被路由、无人 claim 的 generate(task-2)，否则永久 blocked
  assert.deepEqual(createCalls[2].blockedBy, ['task-1']);
});

test('startWithAuto: 会话锁定 S3 时，传入 mode=Auto 不得覆盖（issue #6）', async () => {
  const s = svc();
  s.setSessionPref('sess-lock', { mode: 'S3' });
  const res = await s.startWithAuto({ goal: 'x', mode: 'Auto' }, { agent: { session: { id: 'sess-lock' } } });
  assert.equal(res.lockedMode, 'S3');
  assert.equal(res.run.mode, 'S3');
  assert.deepEqual(res.modeOverride, { requested: 'Auto', locked: 'S3' });
});

test('runView: modelRouting 已持久化并暴露（issue #7）', async () => {
  const s = svc();
  s.updateSettings({ roleModels: { generate: 'magpie::workbuddy/glm-5.3-flash' } });
  const team = makeFakeTeam();
  const res = await s.startWithAuto({ goal: 'x', mode: 'S2' }, { agentTeams: team, agent: { id: 'lead-1' } });
  const view = s.runView(s.store.getRun(res.run.id));
  assert.ok(Array.isArray(view.modelRouting) && view.modelRouting.some((m) => m.stage === 'generate'));
});

test('autoSpawn: S4 并行多审 → 2 个 review 任务 + 2 条 modelRouting（各绑各的 taskId）', async () => {
  const s = svc();
  s.updateSettings({ forceTeam: 'off', rolePools: { review: ['a::A', 'b::B'] } });
  const team = makeFakeTeam();
  const res = await s.startWithAuto({ goal: 'x', mode: 'S4' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, true);
  const revRouting = res.created.modelRouting.filter((m) => m.stage === 'review');
  assert.equal(revRouting.length, 2);
  assert.deepEqual(revRouting.map((m) => m.model), ['a::A', 'b::B']);
  assert.ok(revRouting[0].taskId && revRouting[1].taskId);
  assert.notEqual(revRouting[0].taskId, revRouting[1].taskId); // 不塌缩到同一个任务
  assert.equal(res.created.tasks.filter((t) => t.stage === 'review').length, 2);
  // O4：并行 review 两条任务彼此不被对方 blockedBy（只依赖更早的非模型前驱）→ 说明未被串行化
  const revTaskIds = res.created.tasks.filter((t) => t.stage === 'review').map((t) => t.taskId);
  assert.equal(revTaskIds.length, 2);
  const revCreate = team.calls.createTask.filter((c) => String(c.subject || '').includes('并行多审'));
  assert.equal(revCreate.length, 2);
  for (const c of revCreate) {
    const b = Array.isArray(c.blockedBy) ? c.blockedBy : [];
    assert.ok(!b.some((id) => revTaskIds.includes(id)), '并行 review 子任务不得依赖另一条 review 任务');
  }
});
