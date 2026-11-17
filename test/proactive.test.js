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

// 0.2.2-rc.3 契约：tryMembership / spawnTeammate / listMembers 已删除；
// 插件只用 isEnabled(agent) 判团队成员、用 createTask 建共享任务——这里只实现用到的部分。
function makeFakeTeam({ enabled = true, failCreate = false } = {}) {
  let n = 0;
  const calls = { createTask: [] };
  return {
    calls,
    isEnabled: () => enabled,
    createTask: async (_agent, req) => {
      if (failCreate) throw new Error('create boom');
      calls.createTask.push(req);
      return { id: 'task-' + (++n), revision: 1, status: 'pending', subject: req.subject, blockedBy: req.blockedBy || [] };
    },
  };
}

test('startWithAuto: Lead 团队运行时 → 插件建满任务板并产出 maxAgents 条派活简报', async () => {
  const s = svc();
  const team = makeFakeTeam();
  const res = await s.startWithAuto({ goal: '多文件重构整个模块 + 迁移', mode: 'S3' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, true);
  assert.ok(res.roster.length >= 5);
  // 每个阶段一个共享任务
  assert.equal(team.calls.createTask.length, res.roster.length);
  // 派活简报条数 = min(非模型阶段数, maxAgents)
  const expectBrief = Math.min(res.roster.length, res.plan.maxAgents);
  assert.equal(res.created.briefing.length, expectBrief);
  // 首个任务无 blockedBy，后续链式依赖前一任务 id
  assert.equal(team.calls.createTask[0].blockedBy, undefined);
  assert.deepEqual(team.calls.createTask[1].blockedBy, ['task-1']);
  // 返回体含可执行的下一步 + 花名册 + 可直接照抄的简报
  assert.ok(Array.isArray(res.created.tasks));
  assert.ok(res.created.briefing.every((b) => b.delegation && typeof b.delegation.prompt === 'string' && b.delegation.prompt.length > 20));
  assert.match(res.next, /subagent|任务板/);
});

test('startWithAuto: 非 Lead / 无团队 → 回退纯计划，不建任务也不 spawn', async () => {
  const s = svc();
  const team = makeFakeTeam({ enabled: false });
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent: {} });
  assert.equal(res.orchestrated, false);
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

test('startWithAuto: 全部 createTask 失败必须降级（不得报 orchestrated 成功）', async () => {
  // 旧行为：单个 createTask 抛错被内部 catch，全部失败也照样 orchestrated=true，
  // 于是 forceTeam 保持强制、record 又因缺 teamTaskId 被门禁拒 —— 直接死锁。
  const s = svc();
  const team = makeFakeTeam({ failCreate: true });
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent: {} });
  assert.equal(res.orchestrated, false);
  assert.equal(res.degraded, 'no-orchestration');
  assert.match(res.next, /未建任务板/);
  // 建档明细仍要可见：哪几个阶段失败、错在哪
  assert.ok(res.created.tasks.every((m) => m.error));
  assert.equal(res.created.tasks.length, res.roster.length); // 每个阶段都留了行
});

test('startWithAuto: 团队协作关闭（isEnabled=false）→ 完全不动手，回退纯计划', async () => {
  const s = svc();
  const team = makeFakeTeam({ enabled: false });
  const res = await s.startWithAuto({ goal: 'x', mode: 'S2' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, false);
  assert.equal(team.calls.createTask.length, 0);
  assert.ok(res.plan && Array.isArray(res.roster));
});

test('buildRoster: independentReview 开启时 review/judge 标记 independent，generate 不标', () => {
  const plan = generatePlan('S3', { risk: 'high' });
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

function makeFakeTeamLead() {
  let n = 0;
  const calls = { createTask: [] };
  return {
    calls,
    isEnabled: () => true,
    createTask: async (_a, req) => { calls.createTask.push(req); return { id: 'task-' + (++n), revision: 1, status: 'pending', subject: req.subject, blockedBy: req.blockedBy || [] }; },
  };
}

test('F8 autoBoard 幂等：两次 start 各建一整套任务板，任务 id 不复用', async () => {
  const s = svc();
  const team = makeFakeTeamLead();
  const r1 = await s.startWithAuto({ goal: 'x', mode: 'S3' }, { agentTeams: team, agent: { id: 'lead-1' } });
  const r2 = await s.startWithAuto({ goal: 'x', mode: 'S3' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(r1.orchestrated, true);
  assert.equal(r2.orchestrated, true);
  // 两次各自建了一整套任务（去重交给宿主任务板）
  assert.equal(team.calls.createTask.length, r1.roster.length + r2.roster.length);
  // 每条简报都绑定自己的 taskId，且两次 start 的 id 不重叠
  assert.ok(r1.created.briefing.every((b) => b.taskId));
  const ids1 = r1.created.briefing.map((b) => b.taskId);
  const ids2 = r2.created.briefing.map((b) => b.taskId);
  assert.ok(ids1.every((id) => !ids2.includes(id)), '两次 start 的任务 id 不得复用');
});

test('F8b autoBoard: 未注入 subagents 时用 isEnabled 判 Lead（不抛、不误判）', async () => {
  const s = svc();
  const team = makeFakeTeamLead();
  // 只传 agentTeams（宿主没提供 subagents）→ 退化为「是成员即 Lead」
  const res = await s.startWithAuto({ goal: 'x', mode: 'S3' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, true);
  assert.ok(res.created.briefing.length > 0);
});

test('F8c autoBoard: subagents.rootOf 指向别人 → 判定为队员，完全不动手', async () => {
  const s = svc();
  const team = makeFakeTeamLead();
  const subagents = { rootOf: () => ({ id: 'someone-else' }) };
  const res = await s.startWithAuto({ goal: 'x', mode: 'S3' }, { agentTeams: team, agent: { id: 'member-1' }, subagents });
  assert.equal(res.orchestrated, false);
  assert.equal(team.calls.createTask.length, 0);
});

test('F8d autoBoard: subagents.rootOf 抛 UNAUTHORIZED → 安全回退纯计划', async () => {
  const s = svc();
  const team = makeFakeTeamLead();
  const subagents = { rootOf: () => { throw new Error('UNAUTHORIZED'); } };
  const res = await s.startWithAuto({ goal: 'x', mode: 'S2' }, { agentTeams: team, agent: { id: 'x' }, subagents });
  assert.equal(res.orchestrated, false);
  assert.equal(team.calls.createTask.length, 0);
  assert.ok(res.plan && Array.isArray(res.roster));
});

test('P1 重试：createTask 瞬时错误重试后成功，并回传能力探测', async () => {
  const s = svc();
  let calls = 0;
  const team = {
    isEnabled: () => true,
    createTask: async () => {
      calls += 1;
      if (calls <= 2) { const e = new Error('timeout'); e.code = 'ETIMEDOUT'; throw e; }
      return { id: 'task-' + calls, revision: 1, status: 'pending' };
    },
  };
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, true);
  assert.ok(res.created.tasks.every((t) => !t.error), '瞬时错误应被重试消化');
  assert.ok(calls > res.roster.length, '应发生了重试');
  assert.equal(res.created.capabilities.teamTasks, true);
  assert.equal(res.created.capabilities.leadGate, false); // 没传 subagents
});

test('P1 重试：非瞬时错误不重试（createTask 非幂等，重复会留脏任务）', async () => {
  const s = svc();
  let calls = 0;
  const team = {
    isEnabled: () => true,
    createTask: async () => { calls += 1; throw new Error('permission denied'); },
  };
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent: { id: 'lead-1' } });
  // 全部失败 → 降级（不再假装 orchestrated 成功），但「每个阶段只试一次」的契约不变。
  assert.equal(res.orchestrated, false);
  assert.equal(res.degraded, 'no-orchestration');
  assert.equal(calls, res.roster.length, '每个阶段只应尝试一次');
  assert.ok(res.created.tasks.every((t) => t.error));
});

test('P2 交接：_handoff 汇总上游产物与未关闭问题', () => {
  const s = svc();
  const run = {
    plan: { stages: ['research', 'design', 'generate'] },
    tasks: [
      { stage: 'research', files: ['a.js'], diffSummary: '调研', status: 'done', issues: [] },
      { stage: 'design', files: [], diffSummary: '设计', verdict: 'PASS', issues: ['缺边界用例'] },
      { stage: 'generate', files: ['b.js'], diffSummary: '不该出现' },
    ],
  };
  const h = s._handoff(run, 'generate');
  assert.deepEqual(h.items.map((i) => i.stage), ['research', 'design']);
  assert.ok(h.text.includes('research') && h.text.includes('design'));
  assert.deepEqual(h.openIssues, ['缺边界用例']);
  assert.ok(!h.text.includes('不该出现'), '下游阶段不得泄漏到上游交接里');
});

test('P2 交接：首个阶段没有上游时给出明确说明而非空串', () => {
  const s = svc();
  const h = s._handoff({ plan: { stages: ['research', 'generate'] }, tasks: [] }, 'research');
  assert.deepEqual(h.items, []);
  assert.match(h.text, /上游尚未产出/);
});

test('打磨：_fillGoal 把 <目标>/<子任务> 换成实际目标摘要', () => {
  const s = svc();
  assert.equal(s._fillGoal('调研：<目标>的现状', '把登录模块拆成独立包'), '调研：把登录模块拆成独立包的现状');
  assert.equal(s._fillGoal('实现：<子任务>', '目标X'), '实现：目标X');
  assert.equal(s._fillGoal('无占位', '目标'), '无占位');
  assert.ok(s._fillGoal('<目标>', 'A'.repeat(200)).endsWith('…'), '超长目标应截断');
  assert.equal(s._fillGoal('<目标>', ''), '<目标>', '空目标保持原样，不吞模板');
});

test('P3 成本闸门：面板可见 ok/soft/hard 三档', async () => {
  const s = svc();
  s.settings.update({ tokenBudget: 1000 });
  const team = { isEnabled: () => true, createTask: async () => ({ id: 't1', revision: 1, status: 'pending' }) };
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent: { id: 'lead-1' } });
  const runId = res.run.id;
  assert.equal(s.runView(s.store.getRun(runId)).budgetGate.level, 'ok');
  s.store.getRun(runId).ledger.totalIn = 850;
  assert.equal(s.runView(s.store.getRun(runId)).budgetGate.level, 'soft');
  s.store.getRun(runId).ledger.totalIn = 1000;
  assert.equal(s.runView(s.store.getRun(runId)).budgetGate.level, 'hard');
  assert.equal(s.runView(s.store.getRun(runId)).budgetGate.percent, 100);
});

test('P3 成本闸门：未设预算时 budgetGate 为 null（向后兼容）', async () => {
  const s = svc();
  const team = { isEnabled: () => true, createTask: async () => ({ id: 't1', revision: 1, status: 'pending' }) };
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(s.runView(s.store.getRun(res.run.id)).budgetGate, null);
});

test('打磨：runView 暴露 tasks（action=state 不再永远 0 个任务）', async () => {
  const s = svc();
  const team = { isEnabled: () => true, createTask: async () => ({ id: 't1', revision: 1, status: 'pending' }) };
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent: { id: 'lead-1' } });
  s.store.addTask(res.run.id, { stage: 'research', role: 'researcher', status: 'done', receipt: { diffSummary: '调研结论' }, tokensIn: 1, tokensOut: 2 });
  const view = s.runView(s.store.getRun(res.run.id));
  assert.equal(view.tasks.length, 1, 'runView 必须暴露 tasks');
  assert.equal(view.tasks[0].stage, 'research', '出参回显 stage');
  assert.equal(view.tasks[0].diffSummary, '调研结论', '出参回显 diffSummary');
});

test('打磨：autoBoard 失败时给出可操作原因，而不是伪装成「没有常驻队员」', async () => {
  const s = svc();
  // 宿主缺 createTask → 必须说明版本不匹配
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: { isEnabled: () => true }, agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, false);
  assert.ok(res.orchestrationError && res.orchestrationError.includes('agentTeams.createTask'), '必须说明缺哪个 API');
  assert.ok(res.next.includes('未建任务板'), 'next 必须说明回退原因');
  assert.ok(!res.next.includes('本次没有常驻队员'), '不能把未知伪装成正常态');
});

test('打磨：缺少 runId 时提示怎么拿，而不是「找不到运行 undefined」', async () => {
  const s = svc();
  const r = s.handleTool ? null : null;
  // 直接走 record 分支
  const out = await s.record({ stage: 'research' });
  assert.equal(out.ok, false);
  assert.ok(out.error.includes('缺少 runId'), '必须明确说缺 runId');
  assert.ok(out.error.includes('run_'), '必须给出 run.id 的形态');
});

test('打磨：compactToolResult 对 state 形状不能削成空壳', async () => {
  const { compactToolResult } = await import('../lib/index.js');
  const tasks = Array.from({ length: 60 }, (_, i) => ({ id: 't' + i, stage: 'research', role: 'researcher', status: 'done', owner: 'w1', model: 'p/m', tokens: 100, summary: 'x'.repeat(80), files: ['a.js'], issues: [], diffSummary: 'y'.repeat(80) }));
  const bigState = {
    ok: true,
    mode: 'Auto',
    modes: [{ name: 'Auto', label: '自动' }, { name: 'S3', label: '完整加强' }],
    config: { a: 1 },
    settings: { forceTeam: 'auto' },
    runs: Array.from({ length: 40 }, (_, i) => ({ id: 'run_' + i, mode: 'S3', status: 'done', goal: 'g'.repeat(60), spent: 900, updatedAt: 1 })),
    liveUsage: { input: 1, output: 2 },
    current: { id: 'run_39', mode: 'S3', status: 'running', goal: 'g', tasks, stages: [{ kind: 'research', label: '调研', status: 'running', tasks }], reviews: Array.from({ length: 40 }, (_, i) => ({ id: 'r' + i, verdict: 'PASS', issues: [] })) },
    hint: 'h',
  };
  const out = compactToolResult(bigState);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.runs) && parsed.runs.length > 0, 'runs 不能丢');
  assert.ok(parsed.current && parsed.current.id === 'run_39', 'current 不能丢');
  assert.ok(Array.isArray(parsed.current.tasks), 'current.tasks 不能丢');
  assert.ok(out.length <= 8192, '必须压到限额内，实际 ' + out.length);
});

test('打磨：compactToolResult 对 start 形状仍保留 created/next', async () => {
  const { compactToolResult } = await import('../lib/index.js');
  const bigStart = {
    ok: true,
    run: { id: 'run_1', mode: 'S3', requestedMode: 'S3', status: 'running' },
    plan: { mode: 'S3', maxAgents: 7, stages: ['research', 'plan'], costWeight: 7 },
    created: { tasks: [{ id: 't1' }] },
    modelRouting: [{ stage: 'research', model: 'p/m' }],
    roster: [{ role: 'researcher', prompt: 'z'.repeat(20000) }],
    playbook: { steps: 'q'.repeat(20000) },
    next: '下一步',
  };
  const out = compactToolResult(bigStart);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.created, 'created 不能丢');
  assert.ok(parsed.next, 'next 不能丢');
  assert.ok(out.length <= 8192, '必须压到限额内，实际 ' + out.length);
});

test('打磨：事件流按序留痕（start -> stage -> verdict）', async () => {
  const s = svc();
  const team = { isEnabled: () => true, createTask: async () => ({ id: 't1', revision: 1, status: 'pending' }) };
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent: { id: 'lead-1' } });
  const id = res.run.id;
  s.store.setStageStatus(id, 'research', 'running');
  s.store.setStageStatus(id, 'research', 'done');
  s.store.setVerdict(id, { final: 'PASS', byJudge: 'judge', rationale: 'ok' });
  const ev = s.store.getRun(id).events;
  assert.ok(Array.isArray(ev) && ev.length >= 4, '至少 start + 2 stage + verdict，实际 ' + ev.length);
  assert.equal(ev[0].kind, 'start', '首条必须是 start');
  assert.equal(ev[ev.length - 1].kind, 'verdict', '末条必须是 verdict');
  const stageEvs = ev.filter((e) => e.kind === 'stage').map((e) => e.status);
  assert.deepEqual(stageEvs, ['running', 'done'], '阶段跃迁必须有序');
  assert.ok(s.runView(s.store.getRun(id)).events.length > 0, 'runView 必须暴露 events');
});

test('打磨：运行数超上限时淘汰最旧的，且不淘汰正在跑的', async () => {
  const s = svc();
  const team = { isEnabled: () => true, createTask: async () => ({ id: 't1', revision: 1, status: 'pending' }) };
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = await s.startWithAuto({ goal: 'g' + i, mode: 'S1' }, { agentTeams: team, agent: { id: 'lead-1' } });
    ids.push(r.run.id);
  }
  // 把最早的两个标记成已完成（可被淘汰），最新的保持 running（必须保留）
  s.store.setStatus(ids[0], 'done');
  s.store.setStatus(ids[1], 'done');
  const dropped = s.store._prune(3);
  assert.equal(dropped, 2, '应淘汰 2 个，实际 ' + dropped);
  assert.equal(Object.keys(s.store.state.runs).length, 3);
  assert.ok(s.store.getRun(ids[4]), '最新（running）必须保留');
  assert.ok(!s.store.getRun(ids[0]), '最旧的已完成必须被淘汰');
});

test('打磨：事件条数超上限时截断最旧', async () => {
  const s = svc();
  const team = { isEnabled: () => true, createTask: async () => ({ id: 't1', revision: 1, status: 'pending' }) };
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent: { id: 'lead-1' } });
  for (let i = 0; i < 700; i++) s.store._ev(res.run.id, 'tick', { i });
  const ev = s.store.getRun(res.run.id).events;
  assert.equal(ev.length, 500, '必须截断到 500 条，实际 ' + ev.length);
  assert.equal(ev[ev.length - 1].i, 699, '保留最新的');
});

test('打磨：review 重试通过后阶段自愈为 done（不被历史 FAIL 粘死）', async () => {
  const s = svc();
  s.updateSettings({ forceTeam: 'off' });
  const runId = s.start({ goal: 'x', mode: 'S2' }).run.id;
  s.record({ runId, stage: 'review', status: 'done', verdict: 'FAIL', summary: '有问题', issues: ['a'] });
  const afterFail = s.runView(s.store.getRun(runId)).stages.find((x) => x.kind === 'review');
  assert.equal(afterFail.status, 'failed', 'FAIL 后阶段应为 failed');
  s.record({ runId, stage: 'review', status: 'done', verdict: 'PASS', summary: '已修复' });
  const afterPass = s.runView(s.store.getRun(runId)).stages.find((x) => x.kind === 'review');
  assert.equal(afterPass.status, 'done', '重试通过后必须自愈为 done，实际 ' + afterPass.status);
  // 反向证明：状态是从「最新回执」派生的，不是一次性置位。再来一次 FAIL 必须重新变 failed。
  s.record({ runId, stage: 'review', status: 'done', verdict: 'FAIL', summary: '回归了', issues: ['b'] });
  const afterFail2 = s.runView(s.store.getRun(runId)).stages.find((x) => x.kind === 'review');
  assert.equal(afterFail2.status, 'failed', '新 FAIL 必须立刻反映，实际 ' + afterFail2.status);
});

test('打磨：已完成的运行不能再暂停/恢复（防绕过 finish 门禁）', async () => {
  const s = svc();
  const team = { isEnabled: () => true, createTask: async () => ({ id: 't1', revision: 1, status: 'pending' }) };
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent: { id: 'lead-1' } });
  const runId = res.run.id;
  s.store.setVerdict(runId, { final: 'PASS', byJudge: 'judge', rationale: 'ok' });
  const paused = s.setPaused(runId, true);
  assert.equal(paused.ok, false, '已完成运行必须拒绝暂停');
  assert.match(paused.error, /已结束/);
  assert.equal(s.store.getRun(runId).status, 'done', '状态不能被复活');
  // 直接调 run-store 也不能复活
  assert.equal(s.store.setPaused(runId, true, 'x'), null);
  assert.equal(s.store.getRun(runId).status, 'done');
});

test('打磨：恢复暂停时还原暂停前状态，而不是硬编码 running', async () => {
  const s = svc();
  const team = { isEnabled: () => true, createTask: async () => ({ id: 't1', revision: 1, status: 'pending' }) };
  const res = await s.startWithAuto({ goal: 'x', mode: 'S1' }, { agentTeams: team, agent: { id: 'lead-1' } });
  const runId = res.run.id;
  s.store.setStatus(runId, 'blocked');
  s.setPaused(runId, true);
  assert.equal(s.store.getRun(runId).status, 'paused');
  s.setPaused(runId, false);
  assert.equal(s.store.getRun(runId).status, 'blocked', '应还原为暂停前的 blocked，实际 ' + s.store.getRun(runId).status);
});

test('打磨：pause/delete 缺 runId 时给出可操作错误而非 undefined', async () => {
  const s = svc();
  assert.match(String(s.setPaused(undefined, true).error), /缺少 runId/);
  assert.match(String(s.setPaused(undefined, false).error), /缺少 runId/);
  assert.match(String(s.deleteRun(undefined).error), /缺少 runId/);
});

test('打磨：degraded 显式回传原因（无 agentTeams -> no-team）', async () => {
  const s = svc();
  const r = await s.startWithAuto({ goal: 'x', mode: 'S1' }, null);
  assert.equal(r.degraded, 'no-team', '无宿主能力时必须回传 no-team，实际 ' + r.degraded);
  const team = { isEnabled: () => true, createTask: async () => ({ id: 't1', revision: 1, status: 'pending' }) };
  const ok = await s.startWithAuto({ goal: 'y', mode: 'S1' }, { agentTeams: team, agent: { id: 'lead-1' } });
  assert.equal(ok.degraded, null, '建板成功时 degraded 必须是 null');
  assert.equal(ok.orchestrated, true);
});

test('打磨：多实例写盘前合并，不互相抹掉运行', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { RunStore } = await import('../lib/run-store.js');
  const file = path.join(os.tmpdir(), 'merge-state-' + Date.now() + '.json');
  const plan = { mode: 'S1', maxAgents: 1, stages: ['research'], costWeight: 1 };
  const a = new RunStore({ file });
  const r1 = a.createRun({ goal: 'g1', plan, mode: 'S1' });
  const b = new RunStore({ file }); // 第二个实例（模拟另一个 DSH 窗口）
  const r2 = b.createRun({ goal: 'g2', plan, mode: 'S1' });
  a.createRun({ goal: 'g3', plan, mode: 'S1' }); // a 再写：必须合并 b 的 run
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = Object.keys(onDisk.runs);
  assert.ok(ids.includes(r1.id), 'a 的 run 不能丢');
  assert.ok(ids.includes(r2.id), 'b 的 run 不能被 a 覆盖掉，实际 ' + ids.length + ' 个');
  assert.equal(ids.length, 3);
  fs.unlinkSync(file);
});
