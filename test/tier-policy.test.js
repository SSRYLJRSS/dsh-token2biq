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
  const pb = buildTeamPlaybook(plan, { rolePools: { review: ['magpie::workbuddy/glm-5.3-flash'] } });
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

// 0.2.2-rc.3 契约：tryMembership / spawnTeammate / listMembers 均已删除，
// 插件只用 isEnabled + createTask（+ getTask/updateTask）——这里只实现用到的部分。
function makeFakeTeam() {
  let n = 0;
  const calls = { createTask: [] };
  return {
    calls,
    isEnabled: () => true,
    createTask: async (_a, req) => { calls.createTask.push(req); return { id: 'task-' + (++n), revision: 1, status: 'pending' }; },
  };
}

test('autoBoard：带 model 的阶段不进派活简报，改由 Lead 用 subagent 执行', async () => {
  const s = svc();
  s.updateSettings({ rolePools: { generate: ['magpie::workbuddy/glm-5.3-flash'] } });
  const team = makeFakeTeam();
  const res = await s.startWithAuto({ goal: '给某模块加个功能，涉及多文件', mode: 'S2' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, true);
  assert.ok(Array.isArray(res.created.modelRouting) && res.created.modelRouting.some((m) => m.stage === 'generate'));
  // generate 阶段不进简报：它由 Lead 用 subagent(provider/model) 直接执行
  assert.ok(res.created.briefing.every((b) => b.stage !== 'generate'), 'generate 阶段不应进派活简报');
  assert.ok(res.created.briefing.every((b) => b.delegation && b.delegation.prompt), '每条简报都要带可直接照抄的 delegation.prompt');
  // next 里明确告知要用 subagent 执行带模型阶段
  assert.match(res.next, /subagent/);
});

test('record(generate) 带 model → run.generateModel 仅审计；同厂商评审不再被拒', () => {
  const s = svcTmp();
  const r = s.start({ goal: 'x', mode: 'S2' });
  const runId = r.run.id;
  const g = s.record({ runId, stage: 'generate', teamTaskId: 't1', owner: 'w1', files: ['a.js'], diffSummary: '改', status: 'done', model: 'magpie::workbuddy/glm-5.3-flash' });
  assert.equal(g.ok, true);
  assert.equal(s.store.getRun(runId).generateModel, 'magpie::workbuddy/glm-5.3-flash');
  s.updateSettings({ forceTeam: 'off' });
  const rv = s.record({ runId, stage: 'review', teamTaskId: 't2', owner: 'w2', verdict: 'PASS', model: 'magpie::workbuddy/glm-5.3-flash' });
  assert.equal(rv.ok, true, '同 provider 评审必须放行');
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
  // S3=5 阶段 / maxAgents=5；把「最后一个阶段 regression」配模型
  s.updateSettings({ rolePools: { regression: ['magpie::workbuddy/glm-5.3-flash'] } });
  const team = makeFakeTeam();
  const res = await s.startWithAuto({ goal: '架构级大改', mode: 'S3' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, true);
  assert.ok(res.created.modelRouting.some((m) => m.stage === 'regression'), 'regression 必须进 modelRouting');
  // 非模型阶段 4 个（research/plan/generate/review）→ 派活简报 4 条
  assert.equal(res.created.briefing.length, 4);
});

test('autoSpawn: 全阶段配模型 → members=0 且 next 不谎称已建队员（issue #2）', async () => {
  const s = svc();
  const all = { plan: ['magpie::workbuddy/glm-5.3-flash'], generate: ['magpie::workbuddy/glm-5.3-flash'], review: ['magpie::workbuddy/glm-5.3-flash'], verify: ['magpie::workbuddy/glm-5.3-flash'] };
  s.updateSettings({ rolePools: all });
  const team = makeFakeTeam();
  const res = await s.startWithAuto({ goal: '多文件任务', mode: 'S2' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.created.briefing.length, 0);
  assert.equal(res.created.modelRouting.length, 4);
  assert.match(res.next, /没有常驻队员/);
});

test('autoSpawn: 被路由阶段是真实依赖（新契约：不跳过），下游依赖它的任务', async () => {
  const s = svc();
  // S2 阶段 plan,generate,review,verify；给 generate 配模型 → generate 由 Lead 用 subagent 亲自执行
  s.updateSettings({ rolePools: { generate: ['magpie::workbuddy/glm-5.3-flash'] } });
  const team = makeFakeTeam();
  const res = await s.startWithAuto({ goal: '多文件任务', mode: 'S2' }, { agentTeams: team, agent: { id: 'lead-1' } });
  // 任务按 roster 顺序创建：索引 0=plan(task-1)、1=generate(task-2,路由)、2=review(task-3)、3=verify(task-4)
  const createCalls = team.calls.createTask;
  assert.ok(createCalls.length >= 3);
  // 旧实现「跳过被路由阶段」→ review 依赖 plan(task-1)，generate 之后的整板几乎全 ready。
  // 新契约：review 依赖 generate 的 task-2 —— 而 task-2 正是 modelRouting 里绑定的那条任务。
  assert.deepEqual(createCalls[2].blockedBy, ['task-2']);
  const view = s.runView(s.store.getRun(res.run.id));
  const routed = view.modelRouting.find((m) => m.stage === 'generate');
  assert.ok(routed && routed.taskId === 'task-2', '被路由阶段必须真的上板，否则依赖链指向空气');
  // 依赖必须指向任务板上真实存在的任务：不能是「被跳过」留下的空位。
  const ids = new Set((view.teamTasks || []).map((t) => t.taskId));
  assert.ok(createCalls[2].blockedBy.every((id) => ids.has(id)), 'blockedBy 必须命中真实任务');
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
  s.updateSettings({ rolePools: { generate: ['magpie::workbuddy/glm-5.3-flash'] } });
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
