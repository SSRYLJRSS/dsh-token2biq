// 回归：HTTP 路由接入 DSH 官方 ctx.connection.requestRejection(req)（未信任 Host/Origin → 403，未认证 → 401），
// 并在其放行时叠加既有 Origin 白名单 + 强制 application/json（缺失/非 JSON → 415）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';

let seq = 0;
function settingsFile() {
  return join(tmpdir(), `t2biq-sec-${process.pid}-${Date.now()}-${seq++}.json`);
}

// 假 ctx：inject 一律回调同一个 scope（其中带 connection），get 也返回 connection。
function makeCtx(requestRejection) {
  const captured = {};
  const connection = { requestRejection };
  const scope = {
    effect(fn) { return fn(); },
    webServer: { register(r) { captured.handler = r.handler; return () => {}; } },
    tools: { register(d) { captured.tool = d; return () => {}; } },
    logger: { info() {}, warn() {} },
    connection,
    get(name) { return name === 'connection' ? connection : undefined; },
  };
  const ctx = {
    inject(_names, cb) { cb(scope); },
    effect(fn) { return fn(); },
    on() {},
    logger: { info() {}, warn() {} },
    get(name) { return name === 'connection' ? connection : undefined; },
  };
  return { ctx, captured, connection };
}

// 不提供 connection 时必须 fail closed，不猜测用户的官方信任策略。
function makeCtxNoConn() {
  const captured = {};
  const scope = {
    effect(fn) { return fn(); },
    webServer: { register(r) { captured.handler = r.handler; return () => {}; } },
    tools: { register(d) { captured.tool = d; return () => {}; } },
    logger: { info() {}, warn() {} },
    get() { return undefined; },
  };
  const ctx = {
    inject(_names, cb) { cb(scope); },
    effect(fn) { return fn(); },
    on() {},
    logger: { info() {}, warn() {} },
    get() { return undefined; },
  };
  return { ctx, captured };
}

// mock req/res：res 支持可写 statusCode 与 writeHead/end；req 支持 on('data'/'end')。
function callRoute(handler, { method = 'GET', url, body, headers } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0, headers: {}, body: '',
      writeHead(code, h) { this.statusCode = code; this.headers = h || {}; },
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

test('跨站请求（Origin: http://evil.com）→ requestRejection 返回 403 → handler 响应 403', async () => {
  const rr = (req) => ((req.headers && req.headers.origin) === 'http://evil.com' ? 403 : undefined);
  const { ctx, captured } = makeCtx(rr);
  apply(ctx, { stateFile: null, settingsFile: settingsFile() });
  const r = await callRoute(captured.handler, { method: 'GET', url: '/token2biq/state', headers: { origin: 'http://evil.com' } });
  assert.equal(r.statusCode, 403);
});

test('正常 GET /state（无 origin）→ requestRejection 返回 undefined → 200 且体含 modes', async () => {
  const rr = () => undefined;
  const { ctx, captured } = makeCtx(rr);
  apply(ctx, { stateFile: null, settingsFile: settingsFile() });
  const r = await callRoute(captured.handler, { url: '/token2biq/state' });
  assert.equal(r.statusCode, 200);
  const d = JSON.parse(r.body);
  assert.ok(Array.isArray(d.modes) && d.modes.length > 0, '返回体应含 modes');
});

test('POST 无 content-type（放行态）→ 415（强制 application/json）', async () => {
  const rr = () => undefined;
  const { ctx, captured } = makeCtx(rr);
  apply(ctx, { stateFile: null, settingsFile: settingsFile() });
  const r = await callRoute(captured.handler, { method: 'POST', url: '/token2biq/settings', body: { forceTeam: 'off' } });
  assert.equal(r.statusCode, 415);
});

test('POST 带 application/json → 请求进入处理（非 415）', async () => {
  const rr = () => undefined;
  const { ctx, captured } = makeCtx(rr);
  apply(ctx, { stateFile: null, settingsFile: settingsFile() });
  const r = await callRoute(captured.handler, { method: 'POST', url: '/token2biq/settings', body: { forceTeam: 'off' }, headers: { 'content-type': 'application/json' } });
  assert.equal(r.statusCode, 200);
});

test('requestRejection 返回 401 → GET /state 得 401 且 body 为空（未认证原样传播）', async () => {
  const { ctx, captured } = makeCtx(() => 401);
  apply(ctx, { stateFile: null, settingsFile: settingsFile() });
  const r = await callRoute(captured.handler, { url: '/token2biq/state' });
  assert.equal(r.statusCode, 401);
  assert.equal(r.body, '');
});

test('拒绝 403 且 res.end() 抛异常：仍为 403、body 空，未 fall-through 进业务', async () => {
  const { ctx, captured } = makeCtx(() => 403);
  apply(ctx, { stateFile: null, settingsFile: settingsFile() });
  let endCalls = 0;
  const res = {
    statusCode: 0, body: '',
    writeHead(c) { this.statusCode = c; },
    end(s) { endCalls++; if (endCalls === 1) throw new Error('socket gone'); this.body = s == null ? '' : String(s); },
  };
  const req = { method: 'GET', url: '/token2biq/state', headers: { origin: 'http://evil.com' }, on() { return this; } };
  await captured.handler(req, res); // 若 fall-through 会写入业务 JSON，或抛未捕获错误
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, '');
});

test('content-type application/jsonx → 415（精确匹配，非前缀子串）', async () => {
  const { ctx, captured } = makeCtx(() => undefined);
  apply(ctx, { stateFile: null, settingsFile: settingsFile() });
  const r = await callRoute(captured.handler, { method: 'POST', url: '/token2biq/settings', body: { forceTeam: 'off' }, headers: { 'content-type': 'application/jsonx' } });
  assert.equal(r.statusCode, 415);
});

test('无 connection 时 GET /export → 503 且不抛', async () => {
  const { ctx, captured } = makeCtxNoConn();
  apply(ctx, { stateFile: null, settingsFile: settingsFile() });
  const r = await callRoute(captured.handler, { url: '/token2biq/export', headers: { origin: 'http://evil.com' } });
  assert.equal(r.statusCode, 503);
});

test('official trusted remote origin remains accepted by plugin', async () => {
  const { ctx, captured } = makeCtx(() => undefined);
  apply(ctx, { stateFile: null, settingsFile: settingsFile() });
  const r = await callRoute(captured.handler, { method: 'POST', url: '/token2biq/settings', body: { forceTeam: 'off' }, headers: { origin: 'https://trusted.example', 'content-type': 'application/json' } });
  assert.equal(r.statusCode, 200);
});
