// Token 2b IQ 客户端（Web UI 插件）。浏览器侧产物：只通过 window.__ModuleLoader__.load 注册；
// React 从模块表 require('react')，不打包第二份 React。
//
// 设计原则（按用户反馈）：只展示、不解释；面板就是一个干净的「运行记录」列表——
//   每条记录一眼看到：档位、这个档位额外做了什么、结论、花多少 token、时间；点开看流程。
//   档位切换只在输入框上方的「IQ」下拉里做，面板顶部不再放档位切换按钮。
window.__ModuleLoader__.load({
  id: 'dsh-token2biq',
  factory(require) {
    const React = require('react');
    let ReactDOM = null;
    try { ReactDOM = require('react-dom'); } catch (e) { ReactDOM = null; }
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const C = {
      text: 'var(--dsw-alias-label-primary,inherit)',
      sub: 'var(--dsw-alias-label-secondary,rgba(127,127,127,0.92))',
      tertiary: 'var(--dsw-alias-label-tertiary,rgba(127,127,127,0.72))',
      border: 'var(--dsw-alias-border-l2,rgba(127,127,127,0.28))',
      border3: 'var(--dsw-alias-border-l3,rgba(127,127,127,0.18))',
      card: 'var(--dsw-alias-bg-layer-1,#232327)',
      card2: 'var(--dsw-alias-bg-layer-2,rgba(127,127,127,0.08))',
      brand: 'var(--dsw-alias-brand-primary,#4f6ef7)',
      ok: 'var(--dsw-alias-state-success-primary,#16a34a)',
      warn: 'var(--dsw-alias-state-warn-primary,#b45309)',
      err: 'var(--dsw-alias-state-error-primary,#dc2626)',
    };

    function api(path) {
      const u = new URL(String(path).replace(/^\/+/, ''), document.baseURI);
      return u.pathname + u.search;
    }
    async function getState(runId) {
      const q = runId ? ('?runId=' + encodeURIComponent(runId)) : '';
      const r = await fetch(api('token2biq/state' + q), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }
    async function postJson(path, body) {
      const r = await fetch(api(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }
    async function getJson(path) {
      const r = await fetch(api(path), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }
    async function getSettings() { const d = await getJson('token2biq/settings'); return (d && d.settings) || null; }
    async function saveSettings(patch) { const d = await postJson('token2biq/settings', patch); return (d && d.settings) || null; }
    async function getModels() { try { const d = await getJson('token2biq/models'); return d || { models: [] }; } catch (e) { return { models: [], error: String((e && e.message) || e) }; } }
    async function getSessionPref(sessionId) { try { const d = await getJson('token2biq/session?sessionId=' + encodeURIComponent(sessionId || '')); return d || {}; } catch (e) { return {}; } }

    const S = {
      panelHost: { boxSizing: 'border-box', height: '100%', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', color: C.text, fontFamily: 'system-ui,-apple-system,"Segoe UI",sans-serif', fontSize: 13, background: 'transparent', paddingTop: 'calc(12px + var(--dsh-frame-top-clearance,0px))' },
      header: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px 12px', borderBottom: '1px solid ' + C.border },
      eyebrow: { fontSize: 10, letterSpacing: 1.4, color: C.tertiary, fontWeight: 700 },
      title: { fontSize: 16, fontWeight: 700 },
      grow: { flex: '1 1 auto', minWidth: 0 },
      body: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '14px 18px 24px', width: '100%', maxWidth: 900, margin: '0 auto', boxSizing: 'border-box' },
      btn: { cursor: 'pointer', border: '1px solid ' + C.border, background: C.card2, color: C.text, borderRadius: 7, padding: '4px 10px', fontSize: 12, lineHeight: 1.2 },
      btnClose: { cursor: 'pointer', border: '1px solid ' + C.border, background: C.card2, color: C.text, borderRadius: 7, padding: '4px 9px', fontSize: 13, lineHeight: 1, fontWeight: 700 },
      hint: { fontSize: 11.5, color: C.sub, margin: '0 0 12px' },
      empty: { color: C.sub, padding: '40px 20px', textAlign: 'center', fontSize: 12.5, lineHeight: 1.9, border: '1px dashed ' + C.border, borderRadius: 10 },
      runCard: { border: '1px solid ' + C.border, background: C.card, borderRadius: 10, padding: '11px 13px', marginBottom: 10, cursor: 'pointer' },
      runCardOn: { borderColor: C.brand },
      runHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      modeBadge: { fontSize: 12, fontWeight: 700, padding: '1px 8px', borderRadius: 6, background: 'color-mix(in srgb, ' + C.brand + ' 16%, transparent)', color: C.brand },
      pill: { display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 11, border: '1px solid currentColor', whiteSpace: 'nowrap' },
      runToken: { fontSize: 12, fontWeight: 600, color: C.text },
      runTime: { fontSize: 11, color: C.tertiary },
      runGoal: { fontSize: 12.5, lineHeight: 1.55, marginTop: 7, color: C.text, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' },
      runGoalOpen: { fontSize: 12.5, lineHeight: 1.55, marginTop: 7, color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      detailToggle: { fontSize: 11.5, color: C.brand, cursor: 'pointer', marginTop: 5, userSelect: 'none', display: 'inline-block' },
      runExtra: { fontSize: 11.5, color: C.sub, marginTop: 5 },
      flowRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0, marginTop: 9 },
      flowStep: { fontSize: 11.5, padding: '1px 7px', border: '1px solid', borderRadius: 999, color: C.text, whiteSpace: 'nowrap' },
      flowArrow: { color: C.tertiary, fontSize: 12, padding: '0 5px' },
      deleteLink: { marginTop: 9, cursor: 'pointer', border: '1px solid ' + C.border, background: 'transparent', color: C.err, borderRadius: 6, padding: '2px 8px', fontSize: 11 },
      sectionTitle: { fontSize: 12, fontWeight: 700, color: C.sub, letterSpacing: 0.3, margin: '0 0 10px' },
      // DockControl
      iqWrap: { position: 'relative', display: 'inline-flex', alignItems: 'center', flex: '0 0 auto', verticalAlign: 'middle' },
      iqBtn: { display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 6px', border: '1px solid transparent', borderRadius: 7, background: 'transparent', color: C.text, fontSize: 12, lineHeight: 1, cursor: 'pointer', flex: '0 0 auto' },
      iqTag: { fontWeight: 700, fontSize: 12, letterSpacing: 0.5, color: C.text, lineHeight: 1 },
      iqVal: { fontSize: 12, color: C.text, lineHeight: 1 },
      iqValOff: { fontSize: 12, color: C.tertiary, lineHeight: 1 },
      iqChev: { color: C.sub, display: 'inline-flex', alignItems: 'center' },
      iqMenu: { position: 'fixed', zIndex: 2147483000, minWidth: 140, maxHeight: '70vh', overflowY: 'auto', padding: 4, borderRadius: 9, background: 'var(--dsw-alias-bg-layer-3,#303034)', border: '1px solid ' + C.border, boxShadow: '0 10px 28px rgba(0,0,0,.45)' },
      iqItem: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '7px 10px', borderRadius: 6, fontSize: 12, color: C.text, cursor: 'pointer', whiteSpace: 'nowrap' },
      iqItemHover: { background: C.card2 },
      iqItemOn: { color: C.brand, fontWeight: 600 },
      iqCheck: { fontSize: 12, color: C.brand, lineHeight: 1 },
      // ---- 标签页 + 概览统计 + 设置表单 ----
      tabbar: { display: 'flex', gap: 6, padding: '0 18px', borderBottom: '1px solid ' + C.border, flex: '0 0 auto' },
      tab: { cursor: 'pointer', border: 'none', background: 'transparent', color: C.sub, fontSize: 12.5, padding: '9px 4px', borderBottom: '2px solid transparent', marginBottom: -1, fontWeight: 600 },
      tabOn: { color: C.text, borderBottomColor: C.brand },
      statsRow: { display: 'flex', gap: 10, flexWrap: 'wrap', margin: '0 0 14px' },
      stat: { flex: '1 1 110px', minWidth: 110, border: '1px solid ' + C.border, background: C.card, borderRadius: 10, padding: '9px 12px' },
      statVal: { fontSize: 18, fontWeight: 700, lineHeight: 1.2 },
      statLbl: { fontSize: 11, color: C.sub, marginTop: 2 },
      field: { marginBottom: 14 },
      label: { display: 'block', fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 5 },
      sub: { fontSize: 11, color: C.tertiary, marginTop: 3, lineHeight: 1.5 },
      input: { width: '100%', boxSizing: 'border-box', background: C.card2, color: C.text, border: '1px solid ' + C.border, borderRadius: 7, padding: '7px 9px', fontSize: 12.5 },
      select: { width: '100%', boxSizing: 'border-box', background: C.card2, color: C.text, border: '1px solid ' + C.border, borderRadius: 7, padding: '7px 9px', fontSize: 12.5 },
      row2: { display: 'flex', gap: 10, flexWrap: 'wrap' },
      col2: { flex: '1 1 160px', minWidth: 160 },
      chkRow: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: C.text, marginBottom: 7, cursor: 'pointer' },
      saveBar: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 },
      saveBtn: { cursor: 'pointer', border: '1px solid ' + C.brand, background: 'color-mix(in srgb, ' + C.brand + ' 18%, transparent)', color: C.text, borderRadius: 8, padding: '7px 16px', fontSize: 12.5, fontWeight: 700 },
      msgOk: { color: C.ok, fontSize: 12 }, msgErr: { color: C.err, fontSize: 12 },
      groupTitle: { fontSize: 12, fontWeight: 700, color: C.sub, margin: '18px 0 8px', paddingTop: 10, borderTop: '1px solid ' + C.border3 },
      commonCard: { border: '1px solid ' + C.border, background: C.card, borderRadius: 10, padding: '12px 14px', marginBottom: 12 },
      fieldRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
      advToggle: { fontSize: 12, fontWeight: 700, color: C.brand, cursor: 'pointer', userSelect: 'none', display: 'inline-block', margin: '6px 0' },
      detailsBox: { border: '1px solid ' + C.border3, borderRadius: 10, padding: '4px 14px 14px', marginTop: 8 },
    };

    const MODE_TEXT = { Auto: '自动', S1: '轻量', S2: '标准', S3: '完整', S4: '完整加强' };
    const MODE_DESC = {
      Auto: '按复杂度自动选档',
      S1: '单代理 + 1 轮盲审 + 轻量验证',
      S2: '多代理分视角 + 多轮互审 + 独立验证',
      S3: '研究 + 分片 + 评审团 + 判官 + 红队 + 回归',
      S4: '完整 7 阶段；评审/裁决/红队按角色池多候选并行多审（任一 FAIL 即该阶段 FAIL）',
    };
    function toneColor(tone) { return tone === 'ok' ? C.ok : tone === 'warn' ? C.warn : tone === 'err' ? C.err : tone === 'primary' ? C.brand : C.sub; }
    function fmt(n) {
      const v = Number(n) || 0;
      if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
      if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
      return String(v);
    }
    // 运行条目的 token 文案：优先真实用量；否则显示「≈ 回执上报（估算）」并说明。
    function rowTokenText(run) {
      const real = Number(run.realSpent) || 0;
      if (real > 0) return fmt(real) + ' tok';
      const rep = Number(run.spent) || 0;
      return rep > 0 ? '≈' + fmt(rep) + ' tok' : '—';
    }
    function rowTokenTitle(run) {
      const real = Number(run.realSpent) || 0;
      const rep = Number(run.spent) || 0;
      if (real > 0) return '真实 token（宿主实时实测）：' + real + (rep ? '；回执上报(估算)：' + rep : '');
      return '尚未捕获真实用量，这里显示的是回执上报/字符估算：' + rep + '（仅参考，非真实消耗）';
    }
    function Pill({ text, tone }) { return h('span', { style: { ...S.pill, color: toneColor(tone) } }, text); }
    function Token2bIQIcon({ size }) {
      // 只画「三节点 + 连线」的图标本体，不画外框（与侧栏其它图标一致）；比例撑满 24 viewBox。
      const s = size || 18;
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M6.5 7 L17.5 7 M6.5 7 L12 17.5 M17.5 7 L12 17.5', stroke: 'currentColor' }),
        h('circle', { cx: 6.5, cy: 7, r: 2.3, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 17.5, cy: 7, r: 2.3, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 12, cy: 17.5, r: 2.3, fill: 'currentColor', stroke: 'none' }));
    }

    const STAGE_LABELS = { research: '研究', plan: '计划', generate: '生成', review: '评审', judge: '裁决', verify: '验证', redteam: '红队', regression: '回归', other: '其他' };
    function stageLabel(k) { return STAGE_LABELS[k] || k; }
    function stageEff(s, current) {
      const ts = s.tasks || [];
      if (ts.length) {
        if (ts.some((t) => t.status === 'failed')) return 'failed';
        if (ts.every((t) => t.status === 'done')) return 'done';
        return 'running';
      }
      if (s.status) return s.status;
      if (current && current.status === 'done') return 'skipped';
      return 'pending';
    }
    function stageTone(st) { return st === 'done' ? 'ok' : st === 'running' ? 'primary' : st === 'failed' ? 'err' : 'sub'; }

    // 单条运行记录：档位 / 这个档位额外做了什么 / 结论 / token / 时间；选中时展开流程。
    function RunItem({ run, current, onSelect }) {
      const [expanded, setExpanded] = useState(false);
      const selected = current && current.id === run.id;
      const isAuto = run.requestedMode === 'Auto' && run.mode && run.mode !== 'Auto';
      const modeLabel = isAuto ? ('自动→' + (MODE_TEXT[run.mode] || run.mode)) : (MODE_TEXT[run.mode] || run.mode || '—');
      const pass = run.verdict === 'PASS';
      const isDemo = /演示|可删除/.test(run.goal || '');
      const created = run.createdAt ? new Date(run.createdAt).toLocaleString() : '';
      const stages = selected && current ? (current.stages || []) : [];
      return h('div', { style: { ...S.runCard, ...(selected ? S.runCardOn : null) }, onClick: () => onSelect(run.id) },
        h('div', { style: S.runHead },
          h('span', { style: S.modeBadge }, modeLabel),
          h(Pill, { text: run.verdict ? run.verdict : (run.status === 'done' ? '—' : run.status), tone: run.verdict ? (pass ? 'ok' : 'err') : 'sub' }),
          h('span', { style: S.grow }),
          h('span', { style: S.runToken, title: rowTokenTitle(run) }, rowTokenText(run)),
          h('span', { style: S.runTime }, created)),
        h('div', { style: expanded ? S.runGoalOpen : S.runGoal }, (run.goal || '（无目标）') + (isDemo ? '  [示例]' : '')),
        h('div', { style: S.detailToggle, onClick: (e) => { e.stopPropagation(); setExpanded((v) => !v); } }, expanded ? '收起 ▲' : '详情 ▼'),
        h('div', { style: S.runExtra }, '这个档位额外做了：' + (MODE_DESC[run.mode] || '—') + (isAuto && run.autoDecision ? '　·　Auto 判定：' + (run.autoDecision.decidedBy === 'llm' ? '模型复核' : run.autoDecision.decidedBy === 'heuristic' ? '关键词（有把握）' : '关键词兜底') : '')),
        stages.length ? h('div', { style: S.flowRow },
          ...stages.flatMap((s, i) => {
            const st = stageEff(s, run);
            const v = (s.tasks || []).map((t) => t.verdict).filter(Boolean)[0];
            const items = [h('span', { key: 's_' + s.kind, style: { ...S.flowStep, borderColor: toneColor(stageTone(st)) } }, (s.label || stageLabel(s.kind)) + (v ? ' ' + v : ''))];
            if (i < stages.length - 1) items.push(h('span', { key: 'a_' + s.kind, style: S.flowArrow }, '→'));
            return items;
          })) : null);
    }

    function RunList({ runs, current, onSelect }) {
      return h('div', null,
        h('div', { style: S.sectionTitle }, '运行记录'),
        h('div', { style: S.hint }, '点任意一条查看流程。档位在输入框上方「IQ」里切换。'),
        (runs && runs.length)
          ? runs.map((r) => h(RunItem, { key: r.id, run: r, current, onSelect }))
          : h('div', { style: S.empty }, '还没有运行。在输入框上方「IQ」选好档位后，正常发任务即可。'));
    }

    function Header({ count, onRefresh, onClose, busy, err }) {
      return h('div', { style: S.header },
        h('button', { style: S.btnClose, title: '返回对话', onClick: onClose }, '←'),
        h('div', { style: S.grow },
          h('div', { style: S.eyebrow }, 'TOKEN 2B IQ'),
          h('div', { style: S.title }, '编排运行记录')),
        h('span', { style: S.runTime }, count + ' 条'),
        h('button', { style: S.btn, onClick: onRefresh, disabled: busy }, busy ? '…' : '刷新'),
        h('button', { style: S.btnClose, title: '关闭面板', onClick: onClose }, '×'),
        err ? h('span', { style: { color: C.err, fontSize: 11 } }, err) : null);
    }

    // 概览：运行数 / 真实 token（宿主实时）/ 回执上报（含估算）/ 一次通过率
    function StatsBar({ runs, live }) {
      const list = runs || [];
      const n = list.length;
      const reported = list.reduce((a, r) => a + (Number(r.spent) || 0), 0);
      const realKnown = !!(live && Number(live.requests) > 0);
      const realTotal = realKnown ? Number(live.total) || 0 : 0;
      const judged = list.filter((r) => r.verdict === 'PASS' || r.verdict === 'FAIL');
      const pass = judged.filter((r) => r.verdict === 'PASS').length;
      const rate = judged.length ? Math.round((pass / judged.length) * 100) : null;
      const rateColor = rate == null ? C.text : (rate >= 80 ? C.ok : rate >= 50 ? C.warn : C.err);
      const liveLine = realKnown
        ? '输入 ' + fmt(live.inputTokens) + ' · 输出 ' + fmt(live.outputTokens) + ' · 缓存读 ' + fmt(live.cacheReadTokens) + ' · 请求 ' + live.requests
        : '等待宿主模型调用…（真实用量来自 llm/stream 实时统计，自动归集到当前活动运行）';
      return h('div', null,
        h('div', { style: S.statsRow },
          h('div', { style: S.stat }, h('div', { style: S.statVal }, String(n)), h('div', { style: S.statLbl }, '运行总数')),
          h('div', { style: S.stat }, h('div', { style: S.statVal, title: '宿主 llm/stream 实时统计的真实 token（全局，含缓存读取）' }, realKnown ? fmt(realTotal) : '—'), h('div', { style: S.statLbl }, '真实 token（实时）')),
          h('div', { style: S.stat }, h('div', { style: { ...S.statVal, color: C.sub }, title: '各运行回执上报时按字符/4 估算或调用方上报的 token 之和；仅供参考，非真实消耗' }, fmt(reported)), h('div', { style: S.statLbl }, '回执上报（含估算）')),
          h('div', { style: S.stat }, h('div', { style: { ...S.statVal, color: rateColor } }, rate == null ? '—' : rate + '%'), h('div', { style: S.statLbl }, '一次通过率'))),
        h('div', { style: { ...S.sub, margin: '0 0 14px' } }, liveLine));
    }

    const SETTINGS_ROLES = [
      ['research', '研究'], ['plan', '计划'], ['generate', '生成'], ['review', '评审'],
      ['judge', '裁决'], ['verify', '验证'], ['redteam', '红队'], ['regression', '回归'],
    ];

    // 设置：默认档位 / 预算 / 评审策略 / 按角色指定模型 / 评审池 / 模型白名单
    function SettingsForm() {
      const [draft, setDraft] = useState(null);
      const [models, setModels] = useState([]);
      const [modelsErr, setModelsErr] = useState(null);
      const [modelsBusy, setModelsBusy] = useState(false);
      const [err, setErr] = useState(null);
      const [msg, setMsg] = useState(null);
      const [busy, setBusy] = useState(false);
      const [advOpen, setAdvOpen] = useState(false);
      const [poolOpen, setPoolOpen] = useState({});
      const loadModels = useCallback(async () => {
        setModelsBusy(true);
        let lastErr = null;
        for (let i = 0; i < 8; i++) {
          try {
            const m = await getModels();
            if (m && m.models && m.models.length) { setModels(m.models); setModelsErr(null); setModelsBusy(false); return; }
            lastErr = (m && m.error) || '模型目录为空';
          } catch (e) { lastErr = String((e && e.message) || e); }
          await new Promise((r) => setTimeout(r, 600));
        }
        setModelsErr(lastErr || '模型目录为空');
        setModelsBusy(false);
      }, []);
      useEffect(() => {
        let alive = true;
        getSettings().then((s) => { if (alive) { if (s) setDraft(s); else setErr('读取设置失败'); } })
          .catch((e) => { if (alive) setErr(String((e && e.message) || e)); });
        loadModels();
        return () => { alive = false; };
      }, [loadModels]);
      if (!draft) return h('div', { style: S.empty }, err ? ('加载失败：' + err) : '加载设置中…');
      const up = (patch) => setDraft((d) => ({ ...d, ...patch }));
      const upRole = (k, v) => setDraft((d) => ({ ...d, roleModels: { ...(d.roleModels || {}), [k]: v || null } }));
      const save = async () => {
        setBusy(true); setMsg(null); setErr(null);
        // 明确清空旧字段（不再有全局白名单/评审池覆盖），并按各角色池首项派生 roleModels：
        // 这样清空某角色池时不会因旧 roleModels 兜底被“复活”。
        const rm = {};
        for (const k of ['research', 'plan', 'generate', 'review', 'judge', 'verify', 'redteam', 'regression']) {
          const p = (draft.rolePools && draft.rolePools[k]) || [];
          rm[k] = p[0] || null;
        }
        const toSave = { ...draft, allowModels: [], reviewModels: [], parallelReviews: Number(draft.parallelReviews) || 3, roleModels: rm };
        try { const s = await saveSettings(toSave); if (s) setDraft(s); setMsg('已保存，新运行立即生效。'); }
        catch (e) { setErr(String((e && e.message) || e)); } finally { setBusy(false); }
      };
      const SINGLE_ROLES = ['research', 'plan', 'generate', 'verify', 'regression'];
      const setPoolSingle = (k, ref) => setDraft((d) => {
        const cur = Array.isArray(d.rolePools && d.rolePools[k]) ? d.rolePools[k] : [];
        const next = cur.includes(ref) ? [] : [ref]; // 单选：勾一个即独占；再点已勾=取消
        return { ...d, rolePools: { ...(d.rolePools || {}), [k]: next } };
      });
      const togglePool = (k, ref) => {
        if (SINGLE_ROLES.includes(k)) return setPoolSingle(k, ref);
        return setDraft((d) => {
          const cur = Array.isArray(d.rolePools && d.rolePools[k]) ? d.rolePools[k] : [];
          const set = new Set(cur);
          if (set.has(ref)) set.delete(ref); else set.add(ref);
          return { ...d, rolePools: { ...(d.rolePools || {}), [k]: Array.from(set) } };
        });
      };
      const refLabel = (ref) => { const mm = models.find((x) => x.ref === ref); return mm ? ((mm.providerName ? mm.providerName + ' · ' : '') + (mm.name || mm.id)) : ref; };
      const roleOrder = ['research', 'plan', 'generate', 'review', 'judge', 'verify', 'redteam', 'regression'];
      const roleText = { research: '研究', plan: '计划', generate: '生成', review: '评审', judge: '裁决', verify: '验证', redteam: '红队', regression: '回归' };
      const MODE_LIST = [['Auto', '自动'], ['S1', '轻量'], ['S2', '标准'], ['S3', '完整'], ['S4', '完整加强']];
      return h('div', null,
        h('div', { style: S.sectionTitle }, '设置'),
        h('div', { style: S.commonCard },
          h('div', { style: { ...S.sub, margin: '0 0 12px', color: C.text } }, '每个角色可单独选模型池；单代理角色（研究/计划/生成/验证/回归）单选，评审/裁决/红队可多选；不选时跟随默认。其余高级项一般不用动。'),
          ...roleOrder.map((k) => {
            const pool = (draft.rolePools && Array.isArray(draft.rolePools[k])) ? draft.rolePools[k] : [];
            const open = !!poolOpen[k];
            const isSingle = SINGLE_ROLES.includes(k);
            const isRev = ['review', 'judge', 'redteam'].includes(k);
            let summary;
            if (!pool.length) summary = isSingle ? '未选=跟随默认（单选，只可选 1 个）' : '未选=跟随默认';
            else if (isRev) summary = '已选 ' + pool.length + ' 个：' + pool.map((r, i) => (i + 1) + '.' + refLabel(r)).join('、');
            else if (isSingle) summary = '已选：' + refLabel(pool[0]) + '（单选，只可选 1 个）';
            else summary = pool.length + ' 个：' + pool.map(refLabel).join('、');
            const poolBox = models.length
              ? models.map((mm) => {
                const checked = pool.includes(mm.ref);
                const prefix = (isRev && checked) ? ((pool.indexOf(mm.ref) + 1) + '. ') : '';
                return h('label', { key: mm.ref, style: S.chkRow }, h('input', { type: 'checkbox', checked, onChange: () => togglePool(k, mm.ref) }), prefix + refLabel(mm.ref));
              })
              : h('div', { style: S.sub }, modelsBusy ? '加载模型目录中…' : ('模型目录不可用' + (modelsErr ? '：' + modelsErr : '（稍后自动重试，或在高级设置里点「刷新模型」）')));
            return h('div', { key: k, style: { marginBottom: 6 } },
              h('div', { style: S.fieldRow },
                h('label', { style: { ...S.label, flex: '0 0 90px', marginBottom: 0 } }, roleText[k]),
                h('span', { style: { ...S.sub, flex: '1 1 auto', marginTop: 0 } }, summary),
                h('span', { style: S.detailToggle, onClick: () => setPoolOpen((m) => ({ ...m, [k]: !m[k] })) }, open ? '收起 ▲' : '选择 ▼')),
              open ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 7, margin: '4px 0 8px 90px' } }, poolBox) : null);
          })),
        h('div', { style: S.advToggle, onClick: () => setAdvOpen((v) => !v) }, advOpen ? '高级设置 ▲' : '高级设置 ▼'),
        advOpen ? h('div', { style: S.detailsBox },
          h('div', { style: { ...S.sub, margin: '8px 0 12px', lineHeight: 1.7 } },
            '本插件不直接调用模型：档位与强制联动会真正影响流程；各角色模型池用于给对应阶段挑模型；独立评委开启后，评审须由不看执行过程的独立代理给出结论。'),
          h('div', { style: S.field }, h('label', { style: S.label }, '默认档位'),
            h('select', { style: S.select, value: draft.defaultMode, onChange: (e) => up({ defaultMode: e.target.value }) },
              MODE_LIST.map(([v, t]) => h('option', { key: v, value: v }, t))),
            h('div', { style: S.sub }, '输入框上方「IQ」的选择会覆盖单次并记住（重启后沿用）；这里是全局默认。')),
          h('div', { style: S.field }, h('label', { style: S.label }, '强制用团队（Agent Teams）'),
            h('select', { style: S.select, value: draft.forceTeam || 'auto', onChange: (e) => up({ forceTeam: e.target.value }) },
              [['auto', '仅 标准/完整 档强制（推荐）'], ['on', '始终强制'], ['off', '从不强制']].map(([v, t]) => h('option', { key: v, value: v }, t))),
            h('div', { style: S.sub }, '开启后，每个阶段都要由团队里的队员完成并回填任务，确保真的走团队而不是单代理。默认只在「标准/完整」档强制：小任务强制组队会白烧 token。')),
          h('div', { style: S.sub, marginBottom: 8 }, '控制消耗：不设硬预算；档位决定参与角色/阶段数量（轻量 3 / 标准 4 / 完整 7 / 完整加强 7），档位越高越费。'),
          h('div', { style: S.field }, h('label', { style: S.label }, '完整加强·并行审模型数'),
            h('select', { style: S.select, value: draft.parallelReviews || 3, onChange: (e) => up({ parallelReviews: Number(e.target.value) }) },
              [1, 2, 3, 4, 5].map((n) => h('option', { key: n, value: n }, String(n) + (n === 3 ? '（默认）' : '')))),
            h('div', { style: S.sub }, '实际并行数 = min(该值, 池里选中的模型数)，不足不会报错（=1 退化为单审）。')),
          h('div', { style: S.field }, h('label', { style: S.label }, '严格流程（可选）'),
            h('select', { style: S.select, value: draft.pipelineGate || 'off', onChange: (e) => up({ pipelineGate: e.target.value }) },
              [['off', '宽松（仅记录，默认）'], ['strict', '严格（先计划再实现，验证必须带测试证据）']].map(([v, t]) => h('option', { key: v, value: v }, t))),
            h('div', { style: S.sub }, '严格模式：实现前要先有计划与验收标准；验证阶段必须真的跑过测试且通过才能结束；多个候选还需择优。')),
          h('label', { style: S.chkRow }, h('input', { type: 'checkbox', checked: !!draft.requireDifferentVendor, onChange: (e) => up({ requireDifferentVendor: e.target.checked }) }), '评审模型与生成模型用不同厂商（推荐，降低误判）'),
          h('label', { style: S.chkRow }, h('input', { type: 'checkbox', checked: !!draft.independentReview, onChange: (e) => up({ independentReview: e.target.checked }) }), '独立评委：评审/裁决/红队由不看执行过程的独立代理给出结论（执行者不能自评）'),
          h('div', { style: S.hint }, '模型目录来自宿主的模型列表，为空会自动重试，也可手动刷新。',
            h('button', { style: { ...S.btn, marginLeft: 10 }, onClick: loadModels, disabled: modelsBusy }, modelsBusy ? '刷新中…' : '刷新模型'))
        ) : null,
        h('div', { style: S.saveBar },
          h('button', { style: S.saveBtn, onClick: save, disabled: busy }, busy ? '保存中…' : '保存设置'),
          msg ? h('span', { style: S.msgOk }, msg) : null,
          err ? h('span', { style: S.msgErr }, err) : null));
    }

    function PanelApp({ onClose }) {
      const [data, setData] = useState(null);
      const [selectedRunId, setSelectedRunId] = useState(null);
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState(null);
      const [tab, setTab] = useState('runs');

      const vcache = useRef({});
      const lastSig = useRef('');
      const load = useCallback(async (runId) => {
        setBusy(true);
        try {
          const d = await getState(runId === undefined ? selectedRunId : runId);
          const list = (d && d.runs) || [];
          // 兼容旧宿主（summary 无 verdict）：逐条取详情补齐结论，带缓存只补一次。
          const missing = list.filter((r) => r && r.id && !r.verdict && !(r.id in vcache.current));
          if (missing.length) {
            await Promise.all(missing.map(async (r) => {
              try { const dd = await getState(r.id); const c = dd && dd.current; vcache.current[r.id] = (c && c.verdict && c.verdict.final) || null; }
              catch (e) { vcache.current[r.id] = null; }
            }));
          }
          d.runs = list.map((r) => {
            if (!r) return r;
            if (r.verdict) return r;
            const v = (r.id in vcache.current) ? vcache.current[r.id] : null;
            return Object.assign({}, r, { verdict: v });
          });
          // 只有数据真变化才重渲染（F15：避免 4s 轮询无谓整树刷新）。
          const sig = JSON.stringify(d);
          if (sig !== lastSig.current) { lastSig.current = sig; setData(d); }
          setErr(null);
        } catch (e) {
          setErr('加载失败：' + (e && e.message ? e.message : e));
        } finally {
          setBusy(false);
        }
      }, [selectedRunId]);

      useEffect(() => {
        load();
        const iv = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 8000);
        const onVis = () => { if (document.visibilityState === 'visible') load(); };
        document.addEventListener('visibilitychange', onVis);
        window.addEventListener('focus', onVis);
        return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis); };
      }, [load]);

      const current = data && data.current;
      const runs = (data && data.runs) || [];
      const onSelect = (id) => { setSelectedRunId(id); load(id); };

      const tabBtn = (id, label) => h('button', { style: { ...S.tab, ...(tab === id ? S.tabOn : null) }, onClick: () => setTab(id) }, label);
      return h('div', { style: S.panelHost },
        h(Header, { count: runs.length, busy, err, onClose, onRefresh: () => load() }),
        h('div', { style: S.tabbar }, tabBtn('runs', '运行记录'), tabBtn('settings', '设置')),
        h('div', { style: S.body },
          tab === 'settings'
            ? h(SettingsForm, null)
            : h('div', null, h(StatsBar, { runs, live: data && data.liveUsage }), h(RunList, { runs, current, onSelect }))));
    }

    // ---- 输入框工具行（conversation.input.left）：紧凑档位下拉 ----
    const LS_PREFIX = 't2biq:enabled:v1:';
    const MODE_OPTS = [
      { v: '__off', text: '关闭' }, { v: 'Auto', text: '自动' }, { v: 'S1', text: '轻量' }, { v: 'S2', text: '标准' }, { v: 'S3', text: '完整' }, { v: 'S4', text: '完整加强' },
    ];
    function sessionKey(owner) {
      const o = owner || {};
      const sid = (o.session && (o.session.id || o.session.sessionId)) || o.sessionId || o.id || 'default';
      return LS_PREFIX + String(sid);
    }
    function sessionIdOf(owner) {
      const o = owner || {};
      return (o.session && (o.session.id || o.session.sessionId)) || o.sessionId || o.id || 'default';
    }
    function readEnabled(owner) { try { const v = localStorage.getItem(sessionKey(owner)); return v == null ? true : v === '1'; } catch (e) { return true; } }
    function writeEnabled(owner, on) { try { localStorage.setItem(sessionKey(owner), on ? '1' : '0'); } catch (e) { /* ignore */ } }
    function Chevron({ open }) {
      return h('span', { style: { ...S.iqChev, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' } },
        h('svg', { width: 10, height: 10, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M2.5 4.5 L6 8 L9.5 4.5' })));
    }
    function DockControl({ owner }) {
      const [enabled, setEnabled] = useState(() => readEnabled(owner));
      const [mode, setMode] = useState('Auto');
      const [open, setOpen] = useState(false);
      const [hover, setHover] = useState(-1);
      const [pos, setPos] = useState({ left: 0, bottom: 0 });
      const btnRef = useRef(null);
      useEffect(() => { let alive = true; getState().then((d) => { if (alive && d && d.mode) setMode(d.mode); }).catch(() => {}); return () => { alive = false; }; }, []);
      // 会话级开关：挂载时把本会话「关闭」状态同步到服务端（真正生效），并读取本会话档位。
      useEffect(() => {
        let alive = true;
        const sid = sessionIdOf(owner);
        if (!readEnabled(owner)) {
          postJson('token2biq/session', { sessionId: sid, enabled: false }).catch(() => {});
        } else {
          getSessionPref(sid).then((d) => { if (alive && d && d.pref && d.pref.mode) setMode(d.pref.mode); }).catch(() => {});
        }
        return () => { alive = false; };
      }, []);
      useEffect(() => {
        if (!open) return;
        const onDown = (e) => {
          const b = btnRef.current;
          if (b && b.contains(e.target)) return;
          if (e.target && e.target.closest && e.target.closest('[data-t2biq-menu]')) return;
          setOpen(false);
        };
        const onScroll = () => setOpen(false);
        document.addEventListener('mousedown', onDown, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
        return () => { document.removeEventListener('mousedown', onDown, true); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); };
      }, [open]);
      const value = enabled ? mode : '__off';
      const openMenu = () => {
        try { const r = btnRef.current && btnRef.current.getBoundingClientRect(); if (r) setPos({ left: r.left, bottom: (window.innerHeight - r.top + 6) }); } catch (e) { /* ignore */ }
        setOpen((o) => !o); setHover(-1);
      };
      const choose = async (v) => {
        setOpen(false);
        const sid = sessionIdOf(owner);
        if (v === '__off') {
          setEnabled(false); writeEnabled(owner, false);
          try { await postJson('token2biq/session', { sessionId: sid, enabled: false }); } catch (err) { /* 离线忽略 */ }
          return;
        }
        setEnabled(true); writeEnabled(owner, true); setMode(v);
        try { await postJson('token2biq/session', { sessionId: sid, enabled: true, mode: v }); } catch (err) { /* 离线忽略 */ }
      };
      const cur = MODE_OPTS.find((o) => o.v === value) || MODE_OPTS[1];
      const menu = open ? h('div', { 'data-t2biq-menu': '1', role: 'menu', style: { ...S.iqMenu, left: pos.left, bottom: pos.bottom } },
        ...MODE_OPTS.map((o, i) => h('div', {
          key: o.v, role: 'menuitem',
          style: { ...S.iqItem, ...(i === hover ? S.iqItemHover : null), ...(o.v === value ? S.iqItemOn : null) },
          onMouseEnter: () => setHover(i), onMouseLeave: () => setHover(-1), onClick: () => choose(o.v),
        }, h('span', null, o.text), o.v === value ? h('span', { style: S.iqCheck }, '✓') : null))) : null;
      return h('div', { style: S.iqWrap },
        h('button', {
          ref: btnRef, type: 'button', style: S.iqBtn, onClick: openMenu,
          title: 'Token 2b IQ · 本会话开关/档位（选「关闭」= 本会话不启用插件）', 'aria-haspopup': 'menu', 'aria-expanded': open ? 'true' : 'false',
        }, h('span', { style: S.iqTag }, '档位'), h('span', { style: enabled ? S.iqVal : S.iqValOff }, cur.text), h(Chevron, { open })),
        (menu && ReactDOM && typeof ReactDOM.createPortal === 'function') ? ReactDOM.createPortal(menu, document.body) : menu);
    }

    return {
      inject: ['slots'],
      __components: { RunItem, RunList, Header },
      apply(ctx) {
        const slots = (ctx.get && ctx.get('slots')) || ctx.slots;
        if (!slots || !slots.register) return;
        let layout = null;
        try {
          if (typeof ctx.get === 'function') layout = ctx.get('layout') || layout;
          if (!layout && typeof ctx.inject === 'function') ctx.inject(['layout'], (s) => { try { layout = s.layout || layout; } catch (e) {} });
        } catch (e) { /* ignore */ }
        const getLayout = () => { let L = layout; try { if (!L && typeof ctx.get === 'function') L = ctx.get('layout'); } catch (e) {} return L; };
        const closePanel = () => { try { const L = getLayout(); L && L.selectPanel && L.selectPanel(null); } catch (e) {} };
        try { slots.inject('main', () => slots.register({ name: 'main', key: 'token2biq' }, () => h(PanelApp, { onClose: closePanel }))); } catch (e) { /* 槽位缺失时静默 */ }
        try { slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: 'token2biq', order: 55, label: () => 'Token 2b IQ' }, Token2bIQIcon)); } catch (e) { /* 槽位缺失时静默 */ }
        try { slots.inject('conversation.input.left', () => slots.register({ name: 'conversation.input.left', id: 'token2biq', order: 10, label: () => 'Token 2b IQ' }, (owner) => h(DockControl, { owner: owner }))); } catch (e) { /* 槽位缺失时静默 */ }
      },
    };
  },
});
