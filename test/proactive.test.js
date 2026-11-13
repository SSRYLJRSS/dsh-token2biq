// 主动编排（B）回归测试：花名册 / 角色提示 / start 时真建队员 + 任务板 / 回退 / 容错。
// 用 fake agentTeams 断言调用契约，不触真实宿主。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { generatePlan, buildTeamPlaybook, buildRoster, buildPolicy } from '../lib/orchestrator.js';
import { Token2bIQService } from '../lib/service.js';

function svc() {
  // 隔离设置文件：避免误读真实 C:\Users\...\.dsh\token2biq\settings.json 里的 roleModels 影响断言。
  const f = path.join(os.tmpdir(), 't2biq-def-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  return new Token2bIQService({ stateFile: null, settingsFile: f });
}

function svcTmp() {
  const f = path.join(os.tmpdir(), 't2biq-indep-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  return new Token2bIQService({ stateFile: null, settingsFile: f });
}

test('buildRoster: 每阶段一个队员、阶段链式依赖、名字唯一且 kebab', () => {
  const plan = generatePlan('S3', { goal: 'x' });
  const pb = buildTeamPlaybook(plan, {});
  const roster = buildRoster(plan, pb);
  assert.equal(roster.length, plan.stages.length);
  assert.deepEqual(roster.map((r) => r.stage), plan.stages);
  assert.equal(roster[0].blockedByStage, null);
  assert.equal(roster[1].blockedByStage, roster[0].stage);
  const names = roster.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.match(n, /^[a-z0-9-]+$/);
});

test('buildPolicy: lead 指向 token2biq/start；teammate 指向 claim/回执', () => {
  const lp = buildPolicy('lead');
  assert.match(lp, /token2biq/);
  assert.match(lp, /start/);
  assert.match(lp, /队员|spawn/);
  const tp = buildPolicy('teammate');
  assert.match(tp, /claim|任务/);
  assert.match(tp, /send_message|回执/);
});

function makeFakeTeam({ role = 'lead', failSpawn = false } = {}) {
  let n = 0;
  const calls = { createTask: [], spawn: [] };
  return {
    calls,
    tryMembership: () => ({ role }),
    createTask: async (_agent, req) => {
      calls.createTask.push(req);
      return { id: 'task-' + (++n), revision: 1, status: 'pending', subject: req.subject, blockedBy: req.blockedBy || [] };
    },
    spawnTeammate: async (_agent, req) => {
      if (!req || req.provider !== 'spawn') throw new Error('spawnTeammate 必须收到 provider=spawn，实际：' + (req && req.provider));
      if (failSpawn) throw new Error('spawn boom');
      calls.spawn.push(req);
      return { member: { name: req.name, target: req.name, status: 'provisioning' } };
    },
    listMembers: () => [],
  };
}

test('startWithAuto: Lead 团队运行时 → 插件建满任务板并按 maxAgents spawn 队员', async () => {
  const s = svc();
  const team = makeFakeTeam();
  const res = await s.startWithAuto({ goal: '多文件重构整个模块 + 迁移', mode: 'S3' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, true);
  assert.ok(res.roster.length >= 5);
  // 每个阶段一个共享任务
  assert.equal(team.calls.createTask.length, res.roster.length);
  // 常驻队员数 = min(阶段数, maxAgents)
  const expectSpawn = Math.min(res.roster.length, res.plan.maxAgents);
  assert.equal(team.calls.spawn.length, expectSpawn);
  assert.equal(res.created.members.length, expectSpawn);
  // 首个任务无 blockedBy，后续链式依赖前一任务 id
  assert.equal(team.calls.createTask[0].blockedBy, undefined);
  assert.deepEqual(team.calls.createTask[1].blockedBy, ['task-1']);
  // 返回体含可执行的下一步 + 花名册
  assert.ok(Array.isArray(res.created.tasks));
  assert.match(res.next, /created|队员|任务板/);
});

test('startWithAuto: 非 Lead / 无团队 → 回退纯计划，不建任务也不 spawn', async () => {
  const s = svc();
  const team = makeFakeTeam({ role: 'teammate' });
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent: {} });
  assert.equal(res.orchestrated, false);
  assert.equal(team.calls.spawn.length, 0);
  assert.equal(team.calls.createTask.length, 0);
  assert.ok(Array.isArray(res.roster));
  assert.ok(res.plan);
});

test('startWithAuto: 无 ctxInfo（如 HTTP 调用）→ 不主动建团，纯计划可用', async () => {
  const s = svc();
  const res = await s.startWithAuto({ goal: 'x', mode: 'S2' });
  assert.equal(res.orchestrated, false);
  assert.ok(res.plan);
  assert.ok(res.roster.length >= 3);
});

test('startWithAuto: spawn 抛错不致命，记入 members.error 且 orchestrated 仍成立', async () => {
  const s = svc();
  const team = makeFakeTeam({ failSpawn: true });
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent: {} });
  assert.equal(res.orchestrated, true); // autoSpawn 内部 catch，不向上抛
  assert.ok(res.created.members.some((m) => m.error));
  assert.equal(team.calls.createTask.length, res.roster.length); // 任务仍建好
});

test('buildRoster: independentReview 开启时 review/judge 标记 independent，generate 不标', () => {
  const plan = generatePlan('S3', {});
  const pb = buildTeamPlaybook(plan, { independentReview: true });
  const roster = buildRoster(plan, pb);
  const byStage = Object.fromEntries(roster.map((r) => [r.stage, r]));
  assert.equal(byStage.review.independent, true);
  assert.equal(byStage.judge.independent, true);
  assert.equal(byStage.generate.independent, false);
});

test('independentReview: 执行者自评被拒，换独立评委放行', () => {
  const s = svcTmp();
  s.updateSettings({ independentReview: true });
  const r = s.start({ goal: 'x', mode: 'S2' });
  const runId = r.run.id;
  // S2 forceTeam(auto) 下，record 必须带 teamTaskId + owner
  const g = s.record({ runId, stage: 'generate', teamTaskId: 't1', owner: 'w1', files: ['a.js'], diffSummary: '改了一处', status: 'done' });
  assert.equal(g.ok, true);
  // 执行者 w1 自评 → 拒
  const bad = s.record({ runId, stage: 'review', teamTaskId: 't2', owner: 'w1', verdict: 'PASS' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /执行者|自评|独立评委/);
  // 独立评委 r1 → 放行
  const ok = s.record({ runId, stage: 'review', teamTaskId: 't2', owner: 'r1', verdict: 'PASS' });
  assert.equal(ok.ok, true);
});

test('independentReview 关闭时：执行者自评不拦（旧行为）', () => {
  const s = svcTmp();
  const r = s.start({ goal: 'x', mode: 'S2' });
  const runId = r.run.id;
  s.record({ runId, stage: 'generate', teamTaskId: 't1', owner: 'w1', files: ['a.js'], diffSummary: 'd', status: 'done' });
  const same = s.record({ runId, stage: 'review', teamTaskId: 't2', owner: 'w1', verdict: 'PASS' });
  assert.equal(same.ok, true);
});

function makeFakeTeamWithPrior(priorRows) {
  let n = 0;
  const calls = { createTask: [], spawn: [] };
  return {
    calls,
    tryMembership: () => ({ role: 'lead' }),
    createTask: async (_a, req) => { calls.createTask.push(req); return { id: 'task-' + (++n), revision: 1, status: 'pending', subject: req.subject, blockedBy: req.blockedBy || [] }; },
    listMembers: () => priorRows,
    spawnTeammate: async (_a, req) => { calls.spawn.push(req); return { member: { name: req.name, target: req.name, status: 'provisioning' } }; },
  };
}

test('F8 autoSpawn 幂等：重复 start 复用同名 research 队员，不重复 spawn', async () => {
  const s = svc();
  const team = makeFakeTeamWithPrior([{ name: 'research-researcher', role: 'teammate', status: 'inactive' }]);
  const res = await s.startWithAuto({ goal: 'x', mode: 'S3' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, true);
  const rm = res.created.members.find((m) => m.stage === 'research');
  assert.ok(rm, 'research 阶段应有 member 行');
  assert.equal(rm.status, 'inactive');
  assert.equal(rm.target, 'research-researcher');
  assert.ok(!team.calls.spawn.some((r) => r.name === 'research-researcher'), '不应重复 spawn research-researcher');
});

test('F8 反例：listMembers 为空时照常 spawn research-researcher（provider=spawn）', async () => {
  const s = svc();
  const team = makeFakeTeamWithPrior([]);
  const res = await s.startWithAuto({ goal: 'x', mode: 'S3' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, true);
  assert.ok(team.calls.spawn.some((r) => r.name === 'research-researcher' && r.provider === 'spawn'));
  const rm = res.created.members.find((m) => m.stage === 'research');
  assert.equal(rm.status, 'provisioning');
});

test('F8b listMembers 返回对象：members 数组可复用，非数组安全退化为 spawn', async () => {
  const s = svc();
  const mk = (lmValue) => {
    let n = 0;
    const calls = { createTask: [], spawn: [] };
    return {
      calls,
      tryMembership: () => ({ role: 'lead' }),
      createTask: async (_a, req) => { calls.createTask.push(req); return { id: 'task-' + (++n), revision: 1, status: 'pending', subject: req.subject, blockedBy: req.blockedBy || [] }; },
      listMembers: () => lmValue,
      spawnTeammate: async (_a, req) => { calls.spawn.push(req); return { member: { name: req.name, target: req.name, status: 'provisioning' } }; },
    };
  };
  // ① 返回 { members: [...] } → 复用 research-researcher，不重复 spawn
  const t1 = mk({ members: [{ name: 'research-researcher', role: 'teammate', status: 'inactive' }] });
  const r1 = await s.startWithAuto({ goal: 'x', mode: 'S3' }, { agentTeams: t1, agent: { id: 'lead-1' } });
  assert.equal(r1.orchestrated, true);
  const rm1 = r1.created.members.find((m) => m.stage === 'research');
  assert.equal(rm1.status, 'inactive');
  assert.ok(!t1.calls.spawn.some((r) => r.name === 'research-researcher'));
  // ② 返回 { members: 'oops' }（非数组）→ 安全退化 []，正常 spawn 且不抛
  const t2 = mk({ members: 'oops' });
  const r2 = await s.startWithAuto({ goal: 'x', mode: 'S3' }, { agentTeams: t2, agent: { id: 'lead-1' } });
  assert.equal(r2.orchestrated, true);
  assert.ok(t2.calls.spawn.some((r) => r.name === 'research-researcher' && r.provider === 'spawn'));
});
