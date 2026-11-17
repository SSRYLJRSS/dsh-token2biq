// Production V3：纯函数式 SettingsView 的结构/文案/选择器行为 smoke。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let captured;
const React = { createElement: (type, props, ...children) => { const p = props || {}; if (!('children' in p)) p.children = children.flat(Infinity); return { type, props: p, children: children.flat(Infinity) }; } };
const window = { __ModuleLoader__: { load: (v) => { captured = v; } }, innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
vm.runInNewContext(src, { window, document: { baseURI: 'http://localhost/', addEventListener() {}, removeEventListener() {} }, URL, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, localStorage: { getItem: () => null, setItem() {} } });
const mod = captured.factory((id) => { if (id === 'react') return React; throw new Error(id); });
const draft = { rolePools: { research: [], plan: [], generate: [], review: ['a::One', 'b::Two'], judge: [], verify: [], redteam: [], regression: [] }, defaultMode: 'Auto', forceTeam: 'auto', parallelReviews: 3, pipelineGate: 'off', independentReview: false };
const models = [{ ref: 'a::One', id: 'a::One', name: 'Model A', providerName: 'Alpha' }, { ref: 'b::Two', id: 'b::Two', name: 'Model B', providerName: 'Beta' }];
function expand(node) {
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return expand(node.type(node.props));
  return { ...node, children: (node.children || []).map(expand) };
}
function text(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node && node.children || []).map(text).join('');
}
function nodes(node, out = []) { if (node && typeof node === 'object') { out.push(node); (node.children || []).forEach((c) => nodes(c, out)); } return out; }
function render(props) { return expand(React.createElement(mod.__components.SettingsView, { draft, models, ...props })); }

test('V3 model page renders main-follow copy and eight rows', () => {
  const tree = render({ page: 'model' });
  const t = text(tree);
  assert.ok(t.includes('主模型'));
  assert.ok(t.includes('跟随主对话'));
  for (const role of ['研究', '计划', '生成', '评审', '裁决', '验证', '红队', '回归']) assert.ok(t.includes(role), role);
  assert.ok(t.includes('Model A、Model B'));
});

test('V3 advanced page renders all controls and strict details', () => {
  const tree = render({ page: 'advanced', draft: { ...draft, pipelineGate: 'strict', independentReview: true } });
  const t = text(tree);
  for (const token of ['新会话默认档位', '强制用团队', 'S4 并行审模型数', '严格流程', '独立评委', '进入实现前必须有', 'testsRun', 'selectedCandidate', '必须由执行者之外的代理完成']) assert.ok(t.includes(token), token);
});

test('V3 picker renders follow / selected order and limit text', () => {
  const tree = render({ page: 'model', picker: { roleKey: 'review', anchor: null }, pickerQuery: '' });
  const t = text(tree);
  assert.ok(t.includes('为评审选择模型'));
  assert.ok(t.includes('跟随主对话'));
  assert.ok(t.includes('已选 2 / 5'));
  assert.ok(t.includes('第 1 个为主模型'));
  assert.ok(t.includes('清空已选'));
});

test('V3 role edit and picker callbacks carry role/ref', () => {
  let edited = null; let picked = null;
  let tree = render({ page: 'model', onEditRole: (k) => { edited = k; } });
  const editBtn = nodes(tree).find((n) => n.props && n.props['data-action'] === 'edit-role' && n.props['data-role'] === 'review');
  assert.ok(editBtn, '缺少评审编辑按钮');
  editBtn.props.onClick({});
  assert.equal(edited, 'review');
  tree = render({ page: 'model', picker: { roleKey: 'review', anchor: null }, onPick: (k, ref) => { picked = [k, ref]; } });
  const box = nodes(tree).find((n) => n.type === 'input' && n.props && n.props.type === 'checkbox' && n.props.name === 't2biq-v3-picker-review');
  assert.ok(box, '缺少评审模型 checkbox');
  box.props.onChange();
  assert.deepEqual(picked, ['review', 'a::One']);
});

test('V3 advanced select emits clamped update patch', () => {
  let patch = null;
  const tree = render({ page: 'advanced', onUpdate: (p) => { patch = p; } });
  const select = nodes(tree).find((n) => n.type === 'select' && n.props && n.props.id === 't2biq-v3-parallel-reviews');
  assert.ok(select, '缺少并行审模型数 select');
  select.props.onChange({ target: { value: '5' } });
  assert.equal(patch.parallelReviews, 5);
});

test('V3 narrow flag is exposed on root', () => {
  const tree = render({ page: 'model', narrow: true });
  assert.equal(tree.props['data-narrow'], '1');
});
