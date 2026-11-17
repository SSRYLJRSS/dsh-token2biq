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

test('collectModelRoutes: 汇总 rolePools/目录，解析去重、顺序稳定、丢弃非法', () => {
  const routes = collectModelRoutes({
    rolePools: { review: ['magpie::a', 'magpie::b'], generate: ['magpie::c'], judge: ['', 'nocolon'] },
    catalogGroups: [{ id: 'magpie', models: [{ id: 'a' }, { id: 'd' }] }],
  });
  assert.equal(routes.length, 4);
  assert.deepEqual(routes.map((r) => r.model), ['a', 'b', 'c', 'd']);
  assert.ok(routes.every((r) => r.provider === 'magpie'));
  const keys = routes.map((r) => r.provider + '\0' + r.model);
  assert.equal(new Set(keys).size, keys.length); // 无重复
});

test('legacy policy helper cannot mutate official authorization', () => {
  let writes = 0;
  const result = applySubagentModelPolicy({ append() { writes += 1; } }, [{ provider: 'p', model: 'm' }]);
  assert.equal(writes, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'official-policy-owned');
});
