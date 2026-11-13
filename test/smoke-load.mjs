// 静态装载冒烟测试：不依赖宿主机/浏览器，验证
//  (1) lib/index.js 可被 Node 装载，apply() 能注册 /token2biq 路由并可应答 state/mode；
//  (2) lib/client.js 作为普通脚本可在 __ModuleLoader__ 下装载，factory 返回模块，
//      apply() 正确注册 main(keyed) 与 sidebar.panellist(list) 两个槽位且都带组件。
// 运行：node test/smoke-load.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok - ' + m); } else { fail++; console.log('  NOT OK - ' + m); } };

// ---------- (1) 宿主模块装载 + 路由 ----------
const routes = {};
const fakeScope = {
  effect(fn) { fn(); return () => {}; },
  webServer: { register(route) { routes[route.kind + ' ' + route.path] = route.handler; return () => {}; } },
  tools: { register(def) { globalThis.__tool = def; return () => {}; } },
  logger: { info() {} },
};
const fakeCtx = {
  inject(_services, cb) { cb(fakeScope); },
  effect(fn) { return fn(); },
  logger: { info() {} },
  get() { return undefined; },
};
const tmpState = join(tmpdir(), 'token2biq-smoke-' + process.pid + '.json');
const host = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);
ok(typeof host.apply === 'function', 'host 导出 apply()');
ok(host.name === 'dsh-token2biq', 'host name === dsh-token2biq');
host.apply(fakeCtx, { stateFile: tmpState });
ok(Object.keys(routes).includes('prefix /token2biq'), '注册了 /token2biq 前缀路由');

const mockRes = () => { const r = { code: 0, headers: {}, body: '' }; r.writeHead = (c, h) => { r.code = c; r.headers = h || {}; return r; }; r.end = (b) => { r.body = b || ''; return r; }; return r; };
const route = routes['prefix /token2biq'];
{
  const res = mockRes();
  await route({ method: 'GET', url: '/token2biq/state' }, res);
  ok(res.code === 200 && /"modes"/.test(res.body), 'GET /token2biq/state 返回含 modes 的 JSON');
}
{
  const res = mockRes();
  const req = { method: 'POST', url: '/token2biq/mode' };
  req.on = (ev, cb) => { if (ev === 'data') cb(JSON.stringify({ mode: 'S2' })); if (ev === 'end') cb(); return req; };
  await route(req, res);
  ok(res.code === 200 && /"mode":"S2"/.test(res.body), 'POST /token2biq/mode 切到 S2');
}
{
  const res = mockRes();
  await route({ method: 'GET', url: '/token2biq/export' }, res);
  ok(res.code === 200 && /text\/markdown/.test(res.headers['content-type'] || ''), 'GET /token2biq/export 返回 markdown');
}

// ---------- (2) 客户端脚本装载 + 槽位注册 ----------
let captured = null;
const fakeWindow = { __ModuleLoader__: { load(o) { captured = o; } } };
const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
const stubReact = { createElement: (...a) => ({ type: a[0], props: a[1] }), useState: (v) => [v, () => {}], useEffect() {}, useCallback: (f) => f };
const fakeRequire = (id) => { if (id === 'react') return stubReact; throw new Error('unexpected require ' + id); };
new Function('window', 'require', src)(fakeWindow, fakeRequire);
ok(captured && captured.id === 'dsh-token2biq', 'client 以 id=dsh-token2biq 调用 __ModuleLoader__.load');
const mod = captured.factory(fakeRequire);
ok(mod && Array.isArray(mod.inject) && mod.inject.includes('slots'), 'client 模块 inject 含 slots');
const regs = [];
const fakeSlots = { inject(_name, cb) { cb(); return () => {}; }, register(opts, comp) { regs.push({ opts, comp }); return () => {}; } };
const fakeClientCtx = { get(n) { return n === 'slots' ? fakeSlots : undefined; }, slots: fakeSlots };
mod.apply(fakeClientCtx);
const mainReg = regs.find((r) => r.opts.name === 'main');
const sideReg = regs.find((r) => r.opts.name === 'sidebar.panellist');
ok(mainReg && mainReg.opts.key === 'token2biq' && typeof mainReg.comp === 'function', 'main(keyed) 以 key=token2biq + 组件注册');
ok(sideReg && sideReg.opts.id === 'token2biq' && sideReg.opts.order === 55 && typeof sideReg.opts.label === 'function' && typeof sideReg.comp === 'function', 'sidebar.panellist(list) 以 id/order/label + 图标组件注册');
const pickReg = regs.find((r) => r.opts.name === 'conversation.input.left');
ok(pickReg && pickReg.opts.id === 'token2biq' && typeof pickReg.comp === 'function', 'conversation.input.left(list) 注册了紧凑档位下拉组件');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
