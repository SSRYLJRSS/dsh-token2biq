// 0.7.0 维护轮：readJson/compact/usage/settings/report/autoprovision/autoBoard/client 回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readJson, compactToolResult, makeLlmClassifier, apply as applyPlugin } from '../lib/index.js';
import { Token2bIQService } from '../lib/service.js';
import { normalizeSettings, normalizeReasoning } from '../lib/settings.js';
import { buildReport } from '../lib/report.js';
import { collectModelRefs } from '../lib/autoprovision.js';

function tmp(name) {
  return path.join(os.tmpdir(), 't2biq-maint-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '-' + name);
}
function fakeReq(chunks, opts) {
  const req = new EventEmitter();
  const o = opts || {};
  setImmediate(() => {
    for (const c of chunks) req.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    if (o.abort) req.emit('close');
    else req.emit('end');
  });
  return req;
}
function mkService() {
  return new Token2bIQService({ stateFile: tmp('state.json'), settingsFile: tmp('settings.json') });
}

test('readJson: 跨块中文/emoji UTF-8 不损坏', async () => {
  const text = JSON.stringify({ goal: '中文'.repeat(400), note: 'emoji😀ok' });
  const raw = Buffer.from(text, 'utf8');
  // 在 3 字节/4 字节字符中间切块，模拟 Node data 事件
  const chunks = [raw.subarray(0, 10), raw.subarray(10, 11), raw.subarray(11, 12), raw.subarray(12, 15), raw.subarray(15)];
  const body = await readJson(fakeReq(chunks));
  assert.equal(body.goal, '中文'.repeat(400));
  assert.equal(body.note, 'emoji😀ok');
});

test('readJson: 非法 JSON 返回 __badJson，abort 返回 __aborted', async () => {
  const bad = await readJson(fakeReq([Buffer.from('{bad json')]));
  assert.equal(bad.__badJson, true);
  const aborted = await readJson(fakeReq([Buffer.from('{"a":1')], { abort: true }));
  assert.equal(aborted.__aborted, true);
});

test('compactToolResult: 大 roster 时第 2 级不把 roster 回灌、保住 created/modelRouting', () => {
  const result = {
    ok: true,
    created: { tasks: [{ id: 't1', subject: 'x' }] },
    modelRouting: [{ stage: 'generate', model: 'magpie::m', taskId: 't1' }],
    roster: 'R'.repeat(20000),
    extra: 'E'.repeat(9000),
  };
  const out = compactToolResult(result, 8192);
  assert.equal(typeof out, 'string');
  assert.ok(out.length <= 8192, '输出应 <= 8192');
  assert.match(out, /created/);
  assert.match(out, /modelRouting/);
  assert.doesNotMatch(out, /"truncated":true/);
});

test('compactToolResult: undefined/null 不返回 undefined', () => {
  assert.equal(typeof compactToolResult(undefined), 'string');
  assert.equal(typeof compactToolResult(null), 'string');
});

test('noteUsage: 分类 token 跳过，普通调用正常计数', () => {
  const s = mkService();
  const token = {};
  s._classifyingTokens = new Set([token]);
  s.noteUsage({ inputTokens: 10, totalTokens: 10 }, 's1', token);
  assert.equal(s.live.requests, 0);
  s.noteUsage({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }, 's1');
  assert.equal(s.live.requests, 1);
  assert.equal(s.live.total, 10);
});

test('makeLlmClassifier: 分类流携带 token 且请求结束后清理', async () => {
  const s = mkService();
  let captured = null;
  const ctx = { get(name) {
    if (name === 'llm') return { stream: (options) => {
      captured = options;
      return (async function* () {
        svcNote(s, options);
        yield { type: 'text-delta', text: '{"tier":"S2","worthTeam":true,"reason":"多文件"}' };
      })();
    } };
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    return null;
  } };
  function svcNote(svc, options) {
    // 模拟 llm/stream tap 在分类流进行中拿到 usage
    svc.noteUsage({ totalTokens: 99, inputTokens: 50, outputTokens: 49 }, 's1', options._t2biqClassify);
  }
  const fn = makeLlmClassifier(ctx, () => {}, s);
  const res = await fn('多文件重构');
  assert.equal(res.tier, 'S2');
  assert.ok(captured && captured._t2biqClassify, '分类流必须携带 token');
  assert.equal(s.live.total, 0, '分类流 usage 不得计入');
  assert.equal(s._classifyingTokens.size, 0, '分类结束后 token 必须清理');
});

test('llm/stream: error/aborted 无 usage 时也补记 requests，且不吞流', async () => {
  const routes = {};
  const scope = {
    effect(fn) { fn(); return () => {}; },
    webServer: { register(r) { routes[r.kind + ' ' + r.path] = r.handler; return () => {}; } },
    tools: { register() { return () => {}; } },
    logger: { info() {} },
  };
  let tap = null;
  const ctx = {
    inject(_d, cb) { cb(scope); },
    effect(fn) { return fn(); },
    on(name, fn) { if (name === 'llm/stream') tap = fn; },
    logger: { info() {} },
    get(name) { return name === 'connection' ? { requestRejection: () => undefined } : undefined; },
  };
  applyPlugin(ctx, { stateFile: tmp('state.json') });
  const run = async (reason) => {
    const gen = tap({ sessionId: 's-err' }, () => (async function* () {
      yield { type: 'finish', reason: { kind: reason } };
    })());
    let sawFinish = false;
    for await (const c of gen) if (c && c.type === 'finish') sawFinish = true;
    assert.equal(sawFinish, true, 'finish 必须透传下游');
  };
  await run('error');
  await run('aborted');
  const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b || ''; } };
  await routes['prefix /token2biq']({ method: 'GET', url: '/token2biq/state' }, res);
  const j = JSON.parse(res.body);
  assert.equal(j.liveUsage.requests, 2);
  assert.equal(j.liveUsage.total, 0);
});

test('settings: 中文档位别名与 synth 思考强度', () => {
  assert.equal(normalizeSettings({ defaultMode: '轻量' }).defaultMode, 'S1');
  assert.equal(normalizeSettings({ defaultMode: '标准' }).defaultMode, 'S2');
  assert.equal(normalizeSettings({ defaultMode: '完整' }).defaultMode, 'S3');
  assert.equal(normalizeSettings({ defaultMode: '完整加强' }).defaultMode, 'S4');
  assert.equal(normalizeSettings({ defaultMode: '普通' }).defaultMode, 'S1');
  const rr = normalizeReasoning({ byRole: { synth: 'high' } });
  assert.equal(rr.byRole.synth, 'high');
});

test('report: 非法事件时间与 null modelRouting 不抛', () => {
  const md = buildReport({
    id: 'r1', mode: 'S3', status: 'running', plan: {}, ledger: { stages: {} },
    tasks: [], stages: [], reviews: [], events: [{ ts: 'not-a-date', kind: 'x' }],
    modelRouting: [null, { stage: 'generate', model: 'magpie::m' }],
  });
  assert.match(md, /--:--:--/);
  assert.match(md, /generate=magpie::m/);
});

test('autoprovision: 列表式 providers[].name/models[].id 可收集；映射式回归', () => {
  const listYaml = [
    'llm-pi-ai:', '  providers:', '    - name: openai', '      models:', '        - id: gpt-4o',
    '    - name: anthropic', '      models:', '        - id: claude-3', '',
  ].join('\n');
  assert.deepEqual(collectModelRefs(listYaml), [
    { provider: 'anthropic', model: 'claude-3' },
    { provider: 'openai', model: 'gpt-4o' },
  ]);
  const mapYaml = [
    'llm-pi-ai:', '  providers:', '    magpie:', '      models:', '        - id: workbuddy/hy4std',
    '        - id: workbuddy/glm-5.3-flash', '',
  ].join('\n');
  assert.deepEqual(collectModelRefs(mapYaml), [
    { provider: 'magpie', model: 'workbuddy/glm-5.3-flash' },
    { provider: 'magpie', model: 'workbuddy/hy4std' },
  ]);
});

test('autoBoard: 全量建档失败时落盘不得是 orchestrated:true', async () => {
  const stateFile = tmp('state.json');
  const settingsFile = tmp('settings.json');
  const s = new Token2bIQService({ stateFile, settingsFile });
  const agent = { id: 'lead-x' };
  const agentTeams = {
    isEnabled: () => true,
    createTask: async () => { throw new Error('board down'); },
  };
  const subagents = { rootOf: () => agent };
  const base = await s.startWithAuto({ goal: '大改一个模块', mode: 'S3', taskType: 'code' }, { agentTeams, subagents, agent });
  assert.ok(base && base.run && base.run.id);
  const s2 = new Token2bIQService({ stateFile, settingsFile });
  const run = s2.store.getRun(base.run.id);
  assert.ok(run);
  assert.notEqual(run.orchestrated, true, '落盘快照不能是 orchestrated:true');
  assert.equal(run.degraded, 'no-orchestration');
});

test('client: verdict 查询失败不得写 null 负缓存', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /vcache\.current\[r\.id\]\s*=\s*null/);
});
