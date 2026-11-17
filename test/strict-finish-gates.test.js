// 严格 finish 两处门禁：单候选 judge FAIL 阻断；testsRun 证据必须真的通过（P1-1 / P1-2）。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';
import { testsProven } from '../lib/receipts.js';

function mk() {
  const f = path.join(os.tmpdir(), 't2biq-sfg-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const s = new Token2bIQService({ stateFile: null, settingsFile: f });
  s.updateSettings({ pipelineGate: 'strict', forceTeam: 'off' });
  return s;
}
function baseRun(s) {
  const st = s.start({ goal: 'x', mode: 'S2', acceptance: 'x' });
  const runId = st.run.id;
  s.record({ runId, stage: 'plan', status: 'done', summary: '验收：x', acceptance: ['x'] });
  s.record({ runId, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'impl' });
  return runId;
}

test('P1-1：单候选 judge FAIL → finish(PASS) 拒绝；同 slot 后续 PASS 可恢复', () => {
  const s = mk();
  const runId = baseRun(s);
  s.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: [{ cmd: 'node --test', ok: true }] });
  const jFail = s.record({ runId, stage: 'judge', status: 'done', verdict: 'FAIL', issues: ['覆盖不足'] });
  assert.equal(jFail.ok, true, 'judge FAIL 回执本身合法');
  const blocked = s.finish({ runId, verdict: 'PASS' });
  assert.equal(blocked.ok, false, '单候选 judge FAIL 必须阻断交付（修复前只过滤 review/redteam）');
  assert.match(String(blocked.error), /评审|judge|review/);
  const jPass = s.record({ runId, stage: 'judge', status: 'done', verdict: 'PASS' });
  assert.equal(jPass.ok, true);
  assert.equal(s.finish({ runId, verdict: 'PASS' }).ok, true, '同 slot 最新 PASS 应恢复交付');
});

test('P1-1：FAIL 收口不受评审门禁影响（失败运行必须能结束）', () => {
  const s = mk();
  const runId = baseRun(s);
  s.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: [{ cmd: 'node --test', ok: true }] });
  s.record({ runId, stage: 'judge', status: 'done', verdict: 'FAIL', issues: ['x'] });
  assert.equal(s.finish({ runId, verdict: 'FAIL', rationale: '放弃' }).ok, true);
});

test('P1-2：testsRun 全 ok:null（只报命令名）→ finish 拒绝', () => {
  const s = mk();
  const runId = baseRun(s);
  const v = s.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: [{ cmd: 'node --test', ok: null }] });
  assert.equal(v.ok, true, 'record 允许先收下（结果未知），但 finish 必须据此拒绝');
  const f = s.finish({ runId, verdict: 'PASS' });
  assert.equal(f.ok, false, 'ok:null 不能当验证证据');
  assert.match(String(f.error), /验证|testsRun|verify/);
});

test('P1-2：testsRun[{ok:true}] 放行 finish(PASS)', () => {
  const s = mk();
  const runId = baseRun(s);
  s.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: [{ cmd: 'node --test', ok: true }] });
  assert.equal(s.finish({ runId, verdict: 'PASS' }).ok, true);
});

test('P1-2：最新验证回执含 [{ok:false}] → finish 拒绝', () => {
  const s = mk();
  const runId = baseRun(s);
  s.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: [{ cmd: 'node --test', ok: true }] });
  // 直接注入一条更晚的「PASS 但含失败用例」回执，绕过 record 自身校验，专门验证 finish 能独立拦下。
  s.store.addTask(runId, {
    stage: 'verify', status: 'done',
    receipt: { verdict: 'PASS', evidence: [], testsRun: [{ cmd: 'node --test', ok: false }], testsPassed: false },
    tokensIn: 1, tokensOut: 1,
  });
  const f = s.finish({ runId, verdict: 'PASS' });
  assert.equal(f.ok, false, '存在失败用例的验证不得为交付背书');
  assert.match(String(f.error), /验证|testsRun|verify/);
});

test('testsProven 纯函数：ok:null/ok:false=false；ok:true 或 testsPassed:true=true', () => {
  assert.equal(testsProven({ testsRun: [{ cmd: 'x', ok: null }] }), false);
  assert.equal(testsProven({ testsRun: [{ cmd: 'x', ok: false }] }), false);
  assert.equal(testsProven({ testsRun: [{ cmd: 'x', ok: true }] }), true);
  assert.equal(testsProven({ testsPassed: true }), true);
  assert.equal(testsProven({ testsRun: [] }), false);
  assert.equal(testsProven({}), false);
  assert.equal(testsProven(null), false);
  // 自相矛盾回执：显式声称 testsPassed:true，但用例里已有 ok:false —— 一票否决。
  assert.equal(testsProven({ testsPassed: true, testsRun: [{ cmd: 'x', ok: false }] }), false);
  assert.equal(testsProven({ testsPassed: true, testsRun: [{ cmd: 'x', ok: null }] }), true, 'testsPassed:true 仍兼容（无失败用例时）');
});
