// Token 2b IQ —— 安装后自动补齐 DSH 宿主配置（官方 Agent Teams + 子代理多模型选择）。
// 设计约束（用户需求 + 已确认契约）：
//   1) 只往 <DSH_HOME>/profiles/<profile>/cordis.patch.yml **追加**两条官方条目；
//      不改 settings.yaml、不改其它插件、不覆盖用户已手写的同 id 配置。
//   2) 不引入任何依赖：模型来源用「容错行解析」（缩进 + '- id:'），不用 YAML 库。
//   3) 幂等：同 id 且值满足要求 → 不改；同 id 但值不同/含自定义键 → 跳过并报告。
//   4) 安全：写前备份、临时文件 + rename 原子替换、写后重读校验；
//      任何失败回滚并返回 { ok:false, error }，绝不 throw 到调用方（不能让 DSH 起不来）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_TEAM_ID = 'agent-team';
export const MODEL_SELECTION_ID = 'subagent-model-selection-settings';
export const TEAM_MAX_TASKS = 256;

const BAK_INFIX = '.bak-token2biq-';
const BLOCK_HEADER = [
  '# === dsh-token2biq 自动配置（autoProvision）开始 ===',
  '# 回滚：删除本段两条条目（agent-team / subagent-model-selection-settings），',
  '# 或用同目录 ' + BAK_INFIX + '* 备份覆盖后重启 DSH。',
];

let _seq = 0;

// ---------- 路径解析 ----------

export function resolveDshHome(home) {
  const explicit = home == null ? '' : String(home).trim();
  if (explicit) return explicit;
  const env = process.env.DSH_HOME == null ? '' : String(process.env.DSH_HOME).trim();
  if (env) return env;
  return path.join(os.homedir(), '.dsh');
}

// profile 名合法性：只允许单段、无路径分隔（防止 ../ 逃逸到 profiles 之外）。
const PROFILE_RE = /^[A-Za-z0-9._-]+$/;
function validProfileName(v) {
  const s = v == null ? '' : String(v).trim();
  if (!s || s === '.' || s === '..') return '';
  return PROFILE_RE.test(s) ? s : '';
}

// 枚举 profiles/* 时排除备份/临时目录（desktop.bak、desktop-tmp、~desktop 等），
// 否则一次备份就会把「活动 profile」判成多候选，从而拒绝写入（假 ambiguous）。
const BACKUP_NAME_RE = /^~|\.(bak|tmp|old|orig|swp|backup|copy)$|[._-](bak|tmp|old|orig|swp|backup|copy)([._-]|$)/i;
function isRealProfileDir(name) {
  const s = validProfileName(name);
  return !!s && !BACKUP_NAME_RE.test(s);
}

// 从模块自身安装路径反解 profiles/<name>/node_modules —— 这是「本 profile 正在加载本插件」最可靠的信号。
function profileFromModuleUrl() {
  try {
    const p = fileURLToPath(import.meta.url).replace(/\\/g, '/');
    const m = /\/profiles\/([^/]+)\/node_modules\//.exec(p);
    return m ? validProfileName(m[1]) : '';
  } catch { return ''; }
}

// 解析活动 profile：显式参数 > settings.provisionProfile > DSH_PROFILE > 模块路径反解 > 枚举 profiles/*（仅唯一命中）。
// 多 profile 且无可靠来源时返回 ok:false + 候选，绝不默默写错 profile（旧实现默认 desktop 会写偏）。
export function resolveProfileDetailed(options = {}) {
  const o = options && typeof options === 'object' ? options : {};
  const explicit = validProfileName(o.profile);
  if (explicit) return { ok: true, profile: explicit, source: 'explicit', candidates: [] };
  const fromSettings = validProfileName(o.provisionProfile);
  if (fromSettings) return { ok: true, profile: fromSettings, source: 'settings', candidates: [] };
  const fromEnv = validProfileName(process.env.DSH_PROFILE);
  if (fromEnv) return { ok: true, profile: fromEnv, source: 'env', candidates: [] };
  const fromUrl = profileFromModuleUrl();
  if (fromUrl) return { ok: true, profile: fromUrl, source: 'module-path', candidates: [] };
  let candidates = [];
  try {
    const home = resolveDshHome(o.home != null ? o.home : o.dshHome);
    candidates = fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && isRealProfileDir(d.name))
      .map((d) => d.name)
      .sort();
  } catch { candidates = []; }
  if (candidates.length === 1) return { ok: true, profile: candidates[0], source: 'enumerated', candidates };
  if (candidates.length > 1) {
    return {
      ok: false,
      profile: null,
      source: 'ambiguous',
      candidates,
      error: '检测到多个 DSH profile（' + candidates.join('、') + '），无法可靠确定活动 profile；请显式指定 profile，或设置 DSH_PROFILE / provisionProfile',
    };
  }
  return {
    ok: false,
    profile: null,
    source: 'none',
    candidates: [],
    error: '未能确定 DSH profile（无显式参数 / provisionProfile / DSH_PROFILE，且 profiles 目录为空）；请显式指定 profile',
  };
}

// 兼容旧签名：能可靠确定时返回 profile 字符串，否则返回 null（不再默认 desktop）。
export function resolveProfile(profile) {
  const r = resolveProfileDetailed({ profile });
  return r.ok ? r.profile : null;
}

export function resolvePatchFile(options = {}) {
  const o = options && typeof options === 'object' ? options : {};
  const home = o.home != null ? o.home : o.dshHome;
  const r = resolveProfileDetailed({ profile: o.profile, provisionProfile: o.provisionProfile, home });
  if (!r.ok) return null;
  return path.join(resolveDshHome(home), 'profiles', r.profile, 'cordis.patch.yml');
}

export function resolveSettingsYaml(options = {}) {
  const o = options && typeof options === 'object' ? options : {};
  const home = o.home != null ? o.home : o.dshHome;
  return path.join(resolveDshHome(home), 'settings.yaml');
}

function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return '';
    return ''; // 读不到就当作「没有可扫描的模型」——只会退化成 warning，不阻断
  }
}

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return p(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// ---------- 容错行解析（缩进 + key: value / - key: value） ----------

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function indentOf(line) {
  const m = /^[ \t]*/.exec(line);
  if (!m) return 0;
  return m[0].replace(/\t/g, '  ').length;
}

function unquote(v) {
  let s = String(v == null ? '' : v).trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

// 把一段 YAML 扫成「路径 → 值」的行数组。路径里用 '[]' 表示序列项（每项一段）。
// 只做我们需要的容错解析：忽略注释/空行、按缩进维护父路径、不追求 YAML 全集。
export function scanYamlPaths(text) {
  const out = [];
  const stack = []; // { indent, segment }
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (const raw of lines) {
    if (raw == null) continue;
    const line = stripComment(raw);
    const body = line.trim();
    if (!body) continue;
    if (body === '---' || body === '...') continue;
    const indent = indentOf(line);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack.map((s) => s.segment);

    // 序列项：'- key: value'（可继续嵌套子键）
    const item = /^-\s*(.*)$/.exec(body);
    if (item) {
      const rest = item[1].trim();
      const kv = /^([A-Za-z0-9_.\-@/]+|"[^"]*"|'[^']*')\s*:\s*(.*)$/.exec(rest);
      if (kv) {
        const key = unquote(kv[1]);
        const value = unquote(kv[2]);
        out.push({ path: [...parent, '[]', key], value });
        // 该序列项的键本身是映射/序列头，或后面还有更深缩进的子键：
        // 无论 value 是否为空都要把 '[]'/key 压栈，否则列表式 providers[] 的
        // name/models 子块会被挂到上一级，collectModelRefs 永远找不到。
        stack.push({ indent, segment: '[]' });
        stack.push({ indent, segment: key });
      } else {
        out.push({ path: [...parent, '[]'], value: unquote(rest) });
      }
      continue;
    }

    // 普通映射行
    const kv = /^([A-Za-z0-9_.\-@/]+|"[^"]*"|'[^']*')\s*:\s*(.*)$/.exec(body);
    if (!kv) continue;
    const key = unquote(kv[1]);
    const value = unquote(kv[2]);
    out.push({ path: [...parent, key], value });
    if (value === '') stack.push({ indent, segment: key });
  }
  return out;
}

// 收集 provider/model：兼容 'providers.<name>.models[].id'（映射式 provider）
// 与 'providers[].name/models[].id'（列表式 provider）。多来源合并去重。
export function collectModelRefs(...texts) {
  const seen = new Map();
  for (const text of texts) {
    if (!text) continue;
    const rows = scanYamlPaths(text);
    let listProvider = null;
    for (const row of rows) {
      const p = row.path;
      const n = p.length;
      // 列表式：providers/[]/name 行携带 provider 名；列表路径不含索引，
      // 必须在扫描顺序里记住当前项，不能用一个全局 path→value Map（后一项会覆盖前一项）。
      if (p.includes('providers') && p[n - 1] === 'name' && p[n - 2] === '[]' && row.value) {
        listProvider = String(row.value).trim();
        continue;
      }
      if (n < 5) continue;
      if (p[n - 1] !== 'id' || p[n - 2] !== '[]' || p[n - 3] !== 'models') continue;
      if (!p.includes('providers')) continue;
      // 列表式：.../[]/name/models/[]/id；映射式：.../provider/models/[]/id
      const isListStyle = n >= 6 && p[n - 4] === 'name' && p[n - 5] === '[]';
      let provider = isListStyle ? listProvider : p[n - 4];
      if (!provider || provider === '[]') continue;
      const model = String(row.value || '').trim();
      if (!model) continue;
      const key = provider + '\u0000' + model;
      if (!seen.has(key)) seen.set(key, { provider, model });
    }
  }
  return [...seen.values()].sort((a, b) => (a.provider === b.provider
    ? a.model.localeCompare(b.model)
    : a.provider.localeCompare(b.provider)));
}

// 找到某个顶层数组条目的块（从 '- id: <id>' 到下一个顶层序列项）。
export function findEntryBlock(text, id) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = stripComment(lines[i]).trim();
    if (!t.startsWith('- ')) continue;
    if (indentOf(lines[i]) !== 0) continue;
    const m = /^-\s+id\s*:\s*(.*)$/.exec(t);
    if (!m) continue;
    if (unquote(m[1]) !== id) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const tj = stripComment(lines[j]).trim();
      if (tj && indentOf(lines[j]) === 0 && /^-\s+/.test(tj)) { end = j; break; }
    }
    return { start: i, end, text: lines.slice(i, end).join('\n') };
  }
  return null;
}

// 从条目块里取 allowedModels 的 (provider, model) 对。
export function entryModelPairs(blockText) {
  const rows = scanYamlPaths(blockText);
  const items = [];
  let cur = null;
  for (const row of rows) {
    const p = row.path;
    if (!p.includes('allowedModels')) continue;
    const leaf = p[p.length - 1];
    // provider 作为序列项首键（path 以 '[]' 结尾于其前）；model 是同一项的下一个兄弟键。
    if (leaf === 'provider') {
      cur = { provider: row.value, model: '' };
      items.push(cur);
    } else if (leaf === 'model' && cur) {
      cur.model = row.value;
    }
  }
  return items.filter((it) => it.provider && it.model);
}

function hasEnabledTrue(blockText) {
  return scanYamlPaths(blockText).some((row) => row.path[row.path.length - 1] === 'enabled'
    && String(row.value).toLowerCase() === 'true');
}

function agentTeamSatisfied(blockText) {
  // 官方要求：agent-team 的 config.defaultEnabled === true 才算「已经配好」。
  return scanYamlPaths(blockText).some((row) => row.path[row.path.length - 1] === 'defaultEnabled'
    && String(row.value).toLowerCase() === 'true');
}

function modelSelectionSatisfied(blockText, models) {
  if (!models.length) return false;
  if (!hasEnabledTrue(blockText)) return false;
  const have = new Set(entryModelPairs(blockText).map((it) => it.provider + '\u0000' + it.model));
  return models.every((m) => have.has(m.provider + '\u0000' + m.model));
}

// ---------- 追加块生成 ----------

function yamlScalar(v) {
  const s = String(v == null ? '' : v);
  if (/^[A-Za-z0-9_.\-/@]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "''") + "'";
}

export function buildAgentTeamBlock() {
  return [
    '- id: ' + AGENT_TEAM_ID,
    '  config:',
    '    maxTasks: ' + TEAM_MAX_TASKS,
    '    defaultEnabled: true',
  ].join('\n') + '\n';
}

export function buildModelSelectionBlock(models) {
  const list = Array.isArray(models) ? models : [];
  const lines = [
    '- id: ' + MODEL_SELECTION_ID,
    '  config:',
    '    enabled: true',
    '    allowedModels:',
  ];
  for (const m of list) {
    lines.push('      - provider: ' + yamlScalar(m.provider));
    lines.push('        model: ' + yamlScalar(m.model));
  }
  return lines.join('\n') + '\n';
}

// 在已有（本插件写入的）subagent-model-selection 条目里，把缺失模型增量追加到 allowedModels。
// 只插入新行，不动用户已有键/值；返回 null 表示无法安全合并（allowedModels 非块式或结构异常）。
export function planModelMerge(text, block, missing) {
  const src = String(text == null ? '' : text);
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  let amIdx = -1;
  for (let i = block.start; i < block.end && i < lines.length; i += 1) {
    if (/^(\s*)allowedModels\s*:\s*$/.test(stripComment(lines[i]))) { amIdx = i; break; }
  }
  if (amIdx < 0) return null;
  const baseIndent = indentOf(lines[amIdx]);
  const itemIndent = baseIndent + 2;
  let insertAt = amIdx + 1;
  for (let i = amIdx + 1; i < block.end && i < lines.length; i += 1) {
    const body = stripComment(lines[i]).trim();
    if (!body) continue;
    if (indentOf(lines[i]) > baseIndent) { insertAt = i + 1; continue; }
    break;
  }
  const pad = (n) => ' '.repeat(n);
  const newLines = [];
  for (const m of missing) {
    newLines.push(pad(itemIndent) + '- provider: ' + yamlScalar(m.provider));
    newLines.push(pad(itemIndent + 2) + 'model: ' + yamlScalar(m.model));
  }
  if (!newLines.length) return null;
  const outLines = [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)];
  return { text: outLines.join(eol), insertAt, insertedCount: newLines.length };
}

// ---------- 主流程 ----------

// 幂等补齐宿主配置。永不 throw：失败返回 { ok:false, error }。
export function applyProvision(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const home = opts.home != null ? opts.home : opts.dshHome;
  const prof = resolveProfileDetailed({ profile: opts.profile, provisionProfile: opts.provisionProfile, home });
  const result = {
    ok: true,
    changed: false,
    patchFile: null,
    profileTargeted: prof.profile,
    profileSource: prof.source,
    candidates: prof.candidates || [],
    models: [],
    added: [],
    merged: [],
    unchanged: [],
    skipped: [],
    warning: null,
    backup: null,
    restored: false,
    error: null,
  };
  if (!prof.ok) {
    // 多 profile / 无来源：绝不静默写错 profile，直接把候选带回调用方由其决策。
    result.ok = false;
    result.error = prof.error || '未能确定 DSH profile';
    return result;
  }
  const patchFile = path.join(resolveDshHome(home), 'profiles', prof.profile, 'cordis.patch.yml');
  result.patchFile = patchFile;
  try {
    const dir = path.dirname(patchFile);
    let dirOk = false;
    try { dirOk = fs.statSync(dir).isDirectory(); } catch { dirOk = false; }
    if (!dirOk) {
      // 不替用户 mkdir：profile 目录不存在通常意味着 profile 名/DSH_HOME 不对，静默建目录更像破坏。
      result.ok = false;
      result.error = '未找到 DSH profile 目录，已跳过自动配置：' + dir;
      return result;
    }

    let original = '';
    let exists = false;
    try {
      original = fs.readFileSync(patchFile, 'utf8');
      exists = true;
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
    }

    const models = collectModelRefs(readTextIfExists(resolveSettingsYaml(opts)), original);
    result.models = models;
    if (!models.length) {
      // 官方要求 enabled 时至少一个模型：绝不为 enabled 写空的 allowedModels。
      result.warning = '未在宿主设置里发现可用模型（llm-pi-ai.providers.*.models[].id）：只写入 agent-team，未写空的 allowedModels。';
    }

    const teamBlock = findEntryBlock(original, AGENT_TEAM_ID);
    const modelBlock = findEntryBlock(original, MODEL_SELECTION_ID);
    const wanted = [];

    if (teamBlock && agentTeamSatisfied(teamBlock.text)) {
      result.unchanged.push(AGENT_TEAM_ID);
    } else if (teamBlock) {
      result.skipped.push({ id: AGENT_TEAM_ID, reason: '已存在同 id 条目但 defaultEnabled 不为 true（可能含自定义配置）；不覆盖用户配置' });
    } else {
      wanted.push({ id: AGENT_TEAM_ID, text: buildAgentTeamBlock() });
    }

    let mergedText = null;
    if (modelBlock && models.length && modelSelectionSatisfied(modelBlock.text, models)) {
      result.unchanged.push(MODEL_SELECTION_ID);
    } else if (modelBlock) {
      // 已有的 subagent-model-selection 条目：仅当 enabled:true 且确由本插件写入（含 BLOCK_HEADER）时，
      // 才把缺失模型增量追加进 allowedModels（保留用户内容）；enabled!=true 或非本插件条目一律不动。
      const enabled = hasEnabledTrue(modelBlock.text);
      const ours = original.includes(BLOCK_HEADER[0]);
      if (enabled && ours && models.length) {
        const have = new Set(entryModelPairs(modelBlock.text).map((it) => it.provider + '\u0000' + it.model));
        const missing = models.filter((m) => !have.has(m.provider + '\u0000' + m.model));
        if (!missing.length) {
          result.unchanged.push(MODEL_SELECTION_ID);
        } else {
          const plan = planModelMerge(original, modelBlock, missing);
          if (plan) { mergedText = plan.text; result.merged.push(MODEL_SELECTION_ID); }
          else result.skipped.push({ id: MODEL_SELECTION_ID, reason: '已有条目无法安全增量合并（allowedModels 非块式或结构异常）；不覆盖用户配置' });
        }
      } else {
        result.skipped.push({
          id: MODEL_SELECTION_ID,
          reason: !enabled ? '已存在同 id 条目但 enabled 不为 true；不改用户配置'
            : (!ours ? '已存在同 id 条目但非本插件写入（缺少 BLOCK_HEADER）；不覆盖用户配置'
              : '已存在同 id 条目但无可用模型；不覆盖用户配置'),
        });
      }
    } else if (models.length) {
      wanted.push({ id: MODEL_SELECTION_ID, text: buildModelSelectionBlock(models) });
    }

    if (!wanted.length && mergedText == null) return result;

    let next = mergedText != null ? mergedText : original;
    if (wanted.length) {
      if (next && !next.endsWith('\n')) next += '\n';
      next += BLOCK_HEADER.join('\n') + '\n';
      for (const w of wanted) next += w.text;
    }

    // 写前备份（仅当目标文件已存在）
    if (exists) {
      result.backup = patchFile + BAK_INFIX + stamp();
      fs.copyFileSync(patchFile, result.backup);
    }

    // 临时文件 + rename 原子替换
    const tmp = patchFile + '.' + process.pid + '.' + (_seq = (_seq + 1)) + '.tmp';
    try {
      fs.writeFileSync(tmp, next, 'utf8');
      fs.renameSync(tmp, patchFile);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 清理残余 tmp */ }
      throw e;
    }

    // 写后重读校验：落盘内容必须与预期逐字节一致；追加块可再次解析；合并后模型齐全。
    const after = fs.readFileSync(patchFile, 'utf8');
    if (after !== next) throw new Error('写后校验失败：落盘内容与预期不一致');
    for (const w of wanted) {
      if (!findEntryBlock(after, w.id)) throw new Error('写后校验失败：缺少条目 ' + w.id);
    }
    if (mergedText != null) {
      const mb = findEntryBlock(after, MODEL_SELECTION_ID);
      if (!mb || !modelSelectionSatisfied(mb.text, models)) throw new Error('写后校验失败：增量合并后模型仍不齐全');
    }

    result.changed = true;
    result.added = wanted.map((w) => w.id);
    return result;
  } catch (e) {
    // 任何失败：回滚到备份（有的话），返回 ok:false，绝不 throw 到调用方。
    try {
      if (result.backup && fs.existsSync(result.backup)) {
        fs.copyFileSync(result.backup, patchFile);
        result.restored = true;
      }
    } catch { /* 兜底：回滚本身失败也不能再抛 */ }
    result.ok = false;
    result.changed = false;
    result.added = [];
    result.error = '自动配置失败（' + (result.restored ? '已回滚' : '未改动无法回滚') + '）：' + ((e && e.message) || e);
    return result;
  }
}

// 接线入口：autoProvision=false 时完全不动宿主。
export function runAutoProvision(config = {}) {
  const c = config && typeof config === 'object' ? config : {};
  if (c.autoProvision === false) {
    return {
      ok: true,
      changed: false,
      disabled: true,
      patchFile: null,
      profileTargeted: null,
      candidates: [],
      merged: [],
      models: [],
      added: [],
      unchanged: [],
      skipped: [],
      warning: null,
      backup: null,
      restored: false,
      error: null,
    };
  }
  try {
    return applyProvision(c);
  } catch (e) {
    return {
      ok: false,
      changed: false,
      patchFile: null,
      models: [],
      added: [],
      unchanged: [],
      skipped: [],
      warning: null,
      backup: null,
      restored: false,
      error: String((e && e.message) || e),
    };
  }
}
