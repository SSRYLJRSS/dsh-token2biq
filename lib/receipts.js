// 回执与评审的结构化校验 —— 纯函数。对应 DEV_GUIDE §3 的回执 / 评审 / 验证格式。
// worker 回执: {files, diffSummary, testsRun, status, notes}
// review 回执: {verdict, issues, evidence}
// verify 回执: {verdict, evidence, logs}

export const TASK_STATUSES = ['pending', 'running', 'done', 'failed'];
export const VERDICTS = ['PASS', 'FAIL'];

function asArray(v) {
  return Array.isArray(v) ? v : (v == null ? [] : [v]);
}

// worker 回执校验
export function validateWorkerReceipt(r) {
  const e = [];
  if (!r || typeof r !== 'object') return { ok: false, errors: ['receipt 必须是对象'], value: null };
  const status = r.status || 'done';
  if (!TASK_STATUSES.includes(status)) e.push('status 非法：' + status);
  const files = asArray(r.files).map(String).filter(Boolean);
  const hasDiff = typeof r.diffSummary === 'string' && !!r.diffSummary.trim();
  if (status === 'failed') {
    // 失败的 worker 可能没有改动文件：允许用 notes 说明，仍要求有 diffSummary 或 notes。
    if (!hasDiff && !(typeof r.notes === 'string' && r.notes.trim())) e.push('failed 需说明 diffSummary 或 notes');
  } else {
    if (!files.length) e.push('files 不能为空（至少列出改动的文件）');
    if (!hasDiff) e.push('diffSummary 不能为空');
  }
  const testsRun = asArray(r.testsRun).map((t) => (typeof t === 'string'
    ? { cmd: t, ok: null }
    : { cmd: String(t && t.cmd ? t.cmd : ''), ok: t && typeof t.ok === 'boolean' ? t.ok : null }));
  return {
    ok: e.length === 0,
    errors: e,
    value: {
      files,
      diffSummary: String(r.diffSummary || ''),
      status,
      testsRun,
      notes: typeof r.notes === 'string' ? r.notes : '',
    },
  };
}

// review 回执校验
export function validateReviewReceipt(r) {
  const e = [];
  if (!r || typeof r !== 'object') return { ok: false, errors: ['review 必须是对象'], value: null };
  const verdict = String(r.verdict || '').toUpperCase();
  if (!VERDICTS.includes(verdict)) e.push('verdict 必须是 PASS 或 FAIL');
  const issues = asArray(r.issues).map(String).filter(Boolean);
  const evidence = asArray(r.evidence).map(String).filter(Boolean);
  if (verdict === 'FAIL' && issues.length === 0) e.push('FAIL 必须给出至少一条 issues');
  return { ok: e.length === 0, errors: e, value: { verdict, issues, evidence } };
}

// verify 回执校验
export function validateVerifyReceipt(r) {
  const e = [];
  if (!r || typeof r !== 'object') return { ok: false, errors: ['verify 必须是对象'], value: null };
  const verdict = String(r.verdict || '').toUpperCase();
  if (!VERDICTS.includes(verdict)) e.push('verdict 必须是 PASS 或 FAIL');
  const evidence = asArray(r.evidence).map(String).filter(Boolean);
  if (verdict === 'FAIL' && evidence.length === 0) e.push('验证 FAIL 必须给出证据');
  const testsRun = asArray(r.testsRun).map((t) => (typeof t === 'string'
    ? { cmd: t, ok: null }
    : { cmd: String(t && t.cmd ? t.cmd : ''), ok: t && typeof t.ok === 'boolean' ? t.ok : null }));
  const testsPassed = r.testsPassed === true ? true : (r.testsPassed === false ? false : (testsRun.length && testsRun.every((x) => x.ok === true) ? true : null));
  return { ok: e.length === 0, errors: e, value: { verdict, evidence, logs: asArray(r.logs).map(String), testsRun, testsPassed } };
}

// 归纳型回执（research / plan）：产出是「结论/方案」而非代码文件，files 可选。
function pickSummary(r) {
  return (typeof r.summary === 'string' && r.summary.trim())
    || (typeof r.diffSummary === 'string' && r.diffSummary.trim())
    || (typeof r.notes === 'string' && r.notes.trim())
    || '';
}

// research / plan 回执：必须有文字结论；files 可选（可能落盘调研/方案文档）。
export function validateNoteReceipt(kind, r) {
  const e = [];
  if (!r || typeof r !== 'object') return { ok: false, errors: [`${kind} 回执必须是对象`], value: null };
  const summary = pickSummary(r);
  if (!summary) e.push(`${kind} 回执需要 summary 或 diffSummary（说明调研结论/计划要点）`);
  const status = r.status || 'done';
  if (!TASK_STATUSES.includes(status)) e.push('status 非法：' + status);
  return {
    ok: e.length === 0,
    errors: e,
    value: {
      kind,
      summary,
      files: asArray(r.files).map(String).filter(Boolean),
      findings: asArray(r.findings).map(String).filter(Boolean),
      sources: asArray(r.sources).map(String).filter(Boolean),
      status,
      notes: typeof r.notes === 'string' ? r.notes : '',
    },
  };
}

// judge / redteam 回执：产出是「裁决/攻击结论」，必须有 verdict；FAIL 需 issues；files 可选。
export function validateVerdictReceipt(kind, r) {
  const e = [];
  if (!r || typeof r !== 'object') return { ok: false, errors: [`${kind} 回执必须是对象`], value: null };
  const verdict = String(r.verdict || '').toUpperCase();
  if (!VERDICTS.includes(verdict)) e.push('verdict 必须是 PASS 或 FAIL');
  const issues = asArray(r.issues).map(String).filter(Boolean);
  if (verdict === 'FAIL' && issues.length === 0) e.push(`${kind} FAIL 必须给出至少一条 issues`);
  return {
    ok: e.length === 0,
    errors: e,
    value: {
      kind,
      verdict,
      issues,
      evidence: asArray(r.evidence).map(String).filter(Boolean),
      files: asArray(r.files).map(String).filter(Boolean),
      rationale: typeof r.rationale === 'string' ? r.rationale : '',
      selectedCandidate: r.selectedCandidate != null ? String(r.selectedCandidate) : null,
      notes: typeof r.notes === 'string' ? r.notes : '',
    },
  };
}

// 按阶段选择对应校验器。
// 关键修复：research/plan/judge/redteam 是 S3 阶段的自然产出，不应被按 generate 要求 files+diffSummary。
export function validateReceiptByStage(kind, r) {
  const KNOWN = ['research', 'plan', 'generate', 'review', 'judge', 'redteam', 'verify', 'regression'];
  if (!KNOWN.includes(kind)) {
    return { ok: false, errors: [`未知阶段：${kind}，应为 research/plan/generate/review/judge/redteam/verify/regression`], value: null };
  }
  if (kind === 'review') return validateReviewReceipt(r);
  if (kind === 'verify' || kind === 'regression') return validateVerifyReceipt(r);
  if (kind === 'research' || kind === 'plan') return validateNoteReceipt(kind, r);
  if (kind === 'judge' || kind === 'redteam') return validateVerdictReceipt(kind, r);
  return validateWorkerReceipt(r);
}
