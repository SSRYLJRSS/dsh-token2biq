// 严格流水线（pipelineGate=strict）与候选择优协议的回归测试。
// 目标：把「审题/规格 → 实现 → 验证硬门禁 → 择优」从口头规范变成 record/finish 的硬约束。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Token2bIQService } from '../lib/service.js';

let seq = 0;
function mk() {
  const sf = join(tmpdir(), `t2biq-pipe-${process.pid}-${Date.now()}-${seq++}.json`);
  return new Token2bIQService({ stateFile: null, settingsFile: sf });
}

test('默认宽松（pipelineGate=off）：generate 无需 spec 也可记账（向后兼容）', () => {
  const svc = mk();
  const st = svc.start({ goal: '小改一处', mode: 'S1' });
  const r = svc.record({ runId: st.run.id, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: '改了一行' });
  assert.equal(r.ok, true);
});

test('strict：无 spec 不许进 generate；record plan 带验收标准后放行', () => {
  const svc = mk();
  svc.updateSettings({ pipelineGate: 'strict', forceTeam: 'off' });
  const st = svc.start({ goal: '重构模块 A', mode: 'S2' });
  const runId = st.run.id;
  assert.equal(st.pipelineGate, 'strict');
  const g1 = svc.record({ runId, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'impl' });
  assert.equal(g1.ok, false);
  assert.match(g1.error, /spec|验收/);
  const p = svc.record({ runId, stage: 'plan', status: 'done', summary: '验收标准：a.js 导出 x 且测试通过', acceptance: ['a.js 导出 x'] });
  assert.equal(p.ok, true);
  const g2 = svc.record({ runId, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'impl' });
  assert.equal(g2.ok, true);
});

test('strict：verify 无 testsRun 被拒；带 testsRun 且 PASS 后 finish 放行', () => {
  const svc = mk();
  svc.updateSettings({ pipelineGate: 'strict', forceTeam: 'off' });
  const st = svc.start({ goal: '重构模块 B', mode: 'S2' });
  const runId = st.run.id;
  svc.record({ runId, stage: 'plan', status: 'done', summary: '验收：x', acceptance: ['x'] });
  svc.record({ runId, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'impl' });
  const v1 = svc.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS' });
  assert.equal(v1.ok, false);
  assert.match(v1.error, /testsRun/);
  const v2 = svc.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: 'npm test' });
  assert.equal(v2.ok, true);
  const f = svc.finish({ runId, verdict: 'PASS' });
  assert.equal(f.ok, true);
});

test('strict：finish 前无 verify 被硬拒（不许未验证就交付）', () => {
  const svc = mk();
  svc.updateSettings({ pipelineGate: 'strict', forceTeam: 'off' });
  const st = svc.start({ goal: '重构模块 C', mode: 'S2' });
  const runId = st.run.id;
  svc.record({ runId, stage: 'plan', status: 'done', summary: '验收：x', acceptance: ['x'] });
  svc.record({ runId, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'impl' });
  const f = svc.finish({ runId, verdict: 'PASS' });
  assert.equal(f.ok, false);
  assert.match(f.error, /验证|verify/);
});

test('strict+多候选：generate 需 candidateId、judge 需 selectedCandidate、finish 需 judge 择优', () => {
  const svc = mk();
  svc.updateSettings({ pipelineGate: 'strict', forceTeam: 'off' });
  const st = svc.start({ goal: '多候选实现 D', mode: 'S2', candidates: 3 });
  const runId = st.run.id;
  assert.equal(st.candidates, 3);
  svc.record({ runId, stage: 'plan', status: 'done', summary: '验收：x', acceptance: ['x'] });
  const g0 = svc.record({ runId, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'impl' });
  assert.equal(g0.ok, false);
  assert.match(g0.error, /candidateId/);
  const g1 = svc.record({ runId, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'c1', candidateId: 'c1' });
  assert.equal(g1.ok, true);
  const j0 = svc.record({ runId, stage: 'judge', status: 'done', verdict: 'PASS' });
  assert.equal(j0.ok, false);
  assert.match(j0.error, /selectedCandidate/);
  const j1 = svc.record({ runId, stage: 'judge', status: 'done', verdict: 'PASS', selectedCandidate: 'c1', rationale: 'c1 单测覆盖最高' });
  assert.equal(j1.ok, true);
  svc.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: 'npm test' });
  const f = svc.finish({ runId, verdict: 'PASS' });
  assert.equal(f.ok, true);
});

test('strict：runView 暴露 spec 与 candidates', () => {
  const svc = mk();
  svc.updateSettings({ pipelineGate: 'strict', forceTeam: 'off' });
  const st = svc.start({ goal: 'E', mode: 'S2', candidates: 2 });
  const runId = st.run.id;
  svc.record({ runId, stage: 'plan', status: 'done', summary: '验收：y', acceptance: ['y'] });
  const view = svc.runView(svc.store.getRun(runId));
  assert.equal(view.candidates, 2);
  assert.ok(view.spec && /验收/.test(view.spec.summary));
});

test('strict：S1 无 plan 阶段——靠 start 的 acceptance 提供 spec 后 generate 放行（修死锁）', () => {
  const svc = mk();
  svc.updateSettings({ pipelineGate: 'strict', forceTeam: 'off' });
  const a = svc.start({ goal: 'S1 任务', mode: 'S1' });
  const g0 = svc.record({ runId: a.run.id, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'x' });
  assert.equal(g0.ok, false);
  assert.match(g0.error, /spec|验收/);
  const b = svc.start({ goal: 'S1 任务带验收', mode: 'S1', acceptance: ['a.js 导出 x'] });
  const g1 = svc.record({ runId: b.run.id, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'x' });
  assert.equal(g1.ok, true);
});

test('会话开关：关闭后 startWithAuto 拒绝；开启档位覆盖；未设置不拦截', async () => {
  const svc = mk();
  svc.setSessionPref('sess-1', { enabled: false });
  const r0 = await svc.startWithAuto({ goal: 'x' }, { agent: { session: { id: 'sess-1' } } });
  assert.equal(r0.ok, false);
  assert.equal(r0.disabled, true);
  svc.setSessionPref('sess-1', { enabled: true, mode: 'S2' });
  const r1 = await svc.startWithAuto({ goal: 'x' }, { agent: { session: { id: 'sess-1' } } });
  assert.equal(r1.ok, true);
  assert.equal(r1.plan.mode, 'S2');
  const r2 = await svc.startWithAuto({ goal: 'x' }, { agent: { session: { id: 'sess-2' } } });
  assert.equal(r2.ok, true);
});
