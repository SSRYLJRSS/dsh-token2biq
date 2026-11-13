// 工具注册分支冒烟（无需 @deepseek-ai/dsh-tools）：
// 验证 lib/index.js 以「原生定义对象」向 ctx.tools.register 注册 token2biq，且：
//  (a) index.js 源码不再依赖 @deepseek-ai/dsh-tools（link: 安装也能注册）；
//  (b) apply() 不抛错，ctx.tools.register 收到名为 token2biq 的工具定义；
//  (c) parameters 为完整 JSON Schema（type:object / properties / required）；
//  (d) output.schema 为 string；execute 返回值；execute(start) 含档位与运行 id；
//  (e) output.render 把值渲染为 ContentBlock[]。
// 运行：node test/smoke-tool.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..'); // dsh-token2biq

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok - ' + m); } else { fail++; console.log('  NOT OK - ' + m); } };

try {
  const src = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  ok(!/import\s*\(\s*['"]@deepseek-ai\/dsh-tools|from\s+['"]@deepseek-ai\/dsh-tools/.test(src), 'index.js 不 import @deepseek-ai/dsh-tools');

  let captured = null;
  const fakeScope = {
    effect(fn) { return fn(); },
    webServer: { register() { return () => {}; } },
    tools: { register(def) { captured = def; return () => {}; } },
    logger: { info() {} },
  };
  const fakeCtx = {
    inject(_s, cb) { cb(fakeScope); },
    effect(fn) { return fn(); },
    on() {},
    logger: { info() {} },
    get() { return undefined; },
  };

  const host = await import(pathToFileURL(join(root, 'lib', 'index.js')).href + '?plain=' + Date.now());
  ok(typeof host.apply === 'function', 'host 导出 apply()');
  host.apply(fakeCtx, { stateFile: join(tmpdir(), 'token2biq-tool-smoke-' + process.pid + '.json') });

  ok(captured && captured.name === 'token2biq', '注册了名为 token2biq 的工具');
  ok(typeof captured.execute === 'function', 'execute 为函数（契约 execute(args,exec)=>Promise）');
  ok(captured.output && typeof captured.output.render === 'function', 'output.render 为函数（=>ContentBlock[]）');
  ok(captured.parameters && captured.parameters.type === 'object', 'parameters 是 JSON Schema 对象');
  ok(captured.parameters.properties && captured.parameters.properties.action && captured.parameters.properties.action.type === 'string', 'properties.action 为 string');
  ok(Array.isArray(captured.parameters.required) && captured.parameters.required.includes('action'), 'required 含 action');
  ok(captured.parameters.properties.files && captured.parameters.properties.files.type === 'array' && captured.parameters.properties.files.items.type === 'string', 'files 为 string 数组规格');
  ok(captured.output && captured.output.schema && captured.output.schema.type === 'string', 'output.schema 为 string');

  const res = await captured.execute({ action: 'start', goal: '实现一个快速排序函数并测试', mode: 'S1' });
  ok(typeof res === 'string', 'execute(start) 返回字符串值');
  ok(/S1/.test(res) && /(runId|"id")/.test(res), 'execute(start) 文本含档位与运行 id');

  const rendered = captured.output.render({}, res);
  ok(Array.isArray(rendered) && rendered[0] && rendered[0].type === 'text' && rendered[0].text === res, 'output.render 返回 ContentBlock[] 且文本一致');
} finally {
  /* 无需清理 */
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
