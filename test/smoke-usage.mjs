// 冒烟测试：验证宿主 llm/stream 监听 → service.noteUsage → /state.liveUsage 的完整链路，
// 以及 POST /token2biq/action {action:'help'} 返回用法。纯 Node，不依赖真实模型。
// 运行：node test/smoke-usage.mjs
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok - ' + m); } else { fail++; console.log('  NOT OK - ' + m); } };

const routes = {};
const scope = {
  effect(fn) { fn(); return () => {}; },
  webServer: { register(r) { routes[r.kind + ' ' + r.path] = r.handler; return () => {}; } },
  tools: { register() { return () => {}; } },
  logger: { info() {} },
};
let streamTap = null;
const ctx = {
  inject(_d, cb) { cb(scope); },
  effect(fn) { return fn(); },
  on(name, fn) { if (name === 'llm/stream') streamTap = fn; },
  logger: { info() {} },
  get() { return undefined; },
};
const tmpState = join(tmpdir(), 'token2biq-usage-' + process.pid + '.json');
const host = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);
host.apply(ctx, { stateFile: tmpState });
ok(typeof streamTap === 'function', '注册了 llm/stream 监听器');

// 驱动一次模型流：usage 分片应被累计
const mkStream = async function* () {
  yield { type: 'text-delta', index: 0, text: 'hi' };
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 40, reasoningTokens: 5 } };
};
const gen = streamTap({ sessionId: 'sess-X' }, () => mkStream());
let saw = 0;
for await (const c of gen) { if (c && c.type === 'usage') saw++; }
ok(saw === 1, 'usage 分片透传给下游（不吞流）');

const mockRes = () => { const r = { code: 0, headers: {}, body: '' }; r.writeHead = (c, h) => { r.code = c; r.headers = h || {}; return r; }; r.end = (b) => { r.body = b || ''; return r; }; return r; };
const route = routes['prefix /token2biq'];
{
  const res = mockRes();
  await route({ method: 'GET', url: '/token2biq/state' }, res);
  const j = JSON.parse(res.body);
  ok(res.code === 200 && j.liveUsage && j.liveUsage.total === 125, '/state.liveUsage 累计 = 125');
  ok(j.liveUsage.requests === 1 && j.liveUsage.sessions[0].id === 'sess-X', 'liveUsage 按会话归集 requests=1 / sess-X');
}
{
  const res = mockRes();
  const req = { method: 'POST', url: '/token2biq/action' };
  req.on = (ev, cb) => { if (ev === 'data') cb(JSON.stringify({ action: 'help' })); if (ev === 'end') cb(); return req; };
  await route(req, res);
  const j = JSON.parse(res.body);
  ok(res.code === 200 && j.ok && typeof j.usage === 'string' && /start/.test(j.usage), 'POST action=help 返回用法文本');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
