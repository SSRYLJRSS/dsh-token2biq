// 设置存储 —— 持久化「默认档位 / 各角色模型 / 评审模型池 / 模型白名单 / 评审策略 / 强制联动官方团队」。
// 设计依据：业界对标（RouteLLM 难度路由、PoLL 异构评审、CodeRabbit 分级）。
// 只做配置读写，不执行任何模型调用。写入采用 tmp+rename 原子替换。
import fs from 'node:fs';
import path from 'node:path';
import { resolveSettingsFile } from './paths.js';
import { MAX_PARALLEL_REVIEWS } from './orchestrator.js';

let _saveSeq = 0;

// 可被「按角色指定模型」的阶段（与 orchestrator.STAGE_TEAM 的键一致）。
export const ROLE_KINDS = ['research', 'plan', 'generate', 'review', 'judge', 'verify', 'redteam', 'regression'];
// 单代理角色：只允许选 1 个模型（其余角色可多选）。
export const SINGLE_ROLE_KINDS = ['research', 'plan', 'generate', 'verify', 'regression'];

// 模型引用统一格式：`<provider>::<model>`（provider 为 modelCatalog.groups[].id，model 为模型 id）。
export function parseModelRef(ref) {
  if (typeof ref !== 'string') return null;
  const s = ref.trim();
  const i = s.indexOf('::');
  if (i <= 0 || i >= s.length - 2) return null;
  return { provider: s.slice(0, i), model: s.slice(i + 2) };
}
export function isModelRef(ref) { return parseModelRef(ref) != null; }
function normRef(v) { return isModelRef(v) ? String(v).trim() : null; }

// 强制联动三态：'auto'（S2/S3/S4 强制、S1 不强制）、'on'（始终强制）、'off'（从不）。
export function normalizeForceTeam(v) {
  if (v === 'on' || v === 'always' || v === true) return 'on';
  if (v === 'off' || v === 'never' || v === false) return 'off';
  return 'auto';
}
// 给定设置与当前档位，是否应强制联动官方团队。
export function effectiveForceTeam(settings, mode) {
  const f = normalizeForceTeam(settings && settings.forceTeam);
  if (f === 'on') return true;
  if (f === 'off') return false;
  return mode === 'S2' || mode === 'S3' || mode === 'S4';
}
function refList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) { const r = normRef(x); if (r && !out.includes(r)) out.push(r); }
  return out;
}
// 完整加强并行审模型数：默认 3，夹到 [1, MAX_PARALLEL_REVIEWS]；非法/空回默认。
function normParallelReviews(v) {
  if (v == null || String(v).trim() === '') return 3;
  const n = Number(v);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(MAX_PARALLEL_REVIEWS, Math.round(n)));
}

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  defaultMode: 'Auto',
  forceTeam: 'auto',            // 'auto'=S2/S3/S4 强制、S1 不强制；'on'=始终强制；'off'=从不。强制=record 必须带 teamTaskId/owner 否则拒收
  allowModels: [],              // 允许调用的模型白名单；空=不限制
  roleModels: {},               // 各阶段指定模型；null=继承默认
  reviewModels: [],             // 评审/裁判模型池；空=用 roleModels.review 或默认
  maxReviewers: 2,              // 评审池最多同时用几个
  parallelReviews: 3,           // 完整加强：并行审模型数（1..5，实际=min(该值,池内选中数)）
  requireDifferentVendor: true, // 评审/裁判不得与 generate 同 provider
  independentReview: false,     // true=评审/裁判/红队必须由非执行者的独立代理盲审（record 校验 owner 不能是 generate 执行者）
  pipelineGate: 'off',          // 'off'=宽松（仅记账）；'strict'=严格流水线硬门禁（无 spec 不进实现 / verify 无 testsRun 不许 finish / 多候选须 judge 择优）
});

// 流水线门禁三态：off（宽松）/ strict（严格硬门禁）。
export function normalizePipelineGate(v) {
  return v === 'strict' ? 'strict' : 'off';
}

// 把任意输入规整成完整、合法、可直接使用的设置对象。
function normMode(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 's1') return 'S1';
  if (s === 's2') return 'S2';
  if (s === 's3') return 'S3';
  if (s === 's4') return 'S4';
  if (s === 'auto' || s === '自动') return 'Auto';
  return ['Auto', 'S1', 'S2', 'S3', 'S4'].includes(v) ? v : 'Auto';
}

export function normalizeSettings(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const srcRoles = (r.roleModels && typeof r.roleModels === 'object') ? r.roleModels : {};
  const srcPools = (r.rolePools && typeof r.rolePools === 'object') ? r.rolePools : {};
  const legacyReviewModels = refList(r.reviewModels);
  const rolePools = {};
  const roleModels = {};
  for (const k of ROLE_KINDS) {
    const explicit = Object.prototype.hasOwnProperty.call(srcPools, k); // 显式声明（含显式清空 []）
    let pool = refList(srcPools[k]);
    const isRev = ['review', 'judge', 'redteam'].includes(k);
    if (!pool.length && !explicit) {                    // 非显式空：走旧值迁移，不被默认空键阻断
      if (isRev && legacyReviewModels.length) pool = legacyReviewModels.slice().sort();
      else { const legacy = normRef(srcRoles[k]); if (legacy) pool = [legacy]; }
    }
    if (SINGLE_ROLE_KINDS.includes(k) && pool.length > 1) pool = [pool[0]]; // 单代理角色只留首项
    if (pool.length || explicit) rolePools[k] = pool;   // 只保留非空或显式声明（含显式清空），默认不合成空键
    roleModels[k] = pool[0] || null;                    // 显式空→null，不回填旧值
  }
  return {
    version: 1,
    defaultMode: normMode(r.defaultMode),
    forceTeam: normalizeForceTeam(r.forceTeam),
    allowModels: refList(r.allowModels),
    roleModels,
    rolePools,
    reviewModels: [],
    maxReviewers: Number.isFinite(Number(r.maxReviewers))
      ? Math.max(1, Math.min(5, Math.round(Number(r.maxReviewers)))) : DEFAULT_SETTINGS.maxReviewers,
    parallelReviews: normParallelReviews(r.parallelReviews),
    requireDifferentVendor: r.requireDifferentVendor !== false,
    independentReview: r.independentReview === true,
    pipelineGate: normalizePipelineGate(r.pipelineGate),
  };
}

export class SettingsStore {
  constructor({ file } = {}) {
    this.file = file || resolveSettingsFile();
    this.data = this._load();
  }

  _load() {
    try {
      const txt = fs.readFileSync(this.file, 'utf8');
      return normalizeSettings(JSON.parse(txt));
    } catch {
      return normalizeSettings({});
    }
  }

  get() { return JSON.parse(JSON.stringify(this.data)); }

  update(patch = {}) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = {
      ...this.data,
      ...p,
      // roleModels 用浅合并，便于只改一个角色而不清空其它
      roleModels: p.roleModels
        ? { ...this.data.roleModels, ...p.roleModels }
        : this.data.roleModels,
      // rolePools 同样浅合并（逐角色），便于只改一个角色池而不清空其它
      rolePools: p.rolePools
        ? { ...this.data.rolePools, ...p.rolePools }
        : this.data.rolePools,
    };
    this.data = normalizeSettings(next);
    this._save();
    return this.get();
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 临时文件名带 pid+序号，避免多进程/连点保存抢同一个 .tmp 导致 rename 到损坏内容（P2-2）。
      const tmp = this.file + '.' + process.pid + '.' + (_saveSeq = (_saveSeq + 1)) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) { try { console.warn('[token2biq] settings 落盘失败：' + ((e && e.message) || e)); } catch { /* ignore */ } }
  }
}
