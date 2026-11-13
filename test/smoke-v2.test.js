// 宿主侧无头集成冒烟：不启动真实 DSH，用假 ctx 装载 lib/index.js 的 apply()，
// 验证 web 路由（/settings、/models）、工具动作（action=settings）都能跑通。
// 目的：在不重启进程的前提下，证明 v2 的宿主代码是可装载、可用的。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

function makeCtx(modelCatalog) {
  const captured = { handler: null, tool: null };
  const services = { sessionController: modelCatalog ? { modelCatalog } : undefined };
  const ctx = {
    logger: { info() {} },
    on() {},
    get(name) { return services[name]; },
    inject(_deps, cb) {
      const sctx = {
        effect(fn) { return fn(); },
        get(name) { return services[name]; },
        webServer: { register(route) { captured.handler = route.handler; return () => {}; } },
        tools: { register(def) { captured.tool = def; return () => {}; } },
      };
      cb(sctx);
    },
  };
  return { ctx, captured };
}

function callRoute(handler, { method = 'GET', url = '/token2biq/settings', body } = {}) {
  return new Promise((resolve) => {
    const res = {
      status: 0, headers: {}, body: '',
      writeHead(code, headers) { this.status = code; this.headers = headers || {}; },
      end(s) { this.body = s == null ? '' : String(s); resolve(this); },
    };
    const req = {
      method, url,
      on(ev, cb) {
        if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body), 'utf8'));
        else if (ev === 'end') cb();
        return this;
      },
    };
    handler(req, res);
  });
}

test('apply: 注册 token2biq 工具，action=settings 返回当前设置', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-smoke-'));
  const settingsFile = path.join(dir, 'settings.json');
  const { ctx, captured } = makeCtx();
  apply(ctx, { stateFile: null, settingsFile });
  assert.ok(captured.tool, 'tool 应已注册');
  assert.equal(captured.tool.name, 'token2biq');
  const out = JSON.parse(await captured.tool.execute({ action: 'settings' }));
  assert.equal(out.ok, true);
  assert.equal(out.settings.forceTeam, 'auto');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET /token2biq/settings 返回设置；POST 可改并持久化', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-smoke-'));
  const settingsFile = path.join(dir, 'settings.json');
  const { ctx, captured } = makeCtx();
  apply(ctx, { stateFile: null, settingsFile });

  const r1 = await callRoute(captured.handler, { url: '/token2biq/settings' });
  assert.equal(r1.status, 200);
  assert.equal(JSON.parse(r1.body).settings.forceTeam, 'auto');

  const r2 = await callRoute(captured.handler, { method: 'POST', url: '/token2biq/settings', body: { forceTeam: true, defaultMode: 'S2', roleModels: { review: 'a::b' } } });
  assert.equal(r2.status, 200);
  const s2 = JSON.parse(r2.body).settings;
  assert.equal(s2.forceTeam, 'on');
  assert.equal(s2.defaultMode, 'S2');
  assert.equal(s2.roleModels.review, 'a::b');

  // 重新装载应读到持久化值
  const { ctx: ctx2 } = makeCtx();
  const captured2 = {};
  const ctxB = {
    logger: { info() {} }, on() {}, get() {},
    inject(_d, cb) { cb({ effect: (fn) => fn(), get() {}, webServer: { register(r) { captured2.handler = r.handler; return () => {}; } }, tools: { register(d) { captured2.tool = d; return () => {}; } } }); },
  };
  apply(ctxB, { stateFile: null, settingsFile });
  const r3 = await callRoute(captured2.handler, { url: '/token2biq/settings' });
  assert.equal(JSON.parse(r3.body).settings.forceTeam, 'on');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET /token2biq/models: 归一化 modelCatalog 为 provider::model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-smoke-'));
  const modelCatalog = async () => ({
    default: { provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash' },
    groups: [
      { id: 'magpie', name: 'Magpie', models: [{ id: 'workbuddy/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] },
      { id: 'magpie-anthropic', name: 'Magpie Anthropic', models: [{ id: 'slo-claude-0-12/claude-sonnet-5-5', name: 'Claude Sonnet' }] },
    ],
    failures: [],
  });
  const { ctx, captured } = makeCtx(modelCatalog);
  apply(ctx, { stateFile: null, settingsFile: path.join(dir, 's.json') });
  const r = await callRoute(captured.handler, { url: '/token2biq/models' });
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.ok, true);
  const refs = d.models.map((m) => m.ref);
  assert.ok(refs.includes('magpie::workbuddy/deepseek-v4.1-flash'));
  assert.ok(refs.includes('magpie-anthropic::slo-claude-0-12/claude-sonnet-5-5'));
  assert.equal(d.models[0].provider, 'magpie');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET /token2biq/state 暴露 settings；无 modelCatalog 时 /models 优雅降级', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-smoke-'));
  const { ctx, captured } = makeCtx(); // 无 sessionController
  apply(ctx, { stateFile: null, settingsFile: path.join(dir, 's.json') });
  const st = await callRoute(captured.handler, { url: '/token2biq/state' });
  assert.equal(st.status, 200);
  const sd = JSON.parse(st.body);
  assert.ok(sd.settings && sd.settings.forceTeam === 'auto');
  const md = await callRoute(captured.handler, { url: '/token2biq/models' });
  const mdd = JSON.parse(md.body);
  assert.equal(mdd.ok, false);
  assert.deepEqual(mdd.models, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
