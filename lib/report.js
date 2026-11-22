// 导出 Markdown 报告 —— 纯函数（输入 run 对象，输出字符串）。
// 关键：对缺失/半成品 run 做占位兜底，任何字段缺失都不能抛（旧实现直接读 run.ledger.totalIn 等会 TypeError）。
import { STAGE_LABEL } from './orchestrator.js';

function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return (Math.round(v / 100) / 10) + 'k';
  return String(v);
}

// 事件时间只做展示：非法/缺失的 ts 不能把整份导出报告打崩（旧实现 toISOString 抛 RangeError）。
function safeTs(ts) {
  const d = new Date(ts == null ? 0 : ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  try { return d.toISOString().slice(11, 19); } catch { return '--:--:--'; }
}

export function buildReport(run) {
  if (!run || typeof run !== 'object') return '# Token 2b IQ 报告\n\n（无运行记录）\n';
  const plan = (run.plan && typeof run.plan === 'object') ? run.plan : {};
  const ledger = (run.ledger && typeof run.ledger === 'object') ? run.ledger : {};
  const ledgerStages = (ledger.stages && typeof ledger.stages === 'object') ? ledger.stages : {};
  const planStages = Array.isArray(plan.stages) ? plan.stages : [];
  const tasks = Array.isArray(run.tasks) ? run.tasks : [];
  const stages = Array.isArray(run.stages) ? run.stages : [];
  const reviews = Array.isArray(run.reviews) ? run.reviews : [];
  const events = Array.isArray(run.events) ? run.events : [];
  const escalations = Array.isArray(run.escalations) ? run.escalations : [];
  const spent = (Number(ledger.totalIn) || 0) + (Number(ledger.totalOut) || 0);
  const vd = run.verdict || null;

  const lines = [];
  lines.push('# Token 2b IQ 报告');
  lines.push('');
  lines.push(`- 运行 ID：\`${run.id || '(未知)'}\``);
  lines.push(`- 档位：${run.mode || '(未知)'}${run.requestedMode && run.requestedMode !== run.mode ? `（请求 ${run.requestedMode}，自动分类为 ${run.mode}）` : ''}`);
  lines.push(`- 目标：${run.goal || '（未填写）'}`);
  lines.push(`- 状态：${run.status || '(未知)'}${run.paused ? '（已暂停：' + (run.pauseReason || '') + '）' : ''}`);
  lines.push(`- 计划：maxAgents=${plan.maxAgents != null ? plan.maxAgents : 0}，评审轮数=${plan.reviewRounds != null ? plan.reviewRounds : 0}，阶段=${planStages.join(' → ')}`);
  lines.push(`- 档位成本权重：×${plan.costWeight || 0}（角色越多消耗越大；不设硬上限）`);
  lines.push(`- Token：${spent}（累计消耗，仅统计）`);
  lines.push(`- 插件建板：${run.orchestrated ? '是（共享任务板已建）' : '否（纯计划）'}${run.orchestrationError ? ' · 原因：' + run.orchestrationError : ''}`);
  if (run.capabilities && typeof run.capabilities === 'object') lines.push(`- 宿主能力：teamTasks=${run.capabilities.teamTasks ? '✓' : '✗'}，leadGate=${run.capabilities.leadGate ? '✓' : '✗'}，writeScopes=${run.capabilities.writeScopesDeclared ? '✓' : '✗'}`);
  if (run.budgetGate && typeof run.budgetGate === 'object') lines.push(`- 预算闸门：${run.budgetGate.percent}%（${run.budgetGate.level}，${run.budgetGate.spent}/${run.budgetGate.budget}）`);
  if (run.real && typeof run.real === 'object') lines.push(`- 实测用量（宿主 llm/stream）：输入 ${run.real.input || 0} · 输出 ${run.real.output || 0} · 缓存读 ${run.real.cacheRead || 0} · 缓存写 ${run.real.cacheWrite || 0}`);
  if (Array.isArray(run.modelRouting) && run.modelRouting.length) {
    const routing = run.modelRouting.filter((m) => m && typeof m === 'object');
    if (routing.length) {
      lines.push(`- 模型路由：${routing.map((m) => m.stage + '=' + m.model + (m.taskId ? '(' + m.taskId + ')' : '')).join('、')}`);
    }
  }
  lines.push(`- 最终裁决：${vd && vd.final ? vd.final : '（未裁决）'}${vd && vd.byJudge ? ' · ' + vd.byJudge : ''}`);
  if (vd && vd.rationale) lines.push(`  - 理由：${vd.rationale}`);
  lines.push('');

  lines.push('## 阶段与回执');
  for (const st of stages) {
    if (!st || typeof st !== 'object') continue;
    const stTasks = tasks.filter((t) => t && t.kind === st.kind);
    lines.push(`### ${STAGE_LABEL[st.kind] || st.kind}（${st.kind}，${st.status}）`);
    if (!stTasks.length) { lines.push('- （无任务记录）'); continue; }
    for (const t of stTasks) {
      const r = (t && t.receipt) || {};
      lines.push(`- **${t.role}** · ${t.status} · token ${fmtTok((Number(t.tokensIn) || 0) + (Number(t.tokensOut) || 0))}${t.estimated ? '（估算）' : ''}${t.model ? ' · 模型 ' + t.model : ''}${t.owner ? ' · 队员 ' + t.owner : ''}${t.teamTaskId ? ' · 共享任务 ' + t.teamTaskId : ''}`);
      if (r.summary || r.diffSummary) lines.push(`  - 改动：${r.summary || r.diffSummary}`);
      if (Array.isArray(r.files) && r.files.length) lines.push(`  - 文件：${r.files.join(', ')}`);
      if (r.status && r.status !== t.status) lines.push(`  - 回执状态：${r.status}`);
      if (r.verdict) lines.push(`  - 结论：${r.verdict}`);
      if (Array.isArray(r.issues) && r.issues.length) lines.push(`  - 问题：${r.issues.join('；')}`);
      if (Array.isArray(r.evidence) && r.evidence.length) lines.push(`  - 证据：${r.evidence.join('；')}`);
      if (Array.isArray(r.testsRun) && r.testsRun.length) {
        const ts = r.testsRun.map((x) => `${x && x.cmd}${x && x.ok === true ? '✓' : x && x.ok === false ? '✗' : ''}`).join(', ');
        lines.push(`  - 测试：${ts}`);
      }
      if (r.notes) lines.push(`  - 备注：${r.notes}`);
    }
    lines.push('');
  }

  if (reviews.length) {
    lines.push('## 评审记录');
    for (const rv of reviews) {
      if (!rv || typeof rv !== 'object') continue;
      const issues = Array.isArray(rv.issues) ? rv.issues : [];
      lines.push(`- ${rv.reviewerRole || 'reviewer'} → ${rv.verdict || '?'}${issues.length ? '：' + issues.join('；') : ''}`);
    }
    lines.push('');
  }

  if (events.length) {
    lines.push('## 事件流（状态跃迁）');
    for (const e of events.slice(-40)) {
      const ts = safeTs(e && e.ts);
      const bits = [e && e.stage ? '阶段 ' + e.stage : '', e && e.status ? '→ ' + e.status : '', e && e.verdict ? '裁决 ' + e.verdict : '', e && e.from && e.to ? e.from + ' → ' + e.to : '', e && e.reason ? '（' + e.reason + '）' : ''].filter(Boolean);
      lines.push(`- \`${ts}\` **${(e && e.kind) || 'event'}**${bits.length ? ' · ' + bits.join(' · ') : ''}`);
    }
    lines.push('');
  }

  lines.push('## Token 台账');
  lines.push('| 阶段 | 输入 | 输出 | 小计 |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const [k, v] of Object.entries(ledgerStages)) {
    const vin = Number(v && v.in) || 0;
    const vout = Number(v && v.out) || 0;
    lines.push(`| ${STAGE_LABEL[k] || k} | ${vin} | ${vout} | ${vin + vout} |`);
  }
  lines.push(`| **合计** | ${Number(ledger.totalIn) || 0} | ${Number(ledger.totalOut) || 0} | ${spent} |`);
  lines.push('');
  lines.push('> 注：token 若由调用方回传则为其上报值；缺省时按字符数/4 估算，标注为估算。');
  lines.push('');
  if (escalations.length) {
    lines.push('## 闸门升级记录');
    for (const e of escalations) lines.push(`- ${e && e.from} → ${e && e.to}：${(e && e.reason) || ''}`);
    lines.push('');
  }
  return lines.join('\n');
}
