// 子代理可选模型放行策略：把插件里配置/目录里的模型汇总成宿主策略事件，纯函数 + 单点 append。
// 该模块不依赖宿主；applySubagentModelPolicy 绝不抛（失败以 ok:false 回传）。

// "provider::model" → { provider, model }；非法返回 null。
export function parseModelRef(ref) {
  if (typeof ref !== 'string') return null;
  const i = ref.indexOf('::');
  if (i <= 0) return null;
  const provider = ref.slice(0, i).trim();
  const model = ref.slice(i + 2).trim();
  if (!provider || !model) return null;
  return { provider, model };
}

// 汇总 rolePools / roleModels / 目录里的所有模型，解析去重（按 provider+'\0'+model），丢弃非法。
// 返回 [{ provider, model }, ...]，顺序稳定（rolePools 各角色 → roleModels 各角色 → 目录组/模型）。
export function collectModelRoutes({ rolePools, roleModels, catalogGroups } = {}) {
  const refs = [];
  if (rolePools && typeof rolePools === 'object') {
    for (const k of Object.keys(rolePools)) {
      const arr = rolePools[k];
      if (Array.isArray(arr)) for (const r of arr) refs.push(r);
    }
  }
  if (roleModels && typeof roleModels === 'object') {
    for (const k of Object.keys(roleModels)) {
      const v = roleModels[k];
      if (v) refs.push(v);
    }
  }
  if (Array.isArray(catalogGroups)) {
    for (const g of catalogGroups) {
      if (!g || !g.id || !Array.isArray(g.models)) continue;
      for (const m of g.models) {
        if (m && m.id) refs.push(String(g.id) + '::' + String(m.id));
      }
    }
  }
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    const parsed = parseModelRef(ref);
    if (!parsed) continue;
    const key = parsed.provider + '\0' + parsed.model;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

// 在会话上登记子代理可选模型策略。绝不抛。
export function applySubagentModelPolicy(session, routes) {
  if (!session || typeof session.append !== 'function') return { ok: false, reason: 'no-session' };
  if (!Array.isArray(routes) || !routes.length) return { ok: false, reason: 'no-routes' };
  try {
    session.append('subagent/model-selection-policy', { allowedModels: routes });
    return { ok: true, count: routes.length };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}
