// 0.7.0 自检矩阵：S1–S4 × (code / investigation) 全档位跑通。
// 目的：不依赖真实子代理也能验证「计划形态 → 阶段回执 → finish(PASS)」整条链路没有死结。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Token2bIQService } from '../lib/service.js';
import { generatePlan } from '../lib/orchestrator.js';

function mk() {
  const f = path.join(os.tmpdir(), 't2biq-matrix-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
  const s = new Token2bIQService({ stateFile: null, settingsFile: f });
  s.updateSettings({ forceTeam: 'off', pipelineGate: 'strict' });
  return s;
}

const VERIFY_OK = { cmd: 'node --test', ok: true };

// 按计划里的阶段依次给出合法回执。
function runPlan(s, mode, taskType, goal) {
  // S1 没有 plan 阶段：strict 下必须在 start 直接给验收标准，否则 generate 永远进不去（文档已说明的用法）。
  const st = s.start({ goal, mode, taskType, ...(mode === 'S1' && taskType === 'code' ? { acceptance: '可交付' } : {}) });
  assert.equal(st.ok, true, mode + '/' + taskType + ' start 失败');
  const runId = st.run.id;
  const stages = st.plan.stages;
  const results = {};
  for (const kind of stages) {
    let rec;
    if (kind === 'generate') {
      rec = s.record({ runId, stage: 'generate', status: 'done', files: ['a.js'], diffSummary: 'impl' });
    } else if (kind === 'synth') {
      rec = s.record({ runId, stage: 'synth', status: 'done', files: ['report.md'], diffSummary: '报告成稿' });
    } else if (kind === 'review' || kind === 'judge' || kind === 'redteam') {
      // S4 并行多审要求评审回执能追溯到人：带上 owner。
      rec = s.record({ runId, stage: kind, status: 'done', verdict: 'PASS', owner: 'reviewer-' + kind });
    } else if (kind === 'verify' || kind === 'regression') {
      rec = s.record({ runId, stage: kind, status: 'done', verdict: 'PASS', testsRun: [VERIFY_OK] });
    } else if (kind === 'plan') {
      rec = s.record({ runId, stage: 'plan', status: 'done', summary: '验收：可交付', acceptance: '有产物' });
    } else {
      rec = s.record({ runId, stage: kind, status: 'done', summary: kind + ' 完成' });
    }
    results[kind] = rec.ok ? 'ok' : (rec.error || 'fail');
    assert.equal(rec.ok, true, mode + '/' + taskType + ' 阶段 ' + kind + ' 被拒：' + (rec.error || ''));
  }
  return { runId, stages, results };
}

for (const mode of ['S1', 'S2', 'S3', 'S4']) {
  test('自检矩阵 ' + mode + ' × investigation：全阶段可记录且能 finish(PASS)', () => {
    const s = mk();
    const { runId, stages } = runPlan(s, mode, 'investigation', '调查并回顾一段历史对话记录');
    assert.ok(!stages.includes('generate'), mode + ' 调查类不应有 generate');
    assert.ok(stages.includes('synth'), mode + ' 调查类必须有 synth');
    const f = s.finish({ runId, verdict: 'PASS', rationale: '自检' });
    assert.equal(f.ok, true, mode + '/investigation finish 失败：' + (f.error || ''));
  });

  test('自检矩阵 ' + mode + ' × code：全阶段可记录且能 finish(PASS)', () => {
    const s = mk();
    const { runId } = runPlan(s, mode, 'code', '实现登录并修复重试 bug');
    const f = s.finish({ runId, verdict: 'PASS', rationale: '自检' });
    assert.equal(f.ok, true, mode + '/code finish 失败：' + (f.error || ''));
  });
}

test('自检矩阵：S3 代码计划仍含 generate，S3 调查计划不含', () => {
  assert.ok(generatePlan('S3', { goal: '实现登录', taskType: 'code' }).stages.includes('generate'));
  assert.ok(!generatePlan('S3', { goal: '调查并回顾对话', taskType: 'investigation' }).stages.includes('generate'));
});
