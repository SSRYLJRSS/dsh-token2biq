// 2026-11-13 复盘第二轮修复回归：start 结果精简、HTTP 跨站防护、finish 守卫、删除运行清 currentRunId。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Token2bIQService } from '../lib/service.js';
import { apply, compactToolResult } from '../lib/index.js';

let seq = 0;
function mk() {
  const sf = join(tmpdir(), `t2biq-bf2-${process.pid}-${Date.now()}-${seq++}.json`);
  return new Token2bIQService({ stateFile: null, settingsFile: sf });
}

test('compactToolResult：大 start 结果不整体丢弃，保留 created/modelRouting/next，省略 playbook（P1-3）', () => {
  const big = 'x'.repeat(30000);
  const result = {
    ok: true,
    run: { id: 'r1', mode: 'S4', requestedMode: 'S4', status: 'running' },
    plan: { mode: 'S4', maxAgents: 8, stages: ['research', 'plan', 'generate', 'review', 'judge', 'redteam', 'regression'], costWeight: 16 },
    playbook: { steps: [{ subject: big }], rules: [big] },
    roster: [{ name: 'plan-planner' }, { name: 'generate-worker' }],
    created: { tasks: [{ taskId: 't1', stage: 'plan' }], members: [{ name: 'plan-planner', status: 'running' }], modelRouting: [{ stage: 'review', model: 'm::x' }] },
    modelRouting: [{ stage: 'review', model: 'm::x' }],
    next: 'spawn / send / wait',
  };
  const out = compactToolResult(result, 12000);
  assert.ok(out.length <= 12000, '输出必须 ≤ 12000 字符');
  const p = JSON.parse(out);
  assert.ok(p.created && p.created.tasks[0].taskId === 't1', 'created.tasks 必须保留');
  assert.ok(Array.isArray(p.modelRouting) && p.modelRouting.length === 1, 'modelRouting 必须保留');
  assert.equal(p.next, 'spawn / send / wait', 'next 必须保留');
  assert.equal(p.playbook, undefined, 'playbook 应被省略');
});

test('compactToolResult：小结果原样返回', () => {
  const small = { ok: true, a: 1 };
  assert.equal(compactToolResult(small), JSON.stringify(small));
});

function makeCtx() {
  const captured = {};
  const fakeScope = {
    effect(fn) { return fn(); },
    webServer: { register(r) { captured.handler = r.handler; return () => {}; } },
    tools: { register(d) { captured.tool = d; return () => {}; } },
    logger: { info() {} },
  };
  const ctx = {
    inject(_s, cb) { cb(fakeScope); },
    effect(fn) { return fn(); },
    on() {},
    logger: { info() {} },
    get() { return undefined; },
  };
  return { ctx, captured };
}
function callRoute(handler, { method = 'GET', url, body, headers } = {}) {
  return new Promise((resolve) => {
    const res = {
      status: 0, headers: {}, body: '',
      writeHead(c, h) { this.status = c; this.headers = h || {}; },
      end(s) { this.body = s == null ? '' : String(s); resolve(this); },
    };
    const req = {
      method, url, headers: headers || {},
      on(ev, cb) {
        if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body), 'utf8'));
        else if (ev === 'end') cb();
        return this;
      },
    };
    handler(req, res);
  });
}

test('HTTP POST：拒绝跨站 Origin（403），非 JSON content-type（415），同源放行（P1-4）', async () => {
  const { ctx, captured } = makeCtx();
  apply(ctx, { stateFile: null, settingsFile: join(tmpdir(), `t2biq-org-${process.pid}-${Date.now()}.json`) });
  const r1 = await callRoute(captured.handler, { method: 'POST', url: '/token2biq/settings', body: { forceTeam: 'off' }, headers: { origin: 'http://evil.com' } });
  assert.equal(r1.status, 403);
  const r2 = await callRoute(captured.handler, { method: 'POST', url: '/token2biq/settings', body: { forceTeam: 'off' }, headers: { origin: 'http://127.0.0.1:61000' } });
  assert.equal(r2.status, 200);
  const r3 = await callRoute(captured.handler, { method: 'POST', url: '/token2biq/settings', body: { forceTeam: 'off' }, headers: { 'content-type': 'text/plain' } });
  assert.equal(r3.status, 415);
});

test('finish：缺 verdict 被拒（不再静默记 FAIL）；重复 finish 被拒（P2-6/P2-8）', () => {
  const svc = mk();
  const st = svc.start({ goal: 'x', mode: 'S1' });
  const runId = st.run.id;
  const f0 = svc.finish({ runId });
  assert.equal(f0.ok, false);
  assert.match(f0.error, /verdict/);
  const f1 = svc.finish({ runId, verdict: 'PASS' });
  assert.equal(f1.ok, true);
  const f2 = svc.finish({ runId, verdict: 'PASS' });
  assert.equal(f2.ok, false);
  assert.match(f2.error, /已结束/);
});

test('deleteRun：删除当前运行后 currentRunId 置空，避免用量归集指向已删运行（P2-7）', () => {
  const svc = mk();
  const st = svc.start({ goal: 'x', mode: 'S1' });
  const runId = st.run.id;
  assert.equal(svc.currentRunId, runId);
  const d = svc.deleteRun(runId);
  assert.equal(d.ok, true);
  assert.equal(svc.currentRunId, null);
});
