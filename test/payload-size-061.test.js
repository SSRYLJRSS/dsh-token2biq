// 0.6.1：S3 startWithAuto 返回体瘦身 + briefing 去重 + compactToolResult 默认 8192。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';
import { compactToolResult } from '../lib/index.js';

const BASELINE = 9386; // 0.6.0 实测 S3 start 序列化字节基线
function fakeTeam() {
  let n = 0;
  const calls = [];
  return {
    calls,
    isEnabled: () => true,
    createTask: async (_a, req) => { calls.push(req); return { id: 'task-' + (++n), revision: 1, status: 'pending', subject: req.subject, blockedBy: req.blockedBy || [] }; },
    getTask: async (id) => ({ id, revision: 1 }),
  };
}
// 阶段名从建板描述「… · 阶段 generate（…）」里解析，供定向失败用。
function stageOf(req) {
  const m = String((req && req.description) || '').match(/阶段\s+([A-Za-z]+)/);
  return m ? m[1] : '';
}
// 让指定阶段建档失败、其余正常：制造 partial-orchestration。
function fakeTeamFailOn(badStages) {
  const bad = new Set(badStages);
  let n = 0;
  return {
    isEnabled: () => true,
    createTask: async (_a, req) => {
      const st = stageOf(req);
      if (bad.has(st)) throw new Error('createTask boom: ' + st);
      return { id: 'task-' + (++n), revision: 1, status: 'pending', subject: req.subject, blockedBy: req.blockedBy || [] };
    },
    getTask: async (id) => ({ id, revision: 1 }),
  };
}
// 全部建档失败：制造 all-failed（回退纯计划）。
function fakeTeamAllFail() {
  return {
    isEnabled: () => true,
    createTask: async (_a, req) => { throw new Error('board down: ' + stageOf(req)); },
    getTask: async (id) => ({ id, revision: 1 }),
  };
}
function svc(extra = {}) {
  const f = path.join(os.tmpdir(), 't2biq-payload-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const s = new Token2bIQService({ stateFile: null, settingsFile: f });
  s.updateSettings({ forceTeam: 'off', ...extra });
  return s;
}

test('S3 startWithAuto 序列化结果 ≤7000 字节（0.6.0 基线 9386）', async () => {
  const s = svc();
  const res = await s.startWithAuto({ goal: '多文件重构整个模块 + 迁移', mode: 'S3' }, { agentTeams: fakeTeam(), agent: { id: 'lead-1' } });
  const bytes = JSON.stringify(res).length;
  assert.ok(bytes <= 7000, '序列化 ' + bytes + ' 字节，基线 ' + BASELINE);
  // full：真建团 → orchestrated=true、degraded=null、步骤瘦身（不含 subject）。
  assert.equal(res.orchestrated, true);
  assert.equal(res.degraded, null);
  const step = res.playbook && res.playbook.steps && res.playbook.steps[0];
  assert.ok(step, '应有 playbook.steps');
  assert.ok(!('subject' in step), '瘦身后 step 不应含 subject');
  assert.ok(step.kind && ('role' in step), '瘦身后 step 保留 kind/role 执行字段');
});

test('partial-orchestration：部分任务建档失败时 degraded 可见，且步骤保留完整执行字段', async () => {
  const s = svc();
  const res = await s.startWithAuto({ goal: '多文件重构整个模块 + 迁移', mode: 'S3' }, { agentTeams: fakeTeamFailOn(['generate']), agent: { id: 'lead-1' } });
  assert.equal(res.degraded, 'partial-orchestration');
  assert.equal(res.orchestrated, true, '部分建档成功仍算 orchestrated=true');
  const step = res.playbook && res.playbook.steps && res.playbook.steps[0];
  assert.ok(step && 'subject' in step && 'doneWhen' in step && 'writeScopes' in step, '非 teamBuilt 路径必须保留完整 steps');
});

test('all-failed：全部任务建档失败回退纯计划，orchestrated=false 且保留完整 steps', async () => {
  const s = svc();
  const res = await s.startWithAuto({ goal: '多文件重构整个模块 + 迁移', mode: 'S3' }, { agentTeams: fakeTeamAllFail(), agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, false);
  assert.equal(res.degraded, 'no-orchestration');
  const step = res.playbook && res.playbook.steps && res.playbook.steps[0];
  assert.ok(step && 'subject' in step && 'doneWhen' in step && 'writeScopes' in step, '回退路径必须保留完整 steps');
});

test('budget-hard：预算熔断空板不谎报 orchestrated，强制联动自动降级，保留完整 steps', async () => {
  // forceTeam=on 用来验证：预算硬熔断（空板）时强制联动会被降级到 false，不会与 record 门禁死锁。
  const s = svc({ forceTeam: 'on' });
  s._budgetGate = () => ({ spent: 100000, budget: 100000, ledgerSpent: 100000, realSpent: 0, percent: 100, level: 'hard' });
  const res = await s.startWithAuto({ goal: '多文件重构整个模块 + 迁移', mode: 'S3' }, { agentTeams: fakeTeam(), agent: { id: 'lead-1' } });
  assert.equal(res.orchestrated, false, '空板不能谎报 orchestrated=true');
  assert.equal(res.degraded, 'no-orchestration');
  assert.equal(res.forceTeam, false, '强制联动应自动降级为 false（防死锁）');
  assert.ok(res.forceTeamDowngraded, '必须记录降级原因');
  const step = res.playbook && res.playbook.steps && res.playbook.steps[0];
  assert.ok(step && 'subject' in step && 'doneWhen' in step && 'writeScopes' in step, '回退路径必须保留完整 steps');
});

test('无团队（ctxInfo={}）回退：playbook.steps 保留完整执行字段，next 指向 playbook.steps', async () => {
  const s = svc();
  const res = await s.startWithAuto({ goal: 'x', mode: 'S3' }, {});
  const step = res.playbook && res.playbook.steps && res.playbook.steps[0];
  assert.ok(step, '回退路径应有完整 playbook.steps');
  assert.ok('subject' in step && 'doneWhen' in step && 'writeScopes' in step, 'step 必须含 subject/doneWhen/writeScopes');
  assert.equal(res.orchestrated, false);
  assert.ok(typeof res.next === 'string' && /playbook\.steps/.test(res.next), 'next 必须指向 playbook.steps');
});

test('created.briefing 不再携带重复的 handoff.items（delegation.prompt 已含交接）', async () => {
  const s = svc();
  const res = await s.startWithAuto({ goal: '多文件重构整个模块 + 迁移', mode: 'S3' }, { agentTeams: fakeTeam(), agent: { id: 'lead-1' } });
  const briefing = (res.created && res.created.briefing) || [];
  assert.ok(briefing.length > 0, '应有派活简报');
  for (const b of briefing) {
    assert.ok(!Object.prototype.hasOwnProperty.call(b, 'handoff'), 'briefing 不应含 handoff 字段');
    assert.ok(b.delegation && typeof b.delegation.prompt === 'string', 'delegation.prompt 必须保留');
    assert.ok(b.stage && b.role && b.name && b.taskId);
  }
});

test('startWithAuto 返回体保留 roster(stage)/plan/created/modelRouting/next 契约', async () => {
  const s = svc();
  const res = await s.startWithAuto({ goal: 'x', mode: 'S3' }, { agentTeams: fakeTeam(), agent: { id: 'lead-1' } });
  assert.ok(Array.isArray(res.roster) && res.roster.length === res.plan.stages.length);
  assert.ok(res.roster.every((r) => r.stage && r.role && r.name));
  assert.ok(res.plan && res.created && Array.isArray(res.created.modelRouting));
  assert.ok(typeof res.next === 'string' && res.next.length > 0);
});

test('compactToolResult 默认 8192：超限 start 形状仍保留 created/modelRouting/next', () => {
  const big = 'x'.repeat(30000);
  const result = {
    ok: true, run: { id: 'r1', mode: 'S4' },
    playbook: { steps: [{ subject: big }], rules: [big] },
    roster: [{ name: 'w', prompt: big }],
    created: { tasks: [{ taskId: 't1', stage: 'plan' }] },
    modelRouting: [{ stage: 'review', model: 'm::x' }],
    next: 'n',
  };
  const out = compactToolResult(result);
  assert.ok(out.length <= 8192, '实际 ' + out.length);
  const p = JSON.parse(out);
  assert.ok(p.created && p.modelRouting && p.next !== undefined);
});
