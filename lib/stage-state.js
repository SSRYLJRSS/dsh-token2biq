// 阶段状态聚合（纯函数，可单测）。
// 契约：S4 并行多审同一阶段有多条回执——每个 slot（teamTaskId 优先、其次 owner）取最新一条，
// 组间「任一失败即失败」；同一 slot 重试则以最后一次为准（修好之后看板要能自愈）。

export const REVIEW_KINDS = ['review', 'judge', 'redteam'];

// 执行轮（slot）标识：同一个共享任务 / 同一个队员 = 同一轮的重试。
export function attemptSlot(task) {
  if (!task || typeof task !== 'object') return '';
  // 身份优先：同一个共享任务 / 同一个队员 = 同一轮的重试。
  const tid = task.teamTaskId == null ? '' : String(task.teamTaskId).trim();
  if (tid) return 'task:' + tid;
  const owner = task.owner == null ? '' : String(task.owner).trim();
  if (owner) return 'owner:' + owner;
  // 服务层为新回执合成的序列槽（无 teamTaskId/owner 时）：同一 run+stage 的多次回执共享一个槽，
  // 重试仍按「最新一条」自愈；历史快照没有 slot 字段，走下面的 id 兜底。
  const synth = task.slot == null ? '' : String(task.slot).trim();
  if (synth) return synth;
  // 历史快照可能两个身份都缺：落到 task.id 兜底，让无身份的多条回执各自独立。
  // 宁可阶段保持 failed，也不能被后到的 PASS 吞掉 FAIL（新回执由 service 补合成序列 slot）。
  const id = task.id == null ? '' : String(task.id).trim();
  if (id) return 'id:' + id;
  return '';
}

// 一条回执是否判定为失败：status=failed 或 verdict=FAIL 都算。
export function isFailedAttempt(task) {
  if (!task) return false;
  if (task.status === 'failed') return true;
  return !!(task.receipt && task.receipt.verdict === 'FAIL');
}

// 每个 slot 只保留最新一条回执。
// 「最新」以 createdAt 为准（跨实例 merge 后数组顺序不可靠）；时间相同则按数组顺序（提交序）取后者，
// 不依赖 id 形态——id 可能是 UUID，词法顺序不代表时序。
export function latestPerSlot(tasks) {
  const map = new Map();
  for (const t of tasks || []) {
    if (!t) continue;
    const slot = attemptSlot(t);
    const cur = map.get(slot);
    if (!cur || (Number(t.createdAt) || 0) >= (Number(cur.createdAt) || 0)) map.set(slot, t);
  }
  return Array.from(map.values());
}

// 由任务回执聚合阶段状态：null（还没有任何回执）/ 'running' / 'done' / 'failed'。
// 规则：任一 slot 的最新回执失败 → failed（FAIL 不可被别的 slot 的 PASS 清除）；
//       全部 slot 最新回执 done → done；否则 running。
export function aggregateStageStatus(tasks) {
  const latest = latestPerSlot(tasks);
  if (!latest.length) return null;
  if (latest.some(isFailedAttempt)) return 'failed';
  if (latest.every((t) => t && t.status === 'done')) return 'done';
  return 'running';
}

// 阶段「有效状态」：优先从任务派生（历史快照的 stage.status 会永久停在 running/pending）。
export function effStageStatus(kind, run) {
  const tasks = ((run && run.tasks) || []).filter((t) => t && t.kind === kind);
  const agg = aggregateStageStatus(tasks);
  if (agg) return agg;
  const st = ((run && run.stages) || []).find((s) => s.kind === kind);
  if (run && run.status === 'done') return 'skipped';
  return (st && st.status) || 'pending';
}

// 取某阶段的「当前有效尝试」：每个 slot 的最新一条。
export function stageAttempts(tasks, kind) {
  return latestPerSlot((tasks || []).filter((t) => t && t.kind === kind));
}
