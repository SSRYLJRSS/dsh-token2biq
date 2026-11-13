import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelRef, collectModelRoutes, applySubagentModelPolicy } from '../lib/model-routes.js';

test('parseModelRef: 合法解析，非法返回 null', () => {
  assert.deepEqual(parseModelRef('magpie::a'), { provider: 'magpie', model: 'a' });
  assert.deepEqual(parseModelRef('p::m'), { provider: 'p', model: 'm' });
  for (const bad of ['', 'nocolon', 'x::', '::y', null, undefined, 123]) {
    assert.equal(parseModelRef(bad), null);
  }
});

test('collectModelRoutes: 汇总 rolePools/roleModels/目录，解析去重、顺序稳定、丢弃非法', () => {
  const routes = collectModelRoutes({
    rolePools: { review: ['magpie::a', 'magpie::b'], judge: ['', 'nocolon'] },
    roleModels: { generate: 'magpie::c', plan: 'x::' },
    catalogGroups: [{ id: 'magpie', models: [{ id: 'a' }, { id: 'd' }] }],
  });
  assert.equal(routes.length, 4);
  assert.deepEqual(routes.map((r) => r.model), ['a', 'b', 'c', 'd']);
  assert.ok(routes.every((r) => r.provider === 'magpie'));
  const keys = routes.map((r) => r.provider + '\0' + r.model);
  assert.equal(new Set(keys).size, keys.length); // 无重复
});

test('applySubagentModelPolicy: 正常 append / 无 session / 空 routes / append 抛错', () => {
  let captured = null;
  const sess = { append: (t, d) => { captured = { t, d }; } };
  const routes = [{ provider: 'magpie', model: 'a' }, { provider: 'magpie', model: 'b' }];
  const ok = applySubagentModelPolicy(sess, routes);
  assert.equal(ok.ok, true);
  assert.equal(ok.count, 2);
  assert.equal(captured.t, 'subagent/model-selection-policy');
  assert.deepEqual(captured.d.allowedModels, routes);

  assert.deepEqual(applySubagentModelPolicy(null, routes), { ok: false, reason: 'no-session' });
  assert.deepEqual(applySubagentModelPolicy({}, routes), { ok: false, reason: 'no-session' });
  assert.deepEqual(applySubagentModelPolicy(sess, []), { ok: false, reason: 'no-routes' });

  const boom = { append: () => { throw new Error('nope'); } };
  const r = applySubagentModelPolicy(boom, routes);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'nope');
});
