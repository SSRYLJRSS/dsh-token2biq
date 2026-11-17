// 设置存储 —— 持久化「默认档位 / 8 角色模型池 / 模型白名单 / 评审策略 / 强制联动官方团队」。
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

// 成本预算：0/非法/负数 = 不限（默认，保持向后兼容）。
function normTokenBudget(v) {
  if (v == null || String(v).trim() === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

export function emptyRolePools() {
  return {
    research: [], plan: [], generate: [], review: [],
    judge: [], verify: [], redteam: [], regression: [],
  };
}

export const DEFAULT_SETTINGS = Object.freeze({
  version: 3,
  reasoning: { default: 'auto', byRole: {}, byModel: {} },
  defaultMode: 'Auto',
  forceTeam: 'auto',            // 'auto'=S2/S3/S4 强制、S1 不强制；'on'=始终强制；'off'=从不。强制=record 必须带 teamTaskId/owner 否则拒收
  allowModels: [],              // 允许调用的模型白名单；空=不限制
  rolePools: emptyRolePools(),  // 角色模型池；空数组=跟随主对话。8 个 key 永远存在。
  parallelReviews: 3,           // 完整加强：并行审模型数（1..5，实际=min(该值,池内选中数)）
  independentReview: false,     // true=评审/裁判/红队必须由非执行者的独立代理盲审（record 校验 owner 不能是 generate 执行者）
  pipelineGate: 'off',          // 'off'=宽松（仅记账）；'strict'=严格流水线硬门禁（无 spec 不进实现 / verify 无 testsRun 不许 finish / 多候选须 judge 择优）
  tokenBudget: 0,               // 成本闸门：每运行允许消耗的 token 预算；0=不限。≥80% 收敛（只提示）、≥100% 熔断（不再新建任务）
  autoProvision: true,          // 安装后自动写宿主 profile 配置（团队默认开启 + 子代理多模型）；false 关闭
  provisionProfile: null,       // 自动配置写入的 profile 名；null=DSH_PROFILE 或 desktop
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

// 思考强度 id：'auto' 或 /^[a-z][a-z0-9_-]{0,31}$/，其余一律 'auto'。
const EFFORT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export function normalizeEffort(v) {
  if (typeof v !== 'string') return 'auto';
  const s = v.trim().toLowerCase();
  if (s === 'auto') return 'auto';
  return EFFORT_ID_RE.test(s) ? s : 'auto';
}

// 规整思考强度配置：default 全量、byRole 仅 ROLE_KINDS 且非 auto、byModel 仅合法模型引用且非 auto。
export function normalizeReasoning(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const out = { default: normalizeEffort(r.default), byRole: {}, byModel: {} };
  const byRole = (r.byRole && typeof r.byRole === 'object') ? r.byRole : {};
  for (const k of ROLE_KINDS) {
    if (Object.prototype.hasOwnProperty.call(byRole, k)) {
      const e = normalizeEffort(byRole[k]);
      if (e !== 'auto') out.byRole[k] = e;
    }
  }
  const byModel = (r.byModel && typeof r.byModel === 'object') ? r.byModel : {};
  for (const k of Object.keys(byModel)) {
    if (!isModelRef(k)) continue;
    const e = normalizeEffort(byModel[k]);
    if (e !== 'auto') out.byModel[k] = e;
  }
  return out;
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
    if (!pool.length && !explicit) { // 非显式空：走旧值迁移，不被默认空键阻断
      if (isRev && legacyReviewModels.length) pool = legacyReviewModels.slice().sort();
      else { const legacy = normRef(srcRoles[k]); if (legacy) pool = [legacy]; }
    }
    if (SINGLE_ROLE_KINDS.includes(k) && pool.length > 1) pool = [pool[0]]; // 单代理角色只留首项
    if (isRev && pool.length > MAX_PARALLEL_REVIEWS) pool = pool.slice(0, MAX_PARALLEL_REVIEWS);
    rolePools[k] = pool; // 8 个 key 永远返回，空数组=跟随主对话
    roleModels[k] = pool[0] || null; // 派生只读字段：池首项，不落盘
  }

  return {
    version: 3,
    reasoning: normalizeReasoning(r.reasoning),
    defaultMode: normMode(r.defaultMode),
    forceTeam: normalizeForceTeam(r.forceTeam),
    allowModels: refList(r.allowModels),
    rolePools,
    roleModels,
    parallelReviews: normParallelReviews(r.parallelReviews),
    independentReview: r.independentReview === true,
    pipelineGate: normalizePipelineGate(r.pipelineGate),
    tokenBudget: normTokenBudget(r.tokenBudget),
    autoProvision: r.autoProvision !== false,
    provisionProfile: (typeof r.provisionProfile === 'string' && r.provisionProfile.trim()) ? r.provisionProfile.trim() : null,
  };
}

function persistedSettings(settings) {
  const out = { ...settings };
  delete out.roleModels;
  return out;
}

export class SettingsStore {
  constructor({ file } = {}) {
    // 只有「没传」（undefined）才回退默认设置文件；显式 null = 纯内存（测试/隔离）。
    // 旧的 file || resolveSettingsFile() 会把显式 null 悄悄变成「写真实用户设置」，
    // 于是并行跑的测试互相污染，还会污染用户配置。
    this.file = file === undefined ? resolveSettingsFile() : (file || null);
    this.data = this._load();
  }

  _load() {
    // 纯内存模式：没有文件可读，直接用默认值（别把 null 当路径去 readFile 再告警）。
    if (!this.file) return normalizeSettings({});
    try {
      const txt = fs.readFileSync(this.file, 'utf8');
      return normalizeSettings(JSON.parse(txt));
    } catch (e) {
      // 设置损坏时门禁会静默翻转（forceTeam/pipelineGate/allowModels），必须留痕并备份。
      if (e && e.code !== 'ENOENT') {
        try { console.warn('[token2biq] settings 读取失败，已回退默认值并备份：' + this.file + ' — ' + ((e && e.message) || e)); } catch { /* ignore */ }
        try { fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now()); } catch { /* ignore */ }
      }
      return normalizeSettings({});
    }
  }

  get() { return JSON.parse(JSON.stringify(this.data)); }

  update(patch = {}) {
    const p = (patch && typeof patch === 'object') ? patch : {};
    const poolsFromPatch = (p.rolePools && typeof p.rolePools === 'object') ? p.rolePools : null;
    const roleModelsPatch = (p.roleModels && typeof p.roleModels === 'object') ? p.roleModels : null;
    const nextPools = { ...this.data.rolePools };

    if (poolsFromPatch) {
      for (const k of ROLE_KINDS) {
        if (Object.prototype.hasOwnProperty.call(poolsFromPatch, k)) {
          nextPools[k] = Array.isArray(poolsFromPatch[k]) ? poolsFromPatch[k].slice() : [];
        }
      }
    }

    // 兼容旧调用方：roleModels 只在没有 rolePools patch 时翻译成 rolePools；显式 rolePools 永远优先。
    if (roleModelsPatch && !poolsFromPatch) {
      for (const k of ROLE_KINDS) {
        if (Object.prototype.hasOwnProperty.call(roleModelsPatch, k)) {
          const ref = normRef(roleModelsPatch[k]);
          nextPools[k] = ref ? [ref] : [];
        }
      }
    }

    // reasoning：reasoningReplace=true 时整体替换（设置面板用，清除已删除覆盖）；否则深合并（默认，未提交键保留）。
    let nextReasoning = this.data.reasoning;
    if (p.reasoning && typeof p.reasoning === 'object') {
      if (p.reasoningReplace === true) {
        nextReasoning = normalizeReasoning(p.reasoning);
      } else {
        const cur = this.data.reasoning || { default: 'auto', byRole: {}, byModel: {} };
        const patchRole = (p.reasoning.byRole && typeof p.reasoning.byRole === 'object') ? p.reasoning.byRole : null;
        const patchModel = (p.reasoning.byModel && typeof p.reasoning.byModel === 'object') ? p.reasoning.byModel : null;
        nextReasoning = {
          default: Object.prototype.hasOwnProperty.call(p.reasoning, 'default') ? p.reasoning.default : cur.default,
          byRole: patchRole ? { ...cur.byRole, ...patchRole } : { ...cur.byRole },
          byModel: patchModel ? { ...cur.byModel, ...patchModel } : { ...cur.byModel },
        };
      }
    }
    const next = { ...this.data, ...p, rolePools: nextPools, reasoning: nextReasoning };
    delete next.reasoningReplace;
    delete next.roleModels;
    delete next.strongModel;
    delete next.normalModel;
    delete next.reviewModels;
    delete next.maxReviewers;
    delete next.requireDifferentVendor;

    this.data = normalizeSettings(next);
    this._save(); // 与现实现一致：失败只记录 lastSaveError，由 HTTP 层回传 settingsSaveError
    return this.get();
  }

  _save() {
    // 纯内存模式（file === null）：不落盘，但「本次修改已生效」必须如实返回。
    if (!this.file) {
      this.lastSaveError = null;
      return true;
    }
    let tmp = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 临时文件名带 pid+序号，避免多进程/连点保存抢同一个 .tmp 导致 rename 到损坏内容（P2-2）。
      tmp = this.file + '.' + process.pid + '.' + (_saveSeq = (_saveSeq + 1)) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(persistedSettings(this.data), null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      this.lastSaveError = null;
      return true;
    } catch (e) {
      // 写盘失败必须可见：否则 forceTeam/pipelineGate/allowModels 这些门禁在本进程内是新值、
      // 重启后却静默退回默认——用户会以为门禁一直开着。
      this.lastSaveError = (e && e.message) || String(e);
      try { console.warn('[token2biq] settings 落盘失败：' + this.lastSaveError); } catch { /* ignore */ }
      try { if (tmp) fs.unlinkSync(tmp); } catch { /* 清理残余 tmp */ }
      return false;
    }
  }
}
