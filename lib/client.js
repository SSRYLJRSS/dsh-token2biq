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
      sub: 'var(--dsw-alias-label-secondary,light-dark(#595959,#c1c1ca))',
      tertiary: 'var(--dsw-alias-label-tertiary,light-dark(#666666,#b4b4bd))',
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
      const data = await r.json();
      if (!data || data.ok === false || data.settingsPersisted === false || data.persisted === false || data.settingsSaveError) throw new Error((data && (data.error || data.settingsSaveError)) || '操作未能保存，请重试');
      return data;
    }
    async function getJson(path) {
      const r = await fetch(api(path), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }
    async function getSettings() { const d = await getJson('token2biq/settings'); if (!d || d.ok === false || !d.settings) throw new Error((d && d.error) || '读取设置失败，请重试'); return d.settings; }
    async function saveSettings(patch) { return await postJson('token2biq/settings', patch); }
    async function getModels() { try { const d = await getJson('token2biq/models'); return d || { models: [] }; } catch (e) { return { models: [], error: String((e && e.message) || e) }; } }
    async function getSessionPref(sessionId) { const d = await getJson('token2biq/session?sessionId=' + encodeURIComponent(sessionId || '')); if (!d || d.ok === false) throw new Error((d && d.error) || '会话设置读取失败'); return d; }

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
      trendRow: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', margin: '0 0 10px', padding: '7px 12px', border: '1px solid ' + C.border3, background: C.card2, borderRadius: 10 },
      trendCaption: { fontSize: 10.5, fontWeight: 700, color: C.tertiary, letterSpacing: 0.6, whiteSpace: 'nowrap' },
      trendItem: { minWidth: 86 },
      trendVal: { fontSize: 14.5, fontWeight: 700, lineHeight: 1.25 },
      trendLbl: { fontSize: 11, color: C.sub, lineHeight: 1.3 },
      trendSub: { fontSize: 10.5, color: C.tertiary, lineHeight: 1.3 },
      trendBars: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 26, flex: '1 1 120px', minWidth: 96, justifyContent: 'flex-end' },
      trendBar: { width: 8, borderRadius: 2, display: 'block', minHeight: 2 },
      field: { marginBottom: 14 },
      label: { display: 'block', fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 5 },
      sub: { fontSize: 11, color: C.sub, marginTop: 3, lineHeight: 1.5 },
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
      fieldRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 10 },
      advToggle: { fontSize: 12, fontWeight: 700, color: C.brand, cursor: 'pointer', userSelect: 'none', display: 'inline-block', margin: '6px 0' },
      detailsBox: { border: '1px solid ' + C.border3, borderRadius: 10, padding: '4px 14px 14px', marginTop: 8 },
    };

    // 单一事实源：设置页 / 会话下拉 / 运行列表都从这里取，避免三份文案各自漂移。
    // 显示 S 代号是刻意的：模型侧 action=start 用 S1/S2/S3/S4，用户看到的若只有
    // 「轻量/标准/完整」，双方就对不上号——沟通成本全落在猜上。
    const MODE_TEXT = { Auto: '自动', S1: '轻量 S1', S2: '标准 S2', S3: '完整 S3', S4: '完整加强 S4' };
    const MODE_KEYS = ['Auto', 'S1', 'S2', 'S3', 'S4'];
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
      return h('svg', { 'aria-hidden': true, width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' },
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
      return h('div', { style: { ...S.runCard, ...(selected ? S.runCardOn : null) } },
        h('button', { type: 'button', 'aria-label': '查看运行：' + (run.goal || run.id), 'aria-expanded': !!selected, style: { ...S.runHead, width: '100%', textAlign: 'left', border: 0, padding: 0, background: 'transparent', color: C.text, cursor: 'pointer' }, onClick: () => onSelect(run.id) },
          h('span', { style: S.modeBadge }, modeLabel),
          h(Pill, { text: run.verdict ? run.verdict : (run.status === 'done' ? '—' : run.status), tone: run.verdict ? (pass ? 'ok' : 'err') : 'sub' }),
          h('span', { style: S.grow }),
          h('span', { style: S.runToken, title: rowTokenTitle(run) }, rowTokenText(run)),
          h('span', { style: S.runTime }, created)),
        h('div', { style: expanded ? S.runGoalOpen : S.runGoal }, (run.goal || '（无目标）') + (isDemo ? '  [示例]' : '')),
        h('button', { type: 'button', 'aria-expanded': expanded, style: { ...S.detailToggle, border: 0, background: 'transparent', padding: '4px 0' }, onClick: () => setExpanded((v) => !v) }, expanded ? '收起 ▲' : '详情 ▼'),
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
        h('button', { style: S.btnClose, title: '返回对话', 'aria-label': '返回对话', onClick: onClose }, '←'),
        h('div', { style: S.grow },
          h('div', { style: S.eyebrow }, 'TOKEN 2B IQ'),
          h('div', { style: S.title }, '编排运行记录')),
        h('span', { style: S.runTime }, count + ' 条'),
        h('button', { style: S.btn, onClick: onRefresh, disabled: busy }, busy ? '…' : '刷新'),
        h('button', { style: S.btnClose, title: '关闭面板', 'aria-label': '关闭面板', onClick: onClose }, '×'),
        err ? h('span', { role: 'alert', style: { color: C.err, fontSize: 11 } }, err) : null);
    }

    // 概览：运行数 / 真实 token（宿主实时）/ 回执上报（含估算）/ 一次通过率
    const V3_DAY_MS = 86400000;
    function v3RunTimeMs(run) {
      const raw = run && run.createdAt;
      if (raw == null || raw === '') return NaN;
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
      const t = Date.parse(String(raw));
      return Number.isFinite(t) ? t : NaN;
    }
    function v3DayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
    // 近 30 天按天分桶（纯前端）：只统计已结束（status==='done' 或已有 verdict）的运行。
    function v3PassTrend(runs) {
      const list = Array.isArray(runs) ? runs : [];
      const today = v3DayStart(Date.now());
      const buckets = [];
      for (let i = 0; i < 30; i++) buckets.push({ start: today - i * V3_DAY_MS, pass: 0, total: 0, rate: null });
      for (const run of list) {
        if (!run || !(run.status === 'done' || run.verdict)) continue;
        const ms = v3RunTimeMs(run);
        if (!Number.isFinite(ms)) continue;
        const idx = Math.round((today - v3DayStart(ms)) / V3_DAY_MS);
        if (idx < 0 || idx >= buckets.length) continue;
        const b = buckets[idx];
        b.total += 1;
        if (run.verdict === 'PASS') b.pass += 1;
      }
      for (const b of buckets) if (b.total) b.rate = Math.round((b.pass / b.total) * 100);
      const window = (days) => {
        let pass = 0, total = 0;
        for (let i = 0; i < days; i++) { pass += buckets[i].pass; total += buckets[i].total; }
        return total ? { pass, total, rate: Math.round((pass / total) * 100) } : null;
      };
      return { week: window(7), month: window(30), buckets };
    }
    function v3RateColor(rate) { return rate == null ? C.text : (rate >= 80 ? C.ok : rate >= 50 ? C.warn : C.err); }
    function v3TrendDayLabel(ms) { const d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate(); }
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
      const trend = v3PassTrend(list);
      const trendCell = (item, label, days) => h('div', { style: S.trendItem },
        h('div', { style: { ...S.trendVal, color: v3RateColor(item && item.rate) } }, item ? item.rate + '%' : '—'),
        h('div', { style: S.trendLbl }, label),
        h('div', { style: S.trendSub }, item ? ('PASS ' + item.pass + ' / ' + item.total) : ('近 ' + days + ' 天无样本')));
      const trendBars = trend.buckets.slice(0, 7).reverse().map((b, i) => {
        const day = v3TrendDayLabel(b.start);
        const title = day + '：' + (b.total ? (b.pass + '/' + b.total + ' 通过（' + b.rate + '%）') : '无样本');
        return h('span', { key: day + '_' + i, title, 'aria-label': title, style: { ...S.trendBar, height: b.total ? Math.max(3, Math.round((b.rate / 100) * 22)) : 2, background: b.total ? v3RateColor(b.rate) : C.border3 } });
      });
      return h('div', null,
        h('div', { style: S.statsRow },
          h('div', { style: S.stat }, h('div', { style: S.statVal }, String(n)), h('div', { style: S.statLbl }, '运行总数')),
          h('div', { style: S.stat }, h('div', { style: S.statVal, title: '宿主 llm/stream 实时统计的真实 token（全局，含缓存读取）' }, realKnown ? fmt(realTotal) : '—'), h('div', { style: S.statLbl }, '真实 token（实时）')),
          h('div', { style: S.stat }, h('div', { style: { ...S.statVal, color: C.sub }, title: '各运行回执上报时按字符/4 估算或调用方上报的 token 之和；仅供参考，非真实消耗' }, fmt(reported)), h('div', { style: S.statLbl }, '回执上报（含估算）')),
          h('div', { style: S.stat }, h('div', { style: { ...S.statVal, color: rateColor } }, rate == null ? '—' : rate + '%'), h('div', { style: S.statLbl }, '一次通过率'))),
        h('div', { style: S.trendRow, role: 'group', 'aria-label': '通过率趋势' },
          h('div', { style: S.trendCaption }, '通过率趋势'),
          trendCell(trend.week, '近 7 天通过率', 7),
          trendCell(trend.month, '近 30 天通过率', 30),
          h('div', { style: S.trendBars, title: '近 7 天按天分桶（柱高 = 当日通过率）' }, ...trendBars)),
        h('div', { style: { ...S.sub, margin: '0 0 14px' } }, liveLine));
    }

    const V3_ROLE_KEYS = ['research', 'plan', 'generate', 'review', 'judge', 'verify', 'redteam', 'regression'];
    const V3_ROLE_DEFS = {
      research: { name: '研究', duty: '查资料、摸清现状', multi: false },
      plan: { name: '计划', duty: '拆任务、定方案', multi: false },
      generate: { name: '生成', duty: '写代码、写文档', multi: false },
      review: { name: '评审', duty: '挑毛病', multi: true },
      judge: { name: '裁决', duty: '多个方案里拍板', multi: true },
      verify: { name: '验证', duty: '跑测试、看结果', multi: false },
      redteam: { name: '红队', duty: '故意找茬', multi: true },
      regression: { name: '回归', duty: '检查有没有改坏', multi: false },
    };
    const V3_MODE_OPTIONS = [['Auto', '自动'], ['S1', 'S1 轻量'], ['S2', 'S2 标准'], ['S3', 'S3 完整'], ['S4', 'S4 完整加强']];
    const V3_FORCE_OPTIONS = [['auto', '自动（推荐）'], ['on', '始终'], ['off', '从不']];
    const V3_TASK_TYPE_OPTIONS = [['auto', '自动（按目标判定）'], ['code', '代码任务'], ['investigation', '调查·文档任务']];
    // 思考强度：与编排层 MODE_ROLE_EFFORT 保持一致的档位矩阵。
    const V3_EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const V3_EFFORT_LABELS = { off: '关闭', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' };
    const V3_EFFORT_OPTIONS_GENERIC = [['auto', '自动（按档位矩阵）']].concat(V3_EFFORT_ORDER.map((e) => [e, V3_EFFORT_LABELS[e]]));
    const V3_EFFORT_MATRIX = {
      S1: { generate: 'high', review: 'high', verify: 'high', default: 'high' },
      S2: { plan: 'high', generate: 'high', review: 'high', verify: 'high', default: 'high' },
      S3: { research: 'high', plan: 'high', generate: 'high', review: 'high', judge: 'xhigh', redteam: 'high', verify: 'high', regression: 'high', default: 'high' },
      S4: { research: 'high', plan: 'xhigh', generate: 'high', review: 'xhigh', judge: 'xhigh', redteam: 'xhigh', verify: 'high', regression: 'high', default: 'high' },
    };
    function v3NormalizeEffort(v) {
      const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
      if (s === 'auto') return 'auto';
      return /^[a-z][a-z0-9_-]{0,31}$/.test(s) ? s : 'auto';
    }
    function v3DefaultReasoning() { return { default: 'auto', byRole: {}, byModel: {} }; }
    function v3NormalizeReasoning(raw) {
      const r = raw && typeof raw === 'object' ? raw : {};
      const byRole = {};
      const srcRole = r.byRole && typeof r.byRole === 'object' ? r.byRole : {};
      for (const k of V3_ROLE_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(srcRole, k)) continue;
        const e = v3NormalizeEffort(srcRole[k]);
        if (e !== 'auto') byRole[k] = e;
      }
      const byModel = {};
      const srcModel = r.byModel && typeof r.byModel === 'object' ? r.byModel : {};
      for (const k of Object.keys(srcModel)) {
        if (!/^\S+::\S+$/.test(k)) continue;
        const e = v3NormalizeEffort(srcModel[k]);
        if (e !== 'auto') byModel[k] = e;
      }
      return { default: v3NormalizeEffort(r.default), byRole, byModel };
    }
    const V3_CSS = [
      '.t2biq-v3-root{--t2biq-v3-text:var(--dsw-alias-label-primary,#1f2329);--t2biq-v3-sub:var(--dsw-alias-label-secondary,#595959);--t2biq-v3-ter:var(--dsw-alias-label-tertiary,#666);--t2biq-v3-border:var(--dsw-alias-border-l2,rgba(127,127,127,.28));--t2biq-v3-border3:var(--dsw-alias-border-l3,rgba(127,127,127,.18));--t2biq-v3-bg1:var(--dsw-alias-bg-layer-1,#fff);--t2biq-v3-bg2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));--t2biq-v3-brand:var(--dsw-alias-brand-primary,#4f6ef7);--t2biq-v3-ok:var(--dsw-alias-state-success-primary,#16a34a);--t2biq-v3-warn:var(--dsw-alias-state-warn-primary,#b45309);--t2biq-v3-err:var(--dsw-alias-state-error-primary,#dc2626);box-sizing:border-box;width:100%;min-width:0;color:var(--t2biq-v3-text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.5}',
      '.t2biq-v3-root *{box-sizing:border-box}',
      '.t2biq-v3-shell{display:grid;grid-template-columns:184px minmax(0,1fr);gap:28px;max-width:980px;margin:0 auto;align-items:start;padding:4px 0 0}',
      '.t2biq-v3-nav{border-right:1px solid var(--t2biq-v3-border3);padding:8px 16px 8px 0;min-height:220px}',
      '.t2biq-v3-navbtn{display:flex;align-items:center;width:100%;height:32px;margin:0 0 2px;padding:0 10px;border:0;border-left:2px solid transparent;border-radius:4px;background:transparent;color:var(--t2biq-v3-sub);font:inherit;font-size:13px;text-align:left;cursor:pointer}',
      '.t2biq-v3-navbtn:hover{background:var(--t2biq-v3-bg2);color:var(--t2biq-v3-text)}',
      '.t2biq-v3-navbtn-on{background:var(--t2biq-v3-bg2);border-left-color:var(--t2biq-v3-brand);color:var(--t2biq-v3-text)}',
      '.t2biq-v3-main{min-width:0}',
      '.t2biq-v3-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin:0 0 2px}',
      '.t2biq-v3-page-title{margin:0;font-size:14px;font-weight:600;line-height:1.5;color:var(--t2biq-v3-text)}',
      '.t2biq-v3-page-sub{margin:4px 0 0;font-size:12px;line-height:1.5;color:var(--t2biq-v3-sub)}',
      '.t2biq-v3-catalog{align-self:flex-start;margin-top:2px;padding:0;border:0;background:transparent;color:var(--t2biq-v3-ter);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.t2biq-v3-catalog:hover{color:var(--t2biq-v3-text)}',
      '.t2biq-v3-mainmodel{display:grid;grid-template-columns:120px minmax(0,1fr);gap:12px;padding:14px 0 12px;border-top:1px solid var(--t2biq-v3-border3);margin-top:12px}',
      '.t2biq-v3-mainmodel-label{font-size:13px;color:var(--t2biq-v3-text)}',
      '.t2biq-v3-mainmodel-value{font-size:13px;color:var(--t2biq-v3-text)}',
      '.t2biq-v3-mainmodel-note{grid-column:2;margin:-2px 0 0;font-size:12px;line-height:1.5;color:var(--t2biq-v3-sub)}',
      '.t2biq-v3-section-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:20px 0 0;padding:12px 0 0;border-top:1px solid var(--t2biq-v3-border3)}',
      '.t2biq-v3-section-title{margin:0;font-size:13px;font-weight:600;color:var(--t2biq-v3-text)}',
      '.t2biq-v3-link{padding:0;border:0;background:transparent;color:var(--t2biq-v3-brand);font:inherit;font-size:12px;cursor:pointer}',
      '.t2biq-v3-link:disabled{color:var(--t2biq-v3-ter);cursor:default}',
      '.t2biq-v3-role-table{display:flex;flex-direction:column;min-width:0}',
      '.t2biq-v3-role-head,.t2biq-v3-role-row{display:grid;grid-template-columns:120px minmax(0,1fr) 320px 48px;align-items:center;gap:12px;min-height:38px;padding:0 2px;border-top:1px solid var(--t2biq-v3-border3);font-size:13px}',
      '.t2biq-v3-role-head{min-height:32px;color:var(--t2biq-v3-ter);font-size:12px;border-top:0;border-bottom:1px solid var(--t2biq-v3-border3)}',
      '.t2biq-v3-role-row:hover{background:var(--t2biq-v3-bg2)}',
      '.t2biq-v3-role-cell{min-width:0}',
      '.t2biq-v3-role-name{font-weight:500;color:var(--t2biq-v3-text)}',
      '.t2biq-v3-role-duty{color:var(--t2biq-v3-sub);font-size:12px}',
      '.t2biq-v3-role-duty-mobile{display:none}',
      '.t2biq-v3-model-cell{display:flex;align-items:center;min-width:0;overflow:hidden;white-space:nowrap}',
      '.t2biq-v3-model-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.t2biq-v3-model-more{flex:0 0 auto;margin-left:2px;color:var(--t2biq-v3-ter)}',
      '.t2biq-v3-cell-action{text-align:right}',
      '.t2biq-v3-edit{padding:0;border:0;background:transparent;color:var(--t2biq-v3-brand);font:inherit;font-size:12px;cursor:pointer}',
      '.t2biq-v3-edit:disabled{color:var(--t2biq-v3-ter);cursor:default}',
      '.t2biq-v3-footnote{margin:10px 0 0;font-size:12px;line-height:1.5;color:var(--t2biq-v3-sub)}',
      '.t2biq-v3-section{border-top:1px solid var(--t2biq-v3-border3);padding:14px 0 0;margin:0 0 18px}',
      '.t2biq-v3-section:first-of-type{margin-top:12px}',
      '.t2biq-v3-setting-row{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:24px;align-items:start;padding:7px 0}',
      '.t2biq-v3-setting-label{min-width:0}',
      '.t2biq-v3-setting-label label,.t2biq-v3-setting-label .t2biq-v3-setting-label-text{font-size:13px;color:var(--t2biq-v3-text)}',
      '.t2biq-v3-setting-desc{margin:3px 0 0;font-size:12px;line-height:1.5;color:var(--t2biq-v3-sub)}',
      '.t2biq-v3-select{width:100%;height:28px;box-sizing:border-box;border:1px solid var(--t2biq-v3-border);border-radius:4px;background:var(--t2biq-v3-bg1);color:var(--t2biq-v3-text);font:inherit;font-size:12px;padding:0 7px}',
      '.t2biq-v3-select:focus-visible{outline:2px solid var(--t2biq-v3-brand);outline-offset:1px}',
      '.t2biq-v3-radio-group{display:flex;flex-direction:column;gap:7px;padding-top:2px}',
      '.t2biq-v3-radio{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--t2biq-v3-text);cursor:pointer}',
      '.t2biq-v3-radio input{accent-color:var(--t2biq-v3-sub);margin:0}',
      '.t2biq-v3-strict{margin-top:10px;padding:10px 12px;border-left:2px solid var(--t2biq-v3-warn);background:var(--t2biq-v3-bg2);font-size:12px;line-height:1.6;color:var(--t2biq-v3-text)}',
      '.t2biq-v3-strict p{margin:0 0 4px}.t2biq-v3-strict p:last-child{margin-bottom:0}',
      '.t2biq-v3-strict-warn{color:var(--t2biq-v3-warn)}',
      '.t2biq-v3-switch{position:relative;display:inline-flex;align-items:center;width:36px;height:20px;padding:0;border:1px solid var(--t2biq-v3-border);border-radius:10px;background:var(--t2biq-v3-bg2);cursor:pointer;vertical-align:middle}',
      '.t2biq-v3-switch-dot{position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:var(--t2biq-v3-sub);transition:left .12s ease}',
      '.t2biq-v3-switch[aria-checked="true"]{background:var(--t2biq-v3-brand);border-color:var(--t2biq-v3-brand)}',
      '.t2biq-v3-switch[aria-checked="true"] .t2biq-v3-switch-dot{left:18px;background:var(--t2biq-v3-bg1)}',
      '.t2biq-v3-diff{display:grid;grid-template-columns:48px minmax(0,1fr);gap:4px 10px;margin:10px 0 0;font-size:12px;line-height:1.5}',
      '.t2biq-v3-diff dt{color:var(--t2biq-v3-ter)}.t2biq-v3-diff dd{margin:0;color:var(--t2biq-v3-sub)}',
      '.t2biq-v3-savebar{position:sticky;bottom:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:18px;padding:10px 0;border-top:1px solid var(--t2biq-v3-border3);background:var(--t2biq-v3-bg1)}',
      '.t2biq-v3-save-note{font-size:12px;color:var(--t2biq-v3-sub)}',
      '.t2biq-v3-save{height:28px;padding:0 12px;border:1px solid var(--t2biq-v3-border);border-radius:4px;background:transparent;color:var(--t2biq-v3-text);font:inherit;font-size:12px;cursor:pointer}',
      '.t2biq-v3-save:hover:not(:disabled){background:var(--t2biq-v3-bg2)}.t2biq-v3-save:disabled{color:var(--t2biq-v3-ter);border-color:var(--t2biq-v3-border3);cursor:default}',
      '.t2biq-v3-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:120;max-width:min(560px,calc(100vw - 32px));padding:8px 12px;border:1px solid var(--t2biq-v3-border);border-radius:4px;background:var(--t2biq-v3-bg1);color:var(--t2biq-v3-text);font-size:12px;line-height:1.5;box-shadow:0 2px 8px rgba(0,0,0,.12)}',
      '.t2biq-v3-toast-err{color:var(--t2biq-v3-err)}.t2biq-v3-toast-ok{color:var(--t2biq-v3-ok)}',
      '.t2biq-v3-picker-mask{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.18)}',
      '.t2biq-v3-picker{position:fixed;z-index:101;display:flex;flex-direction:column;width:360px;max-width:calc(100vw - 16px);max-height:440px;border:1px solid var(--t2biq-v3-border);border-radius:6px;background:var(--t2biq-v3-bg1);box-shadow:0 2px 8px rgba(0,0,0,.12);overflow:hidden}',
      '.t2biq-v3-picker-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px 8px}',
      '.t2biq-v3-picker-title{font-size:13px;font-weight:600;margin:0}.t2biq-v3-picker-close{width:24px;height:24px;padding:0;border:0;background:transparent;color:var(--t2biq-v3-sub);font-size:16px;line-height:1;cursor:pointer}',
      '.t2biq-v3-picker-search{display:flex;align-items:center;gap:6px;margin:0 12px 8px;border-bottom:1px solid var(--t2biq-v3-border3)}',
      '.t2biq-v3-picker-search input{flex:1;min-width:0;height:28px;border:0;background:transparent;color:var(--t2biq-v3-text);font:inherit;font-size:12px;outline:none}',
      '.t2biq-v3-picker-body{flex:1 1 auto;overflow:auto;padding:0 6px 6px}',
      '.t2biq-v3-picker-row{display:flex;align-items:center;gap:8px;min-height:38px;padding:4px 8px;border-radius:3px;cursor:pointer;font-size:12px}.t2biq-v3-picker-row:hover{background:var(--t2biq-v3-bg2)}',
      '.t2biq-v3-picker-row input{accent-color:var(--t2biq-v3-sub);margin:0}.t2biq-v3-picker-row-main{min-width:0;flex:1}.t2biq-v3-picker-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.t2biq-v3-picker-sub{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--t2biq-v3-ter);font-size:12px}',
      '.t2biq-v3-picker-follow{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:38px;padding:4px 8px;border-bottom:1px solid var(--t2biq-v3-border3);font-size:12px}.t2biq-v3-picker-follow label{display:flex;align-items:center;gap:8px;cursor:pointer}',
      '.t2biq-v3-provider-head{padding:7px 8px 3px;color:var(--t2biq-v3-ter);font-size:12px;font-weight:600}',
      '.t2biq-v3-picker-empty{padding:18px 8px;text-align:center;color:var(--t2biq-v3-sub);font-size:12px}',
      '.t2biq-v3-order{margin:8px 8px 0;padding-top:8px;border-top:1px solid var(--t2biq-v3-border3)}',
      '.t2biq-v3-order-head{display:flex;justify-content:space-between;color:var(--t2biq-v3-ter);font-size:12px;margin-bottom:4px}',
      '.t2biq-v3-order-row{display:flex;align-items:center;gap:6px;min-height:27px;font-size:12px}.t2biq-v3-order-idx{width:18px;color:var(--t2biq-v3-ter);text-align:right}.t2biq-v3-order-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.t2biq-v3-order-main{color:var(--t2biq-v3-ter);font-size:12px}.t2biq-v3-order-btn{width:22px;height:22px;padding:0;border:1px solid var(--t2biq-v3-border3);border-radius:3px;background:transparent;color:var(--t2biq-v3-sub);cursor:pointer;font-size:12px}.t2biq-v3-order-btn:disabled{color:var(--t2biq-v3-ter);cursor:default}',
      '.t2biq-v3-picker-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;border-top:1px solid var(--t2biq-v3-border3);font-size:12px;color:var(--t2biq-v3-sub)}.t2biq-v3-picker-actions{display:flex;align-items:center;gap:8px}',
      '.t2biq-v3-confirm-mask{position:fixed;inset:0;z-index:130;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.24)}',
      '.t2biq-v3-confirm{width:min(400px,calc(100vw - 32px));border:1px solid var(--t2biq-v3-border);border-radius:6px;background:var(--t2biq-v3-bg1);padding:16px;box-shadow:0 2px 8px rgba(0,0,0,.12)}',
      '.t2biq-v3-confirm h3{margin:0 0 8px;font-size:13px;font-weight:600}.t2biq-v3-confirm p{margin:0 0 14px;font-size:12px;line-height:1.5;color:var(--t2biq-v3-sub)}.t2biq-v3-confirm-actions{display:flex;justify-content:flex-end;gap:8px}',
      '.t2biq-v3-effort-hero{margin:12px 0 0;padding:14px 16px;border:1px solid var(--t2biq-v3-border3);border-radius:8px;background:var(--t2biq-v3-bg2)}',
      '.t2biq-v3-effort-hero-title{font-size:12px;color:var(--t2biq-v3-ter)}',
      '.t2biq-v3-effort-hero-main{margin-top:4px;font-size:15px;font-weight:600;color:var(--t2biq-v3-text)}',
      '.t2biq-v3-effort-hero-note{margin-top:6px;font-size:12px;color:var(--t2biq-v3-sub)}',
      '.t2biq-v3-effort-table{display:flex;flex-direction:column;min-width:0;margin-top:6px}',
      '.t2biq-v3-effort-head,.t2biq-v3-effort-row{display:grid;grid-template-columns:96px minmax(0,1fr) 96px 200px;align-items:center;gap:12px;min-height:38px;padding:0 2px;border-top:1px solid var(--t2biq-v3-border3);font-size:13px}',
      '.t2biq-v3-effort-head{min-height:32px;color:var(--t2biq-v3-ter);font-size:12px;border-top:0;border-bottom:1px solid var(--t2biq-v3-border3)}',
      '.t2biq-v3-effort-row:hover{background:var(--t2biq-v3-bg2)}',
      '.t2biq-v3-effort-badge{display:inline-block;padding:1px 8px;border:1px solid var(--t2biq-v3-border);border-radius:999px;font-size:11px;color:var(--t2biq-v3-sub);white-space:nowrap}',
      '.t2biq-v3-effort-badge-off{color:var(--t2biq-v3-ter)}',
      '.t2biq-v3-effort-model-row{display:grid;grid-template-columns:minmax(0,1fr) 200px;gap:12px;align-items:center;padding:8px 0;border-top:1px solid var(--t2biq-v3-border3)}',
      '.t2biq-v3-root[data-narrow="1"] .t2biq-v3-effort-head{display:none}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-effort-row{grid-template-columns:minmax(0,1fr) 160px;grid-template-areas:"role badge" "duty action";gap:2px 10px;padding:8px 2px}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-effort-row>[role="cell"]:nth-child(1){grid-area:role}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-effort-row>[role="cell"]:nth-child(2){grid-area:duty}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-effort-row>[role="cell"]:nth-child(3){grid-area:badge}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-effort-row>[role="cell"]:nth-child(4){grid-area:action}',
      '@media (max-width:720px){.t2biq-v3-effort-head{display:none}.t2biq-v3-effort-row{grid-template-columns:minmax(0,1fr) 160px;grid-template-areas:"role badge" "duty action";gap:2px 10px;padding:8px 2px}.t2biq-v3-effort-row>[role="cell"]:nth-child(1){grid-area:role}.t2biq-v3-effort-row>[role="cell"]:nth-child(2){grid-area:duty}.t2biq-v3-effort-row>[role="cell"]:nth-child(3){grid-area:badge}.t2biq-v3-effort-row>[role="cell"]:nth-child(4){grid-area:action}.t2biq-v3-effort-model-row{grid-template-columns:1fr;gap:4px}}',
      '.t2biq-v3-root[data-narrow="1"] .t2biq-v3-shell{display:block;max-width:none;padding-top:0}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-nav{display:flex;min-height:0;border-right:0;border-bottom:1px solid var(--t2biq-v3-border3);padding:0;margin-bottom:14px}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-navbtn{width:auto;height:31px;margin:0 22px 0 0;padding:0 0 6px;border-left:0;border-bottom:2px solid transparent;border-radius:0}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-navbtn-on{border-left:0;border-bottom-color:var(--t2biq-v3-brand);background:transparent}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-page-head{display:block}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-catalog{display:block;margin:8px 0 0}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-mainmodel{grid-template-columns:1fr;gap:3px;padding:12px 0 10px}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-mainmodel-note{grid-column:1}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-role-head{display:none}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-role-row{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"role action" "duty duty" "models models";gap:0 8px;min-height:48px;padding:1px 8px;align-items:start}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-role-cell{grid-area:role;line-height:16px}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-role-duty-mobile{display:none}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-cell-duty{display:block;grid-area:duty;font-size:12px;line-height:15px;color:var(--t2biq-v3-sub)}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-model-cell{grid-area:models;line-height:15px;font-size:12px}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-cell-action{grid-area:action}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-setting-row{grid-template-columns:1fr;gap:4px;padding:7px 0}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-section-head{margin-top:16px}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-picker{left:8px !important;right:8px !important;bottom:8px !important;top:auto !important;width:auto;max-height:80vh;border-radius:6px}.t2biq-v3-root[data-narrow="1"] .t2biq-v3-savebar{position:sticky;bottom:0;margin-top:14px}',
      '@media (max-width:720px){.t2biq-v3-root .t2biq-v3-shell{display:block;max-width:none;padding-top:0}.t2biq-v3-root .t2biq-v3-nav{display:flex;min-height:0;border-right:0;border-bottom:1px solid var(--t2biq-v3-border3);padding:0;margin-bottom:14px}.t2biq-v3-root .t2biq-v3-navbtn{width:auto;height:31px;margin:0 22px 0 0;padding:0 0 6px;border-left:0;border-bottom:2px solid transparent;border-radius:0}.t2biq-v3-root .t2biq-v3-navbtn-on{border-left:0;border-bottom-color:var(--t2biq-v3-brand);background:transparent}.t2biq-v3-root .t2biq-v3-page-head{display:block}.t2biq-v3-root .t2biq-v3-catalog{display:block;margin:8px 0 0}.t2biq-v3-root .t2biq-v3-mainmodel{grid-template-columns:1fr;gap:3px;padding:12px 0 10px}.t2biq-v3-root .t2biq-v3-mainmodel-note{grid-column:1}.t2biq-v3-root .t2biq-v3-role-head{display:none}.t2biq-v3-root .t2biq-v3-role-row{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"role action" "duty duty" "models models";gap:0 8px;min-height:48px;padding:1px 8px;align-items:start}.t2biq-v3-root .t2biq-v3-role-cell{grid-area:role;line-height:16px}.t2biq-v3-root .t2biq-v3-role-duty-mobile{display:none}.t2biq-v3-root .t2biq-v3-cell-duty{display:block;grid-area:duty;font-size:12px;line-height:15px;color:var(--t2biq-v3-sub)}.t2biq-v3-root .t2biq-v3-model-cell{grid-area:models;line-height:15px;font-size:12px}.t2biq-v3-root .t2biq-v3-cell-action{grid-area:action}.t2biq-v3-root .t2biq-v3-setting-row{grid-template-columns:1fr;gap:4px}.t2biq-v3-root .t2biq-v3-section-head{margin-top:16px}.t2biq-v3-root .t2biq-v3-picker{left:8px !important;right:8px !important;bottom:8px !important;top:auto !important;width:auto;max-height:80vh}.t2biq-v3-root .t2biq-v3-savebar{position:sticky;bottom:0;margin-top:14px}}',
    ].join('\n');
    function v3EmptyRolePools() {
      const out = {};
      for (const k of V3_ROLE_KEYS) out[k] = [];
      return out;
    }
    function v3DefaultDraft() {
      return { rolePools: v3EmptyRolePools(), defaultMode: 'Auto', forceTeam: 'auto', parallelReviews: 3, pipelineGate: 'off', taskType: 'auto', independentReview: false, reasoning: v3DefaultReasoning() };
    }
    function v3ClipParallel(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return 3;
      return Math.max(1, Math.min(5, Math.round(n)));
    }
    function v3NormalizeTaskType(v) {
      const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
      return s === 'code' || s === 'investigation' ? s : 'auto';
    }
    function v3ToDraft(settings) {
      const s = settings && typeof settings === 'object' ? settings : {};
      const srcPools = s.rolePools && typeof s.rolePools === 'object' ? s.rolePools : {};
      const legacy = s.roleModels && typeof s.roleModels === 'object' ? s.roleModels : {};
      const rolePools = {};
      for (const k of V3_ROLE_KEYS) {
        let pool = [];
        if (Object.prototype.hasOwnProperty.call(srcPools, k)) {
          pool = Array.isArray(srcPools[k]) ? srcPools[k].filter((x) => typeof x === 'string' && x) : [];
        } else if (typeof legacy[k] === 'string' && legacy[k]) {
          pool = [legacy[k]];
        }
        const def = V3_ROLE_DEFS[k];
        const cap = def && def.multi ? 5 : 1;
        rolePools[k] = pool.slice(0, cap);
      }
      return {
        rolePools,
        defaultMode: V3_MODE_OPTIONS.some((x) => x[0] === s.defaultMode) ? s.defaultMode : 'Auto',
        forceTeam: s.forceTeam === 'on' || s.forceTeam === 'off' ? s.forceTeam : 'auto',
        parallelReviews: v3ClipParallel(s.parallelReviews),
        // 必须原样保留 auto：旧实现把非 strict 一律折成 off，导致用户在 API/文件里设的 auto
        // 只要打开面板保存一次就被静默改回 off（门禁自动化失效）。
        pipelineGate: s.pipelineGate === 'strict' ? 'strict' : (s.pipelineGate === 'auto' ? 'auto' : 'off'),
        taskType: v3NormalizeTaskType(s.taskType),
        independentReview: s.independentReview === true,
        reasoning: v3NormalizeReasoning(s.reasoning),
      };
    }
    function toDraft(settings) { return v3ToDraft(settings); }
    function buildSavePayload(draft) { return v3BuildPayload(draft); }
    function v3BuildPayload(draft) {
      const rolePools = {};
      for (const k of V3_ROLE_KEYS) {
        const arr = draft && draft.rolePools && Array.isArray(draft.rolePools[k]) ? draft.rolePools[k] : [];
        const def = V3_ROLE_DEFS[k];
        rolePools[k] = arr.slice(0, def && def.multi ? 5 : 1);
      }
      return {
        rolePools,
        defaultMode: draft.defaultMode,
        forceTeam: draft.forceTeam,
        parallelReviews: draft.parallelReviews,
        pipelineGate: draft.pipelineGate,
        taskType: v3NormalizeTaskType(draft && draft.taskType),
        independentReview: draft.independentReview,
        reasoning: v3NormalizeReasoning(draft && draft.reasoning),
        reasoningReplace: true,
      };
    }
    function v3ModelLabel(ref, models) {
      const m = (models || []).find((x) => x && x.ref === ref);
      return m ? (m.name || m.id || ref) : String(ref || '');
    }
    function v3ModelTitle(pool, models) {
      return (pool || []).map((r) => v3ModelLabel(r, models)).join('、');
    }
    function v3RoleName(key) { return (V3_ROLE_DEFS[key] && V3_ROLE_DEFS[key].name) || key; }
    function V3Select(props) {
      return h('select', { id: props.id, className: 't2biq-v3-select', value: props.value, onChange: props.onChange, 'aria-label': props.label }, ...props.options.map((x) => h('option', { key: x[0], value: x[0] }, x[1])));
    }
    function V3Section(props) {
      return h('section', { className: 't2biq-v3-section' }, h('h3', { className: 't2biq-v3-section-title' }, props.title), props.children);
    }
    function V3SettingRow(props) {
      const controlId = props.control && props.control.props ? props.control.props.id : null;
      const hasControlId = Boolean(controlId && controlId === props.id);
      const labelNode = hasControlId
        ? h('label', { htmlFor: props.id }, props.label)
        : h('span', { className: 't2biq-v3-setting-label-text' }, props.label);
      return h('div', { className: 't2biq-v3-setting-row', 'data-setting-id': props.id },
        h('div', { className: 't2biq-v3-setting-label' }, labelNode, props.desc ? h('p', { className: 't2biq-v3-setting-desc' }, props.desc) : null, props.extra || null),
        props.control);
    }
    function V3RoleRow(props) {
      const def = V3_ROLE_DEFS[props.roleKey] || {};
      const pool = Array.isArray(props.pool) ? props.pool : [];
      const names = pool.map((r) => v3ModelLabel(r, props.models));
      const modelNode = names.length === 0 ? h('span', { className: 't2biq-v3-model-text' }, '跟随主对话')
        : names.length <= 2 ? h('span', { className: 't2biq-v3-model-text', title: v3ModelTitle(pool, props.models) }, names.join('、'))
          : h('span', null, h('span', { className: 't2biq-v3-model-text', title: v3ModelTitle(pool, props.models) }, names.slice(0, 2).join('、')), h('span', { className: 't2biq-v3-model-more' }, '+' + (names.length - 2)));
      return h('div', { className: 't2biq-v3-role-row', role: 'row', 'data-role-row': props.roleKey },
        h('div', { className: 't2biq-v3-role-cell', role: 'cell' },
          h('div', { className: 't2biq-v3-role-name' }, def.name || props.roleKey),
          h('div', { className: 't2biq-v3-role-duty-mobile' }, def.duty || '')),
        h('div', { className: 't2biq-v3-cell-duty t2biq-v3-role-duty', role: 'cell' }, def.duty || ''),
        h('div', { className: 't2biq-v3-model-cell', role: 'cell', 'data-model-cell': props.roleKey, title: v3ModelTitle(pool, props.models) }, modelNode),
        h('div', { className: 't2biq-v3-cell-action', role: 'cell' },
          h('button', {
            type: 'button', className: 't2biq-v3-edit', 'data-action': 'edit-role', 'data-role': props.roleKey,
            disabled: !props.models || props.models.length === 0,
            title: !props.models || props.models.length === 0 ? '模型目录不可用' : '编辑模型',
            'aria-haspopup': 'dialog', 'aria-expanded': props.pickerRole === props.roleKey,
            onClick: (e) => props.onEdit && props.onEdit(props.roleKey, e),
          }, '编辑')));
    }
    function V3ModelPicker(props) {
      const roleKey = props.picker.roleKey;
      const def = V3_ROLE_DEFS[roleKey] || {};
      const pool = Array.isArray(props.pool) ? props.pool : [];
      const selected = new Set(pool);
      const query = String(props.query || '').trim().toLowerCase();
      const models = Array.isArray(props.models) ? props.models.filter((m) => {
        if (!m) return false;
        const hay = [m.name, m.id, m.providerName, m.provider].filter(Boolean).join(' ').toLowerCase();
        return !query || hay.includes(query);
      }) : [];
      const groups = [];
      for (const m of models) {
        const name = m.providerName || m.provider || '其他';
        let g = groups.find((x) => x.name === name);
        if (!g) { g = { name, models: [] }; groups.push(g); }
        g.models.push(m);
      }
      const pos = props.anchor && !props.narrow ? (() => {
        const w = 360; const pad = 8;
        const width = typeof window !== 'undefined' ? window.innerWidth : 1200;
        const height = typeof window !== 'undefined' ? window.innerHeight : 800;
        let left = props.anchor.left || pad;
        if (left + w > width - pad) left = Math.max(pad, width - w - pad);
        let top = (props.anchor.bottom || 0) + 4;
        const hEst = 420;
        if (top + hEst > height - pad) top = Math.max(pad, (props.anchor.top || 0) - hEst - 4);
        return { left, top };
      })() : null;
      const close = () => props.onClose && props.onClose();
      return h('div', { className: 't2biq-v3-picker-mask', onClick: close },
        h('div', { className: 't2biq-v3-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': '为' + (def.name || roleKey) + '选择模型', 'aria-labelledby': 't2biq-v3-picker-title', style: pos || {}, onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); } },
          h('div', { className: 't2biq-v3-picker-head' },
            h('h2', { id: 't2biq-v3-picker-title', className: 't2biq-v3-picker-title' }, '为' + (def.name || roleKey) + '选择模型'),
            h('button', { type: 'button', className: 't2biq-v3-picker-close', 'aria-label': '关闭', onClick: close }, '×')),
          h('div', { className: 't2biq-v3-picker-search' }, h('input', { id: 't2biq-v3-picker-search', type: 'search', value: props.query || '', placeholder: '搜索模型名或 provider/id', 'aria-label': '搜索模型', onChange: (e) => props.onQuery && props.onQuery(e.target.value) })),
          h('div', { className: 't2biq-v3-picker-body' },
            def.multi
              ? h('div', { className: 't2biq-v3-picker-follow' }, h('span', null, '跟随主对话（不指定模型）'), h('button', { type: 'button', className: 't2biq-v3-link', onClick: () => props.onClear && props.onClear(roleKey) }, '清空已选'))
              : h('div', { className: 't2biq-v3-picker-follow' }, h('label', null, h('input', { type: 'radio', name: 't2biq-v3-picker-' + roleKey, checked: pool.length === 0, onChange: () => props.onClear && props.onClear(roleKey) }), '跟随主对话'), h('span', { className: 't2biq-v3-picker-sub' }, '不指定模型，使用主对话当前模型')),
            props.modelsBusy && !props.models.length ? h('div', { className: 't2biq-v3-picker-empty' }, '模型目录加载中…') : null,
            !props.modelsBusy && props.modelsErr && !props.models.length ? h('div', { className: 't2biq-v3-picker-empty' }, '模型目录不可用：' + props.modelsErr, h('button', { type: 'button', className: 't2biq-v3-link', style: { marginLeft: 6 }, onClick: props.onRefresh }, '重试')) : null,
            groups.map((g) => h('div', { key: g.name }, h('div', { className: 't2biq-v3-provider-head' }, g.name), g.models.map((m) => h('label', { key: m.ref, className: 't2biq-v3-picker-row' }, h('input', { type: def.multi ? 'checkbox' : 'radio', name: 't2biq-v3-picker-' + roleKey, checked: selected.has(m.ref), onChange: () => props.onPick && props.onPick(roleKey, m.ref) }), h('span', { className: 't2biq-v3-picker-row-main' }, h('span', { className: 't2biq-v3-picker-name' }, m.name || m.id || m.ref), h('span', { className: 't2biq-v3-picker-sub' }, (m.providerName ? m.providerName + ' · ' : '') + (m.id || ''))))))),
            !props.modelsBusy && !props.modelsErr && models.length === 0 ? h('div', { className: 't2biq-v3-picker-empty' }, '没有匹配的模型', h('button', { type: 'button', className: 't2biq-v3-link', style: { marginLeft: 6 }, onClick: () => props.onQuery && props.onQuery('') }, '清除搜索')) : null),
          def.multi ? h('div', { className: 't2biq-v3-order' }, h('div', { className: 't2biq-v3-order-head' }, h('span', null, '已选顺序'), h('span', null, '第 1 个为主模型')), pool.length === 0 ? h('div', { className: 't2biq-v3-order-row t2biq-v3-order-empty' }, '未选择，跟随主对话') : pool.map((ref, i) => h('div', { key: ref, className: 't2biq-v3-order-row' }, h('span', { className: 't2biq-v3-order-idx' }, String(i + 1)), h('span', { className: 't2biq-v3-order-name', title: v3ModelLabel(ref, props.models) }, v3ModelLabel(ref, props.models)), i === 0 ? h('span', { className: 't2biq-v3-order-main' }, '主模型') : null, h('button', { type: 'button', className: 't2biq-v3-order-btn', disabled: i === 0, 'aria-label': '上移', onClick: () => props.onMove && props.onMove(roleKey, i, -1) }, '↑'), h('button', { type: 'button', className: 't2biq-v3-order-btn', disabled: i === pool.length - 1, 'aria-label': '下移', onClick: () => props.onMove && props.onMove(roleKey, i, 1) }, '↓'), h('button', { type: 'button', className: 't2biq-v3-order-btn', 'aria-label': '移除', onClick: () => props.onRemove && props.onRemove(roleKey, i) }, '×')))) : null,
          h('div', { className: 't2biq-v3-picker-foot' }, h('span', null, '已选 ' + pool.length + ' / ' + (def.multi ? 5 : 1)), h('div', { className: 't2biq-v3-picker-actions' }, h('button', { type: 'button', className: 't2biq-v3-link', disabled: pool.length === 0, onClick: () => props.onClear && props.onClear(roleKey) }, '清空'), h('button', { type: 'button', className: 't2biq-v3-save', onClick: close }, '完成')))));
    }
    function V3Confirm(props) {
      const c = props.confirm || {};
      return h('div', { className: 't2biq-v3-confirm-mask', onClick: () => props.onClose && props.onClose() },
        h('div', { className: 't2biq-v3-confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 't2biq-v3-confirm-title', onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); } },
          h('h3', { id: 't2biq-v3-confirm-title' }, c.title || '确认'),
          h('p', null, c.body || ''),
          h('div', { className: 't2biq-v3-confirm-actions' },
            h('button', { type: 'button', className: 't2biq-v3-save', onClick: () => props.onClose && props.onClose() }, '取消'),
            h('button', { type: 'button', className: 't2biq-v3-save', onClick: () => c.onConfirm && c.onConfirm() }, '确认'))));
    }
    function SettingsView(props) {
      const p = props || {};
      const draft = p.draft || v3DefaultDraft();
      const models = Array.isArray(p.models) ? p.models : [];
      const page = p.page === 'advanced' ? 'advanced' : p.page === 'effort' ? 'effort' : 'model';
      const narrow = p.narrow === true;
      const rolePools = draft.rolePools || v3EmptyRolePools();
      const taskType = v3NormalizeTaskType(draft.taskType);
      const hasOverride = V3_ROLE_KEYS.some((k) => Array.isArray(rolePools[k]) && rolePools[k].length);
      const navBtn = (id, label) => h('button', { key: id, type: 'button', role: 'tab', id: 't2biq-v3-tab-' + id, 'aria-selected': page === id, 'aria-controls': 't2biq-v3-page-' + id, className: 't2biq-v3-navbtn' + (page === id ? ' t2biq-v3-navbtn-on' : ''), onClick: () => p.onPage && p.onPage(id) }, label);
      const modelPage = h('main', { className: 't2biq-v3-main', role: 'tabpanel', id: 't2biq-v3-page-model', 'aria-labelledby': 't2biq-v3-tab-model' },
        h('div', { className: 't2biq-v3-page-head' },
          h('div', null, h('h2', { className: 't2biq-v3-page-title' }, '模型'), h('p', { className: 't2biq-v3-page-sub' }, '角色默认使用主对话的模型。需要让某个角色换模型时，单独指定即可。')),
          h('button', { type: 'button', className: 't2biq-v3-catalog', onClick: p.onRefreshModels, disabled: p.modelsBusy && !models.length }, p.modelsErr ? '模型目录不可用：' + p.modelsErr + ' · 重试' : p.modelsBusy && !models.length ? '模型目录加载中…' : '模型目录：' + models.length + ' 个 · 刷新')),
        h('div', { className: 't2biq-v3-mainmodel' },
          h('div', { className: 't2biq-v3-mainmodel-label' }, '主模型'),
          h('div', { className: 't2biq-v3-mainmodel-value' }, '跟随主对话'),
          h('p', { className: 't2biq-v3-mainmodel-note' }, '由输入框上方的模型选择器决定。插件不读取、也不修改这个选择。')),
        h('div', { className: 't2biq-v3-section-head' }, h('h3', { className: 't2biq-v3-section-title' }, '角色模型'), h('button', { type: 'button', className: 't2biq-v3-link', disabled: !hasOverride, onClick: p.onResetAll }, '全部恢复跟随主对话')),
        h('div', { className: 't2biq-v3-role-table', role: 'table' },
          h('div', { className: 't2biq-v3-role-head', role: 'row' }, h('div', { role: 'columnheader' }, '角色'), h('div', { role: 'columnheader' }, '用途'), h('div', { role: 'columnheader' }, '模型'), h('div', { role: 'columnheader' }, '操作')),
          V3_ROLE_KEYS.map((k) => h(V3RoleRow, { key: k, roleKey: k, pool: rolePools[k] || [], models, pickerRole: p.picker && p.picker.roleKey, onEdit: p.onEditRole }))),
        h('p', { className: 't2biq-v3-footnote' }, '多选角色按顺序使用，第 1 个为主模型；S4 实际并行数由「高级」中的「S4 并行审模型数」决定。'));
      const advancedPage = h('main', { className: 't2biq-v3-main', role: 'tabpanel', id: 't2biq-v3-page-advanced', 'aria-labelledby': 't2biq-v3-tab-advanced' },
        h('div', { className: 't2biq-v3-page-head' }, h('div', null, h('h2', { className: 't2biq-v3-page-title' }, '高级'), h('p', { className: 't2biq-v3-page-sub' }, '档位、任务类型、成本、流程门禁和评审独立性。'))),
        h(V3Section, { title: '会话与团队' },
          h(V3SettingRow, { id: 't2biq-v3-default-mode', label: '新会话默认档位', desc: '只决定新会话从哪一档开始；当前会话的档位在输入框上方「IQ」中切换，会被记住。', control: h(V3Select, { id: 't2biq-v3-default-mode', label: '新会话默认档位', value: draft.defaultMode, options: V3_MODE_OPTIONS, onChange: (e) => p.onUpdate && p.onUpdate({ defaultMode: e.target.value }) }) }),
          h(V3SettingRow, { id: 't2biq-v3-force-team', label: '强制用团队', desc: '自动：S2/S3/S4 强制团队、S1 不强制；始终：所有档位强制；从不：都不强制。', extra: draft.forceTeam === 'on' ? h('p', { className: 't2biq-v3-strict-warn' }, '小任务也会明显增加 token 消耗。') : null, control: h(V3Select, { id: 't2biq-v3-force-team', label: '强制用团队', value: draft.forceTeam, options: V3_FORCE_OPTIONS, onChange: (e) => p.onUpdate && p.onUpdate({ forceTeam: e.target.value }) }) })),
        h(V3Section, { title: '成本与并行' },
          h(V3SettingRow, { id: 't2biq-v3-parallel-reviews', label: 'S4 并行审模型数', desc: '仅完整加强 S4 的评审 / 裁决 / 红队生效；实际并行数取该值与已选模型数的较小者，不足 2 个自动退化为单审。', control: h(V3Select, { id: 't2biq-v3-parallel-reviews', label: 'S4 并行审模型数', value: String(draft.parallelReviews), options: [1, 2, 3, 4, 5].map((n) => [String(n), String(n)]), onChange: (e) => p.onUpdate && p.onUpdate({ parallelReviews: Number(e.target.value) }) }) })),
        h(V3Section, { title: '任务类型' },
          h(V3SettingRow, { id: 't2biq-v3-task-type', label: '任务类型', desc: '调查类任务走 research→synth→review→verify，不含实现阶段。', control: h('div', { className: 't2biq-v3-radio-group', role: 'radiogroup', 'aria-label': '任务类型' },
            V3_TASK_TYPE_OPTIONS.map(([value, text]) => h('label', { key: value, className: 't2biq-v3-radio' },
              h('input', { type: 'radio', name: 't2biq-v3-task-type', value, checked: taskType === value, onChange: () => p.onUpdate && p.onUpdate({ taskType: value }) }), text)))})),
        h(V3Section, { title: '流程门禁' },
          h(V3SettingRow, { id: 't2biq-v3-pipeline-gate', label: '严格流程', desc: '严格流程会拦截缺少验收标准、testsRun 或多候选裁决的流程。', control: h('div', { className: 't2biq-v3-radio-group', role: 'radiogroup', 'aria-label': '严格流程' },
            h('label', { className: 't2biq-v3-radio' }, h('input', { type: 'radio', name: 't2biq-v3-pipeline-gate', value: 'off', checked: draft.pipelineGate === 'off', onChange: () => p.onUpdate && p.onUpdate({ pipelineGate: 'off' }) }), '宽松（仅记录）'),
            h('label', { className: 't2biq-v3-radio' }, h('input', { type: 'radio', name: 't2biq-v3-pipeline-gate', value: 'strict', checked: draft.pipelineGate === 'strict', onChange: () => p.onUpdate && p.onUpdate({ pipelineGate: 'strict' }) }), '严格（硬门禁）'),
            h('label', { className: 't2biq-v3-radio' }, h('input', { type: 'radio', name: 't2biq-v3-pipeline-gate', value: 'auto', checked: draft.pipelineGate === 'auto', onChange: () => p.onUpdate && p.onUpdate({ pipelineGate: 'auto' }) }), '自动（按任务类型）')) }),
          draft.pipelineGate === 'auto' ? h('div', { className: 't2biq-v3-strict' },
            h('p', null, '作用域：按运行决定，保存后对之后开始的运行生效。'),
            h('p', null, '• 调查 / 文档任务：一律不启用硬门禁（没有实现阶段，硬门禁只会逼人造假）；'),
            h('p', null, '• 代码任务：仅 S3 / S4（大改）启用严格门禁，S1 / S2 的小改保持宽松。')) : null,
          draft.pipelineGate === 'strict' ? h('div', { className: 't2biq-v3-strict' },
            h('p', null, '作用域：所有档位（S1–S4）和所有运行，保存后立即生效。'),
            h('p', null, '• 进入实现前必须有 spec / 验收标准；'),
            h('p', null, '• verify / regression 必须带 testsRun；'),
            h('p', null, '• 多候选必须由 judge 带 selectedCandidate 择优；'),
            h('p', { className: 't2biq-v3-strict-warn' }, '开启前请确认团队知道这些要求；否则 record / finish 会被拒绝，任务会卡住。')) : null),
        h(V3Section, { title: '评审独立性' },
          h(V3SettingRow, { id: 't2biq-v3-independent-review', label: '独立评委', desc: draft.independentReview ? '评审 / 裁决 / 红队必须由执行者之外的代理完成；回执必须带 owner；评委只能依据产物与验收标准，不得参考执行者的推理过程或聊天记录。' : '允许执行者自评，也允许评委参考执行过程。', control: h('button', { type: 'button', className: 't2biq-v3-switch', role: 'switch', 'aria-checked': draft.independentReview === true, 'aria-label': '独立评委', onClick: () => p.onUpdate && p.onUpdate({ independentReview: !draft.independentReview }) }, h('span', { className: 't2biq-v3-switch-dot' })) }),
          h('dl', { className: 't2biq-v3-diff' },
            h('dt', null, '关闭'), h('dd', null, '执行者也可自评；评委可以看执行过程。'),
            h('dt', null, '开启'), h('dd', null, '必须由独立代理；回执必须带 owner；只看产物与验收标准。'))));
      const reasoning = v3NormalizeReasoning(draft.reasoning);
      const matrixMode = ['S1', 'S2', 'S3', 'S4'].indexOf(draft.defaultMode) >= 0 ? draft.defaultMode : 'S3';
      const matrix = V3_EFFORT_MATRIX[matrixMode] || V3_EFFORT_MATRIX.S3;
      const effortLabel = (e) => V3_EFFORT_LABELS[e] || e || '自动';
      const setReasoning = (next) => p.onUpdate && p.onUpdate({ reasoning: v3NormalizeReasoning(next) });
      const setByRole = (roleKey, val) => {
        const byRole = Object.assign({}, reasoning.byRole);
        if (!val || val === 'auto') delete byRole[roleKey]; else byRole[roleKey] = val;
        setReasoning({ default: reasoning.default, byRole, byModel: reasoning.byModel });
      };
      const setByModel = (ref, val) => {
        const byModel = Object.assign({}, reasoning.byModel);
        if (!val) delete byModel[ref]; else byModel[ref] = val;
        setReasoning({ default: reasoning.default, byRole: reasoning.byRole, byModel });
      };
      const effortModelRefs = [];
      for (const k of V3_ROLE_KEYS) { for (const ref of (rolePools[k] || [])) { if (ref && effortModelRefs.indexOf(ref) === -1) effortModelRefs.push(ref); } }
      const effortPage = h('main', { className: 't2biq-v3-main', role: 'tabpanel', id: 't2biq-v3-page-effort', 'aria-labelledby': 't2biq-v3-tab-effort' },
        h('div', { className: 't2biq-v3-page-head' }, h('div', null, h('h2', { className: 't2biq-v3-page-title' }, '思考强度'), h('p', { className: 't2biq-v3-page-sub' }, '控制每个阶段向模型请求多少推理预算；不支持的模型会自动省略，不影响运行。'))),
        h('div', { className: 't2biq-v3-effort-hero' },
          h('div', { className: 't2biq-v3-effort-hero-title' }, '当前策略'),
          h('div', { className: 't2biq-v3-effort-hero-main' }, reasoning.default === 'auto' ? '自动（按档位矩阵）' : '全局 ' + effortLabel(reasoning.default)),
          h('div', { className: 't2biq-v3-effort-hero-note' }, '当前档位 ' + (draft.defaultMode || 'Auto') + '：生成 ' + effortLabel(matrix.generate || matrix.default) + ' · 评审 ' + effortLabel(matrix.review || matrix.default) + ' · 验证 ' + effortLabel(matrix.verify || matrix.default))),
        h(V3Section, { title: '全局默认' },
          h(V3SettingRow, { id: 't2biq-v3-effort-default', label: '默认思考强度', desc: 'auto 表示按档位矩阵自动决定；显式选择后对所有未被角色/模型覆盖的阶段生效。', control: h(V3Select, { id: 't2biq-v3-effort-default', label: '默认思考强度', value: reasoning.default, options: V3_EFFORT_OPTIONS_GENERIC, onChange: (e) => setReasoning({ default: e.target.value, byRole: reasoning.byRole, byModel: reasoning.byModel }) }) })),
        h(V3Section, { title: '角色覆盖' },
          h('div', { className: 't2biq-v3-effort-table', role: 'table' },
            h('div', { className: 't2biq-v3-effort-head', role: 'row' }, h('div', { role: 'columnheader' }, '角色'), h('div', { role: 'columnheader' }, '用途'), h('div', { role: 'columnheader' }, '建议'), h('div', { role: 'columnheader' }, '档位')),
            V3_ROLE_KEYS.map((k) => {
              const def = V3_ROLE_DEFS[k] || {};
              const suggest = matrix[k] || matrix.default;
              const cur = reasoning.byRole[k] || 'auto';
              const opts = [['auto', reasoning.default === 'auto' ? '跟随矩阵（' + effortLabel(suggest) + '）' : '跟随默认（' + effortLabel(reasoning.default) + '）']].concat(V3_EFFORT_ORDER.map((e) => [e, V3_EFFORT_LABELS[e]]));
              return h('div', { key: k, className: 't2biq-v3-effort-row', role: 'row', 'data-effort-role': k },
                h('div', { className: 't2biq-v3-role-name', role: 'cell' }, def.name || k),
                h('div', { className: 't2biq-v3-role-duty', role: 'cell' }, def.duty || ''),
                h('div', { role: 'cell' }, h('span', { className: 't2biq-v3-effort-badge' }, effortLabel(suggest))),
                h('div', { role: 'cell' }, h(V3Select, { id: 't2biq-v3-effort-role-' + k, label: (def.name || k) + '思考强度', value: cur, options: opts, onChange: (e) => setByRole(k, e.target.value) })));
            })),
          h('p', { className: 't2biq-v3-footnote' }, '「建议」按当前档位矩阵给出，仅作参考；显式覆盖优先于矩阵与全局默认。')),
        h(V3Section, { title: '按模型覆盖' },
          effortModelRefs.length === 0
            ? h('p', { className: 't2biq-v3-footnote' }, '未指定角色模型。全部跟随主对话时无法按模型调档；在「模型」页为角色指定模型后可在此单独设置。')
            : h('div', null, effortModelRefs.map((ref) => {
                const m = (models || []).find((x) => x && x.ref === ref);
                const rz = m && m.reasoning ? m.reasoning : null;
                const asEffId = (v) => (typeof v === 'string' ? v : (v && (v.id || v.effort || v.name)) ? String(v.id || v.effort || v.name) : null);
                const rawEfforts = rz && Array.isArray(rz.supportedEfforts) ? rz.supportedEfforts : (rz && Array.isArray(rz.efforts) ? rz.efforts : []);
                const effortIds = rawEfforts.map(asEffId).filter(Boolean);
                const defEffort = rz ? asEffId(rz.defaultEffort || rz.default) : null;
                const cur = reasoning.byModel[ref] || '';
                return h('div', { key: ref, className: 't2biq-v3-effort-model-row', 'data-effort-model': ref },
                  h('div', null, h('div', { className: 't2biq-v3-role-name' }, (m && (m.name || m.id)) || ref), h('div', { className: 't2biq-v3-role-duty' }, m && m.providerName ? m.providerName : ref)),
                  effortIds.length === 0
                    ? h('div', { className: 't2biq-v3-effort-badge t2biq-v3-effort-badge-off' }, defEffort ? ('仅默认 ' + effortLabel(defEffort)) : '不支持思考强度')
                    : h(V3Select, { id: 't2biq-v3-effort-model-' + ref, label: ((m && m.name) || ref) + '思考强度', value: cur, options: [['', '跟随默认' + (defEffort ? '（' + effortLabel(defEffort) + '）' : '')]].concat(effortIds.map((e) => [e, effortLabel(e)])), onChange: (e) => setByModel(ref, e.target.value) }));
              }))));
      return h('div', { className: 't2biq-v3-root', 'data-narrow': narrow ? '1' : '0', ref: p.rootRef },
        h('style', null, V3_CSS),
        h('div', { className: 't2biq-v3-shell' },
          h('nav', { className: 't2biq-v3-nav', role: 'tablist', 'aria-label': '设置页面' }, navBtn('model', '模型'), navBtn('effort', '思考强度'), navBtn('advanced', '高级')),
          page === 'advanced' ? advancedPage : page === 'effort' ? effortPage : modelPage),
        h('div', { className: 't2biq-v3-savebar' },
          h('div', { className: 't2biq-v3-save-note' }, p.dirty ? '有未保存更改' : ''),
          h('button', { type: 'button', className: 't2biq-v3-save', disabled: p.busy || !p.dirty, onClick: p.onSave }, p.busy ? '保存中…' : '保存设置')),
        p.picker ? h(V3ModelPicker, { picker: p.picker, models, modelsBusy: p.modelsBusy, modelsErr: p.modelsErr, query: p.pickerQuery, pool: rolePools[p.picker.roleKey] || [], anchor: p.picker.anchor, narrow, onQuery: p.onPickerQuery, onPick: p.onPick, onClear: p.onClearPool, onMove: p.onMove, onRemove: p.onRemove, onClose: p.onClosePicker, onRefresh: p.onRefreshModels }) : null,
        p.confirm ? h(V3Confirm, { confirm: p.confirm, onClose: p.onCloseConfirm }) : null,
        (p.msg || p.err) ? h('div', { className: 't2biq-v3-toast ' + (p.err ? 't2biq-v3-toast-err' : 't2biq-v3-toast-ok'), role: p.err ? 'alert' : 'status', 'aria-live': 'polite' }, p.err || p.msg) : null);
    }
    function SettingsForm() {
      const [draft, setDraft] = useState(null);
      const [saved, setSaved] = useState(null);
      const [models, setModels] = useState([]);
      const [modelsBusy, setModelsBusy] = useState(false);
      const [modelsErr, setModelsErr] = useState(null);
      const [page, setPage] = useState('model');
      const [picker, setPicker] = useState(null);
      const [pickerQuery, setPickerQuery] = useState('');
      const [confirm, setConfirm] = useState(null);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState(null);
      const [err, setErr] = useState(null);
      const [narrow, setNarrow] = useState(false);
      const rootRef = useRef(null);
      const triggerRef = useRef(null);
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
      const loadSettings = useCallback(async () => {
        setErr(null);
        try {
          const s = await getSettings();
          if (!s) throw new Error('读取设置失败');
          const d = toDraft(s);
          setDraft(d); setSaved(toDraft(s));
        } catch (e) { setErr(String((e && e.message) || e)); }
      }, []);
      useEffect(() => { loadSettings(); loadModels(); }, [loadSettings, loadModels]);
      useEffect(() => {
        const update = () => {
          const el = rootRef.current;
          const w = el && el.clientWidth ? el.clientWidth : (typeof window !== 'undefined' ? window.innerWidth : 900);
          setNarrow(w < 720);
        };
        update();
        if (typeof ResizeObserver !== 'undefined' && rootRef.current) { const ro = new ResizeObserver(update); ro.observe(rootRef.current); return () => ro.disconnect(); }
        if (typeof window !== 'undefined' && window.addEventListener) { window.addEventListener('resize', update); return () => window.removeEventListener('resize', update); }
      }, [draft]);
      useEffect(() => {
        if (!confirm) return;
        const onKey = (e) => { if (e.key === 'Escape') setConfirm(null); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [confirm]);
      useEffect(() => {
        if (!picker) return;
        const onKey = (e) => { if (e.key === 'Escape') { setPicker(null); setPickerQuery(''); const t = triggerRef.current; if (t && t.focus) setTimeout(() => { try { t.focus(); } catch (x) {} }, 0); } };
        const onDown = (e) => { const t = e && e.target; if (t && t.closest && t.closest('.t2biq-v3-picker')) return; setPicker(null); setPickerQuery(''); };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onDown, true);
        return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown, true); };
      }, [picker]);
      useEffect(() => {
        if (!picker || typeof document === 'undefined' || !document.querySelector) return;
        const t = setTimeout(() => { const el = document.querySelector('#t2biq-v3-picker-search'); if (el && el.focus) el.focus(); }, 0);
        return () => clearTimeout(t);
      }, [picker]);
      if (!draft) return err ? h('div', { className: 't2biq-v3-root' }, h('style', null, V3_CSS), h('div', { className: 't2biq-v3-page-sub' }, '加载失败：' + err, h('button', { type: 'button', className: 't2biq-v3-link', style: { marginLeft: 8 }, onClick: loadSettings }, '重试'))) : h('div', { className: 't2biq-v3-root' }, h('style', null, V3_CSS), h('div', { className: 't2biq-v3-page-sub' }, '加载设置中…'));
      const update = (patch) => { setMsg(null); setErr(null); setDraft((d) => ({ ...(d || v3DefaultDraft()), ...patch })); };
      const setPool = (roleKey, next) => { setMsg(null); setErr(null); setDraft((d) => ({ ...(d || v3DefaultDraft()), rolePools: { ...(d || v3DefaultDraft()).rolePools, [roleKey]: next } })); };
      const openPicker = (roleKey, e) => {
        if (!models.length) return;
        triggerRef.current = e && e.currentTarget ? e.currentTarget : null;
        const rect = triggerRef.current && triggerRef.current.getBoundingClientRect ? triggerRef.current.getBoundingClientRect() : null;
        setPickerQuery(''); setPicker({ roleKey, anchor: rect });
      };
      const closePicker = () => { setPicker(null); setPickerQuery(''); const t = triggerRef.current; if (t && t.focus) setTimeout(() => { try { t.focus(); } catch (x) {} }, 0); };
      const pick = (roleKey, ref) => {
        const def = V3_ROLE_DEFS[roleKey] || {};
        const cur = Array.isArray(draft.rolePools[roleKey]) ? draft.rolePools[roleKey] : [];
        if (!def.multi) { setPool(roleKey, cur.includes(ref) ? [] : [ref]); closePicker(); return; }
        if (cur.includes(ref)) { setPool(roleKey, cur.filter((x) => x !== ref)); return; }
        if (cur.length >= 5) { setMsg('最多 5 个（S4 并行上限）'); return; }
        setPool(roleKey, cur.concat([ref]));
      };
      const move = (roleKey, index, delta) => {
        const cur = (draft.rolePools[roleKey] || []).slice();
        const j = index + delta;
        if (j < 0 || j >= cur.length) return;
        const tmp = cur[index]; cur[index] = cur[j]; cur[j] = tmp; setPool(roleKey, cur);
      };
      const remove = (roleKey, index) => { const cur = (draft.rolePools[roleKey] || []).slice(); cur.splice(index, 1); setPool(roleKey, cur); };
      const save = async () => {
        setBusy(true); setMsg(null); setErr(null);
        try {
          const payload = buildSavePayload(draft);
          const r = await saveSettings(payload);
          const s = (r && r.settings) || null;
          if (!s) throw new Error('保存响应缺少设置，请重新读取后确认');
          const next = toDraft(s);
          setDraft(next); setSaved(toDraft(s)); setMsg('已保存，新运行生效。');
        } catch (e) { setErr('保存失败：' + String((e && e.message) || e)); } finally { setBusy(false); }
      };
      const openReset = () => setConfirm({ title: '全部恢复跟随主对话？', body: '将把 8 个角色的模型都恢复为「跟随主对话」。', onConfirm: () => { setDraft((d) => ({ ...(d || v3DefaultDraft()), rolePools: v3EmptyRolePools() })); setConfirm(null); } });
      const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
      return h(SettingsView, { draft, models, modelsBusy, modelsErr, page, onPage: setPage, onEditRole: openPicker, picker, pickerQuery, onPickerQuery: setPickerQuery, onPick: pick, onClearPool: (roleKey) => setPool(roleKey, []), onMove: move, onRemove: remove, onClosePicker: closePicker, onSave: save, busy, dirty, msg, err, onResetAll: openReset, onUpdate: update, onRefreshModels: loadModels, narrow, rootRef, confirm, onCloseConfirm: () => setConfirm(null) });
    }

    function PanelApp({ onClose }) {
      const [data, setData] = useState(null);
      const [selectedRunId, setSelectedRunId] = useState(null);
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState(null);
      const [tab, setTab] = useState('runs');

      const vcache = useRef({});
      const lastSig = useRef('');
      const loadSeq = useRef(0);
      const load = useCallback(async (runId) => {
        const my = ++loadSeq.current; // 后发先到的响应必须丢弃，否则会覆盖当前选中
        setBusy(true);
        try {
          const d = await getState(runId === undefined ? selectedRunId : runId);
          if (my !== loadSeq.current) return;
          const list = (d && d.runs) || [];
          // 兼容旧宿主（summary 无 verdict）：逐条取详情补齐结论，带缓存只补一次。
          const missing = list.filter((r) => r && r.id && !r.verdict && !(r.id in vcache.current)).slice(0, 3);
          if (missing.length) {
            await Promise.all(missing.map(async (r) => {
              try { const dd = await getState(r.id); const c = dd && dd.current; vcache.current[r.id] = (c && c.verdict && c.verdict.final) || null; }
              catch { /* 失败不写负缓存：下一轮轮询会重试，避免永久空白 */ }
            }));
          }
          if (my !== loadSeq.current) return;
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
          if (my === loadSeq.current) setErr('加载失败：' + (e && e.message ? e.message : e));
        } finally {
          if (my === loadSeq.current) setBusy(false);
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
      const onSelect = (id) => { if (id === selectedRunId) load(id); else { ++loadSeq.current; setSelectedRunId(id); } };

      const tabBtn = (id, label) => h('button', { type: 'button', 'aria-pressed': tab === id, style: { ...S.tab, ...(tab === id ? S.tabOn : null) }, onClick: () => setTab(id) }, label);
      return h('div', { className: 't2biq-surface', style: S.panelHost },
        h('style', null, '.t2biq-surface button:focus-visible,.t2biq-surface select:focus-visible,[data-t2biq-menu] button:focus-visible{outline:2px solid #4f6ef7;outline-offset:2px}.t2biq-surface button:hover:not(:disabled),[data-t2biq-menu] button:hover:not(:disabled){filter:brightness(1.12)}'),
        h(Header, { count: runs.length, busy, err, onClose, onRefresh: () => load() }),
        h('div', { style: S.tabbar }, tabBtn('runs', '运行记录'), tabBtn('settings', '设置')),
        h('div', { style: S.body },
          tab === 'settings'
            ? h(SettingsForm, null)
            : h('div', null, h(StatsBar, { runs, live: data && data.liveUsage }), h(RunList, { runs, current, onSelect }))));
    }

    // ---- 输入框工具行（conversation.input.left）：紧凑档位下拉 ----
    const MODE_OPTS = [{ v: '__off', text: '关闭' }].concat(MODE_KEYS.map((k) => ({ v: k, text: MODE_TEXT[k] })));
    function sessionIdOf(owner) {
      const o = owner || {};
      return (o.session && (o.session.id || o.session.sessionId)) || o.sessionId || o.id || 'default';
    }
    function Chevron({ open }) {
      return h('span', { style: { ...S.iqChev, transform: open ? 'rotate(180deg)' : 'none' } },
        h('svg', { 'aria-hidden': true, width: 10, height: 10, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M2.5 4.5 L6 8 L9.5 4.5' })));
    }
    function DockControl({ owner }) {
      const sid = sessionIdOf(owner);
      const [pref, setPref] = useState(null);
      const [open, setOpen] = useState(false);
      const [err, setErr] = useState(null);
      const [busy, setBusy] = useState(false);
      const [host, setHost] = useState(null);
      const [pos, setPos] = useState({ left: 8, top: 8, maxHeight: '70vh' });
      const btnRef = useRef(null);
      const currentSid = useRef(sid);
      currentSid.current = sid;
      const seq = useRef(0);
      const mutation = useRef(false);
      const refresh = useCallback(async () => {
        if (mutation.current) return;
        const my = ++seq.current;
        setBusy(true);
        try {
          const d = await getSessionPref(sid);
          let p = d.pref;
          if (!p || !p.mode) {
            const settings = await getSettings();
            p = { ...(p || {}), mode: (settings && settings.defaultMode) || 'Auto' };
          }
          if (my !== seq.current || sid !== currentSid.current) return;
          setPref({ sessionId: sid, enabled: p.enabled !== false, mode: p.mode });
          setErr(null);
        } catch (e) { if (my === seq.current && sid === currentSid.current) setErr('会话设置同步失败：' + (e.message || e)); }
        finally { if (my === seq.current && sid === currentSid.current) setBusy(false); }
      }, [sid]);
      const refreshHost = useCallback(async () => {
        try {
          const d = await getJson('token2biq/host?sessionId=' + encodeURIComponent(sid));
          if (!d || d.ok === false || !d.team) throw new Error((d && d.error) || '官方团队状态不可用');
          if (sid === currentSid.current) setHost({ ...d.team, sessionId: sid });
          return d.team;
        } catch (e) {
          if (sid === currentSid.current) setHost({ sessionId: sid, supported: false, enabled: null, canEnable: false, reason: String(e.message || e) });
          throw e;
        }
      }, [sid]);
      useEffect(() => {
        setOpen(false); setPref(null); setHost(null); setErr(null); mutation.current = false;
        refresh();
        const onFocus = () => { refresh(); };
        window.addEventListener('focus', onFocus);
        return () => { ++seq.current; window.removeEventListener('focus', onFocus); };
      }, [refresh]);
      useEffect(() => {
        if (!open) return;
        refreshHost().catch(() => {});
        const close = () => setOpen(false);
        const onDown = (e) => {
          if (btnRef.current && btnRef.current.contains(e.target)) return;
          if (e.target && e.target.closest && e.target.closest('[data-t2biq-menu]')) return;
          close();
        };
        const onKey = (e) => { if (e.key === 'Escape') { close(); btnRef.current && btnRef.current.focus(); } };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', close);
        return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey); window.removeEventListener('resize', close); };
      }, [open, refreshHost]);
      const active = pref && pref.sessionId === sid ? pref : null;
      const activeHost = host && host.sessionId === sid ? host : null;
      const enabled = active && active.enabled;
      const value = enabled ? active.mode : '__off';
      const openMenu = () => {
        const r = btnRef.current && btnRef.current.getBoundingClientRect();
        if (r) {
          const above = r.top; const below = window.innerHeight - r.bottom;
          setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 288)), ...(above > below ? { bottom: Math.max(8, window.innerHeight - r.top + 6) } : { top: Math.max(8, r.bottom + 6) }), maxHeight: Math.max(64, Math.max(above, below) - 14) });
        }
        setOpen((o) => !o);
      };
      const choose = async (v) => {
        if (mutation.current || !active) return;
        mutation.current = true; ++seq.current; setBusy(true); setErr(null);
        try {
          const patch = v === '__off' ? { enabled: false } : { enabled: true, mode: v };
          await postJson('token2biq/session', { sessionId: sid, ...patch });
          if (sid !== currentSid.current) return;
          mutation.current = false;
          await refresh();
          setOpen(false);
          btnRef.current && btnRef.current.focus();
        } catch (e) { if (sid === currentSid.current) setErr('同步失败，未确认新设置：' + (e.message || e)); }
        finally { if (sid === currentSid.current) { mutation.current = false; setBusy(false); } }
      };
      const enableTeam = async () => {
        if (mutation.current || !activeHost || !activeHost.canEnable) return;
        mutation.current = true; setBusy(true); setErr(null);
        try {
          await postJson('token2biq/host/team', { sessionId: sid, enabled: true });
          const team = await refreshHost();
          if (team.enabled !== true) throw new Error('官方团队尚未确认启用，请在官方设置检查');
        } catch (e) {
          if (sid === currentSid.current) { setErr('官方团队启用未确认保存：' + (e.message || e)); await refreshHost().catch(() => {}); }
        }
        finally { if (sid === currentSid.current) { mutation.current = false; setBusy(false); } }
      };
      const cur = MODE_OPTS.find((o) => o.v === value) || MODE_OPTS[1];
      const menu = open ? h('div', { 'data-t2biq-menu': '1', role: 'group', 'aria-label': '本会话 IQ 设置', style: { ...S.iqMenu, width: 272, maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box', ...pos } },
        ...MODE_OPTS.map((o) => h('button', {
          key: o.v, type: 'button', disabled: busy || !active, 'aria-pressed': o.v === value && !!active,
          style: { ...S.iqItem, width: '100%', border: 0, background: 'transparent', textAlign: 'left', ...(o.v === value ? S.iqItemOn : null) },
          onClick: () => choose(o.v),
        }, h('span', null, o.text), o.v === value && active ? h('span', { 'aria-hidden': true, style: S.iqCheck }, '✓') : null)),
        h('div', { style: { borderTop: '1px solid ' + C.border, padding: 10, fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere' } },
          h('div', { role: 'status' }, !activeHost ? '正在读取官方团队状态…' : activeHost.enabled === true ? '官方 Agent Teams：已启用' : activeHost.enabled === false ? '官方 Agent Teams：未启用' : '官方 Agent Teams：状态不可用'),
          activeHost && activeHost.canEnable && !activeHost.enabled ? h('button', { type: 'button', style: S.btn, disabled: busy, onClick: enableTeam }, '启用官方 Agent Teams') : null,
          activeHost && activeHost.reason ? h('div', { style: S.sub }, activeHost.reason) : null,
          h('div', { style: S.sub }, '官方团队与 IQ 档位分别设置。模型授权请到官方设置修改；更改后新建会话。')),
        h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => { refresh(); refreshHost().catch(() => {}); } }, '重新同步')) : null;
      return h('div', { className: 't2biq-surface', style: { ...S.iqWrap, flexWrap: 'wrap', maxWidth: '100%' } },
        h('style', null, '.t2biq-surface button:focus-visible,[data-t2biq-menu] button:focus-visible{outline:2px solid #4f6ef7;outline-offset:2px}[data-t2biq-menu] button:hover:not(:disabled){background:rgba(127,127,127,.15)!important}'),
        h('button', {
          ref: btnRef, type: 'button', style: S.iqBtn, onClick: openMenu,
          title: 'Token 2b IQ · 本会话开关/档位', 'aria-expanded': open, 'aria-label': 'IQ：' + (!active ? '状态未确认' : cur.text),
        }, h('span', { style: S.iqTag }, 'IQ'), h('span', { style: enabled ? S.iqVal : S.iqValOff }, !active ? (busy ? '同步中…' : '状态未确认') : cur.text), h(Chevron, { open })),
        err ? h('span', { role: 'alert', style: { ...S.msgErr, maxWidth: 320, overflowWrap: 'anywhere' } }, err) : null,
        (menu && ReactDOM && typeof ReactDOM.createPortal === 'function') ? ReactDOM.createPortal(menu, document.body) : menu);
    }

    return {
      inject: ['slots'],
      __components: { RunItem, RunList, StatsBar, Header, SettingsForm, SettingsView, DockControl, PanelApp },
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
