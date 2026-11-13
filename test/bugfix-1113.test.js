// 2026-11-13 复盘发现并修复的缺陷回归测试（发布前加固）。
// 覆盖：S4 锁定/强制、strict 空 testsRun 漏洞、会话档位持久化、工具 schema 参数缺失、打包漏发 model-routes.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { buildPolicy } from '../lib/orchestrator.js';
import { effectiveForceTeam } from '../lib/settings.js';
import { Token2bIQService } from '../lib/service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let seq = 0;
function mk(stateFile) {
  const sf = join(tmpdir(), `t2biq-bf-${process.pid}-${Date.now()}-${seq++}.json`);
  return new Token2bIQService({ stateFile: stateFile || null, settingsFile: sf });
}

test('buildPolicy：锁定 S4 也必须先 start、禁止单干（修复前 locked 漏了 S4，会退化成"小任务直接做"）', () => {
  const p = buildPolicy('lead', { mode: 'S4' });
  assert.match(p, /锁定为 S4/);
  assert.match(p, /MUST 先调用 token2biq action=start \{mode:"S4"\}/);
  assert.match(p, /禁止单干/);
  // 仍然保留模型路由指引
  assert.match(p, /subagent/);
});

test('effectiveForceTeam：auto 模式下 S4 与 S2/S3 一样强制团队（完整加强不该比完整更松）', () => {
  assert.equal(effectiveForceTeam({ forceTeam: 'auto' }, 'S2'), true);
  assert.equal(effectiveForceTeam({ forceTeam: 'auto' }, 'S3'), true);
  assert.equal(effectiveForceTeam({ forceTeam: 'auto' }, 'S4'), true);
  assert.equal(effectiveForceTeam({ forceTeam: 'auto' }, 'S1'), false);
  assert.equal(effectiveForceTeam({ forceTeam: 'off' }, 'S4'), false);
});

test('strict：空数组 testsRun 不算验证证据（修复前 [] 因 truthy 蒙混过关）', () => {
  const svc = mk();
  svc.updateSettings({ pipelineGate: 'strict', forceTeam: 'off' });
  const st = svc.start({ goal: 'x', mode: 'S2' });
  const runId = st.run.id;
  svc.record({ runId, stage: 'plan', status: 'done', summary: '验收：x', acceptance: ['x'] });
  svc.record({ runId, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'impl' });
  const vEmpty = svc.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: [] });
  assert.equal(vEmpty.ok, false);
  assert.match(vEmpty.error, /testsRun/);
  const vOk = svc.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: ['node --test'] });
  assert.equal(vOk.ok, true);
  const f = svc.finish({ runId, verdict: 'PASS' });
  assert.equal(f.ok, true);
});

test('setSessionPref：会话档位选择落盘到 store.mode，宿主重启后沿用（修复前只存内存 Map）', () => {
  const stateFile = join(tmpdir(), `t2biq-bf-state-${process.pid}-${Date.now()}.json`);
  const a = mk(stateFile);
  a.setSessionPref('sess-x', { enabled: true, mode: 'S3' });
  assert.equal(a.store.getMode(), 'S3');
  const b = mk(stateFile); // 模拟宿主重启：同一 state 文件重新构造
  assert.equal(b.getMode(), 'S3');
});

test('tool schema：start/record 的候选与验收参数已进 parameters（否则被 additionalProperties:false 挡在工具外）', async () => {
  const { apply } = await import('../lib/index.js');
  let captured = null;
  const fakeScope = {
    effect(fn) { return fn(); },
    webServer: { register() { return () => {}; } },
    tools: { register(def) { captured = def; return () => {}; } },
    logger: { info() {} },
  };
  const fakeCtx = {
    inject(_s, cb) { cb(fakeScope); return () => {}; },
    effect(fn) { return fn(); },
    on() {},
    logger: { info() {} },
    get() { return undefined; },
  };
  apply(fakeCtx, { stateFile: join(tmpdir(), `t2biq-tool-${process.pid}-${Date.now()}.json`), settingsFile: join(tmpdir(), `t2biq-tool-s-${process.pid}.json`) });
  assert.ok(captured && captured.parameters && captured.parameters.properties, '工具已注册且带 parameters');
  const props = captured.parameters.properties;
  for (const k of ['acceptance', 'spec', 'constraints', 'candidates', 'candidateId', 'selectedCandidate', 'testsPassed']) {
    assert.ok(props[k], '缺少参数：' + k);
  }
  assert.equal(captured.parameters.additionalProperties, false);
});

test('packaging：lib/ 下的模块都会随包发布（修复前枚举式 files 漏了 model-routes.js，安装即崩）', () => {
  const root = join(__dirname, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const shipsWholeLib = files.some((f) => f === 'lib/' || f === 'lib');
  const shippedLib = new Set(files.filter((f) => f.startsWith('lib/')).map((f) => f.slice(4)));
  const libFiles = readdirSync(join(root, 'lib')).filter((f) => f.endsWith('.js'));
  if (!shipsWholeLib) {
    for (const f of libFiles) assert.ok(shippedLib.has(f), `lib/${f} 未被 package.json files 包含，安装后会缺文件`);
  }
  // 关键回归：无论如何 model-routes.js 必须在发布集合内
  assert.ok(shipsWholeLib || shippedLib.has('model-routes.js'), 'model-routes.js 必须随包发布');
});
