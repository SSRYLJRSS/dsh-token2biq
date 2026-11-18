// 0.7.0 新增：任务类型（code / investigation）与调查类流水线。
// 覆盖点：
//  · 任务类型判定（保守：出现任何代码动作词一律 code）
//  · 调查类计划不含 generate，改由 synth 成稿
//  · pipelineGate=auto 按任务类型/档位决定生效门禁
//  · 调查类运行能在 strict 下正常 finish(PASS)（不再被 generate 缺失卡死）
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';
import { detectTaskType, resolveTaskType, generatePlan, INVESTIGATION_PLANS } from '../lib/orchestrator.js';
import { validateReceiptByStage } from '../lib/receipts.js';
import { effectivePipelineGate, normalizePipelineGate, normalizeTaskType } from '../lib/settings.js';

function mk(over = {}) {
  const f = path.join(os.tmpdir(), 't2biq-inv-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const s = new Token2bIQService({ stateFile: null, settingsFile: f });
  s.updateSettings({ forceTeam: 'off', ...over });
  return s;
}

test('任务类型判定：调查类需 >=2 个调查信号且无代码动作词', () => {
  assert.equal(detectTaskType('调查并回顾今天和昨天的对话记录'), 'investigation');
  assert.equal(detectTaskType('调研与盘点现有插件能力'), 'investigation');
  // 只要出现代码动作词，一律按代码任务处理（保守）。
  assert.equal(detectTaskType('全面复盘并优化 dsh-token2biq 插件'), 'code');
  assert.equal(detectTaskType('实现登录功能并修复重试 bug'), 'code');
  // 无信号默认代码任务。
  assert.equal(detectTaskType('随便看看'), 'code');
  assert.equal(detectTaskType(''), 'code');
});

test('任务类型解析：显式值优先于自动判定', () => {
  assert.equal(resolveTaskType('code', '调查并回顾对话'), 'code');
  assert.equal(resolveTaskType('investigation', '实现登录'), 'investigation');
  assert.equal(resolveTaskType('auto', '调查并回顾今天和昨天的对话'), 'investigation');
  assert.equal(resolveTaskType(null, '实现登录'), 'code');
});

test('调查类计划：不含 generate，改由 synth 成稿', () => {
  const inv = generatePlan('S3', { goal: '调查并回顾一段对话记录', taskType: 'investigation' });
  assert.equal(inv.taskType, 'investigation');
  assert.ok(!inv.stages.includes('generate'), '调查类不应有 generate 阶段');
  assert.ok(inv.stages.includes('synth'), '调查类必须有 synth 成稿阶段');
  assert.ok(inv.stages.includes('verify'), '调查类必须有独立验证');
  // 未传 risk → 只展开 coreStages（judge/redteam 是 risk=high 的可选阶段）。
  assert.deepEqual(inv.stages, INVESTIGATION_PLANS.S3.coreStages);

  const code = generatePlan('S3', { goal: '实现登录', taskType: 'code' });
  assert.equal(code.taskType, 'code');
  assert.ok(code.stages.includes('generate'));
  assert.ok(!code.stages.includes('synth'));
});

test('调查类计划按档位收缩：S1 只有 research/synth/verify', () => {
  const p = generatePlan('S1', { goal: '调查并回顾历史记录', taskType: 'investigation' });
  assert.deepEqual(p.stages, ['research', 'synth', 'verify']);
  assert.equal(p.maxAgents, 1);
});

test('pipelineGate=auto：S3 代码任务 strict；S2 代码与调查任务 off', () => {
  assert.equal(normalizePipelineGate('auto'), 'auto');
  assert.equal(normalizePipelineGate('STRICT'), 'strict');
  assert.equal(normalizePipelineGate('nonsense'), 'off');
  assert.equal(effectivePipelineGate({ pipelineGate: 'strict' }, { mode: 'S2' }), 'strict');
  assert.equal(effectivePipelineGate({ pipelineGate: 'off' }, { mode: 'S3' }), 'off');
  assert.equal(effectivePipelineGate({ pipelineGate: 'auto' }, { mode: 'S3', taskType: 'code' }), 'strict');
  assert.equal(effectivePipelineGate({ pipelineGate: 'auto' }, { mode: 'S2', taskType: 'code' }), 'off');
  assert.equal(effectivePipelineGate({ pipelineGate: 'auto' }, { mode: 'S3', taskType: 'investigation' }), 'off');
  assert.equal(effectivePipelineGate({ pipelineGate: 'auto' }, null), 'off');
});

test('settings：taskType 归一化', () => {
  assert.equal(normalizeTaskType('CODE'), 'code');
  assert.equal(normalizeTaskType('investigation'), 'investigation');
  assert.equal(normalizeTaskType('乱写'), 'auto');
  assert.equal(normalizeTaskType(null), 'auto');
});

test('synth 回执按 worker 契约校验：需要 files + diffSummary', () => {
  const ok = validateReceiptByStage('synth', { files: ['report.md'], diffSummary: '产出调查报告' });
  assert.equal(ok.ok, true);
  const bad = validateReceiptByStage('synth', { files: [], diffSummary: '' });
  assert.equal(bad.ok, false);
});

test('调查类运行：strict 下无 generate 也能正常 finish(PASS)', () => {
  const s = mk({ pipelineGate: 'strict' });
  const st = s.start({ goal: '调查并回顾今天和昨天的对话记录', mode: 'S3', taskType: 'investigation' });
  assert.equal(st.ok, true);
  assert.equal(st.taskType, 'investigation');
  const runId = st.run.id;

  assert.equal(s.record({ runId, stage: 'research', status: 'done', summary: '拿到 47 次运行台账与 258 次 tool_use' }).ok, true);
  assert.equal(s.record({ runId, stage: 'synth', status: 'done', files: ['report.md'], diffSummary: '产出调查报告' }).ok, true);
  assert.equal(s.record({ runId, stage: 'review', status: 'done', verdict: 'PASS' }).ok, true);
  assert.equal(s.record({ runId, stage: 'verify', status: 'done', verdict: 'PASS', testsRun: [{ cmd: 'node --test', ok: true }] }).ok, true);

  const f = s.finish({ runId, verdict: 'PASS' });
  assert.equal(f.ok, true, '调查类任务不应因为「没有 generate」而无法交付：' + JSON.stringify(f.error || ''));
});

test('代码任务在 strict 下仍要求 generate 前有 spec（门禁没被放宽）', () => {
  const s = mk({ pipelineGate: 'strict' });
  const st = s.start({ goal: '实现登录功能', mode: 'S3', taskType: 'code' });
  const runId = st.run.id;
  const r = s.record({ runId, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'impl' });
  assert.equal(r.ok, false, '无 spec 的 generate 必须被拒');
  assert.match(String(r.error), /spec|验收/);
});


// ---- 独立评审发现的回归用例（0.7.0 发布前修复） ----

test('评审回归：代码动词必须覆盖 优化/修改/调整/编写/添加/集成/调试', () => {
  assert.equal(detectTaskType('分析并评估登录模块的性能并优化'), 'code', '「优化」必须判为代码任务');
  assert.equal(detectTaskType('审查并评估这段代码，修改其中的问题'), 'code', '「修改」必须判为代码任务');
  assert.equal(detectTaskType('调整现有接口并集成到主流程'), 'code');
  assert.equal(detectTaskType('编写单元测试并调试失败用例'), 'code');
});

test('评审回归：S3 调查计划在 risk=high 下能展开 judge/redteam', () => {
  const p = generatePlan('S3', { goal: '调查并回顾历史对话记录', taskType: 'investigation', risk: 'high' });
  assert.ok(p.stages.includes('judge'), 'risk=high 应展开 judge');
  assert.ok(p.stages.includes('redteam'), 'risk=high 应展开 redteam');
  assert.ok(p.stages.includes('synth'));
});

test('评审回归：多候选调查运行可 judge 择优并 finish(PASS)', () => {
  const s = mk({ pipelineGate: 'strict' });
  const st = s.start({ goal: '调查并回顾历史对话记录', mode: 'S3', taskType: 'investigation', candidates: 2 });
  const runId = st.run.id;
  assert.equal(s.record({ runId, stage: 'research', status: 'done', summary: '调研完成' }).ok, true);
  assert.equal(s.record({ runId, stage: 'synth', status: 'done', files: ['a.md'], diffSummary: '报告 A', candidateId: 1 }).ok, true);
  assert.equal(s.record({ runId, stage: 'synth', status: 'done', files: ['b.md'], diffSummary: '报告 B', candidateId: 2 }).ok, true);
  assert.equal(s.record({ runId, stage: 'review', status: 'done', verdict: 'PASS', owner: 'reviewer-1' }).ok, true);
  const j = s.record({ runId, stage: 'judge', status: 'done', verdict: 'PASS', selectedCandidate: '2', owner: 'judge-1' });
  assert.equal(j.ok, true, 'judge 必须能选中 synth 产出的候选：' + (j.error || ''));
  assert.equal(s.record({ runId, stage: 'regression', status: 'done', verdict: 'PASS', testsRun: [{ cmd: 'node --test', ok: true }] }).ok, true);
  const f = s.finish({ runId, verdict: 'PASS' });
  assert.equal(f.ok, true, '多候选调查运行必须能交付：' + (f.error || ''));
});

test('评审回归：synth 回执使用 synthesizer 角色而非 worker', () => {
  const s = mk();
  const st = s.start({ goal: '调查并回顾历史对话记录', mode: 'S2', taskType: 'investigation' });
  const rec = s.record({ runId: st.run.id, stage: 'synth', status: 'done', files: ['r.md'], diffSummary: 'x' });
  assert.equal(rec.ok, true);
  assert.equal(rec.task.role, 'synthesizer');
});

test('评审回归：planFor 能按 taskType 出计划', () => {
  const s = mk();
  const code = s.planFor('S3', '实现登录', 'code');
  const inv = s.planFor('S3', '调查并回顾历史对话', 'investigation');
  assert.ok(code.stages.includes('generate'));
  assert.ok(!inv.stages.includes('generate'));
  assert.ok(inv.stages.includes('synth'));
});

