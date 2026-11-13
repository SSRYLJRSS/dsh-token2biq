// 离线渲染冒烟：用极简 React 桩真实调用 client.js 里导出的展示组件（RunItem / RunList / Header），
// 验证「运行记录」列表在真实数据结构下能渲染出：档位、该档位额外做了什么、结论、token、时间、流程，且不抛错。
// 运行：node test/render-smoke.mjs
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok - ' + m); } else { fail++; console.log('  NOT OK - ' + m); } };

// ---- 极简 React 桩：createElement 返回树；渲染时递归调用函数组件 ----
function createElement(type, props, ...children) {
  const kids = children.length ? children : (props && props.children != null ? [].concat(props.children) : []);
  return { type, props: Object.assign({}, props || {}, { children: kids }) };
}
const stubReact = {
  createElement,
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect() {},
  useCallback: (f) => f,
  useRef: (v) => ({ current: v }),
};
const fakeRequire = (id) => { if (id === 'react') return stubReact; throw new Error('unexpected require ' + id); };

function flatten(node, out) {
  if (node == null || node === false || node === true) return;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return; }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') { flatten(node.type(node.props || {}), out); return; }
    const ch = node.props && node.props.children;
    if (ch !== undefined) flatten(ch, out);
  }
}
function textOf(node) { const o = []; flatten(node, o); return o.join(' '); }

// ---- 装载 client.js 拿到导出组件 ----
let captured = null;
const fakeWindow = { __ModuleLoader__: { load(o) { captured = o; } } };
const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
new Function('window', 'require', src)(fakeWindow, fakeRequire);
const mod = captured.factory(fakeRequire);
ok(mod && mod.__components, 'client 导出了 __components（供渲染冒烟）');
const { RunItem, RunList, Header } = mod.__components;
ok(typeof RunItem === 'function' && typeof RunList === 'function' && typeof Header === 'function', '导出 RunItem / RunList / Header');

// ---- 造一条真实形态的 S3 运行（内存 store） ----
const { Token2bIQService } = await import(pathToFileURL(join(root, 'lib', 'service.js')).href);
const svc = new Token2bIQService({ settingsFile: join(os.tmpdir(), 't2biq-render-' + process.pid + '.json') });
svc.updateSettings({ forceTeam: 'off' });
const { run } = svc.start({ goal: '对「茶馆AI素材管理」项目执行只读全面维护审计', mode: 'S3' });
const rec = (stage, extra) => svc.record(Object.assign({ runId: run.id, stage }, extra));
rec('research', { role: 'researcher', files: ['r.md'], diffSummary: '调研完成', tokensIn: 123, tokensOut: 82 });
rec('plan', { role: 'planner', files: ['p.md'], diffSummary: '计划完成', tokensIn: 87, tokensOut: 58 });
rec('generate', { role: 'worker', files: ['g.md'], diffSummary: '产出完成', tokensIn: 95, tokensOut: 63 });
rec('review', { role: 'reviewer', verdict: 'PASS', evidence: ['ok'], tokensIn: 56, tokensOut: 36 });
rec('judge', { role: 'judge', verdict: 'PASS', files: ['j.md'], diffSummary: '裁决完成', tokensIn: 100, tokensOut: 66 });
rec('redteam', { role: 'red-team', verdict: 'PASS', files: ['rd.md'], diffSummary: '红队完成', tokensIn: 74, tokensOut: 49 });
rec('regression', { role: 'verifier', verdict: 'PASS', evidence: ['1366 passed'], tokensIn: 39, tokensOut: 26 });
svc.finish({ runId: run.id, verdict: 'PASS', rationale: '五份报告落盘，11 项门禁 exit 0，cargo test 1366 passed', byJudge: 'judge' });
const st = svc.state(run.id);
const summary = st.runs[0];
const current = st.current;

// ---- 断言 ----
let t;
t = textOf(RunItem({ run: summary, current, onSelect() {}, onDelete() {}, busy: false }));
ok(t.includes('完整'), 'RunItem 显示档位（S3→完整）');
ok(t.includes('PASS'), 'RunItem 显示结论 PASS');
ok(/954/.test(t), 'RunItem 显示本次 token 954');
ok(t.includes('这个档位额外做了'), 'RunItem 说明「这个档位额外做了」');
ok(t.includes('研究') && t.includes('红队') && t.includes('回归'), 'RunItem 概述含该档位做的事');
ok(t.includes('茶馆'), 'RunItem 显示目标任务');
ok(t.includes('→'), '选中项展开流程箭头');
ok(!t.includes('删除'), '列表不显示删除入口（避免旧宿主不支持的按钮）');

t = textOf(RunItem({ run: summary, current: null, onSelect() {}, onDelete() {}, busy: false }));
ok(t.includes('完整') && /954/.test(t), '未选中项仍显示档位与 token');
ok(!t.includes('→'), '未选中项不展开流程');

const demo = Object.assign({}, summary, { id: 'run_demo', goal: '演示运行：连通性验证（可删除）', mode: 'S2', status: 'done', verdict: 'PASS', spent: 1650 });
t = textOf(RunList({ runs: [summary, demo], current, onSelect() {}, onDelete() {}, busy: false }));
ok(t.includes('运行记录'), 'RunList 渲染标题「运行记录」');
ok(t.includes('茶馆') && t.includes('[示例]'), 'RunList 列出运行并标注示例');
ok(t.includes('标准'), 'RunList 按档位显示（S2→标准）');
ok(!t.includes('102.7M'), 'RunList 不出现误导性的全进程 102.7M');

t = textOf(RunList({ runs: [], current: null, onSelect() {}, onDelete() {}, busy: false }));
ok(t.includes('还没有运行'), 'RunList 空态提示');

t = textOf(Header({ count: 2, busy: false, err: null, onClose() {}, onRefresh() {} }));
ok(t.includes('TOKEN 2B IQ') && t.includes('编排运行记录'), 'Header 显示品牌与标题');
ok(t.includes('刷新') && t.includes('2 条'), 'Header 显示刷新与条数');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
