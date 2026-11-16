// 主动编排「接线」测试：验证 index.js apply 会向 Team 代理注入 systemPrompt.section，
// 且工具 execute(action=start) 在传入 Lead exec.agent 时真去建任务板 + spawn 队员。
// 用 fake ctx / fake agentTeams，不触真实宿主。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

function tmp(name) { return path.join(os.tmpdir(), 't2biq-wire-' + process.pid + '-' + name); }

function makeAgent(id, role) {
  const sections = [];
  return {
    id,
    __m: { role },
    sections,
    ctx: {
      systemPrompt: {
        section(o) { sections.push(o); return () => {}; },
        getSectionOrder() { return 600; },
      },
    },
  };
}

function makeCtx(agentTeams, agents, onRegister, subagents) {
  const events = {};
  return {
    events,
    logger: { info() {} },
    get() { return undefined; },
    on(ev, fn) { (events[ev] = events[ev] || []).push(fn); },
    inject(names, cb) {
      const s = {};
      s.effect = (fn) => { const d = fn(); return typeof d === 'function' ? d : (() => {}); };
      if (names.includes('agentTeams')) { s.agentTeams = agentTeams; s.agents = agents; cb(s); }
      else if (names.includes('subagents')) { s.subagents = subagents; cb(s); }
      else if (names.includes('tools')) { s.tools = { register: (def) => { onRegister(def); return () => {}; } }; cb(s); }
      // sessionController / webServer 在测试里跳过
    },
  };
}

test('apply 注入 Lead/队员提示段，且工具 start 会真建任务板+出简报（fake 宿主）', async () => {
  const calls = { createTask: [] };
  let n = 0;
  // 0.2.2-rc.3 契约：只用 isEnabled 判团队成员；Lead/队员判定交给 subagents.rootOf。
  const agentTeams = {
    isEnabled: (a) => !!(a && a.__m),
    createTask: async (_a, req) => { calls.createTask.push(req); return { id: 'task-' + (++n), revision: 1, status: 'pending', subject: req.subject }; },
  };
  const lead = makeAgent('lead-1', 'lead');
  const mate = makeAgent('mate-1', 'teammate');
  const agents = { list: () => [lead, mate] };
  const subagents = { rootOf: (a) => (a && a.__m && a.__m.role === 'lead' ? a : lead) };

  let toolDef = null;
  const ctx = makeCtx(agentTeams, agents, (d) => { toolDef = d; }, subagents);
  apply(ctx, { stateFile: tmp('state.json'), settingsFile: tmp('settings.json') });

  // ① 启动时对已有 Team 成员注入提示段（lead + teammate 各一段）
  assert.equal(lead.sections.length, 1);
  assert.equal(lead.sections[0].name, 'token2biq:policy');
  assert.equal(lead.sections[0].order, 600);
  assert.match(lead.sections[0].text({}), /token2biq/);
  assert.equal(mate.sections.length, 1);
  assert.match(mate.sections[0].text({}), /claim|任务/);

  // ② 之后新建的 Team 代理也会被注入；同一代理重复事件不重复注入
  const late = makeAgent('late-1', 'lead');
  for (const fn of ctx.events['agent/created'] || []) fn({ agent: late });
  for (const fn of ctx.events['agent/created'] || []) fn({ agent: late });
  assert.equal(late.sections.length, 1);

  // ③ 工具 execute(start) 传 Lead exec.agent → 真去建任务板并出派活简报（S1：3 任务 / 1 条简报）
  assert.ok(toolDef && typeof toolDef.execute === 'function');
  const out = await toolDef.execute({ action: 'start', mode: 'S1', goal: '修一个跨文件 bug' }, { agent: lead, signal: undefined });
  const res = JSON.parse(out);
  assert.equal(res.ok, true);
  assert.equal(res.orchestrated, true);
  assert.equal(calls.createTask.length, res.roster.length);
  assert.equal(res.created.briefing.length, Math.min(res.roster.length, res.plan.maxAgents));
  assert.ok(res.created.briefing.every((b) => b.delegation && typeof b.delegation.prompt === 'string'));
});

test('apply: 宿主无 agentTeams 时优雅降级（不抛、工具仍注册）', async () => {
  let toolDef = null;
  const ctx = {
    logger: { info() {} },
    get() { return undefined; },
    on() {},
    inject(names, cb) {
      const s = { effect: (fn) => { fn(); return () => {}; } };
      if (names.includes('tools')) { s.tools = { register: (d) => { toolDef = d; return () => {}; } }; cb(s); }
    },
  };
  assert.doesNotThrow(() => apply(ctx, { stateFile: tmp('s2.json'), settingsFile: tmp('set2.json') }));
  assert.ok(toolDef);
});

test('apply: 队员身份调 start → 不建任务板（Lead 门禁生效）', async () => {
  const calls = { createTask: [] };
  let n = 0;
  const agentTeams = {
    isEnabled: () => true,
    createTask: async (_a, req) => { calls.createTask.push(req); return { id: 'task-' + (++n), revision: 1, status: 'pending', subject: req.subject }; },
  };
  const lead = makeAgent('lead-2', 'lead');
  const mate = makeAgent('mate-2', 'teammate');
  const agents = { list: () => [lead, mate] };
  const subagents = { rootOf: (a) => (a && a.__m && a.__m.role === 'lead' ? a : lead) };
  let toolDef = null;
  const ctx = makeCtx(agentTeams, agents, (d) => { toolDef = d; }, subagents);
  apply(ctx, { stateFile: tmp('s3.json'), settingsFile: tmp('set3.json') });
  const out = await toolDef.execute({ action: 'start', mode: 'S2', goal: 'x' }, { agent: mate });
  const res = JSON.parse(out);
  assert.equal(res.orchestrated, false, '队员不得建板');
  assert.equal(calls.createTask.length, 0);
});
