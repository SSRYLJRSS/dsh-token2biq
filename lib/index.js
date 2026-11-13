// Token 2b IQ 宿主插件入口（Cordis bundle）。
// 职责：装载 Token2bIQService；注册 web 路由（面板数据/动作/导出）；注册 token2biq 工具（编排决策 + 回执记账）。
// 复用优先：不引入任何新依赖，不实现自己的 agent 运行时；实际执行交给 DSH 既有 subagent / workflow / team_task_*。
import { Token2bIQService } from './service.js';
import { buildPolicy } from './orchestrator.js';
import { parseModelRef, collectModelRoutes, applySubagentModelPolicy } from './model-routes.js';
import { resolveStateFile } from './paths.js';

export const name = 'dsh-token2biq';
export const inject = []; // 依赖在内部按需可选用 ctx.inject 懒获取

// 说明：工具使用“原生定义对象”（{name,description,parameters,output,execute}），
// 由 ctx.tools.register 直接消费——与 genui / billion-context 完全相同的做法。
// 因此不再依赖 @deepseek-ai/dsh-tools 这一宿主内部包，link: 方式安装的插件也能正常注册工具。

const TOOL_DESCRIPTION = [
  'Token 2b IQ 主动编排控制器：给复杂任务按档位自动建团队（真 spawn 队员 + 建共享任务板），并用 token 换成功率/准确性。',
  '用法：先 action=start(goal, mode?)。mode 可省略——省略时以本会话「IQ」下拉锁定的档位为准（S1/S2/S3/S4 会强制建团，忽略传入的异档）；仅当本会话为「自动」时才按复杂度分类。若调用方是 Team Lead，插件会直接创建好队员与共享任务板（返回 roster/created/modelRouting），随后你用 send_message / wait_agent / team_task_list 监督执行。',
  '模型：设置里按角色指定的模型会让对应阶段改由 subagent(provider/model) 执行（spawn_teammate 无法携带模型），record 时带上 model 供白名单/跨厂商校验。',
  '流程：action=start → 派活/执行（模型阶段用 subagent，执行后 complete 对应共享任务）→ 每阶段 action=record(带 teamTaskId/owner 与回执) → action=finish(verdict)。会话为「自动」且确属小任务时不要起团队。',
  '其它：action=map 只取团队手册；action=help 看字段；settings/state/list/export/mode/pause/resume/delete。',
].join('\n');

// 工具结果体量控制：超限时**不要整体丢弃**——优先保留主动编排必需的 created / modelRouting / next，
// 只省略体积最大的 playbook/roster（可用 action=map 再取）。修复：S3/S4 的 start 结果超 12k 时
// 模型拿不到 created.tasks/members/modelRouting，导致主动编排静默空转。
export function compactToolResult(result, limit = 12000) {
  let text;
  try { text = JSON.stringify(result); } catch { text = String(result); }
  if (!text || text.length <= limit) return text;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const slim = { ...result };
    delete slim.playbook;
    delete slim.roster;
    let slimText = '';
    try { slimText = JSON.stringify({ ...slim, _truncated: 'playbook/roster 已省略（用 action=map 获取完整手册）；created/modelRouting/next 已保留。' }); } catch { slimText = ''; }
    if (slimText && slimText.length <= limit) return slimText;
    const core = {
      ok: result.ok !== false,
      run: result.run ? { id: result.run.id, mode: result.run.mode, requestedMode: result.run.requestedMode, status: result.run.status } : undefined,
      plan: result.plan ? { mode: result.plan.mode, maxAgents: result.plan.maxAgents, stages: result.plan.stages, costWeight: result.plan.costWeight } : undefined,
      created: result.created,
      modelRouting: result.modelRouting,
      roster: result.roster,
      next: result.next,
      _truncated: '结果过大：已保留 run/plan/created/roster/modelRouting/next；完整手册用 action=map。',
    };
    let coreText = '';
    try { coreText = JSON.stringify(core); } catch { coreText = ''; }
    if (coreText && coreText.length <= limit) return coreText;
    return JSON.stringify({ ok: true, truncated: true, message: '结果过大且无法精简；请用 action=list / action=export。' });
  }
  return JSON.stringify({ ok: true, truncated: true, message: '结果过大；请用 action=list / action=export。' });
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve) => {
    let buf = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      buf += c;
      if (Buffer.byteLength(buf, 'utf8') > limit) { tooLarge = true; buf = ''; }
    });
    req.on('end', () => {
      if (tooLarge) return resolve({ __tooLarge: true });
      try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// 低思考模型复核器：Auto 混合模式里「关键词拿不准」时调用一次，要求严格 JSON。
// 走宿主 llm.stream（一次性补全，不是起子代理）；任何失败/超时都静默返回 null，由上层回退关键词。
const CLASSIFY_SYSTEM = '你是任务复杂度分流器。只输出一个 JSON 对象，不要任何多余文字或代码块：{"tier":"S1|S2|S3","worthTeam":true|false,"reason":"不超过20字的理由"}。'
  + 'S1=单文件小修/问答/单点改动；S2=多文件、需要计划或多次评审的中等任务；S3=架构级/大重构/多模块迁移/需要研究+红队+回归的大改。'
  + 'worthTeam 表示是否真的值得动用多智能体（小任务判 false）。拿不准时略保守，但不要把一切都判成 S3。';

function makeLlmClassifier(ctx, log, service) {
  return async function classifyWithLlm(goal) {
    let llm = null;
    try { llm = (typeof ctx.get === 'function' && ctx.get('llm')) || null; } catch { llm = null; }
    if (!llm || typeof llm.stream !== 'function') return null;
    // 选路由：优先当前默认模型；否则回退到可用的 deepseek flash（便宜快）。
    let provider = 'magpie', model = 'workbuddy/deepseek-v4.1-flash';
    try {
      const adm = ctx.get('agentDefaultModel');
      const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null;
      if (sel && sel.provider && sel.model) { provider = sel.provider; model = sel.model; }
    } catch { /* 用回退路由 */ }
    // 最低思考：宿主规范枚举为 none|minimal|low|medium|high|xhigh|max，'off' 非法会静默失败
    const effort = /deepseek-v4\.1-flash|deepseek-flash/i.test(model) ? 'none' : undefined;
    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, 8000);
    // 让 noteUsage 跳过这次分类调用：路由开销不应算进「用户实时 token」。
    if (service) service._classifying = (service._classifying || 0) + 1;
    try {
      let text = '';
      const stream = llm.stream({
        provider, model,
        ...(effort ? { reasoningEffort: effort } : {}),
        temperature: 0, maxTokens: 220,
        messages: [{ role: 'user', content: [{ type: 'text', text: CLASSIFY_SYSTEM + '\n\n任务：' + String(goal || '').slice(0, 4000) }] }],
        signal: ac.signal,
      });
      for await (const ch of stream) {
        if (!ch) continue;
        if (ch.type === 'text-delta' && ch.text) text += ch.text;
        else if (ch.type === 'finish' && ch.reason && ch.reason.kind === 'error') return null;
      }
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const obj = JSON.parse(m[0]);
      const tier = obj.tier === 'S3' ? 'S3' : obj.tier === 'S2' ? 'S2' : obj.tier === 'S1' ? 'S1' : null;
      if (!tier) return null;
      return { tier, worthTeam: obj.worthTeam !== false, reason: obj.reason ? String(obj.reason).slice(0, 120) : '' };
    } catch (e) {
      try { log('Auto 模型复核失败，回退关键词：' + ((e && e.message) || e)); } catch { /* ignore */ }
      return null;
    } finally {
      if (service) service._classifying = Math.max(0, (service._classifying || 1) - 1);
      clearTimeout(timer);
    }
  };
}

export function apply(ctx, config = {}) {
  const log = (...a) => { try { if (ctx.logger && ctx.logger.info) ctx.logger.info('[token2biq]', ...a); } catch {} };

  const service = new Token2bIQService({
    ...config,
    stateFile: config.stateFile || resolveStateFile(),
  });
  // Auto 混合判定的模型复核器（关键词拿不准时才用；宿主 llm 服务不可用时自动回退关键词）。
  service.classifier = makeLlmClassifier(ctx, log, service);

  // 可选依赖：持有 sessionController 引用（模型目录 / 精确计量都用它）。宿主未就绪时先留空，用时再取。
  let sessionControllerRef = null;
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sessionController'], (sc) => {
        try { sessionControllerRef = (sc && sc.sessionController) || sessionControllerRef; } catch { /* ignore */ }
      });
    }
  } catch { /* 服务不存在时忽略 */ }

  // 让插件自己登记「子代理可选模型」放行策略：start/settings 时把面板里配的模型（+目录模型）
  // append 成宿主策略事件，无需用户去 DSH 官方设置里手动点。绝不抛，失败以 ok:false 回传。
  const policyDoneSessions = new Set();
  async function ensureSubagentModelPolicy(agent) {
    try {
      const sess = (agent && agent.session) ? agent.session : null;
      if (!sess || typeof sess.append !== 'function') return { ok: false, reason: 'no-session' };
      const sid = sess.id || sess.sessionId || null;
      if (sid && policyDoneSessions.has(sid)) return { ok: true, cached: true };
      const st = service.settings.get();
      let catalogGroups = [];
      try {
        const sc = sessionControllerRef || (typeof ctx.get === 'function' ? ctx.get('sessionController') : null);
        if (sc && typeof sc.modelCatalog === 'function') {
          const cat = await sc.modelCatalog();
          if (cat && Array.isArray(cat.groups)) catalogGroups = cat.groups;
        }
      } catch { catalogGroups = []; }
      const routes = collectModelRoutes({ rolePools: st.rolePools, roleModels: st.roleModels, catalogGroups });
      const r = applySubagentModelPolicy(sess, routes);
      if (r.ok && sid) {
        policyDoneSessions.add(sid);
        if (policyDoneSessions.size > 256) {
          const first = policyDoneSessions.values().next().value;
          policyDoneSessions.delete(first);
        }
      }
      try { log('子代理放行策略：' + JSON.stringify(r)); } catch { /* ignore */ }
      return r;
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  // ---------- 0.4) 主动编排：向 Team 代理注入角色化提示段（让模型主动起团队） ----------
  // 宿主提供 agentTeams/agents 时，为每个 Team 成员注册 systemPrompt.section：
  //   Lead → 编排策略（大任务先 token2biq action=start，插件自动建队员 + 任务板）；
  //   队员 → 执行/回执纪律（claim/complete + send_message 回执）。
  let agentTeamsRef = null;
  let leadAgentRef = null;
  const policyDisposers = new Map();
  const agentSessionIds = new Map();
  const installAgentPolicy = (agent) => {
    try {
      if (!agent || policyDisposers.has(agent)) return;
      const at = agentTeamsRef;
      if (!at || typeof at.tryMembership !== 'function') return;
      let m = null;
      try { m = at.tryMembership(agent); } catch { m = null; }
      if (!m) return; // 非 Team 成员（普通子代理 / 陈旧身份）不注入
      if (m.role === 'lead' && !leadAgentRef) leadAgentRef = agent;
      let sid = '';
      try { sid = (agent.session && (agent.session.id || agent.session.sessionId)) || ''; } catch { sid = ''; }
      if (sid) agentSessionIds.set(agent, sid);
      let policyMode = null;
      let policyEnabled = true;
      try {
        const pf = sid ? service.getSessionPref(sid) : null;
        if (pf) { policyMode = pf.mode || null; policyEnabled = pf.enabled !== false; }
      } catch { /* 用默认 */ }
      const scoped = agent.ctx;
      if (!scoped || !scoped.systemPrompt || typeof scoped.systemPrompt.section !== 'function') return;
      const disposers = [];
      try {
        let order = 650;
        try {
          if (typeof scoped.systemPrompt.getSectionOrder === 'function') {
            const anchor = scoped.systemPrompt.getSectionOrder('TEAM_POLICY');
            if (Number.isFinite(anchor)) order = anchor;
          }
        } catch { /* 用默认 order */ }
        const d = scoped.systemPrompt.section({ name: 'token2biq:policy', order, text: buildPolicy(m.role, { mode: policyMode, enabled: policyEnabled }) });
        if (typeof d === 'function') disposers.push(d);
      } catch (e) { log('token2biq 提示段注入失败：' + ((e && e.message) || e)); }
      policyDisposers.set(agent, () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } });
    } catch (e) { log('installAgentPolicy 失败：' + ((e && e.message) || e)); }
  };
  // 档位变更后重渲染该会话 agent 的提示段：让「锁定档位」即时进入系统提示，而不是等下次重启。
  const refreshPoliciesForSession = (sid) => {
    try {
      for (const [agent, dispose] of Array.from(policyDisposers.entries())) {
        if (agentSessionIds.get(agent) !== sid) continue;
        try { dispose(); } catch { /* ignore */ }
        policyDisposers.delete(agent);
        try { installAgentPolicy(agent); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  };
  try { service.onSessionPrefChanged = (sid) => refreshPoliciesForSession(sid); } catch { /* ignore */ }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['agentTeams', 'agents'], (sctx) => {
        try { agentTeamsRef = (sctx && sctx.agentTeams) || agentTeamsRef; } catch { /* ignore */ }
        sctx.effect(() => {
          try {
            if (sctx.agents && typeof sctx.agents.list === 'function') {
              for (const a of sctx.agents.list()) installAgentPolicy(a);
            }
          } catch { /* ignore */ }
          return () => {
            for (const d of policyDisposers.values()) { try { d(); } catch { /* ignore */ } }
            policyDisposers.clear();
            agentSessionIds.clear();
          };
        }, 'token2biq.agentPolicy');
      });
    }
  } catch { /* 宿主无 agentTeams 时忽略 */ }
  try { ctx.on('agent/created', ({ agent }) => { installAgentPolicy(agent); }); } catch { /* ignore */ }
  try {
    ctx.on('agent/disposed', ({ agent }) => {
      const d = policyDisposers.get(agent);
      if (d) { try { d(); } catch { /* ignore */ } policyDisposers.delete(agent); }
      agentSessionIds.delete(agent);
      if (leadAgentRef === agent) leadAgentRef = null;
    });
  } catch { /* ignore */ }

  // ---------- 0) 实时 token 观测：监听宿主每次模型流式调用，按会话累计 usage ----------
  try {
    ctx.on('llm/stream', async function* (options, next) {
      const sid = options && options.sessionId;
      let stream;
      try { stream = next(); }
      catch (e) { try { log('llm/stream next() 抛错，原样抛出：' + ((e && e.message) || e)); } catch { /* ignore */ } throw e; }
      for await (const chunk of stream) {
        try {
          if (chunk && chunk.type === 'usage' && chunk.usage) service.noteUsage(chunk.usage, sid);
        } catch { /* 绝不影响主流程 */ }
        yield chunk;
      }
    });
  } catch (err) {
    log('llm/stream tap 注册失败：' + ((err && err.message) || err));
  }

  // ---------- 1) HTTP 路由（面板数据 + 动作 + 导出） ----------
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const handler = async (req, res) => {
        const u = new URL(req.url, 'http://localhost');
        const p = u.pathname.replace(/^\/token2biq\/?/, '');
        const sendJson = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(obj));
        };
        try {
          if (req.method === 'GET' && (p === '' || p === 'state')) {
            return sendJson(200, service.state(u.searchParams.get('runId') || undefined));
          }
          if (req.method === 'GET' && p === 'settings') {
            return sendJson(200, { ok: true, settings: service.getSettings() });
          }
          if (req.method === 'GET' && p === 'session') {
            const sid = u.searchParams.get('sessionId') || '';
            return sendJson(200, { ok: true, sessionId: sid, pref: service.getSessionPref(sid) });
          }
          if (req.method === 'GET' && p === 'models') {
            const getSC = () => {
              try {
                return sessionControllerRef
                  || (typeof ctx.get === 'function' && ctx.get('sessionController'))
                  || (typeof sctx.get === 'function' && sctx.get('sessionController'))
                  || null;
              } catch { return sessionControllerRef || null; }
            };
            const sc = getSC();
            if (!sc || typeof sc.modelCatalog !== 'function') {
              return sendJson(200, { ok: false, models: [], error: '宿主 sessionController 尚未就绪（刚启动常见，稍后会自动重试）', retryable: true });
            }
            // @Remote 服务在刚启动/新会话时可能短暂不可用：重试数次而不是直接报「未就绪」。
            let lastErr = null;
            for (let attempt = 0; attempt < 6; attempt++) {
              try {
                const cat = await sc.modelCatalog();
                const models = [];
                for (const g of (cat.groups || [])) {
                  for (const m of (g.models || [])) {
                    models.push({
                      ref: g.id + '::' + m.id,
                      provider: g.id,
                      providerName: g.name,
                      id: m.id,
                      name: m.name,
                      description: m.description || '',
                      reasoning: m.reasoning || null,
                    });
                  }
                }
                if (models.length) return sendJson(200, { ok: true, default: cat.default || null, models, failures: cat.failures || [] });
                lastErr = '模型目录为空';
              } catch (e) {
                lastErr = String((e && e.message) || e);
              }
              await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
            }
            return sendJson(200, { ok: false, models: [], error: lastErr || '模型目录为空', retryable: true });
          }
          if (req.method === 'GET' && p === 'export') {
            const md = service.exportReport(u.searchParams.get('runId') || undefined);
            res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="token2biq-report.md"', 'cache-control': 'no-store' });
            return res.end(md);
          }
          if (req.method === 'POST') {
            // CSRF/跨站防护（P1-4）：浏览器跨站 POST 会带 Origin → 只允许本机来源；
            // 且要求 application/json（跨站「简单请求」只能用 text/plain，无法带 JSON content-type）。
            const origin = req.headers && req.headers.origin;
            if (origin) {
              let oh = '';
              try { oh = new URL(origin).hostname; } catch { oh = ''; }
              if (oh !== '127.0.0.1' && oh !== 'localhost' && oh !== '::1' && oh !== '[::1]') {
                return sendJson(403, { error: 'forbidden origin' });
              }
            }
            const ctype = String((req.headers && req.headers['content-type']) || '');
            if (ctype && !/application\/json/i.test(ctype)) {
              return sendJson(415, { error: 'content-type must be application/json' });
            }
            const body = await readJson(req);
            if (body && body.__tooLarge) return sendJson(413, { error: 'payload too large (>1MB)' });
            if (p === 'mode') return sendJson(200, { ok: true, mode: service.setMode(body.mode) });
            if (p === 'pause') return sendJson(200, service.setPaused(body.runId, body.paused !== false));
            if (p === 'config') return sendJson(200, { ok: true, config: service.updateConfig(body) });
            if (p === 'settings') return sendJson(200, { ok: true, settings: service.updateSettings(body) });
            if (p === 'session') return sendJson(200, service.setSessionPref(body.sessionId, { enabled: body.enabled, mode: body.mode }));
            if (p === 'action') return sendJson(200, await service.handleToolAsync(body));
          }
          return sendJson(404, { error: 'not found', path: u.pathname });
        } catch (err) {
          try { sendJson(500, { error: String((err && err.message) || err) }); } catch {}
        }
      };
      const dispose = sctx.webServer.register({ kind: 'prefix', path: '/token2biq', handler });
      return () => { try { dispose(); } catch {} };
    }, 'token2biq.web-routes');
  });

  // ---------- 2) token2biq 工具（原生定义对象，不依赖 @deepseek-ai/dsh-tools） ----------
  // 形状与 genui / billion-context 一致：execute 返回「值」，output.render 把值渲染成 ContentBlock[]。
  const TOOL_PARAMETERS = {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: { type: 'string', description: '动作', enum: ['start', 'record', 'finish', 'pause', 'resume', 'export', 'list', 'mode', 'state', 'settings', 'delete', 'map', 'help'] },
      goal: { type: 'string', description: '目标(start)' },
      mode: { type: 'string', description: '档位', enum: ['S1', 'S2', 'S3', 'S4', 'Auto'] },
      runId: { type: 'string', description: '运行ID' },
      stage: { type: 'string', description: '阶段' },
      status: { type: 'string', description: 'worker 状态 done|failed' },
      files: { type: 'array', description: '改动文件', items: { type: 'string' } },
      diffSummary: { type: 'string', description: '改动摘要' },
      testsRun: { type: 'array', description: '已跑测试', items: { type: 'string' } },
      notes: { type: 'string', description: '备注' },
      verdict: { type: 'string', description: '结论', enum: ['PASS', 'FAIL'] },
      issues: { type: 'array', description: '问题', items: { type: 'string' } },
      evidence: { type: 'array', description: '证据', items: { type: 'string' } },
      findings: { type: 'array', description: 'research/plan 的发现（可选）', items: { type: 'string' } },
      sources: { type: 'array', description: '调研来源（可选）', items: { type: 'string' } },
      logs: { type: 'array', description: '验证日志（可选）', items: { type: 'string' } },
      rationale: { type: 'string', description: '裁决理由' },
      tokensIn: { type: 'number', description: '输入token' },
      tokensOut: { type: 'number', description: '输出token' },
      paused: { type: 'boolean', description: '暂停/继续' },
      teamTaskId: { type: 'string', description: '官方共享任务 id（team_task_* 返回），用于台账绑定' },
      owner: { type: 'string', description: '执行该任务的队员 target（spawn_teammate 返回）' },
      model: { type: 'string', description: '本阶段实际用的模型引用 provider::model（可选，用于白名单/跨厂商校验）' },
      summary: { type: 'string', description: 'research/plan 阶段的结论摘要（或改用 diffSummary）' },
      role: { type: 'string', description: '执行角色（可选，覆盖默认角色）' },
      brief: { type: 'string', description: '任务简报' },
      candidates: { type: 'number', description: 'start：候选数量 1..5，>1 开启多候选择优（strict 下须配 candidateId/selectedCandidate）' },
      acceptance: { type: 'string', description: 'start/plan：验收标准（strict 门禁要求进入 generate 前必须有 spec/acceptance）' },
      spec: { type: 'string', description: 'start：规格说明（可与 acceptance 一起传）' },
      constraints: { type: 'string', description: 'start/plan：约束条件' },
      candidateId: { type: 'number', description: 'record(generate)：多候选模式下的候选编号（1..N）' },
      selectedCandidate: { type: 'string', description: 'record(judge)：择优选中的候选编号' },
      testsPassed: { type: 'boolean', description: 'record(verify/regression)：测试是否通过（可选，用于门禁证据）' },
      targetTaskId: { type: 'string', description: 'review 阶段被评审任务的 id' },
      byJudge: { type: 'string', description: 'finish 时指定裁决者（judge/verifier 等）' },
      settings: { type: 'object', description: 'action=settings 时的设置补丁，如 {"forceTeam":"off"}', additionalProperties: true },
    },
  };

  const toolDef = {
    name: 'token2biq',
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        const text = typeof value === 'string' ? value : String(value == null ? '' : value);
        return [{ type: 'text', text }];
      },
    },
    async execute(args, exec) {
      try {
        const a = String((args && args.action) || '').toLowerCase();
        // 调用方精确 Agent（用于「主动建团」判定 Lead 身份）与取消信号；exec 缺省时用缓存的 Lead。
        const callerAgent = (exec && exec.agent) || leadAgentRef;
        if (exec && exec.agent) { try { installAgentPolicy(exec.agent); } catch { /* ignore */ } }
        // start/settings 时顺带登记子代理模型放行策略；失败不影响主流程。
        let policyInfo = null;
        if (a === 'start' || a === 'settings') {
          try { policyInfo = await ensureSubagentModelPolicy(callerAgent); } catch { policyInfo = null; }
        }
        const ctxInfo = {
          agent: callerAgent,
          signal: exec && exec.signal,
          agentTeams: agentTeamsRef,
        };
        let result;
        if (a === 'state') {
          // 工具侧只回精简视图，避免全量 state 序列化过大、被截断成非法 JSON
          const full = service.state(args && args.runId);
          const cur = full.current;
          result = {
            ok: true,
            mode: full.mode,
            modes: full.modes,
            settings: full.settings,
            liveUsage: full.liveUsage,
            runs: (full.runs || []).slice(0, 15),
            current: cur ? {
              id: cur.id, requestedMode: cur.requestedMode, mode: cur.mode,
              status: cur.status, verdict: cur.verdict, stages: cur.stages,
              taskCount: (cur.tasks || []).length, tasks: (cur.tasks || []).slice(-8),
              reviewCount: (cur.reviews || []).length,
            } : null,
            hint: '如需完整明细请用 action=export 导出报告。',
          };
        } else {
          result = await service.handleToolAsync(args || {}, ctxInfo);
        }
        if (a === 'start' && policyInfo && result && typeof result === 'object' && !Array.isArray(result)) {
          result.subagentPolicy = policyInfo;
        }
        return compactToolResult(result);
      } catch (err) {
        return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
      }
    },
  };

  ctx.inject(['tools'], (sctx) => {
    sctx.effect(() => {
      let dispose = null;
      try {
        dispose = sctx.tools.register(toolDef);
        log('tool registered: token2biq');
      } catch (err) {
        log('tool 注册失败：' + ((err && err.message) || err));
      }
      return () => { try { if (typeof dispose === 'function') dispose(); } catch {} };
    }, 'token2biq.tool');
  });

  log('loaded, mode=' + service.getMode());
}

export default { name, inject, apply };
