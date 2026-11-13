// 导出 Markdown 报告 —— 纯函数（输入 run 对象，输出字符串）。
import { STAGE_LABEL } from './orchestrator.js';

function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return (Math.round(v / 100) / 10) + 'k';
  return String(v);
}

export function buildReport(run) {
  if (!run) return '# Token 2b IQ 报告\n\n（无运行记录）\n';
  const spent = (run.ledger.totalIn || 0) + (run.ledger.totalOut || 0);
  const lines = [];
  lines.push('# Token 2b IQ 报告');
  lines.push('');
  lines.push(`- 运行 ID：\`${run.id}\``);
  lines.push(`- 档位：${run.mode}${run.requestedMode && run.requestedMode !== run.mode ? `（请求 ${run.requestedMode}，自动分类为 ${run.mode}）` : ''}`);
  lines.push(`- 目标：${run.goal || '（未填写）'}`);
  lines.push(`- 状态：${run.status}${run.paused ? '（已暂停：' + (run.pauseReason || '') + '）' : ''}`);
  lines.push(`- 计划：maxAgents=${run.plan.maxAgents}，评审轮数=${run.plan.reviewRounds}，阶段=${run.plan.stages.join(' → ')}`);
  lines.push(`- 档位成本权重：×${run.plan.costWeight || 0}（角色越多消耗越大；不设硬上限）`);
  lines.push(`- Token：${spent}（累计消耗，仅统计）`);
  const vd = run.verdict;
  lines.push(`- 最终裁决：${vd ? vd.final : '（未裁决）'}${vd && vd.byJudge ? ' · ' + vd.byJudge : ''}`);
  if (vd && vd.rationale) lines.push(`  - 理由：${vd.rationale}`);
  lines.push('');

  lines.push('## 阶段与回执');
  for (const st of run.stages) {
    const tasks = run.tasks.filter((t) => t.kind === st.kind);
    lines.push(`### ${STAGE_LABEL[st.kind] || st.kind}（${st.kind}，${st.status}）`);
    if (!tasks.length) { lines.push('- （无任务记录）'); continue; }
    for (const t of tasks) {
      lines.push(`- **${t.role}** · ${t.status} · token ${fmtTok(t.tokensIn + t.tokensOut)}${t.owner ? ' · 队员 ' + t.owner : ''}${t.teamTaskId ? ' · 共享任务 ' + t.teamTaskId : ''}`);
      const r = t.receipt || {};
      if (r.summary || r.diffSummary) lines.push(`  - 改动：${r.summary || r.diffSummary}`);
      if (r.files && r.files.length) lines.push(`  - 文件：${r.files.join(', ')}`);
      if (r.status && r.status !== t.status) lines.push(`  - 回执状态：${r.status}`);
      if (r.verdict) lines.push(`  - 结论：${r.verdict}`);
      if (r.issues && r.issues.length) lines.push(`  - 问题：${r.issues.join('；')}`);
      if (r.evidence && r.evidence.length) lines.push(`  - 证据：${r.evidence.join('；')}`);
      if (r.testsRun && r.testsRun.length) {
        const ts = r.testsRun.map((x) => `${x.cmd}${x.ok === true ? '✓' : x.ok === false ? '✗' : ''}`).join(', ');
        lines.push(`  - 测试：${ts}`);
      }
      if (r.notes) lines.push(`  - 备注：${r.notes}`);
    }
    lines.push('');
  }

  if (run.reviews.length) {
    lines.push('## 评审记录');
    for (const rv of run.reviews) {
      lines.push(`- ${rv.reviewerRole} → ${rv.verdict}${rv.issues.length ? '：' + rv.issues.join('；') : ''}`);
    }
    lines.push('');
  }

  lines.push('## Token 台账');
  lines.push('| 阶段 | 输入 | 输出 | 小计 |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const [k, v] of Object.entries(run.ledger.stages || {})) {
    lines.push(`| ${STAGE_LABEL[k] || k} | ${v.in} | ${v.out} | ${v.in + v.out} |`);
  }
  lines.push(`| **合计** | ${run.ledger.totalIn} | ${run.ledger.totalOut} | ${spent} |`);
  lines.push('');
  lines.push('> 注：token 若由调用方回传则为其上报值；缺省时按字符数/4 估算，标注为估算。');
  lines.push('');
  if (run.escalations && run.escalations.length) {
    lines.push('## 闸门升级记录');
    for (const e of run.escalations) lines.push(`- ${e.from} → ${e.to}：${e.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}
