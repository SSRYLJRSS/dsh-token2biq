// 设置 V3 离线渲染冒烟：真实调用 client.js 的 SettingsView（模型/高级/选择器）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok - ' + m); } else { fail++; console.log('  NOT OK - ' + m); } };

function createElement(type, props, ...children) {
  const kids = children.length ? children : (props && props.children != null ? [].concat(props.children) : []);
  return { type, props: Object.assign({}, props || {}, { children: kids }) };
}
const React = { createElement };
function textOf(node) {
  const out = [];
  const walk = (n) => {
    if (n == null || n === false || n === true) return;
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n === 'object') {
      if (typeof n.type === 'function') { walk(n.type(n.props || {})); return; }
      walk(n.props && n.props.children);
    }
  };
  walk(node);
  return out.join(' ');
}
let captured = null;
const fakeWindow = { __ModuleLoader__: { load(o) { captured = o; } }, innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
new Function('window', 'require', src)(fakeWindow, (id) => { if (id === 'react') return React; throw new Error(id); });
const mod = captured.factory((id) => { if (id === 'react') return React; throw new Error(id); });
const { SettingsView } = mod.__components;
ok(typeof SettingsView === 'function', 'client 导出 SettingsView');

const draft = {
  rolePools: { research: [], plan: [], generate: [], review: ['a::A', 'b::B'], judge: [], verify: [], redteam: [], regression: [] },
  defaultMode: 'Auto', forceTeam: 'auto', parallelReviews: 3, pipelineGate: 'off', independentReview: false,
};
const models = [{ ref: 'a::A', id: 'A', name: 'Model A', providerName: 'Alpha' }, { ref: 'b::B', id: 'B', name: 'Model B', providerName: 'Beta' }];
let t = textOf(SettingsView({ draft, models, page: 'model' }));
ok(t.includes('模型'), '模型页标题');
ok(t.includes('主模型') && t.includes('跟随主对话'), '主模型跟随主对话');
for (const role of ['研究','计划','生成','评审','裁决','验证','红队','回归']) ok(t.includes(role), '角色：' + role);
ok(t.includes('Model A') && t.includes('Model B'), '角色池显示模型名');
ok(t.includes('全部恢复跟随主对话'), '恢复全部');
ok(!t.includes('strongModel') && !t.includes('不同厂商'), '无旧文案');

t = textOf(SettingsView({ draft: Object.assign({}, draft, { pipelineGate: 'strict', independentReview: true }), models, page: 'advanced' }));
for (const x of ['新会话默认档位','强制用团队','S4 并行审模型数','严格流程','独立评委','进入实现前必须有','testsRun','selectedCandidate']) ok(t.includes(x), x);
ok(t.includes('必须由执行者之外的代理完成'), '独立评委说明');

t = textOf(SettingsView({ draft, models, page: 'model', picker: { roleKey: 'review', anchor: null }, pickerQuery: '' }));
ok(t.includes('为评审选择模型') && t.includes('已选 2 / 5') && t.includes('第 1 个为主模型'), '选择器结构与多选顺序');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
