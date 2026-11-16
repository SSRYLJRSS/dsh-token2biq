import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

function harness(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 't2biq-integration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const events = [], sections = [], subscriptions = {};
  const agent = { session: { id: 'root-session', append: (...args) => events.push(args) }, ctx: { systemPrompt: { section: s => { sections.push(s); return () => {}; } } } };
  const other = { session: { id: 'other-session', append: (...args) => events.push(args) }, ctx: agent.ctx };
  const child = { session: { id: 'child-session' }, ctx: agent.ctx };
  let enabled = false, setCalls = [], handler, tool;
  const team = { isEnabled: () => enabled, createTask: async () => ({ id: 'task-1' }), async setEnabled(a, value) { setCalls.push([a, value]); enabled = value; events.push(['team/mode', { enabled: value }]); if (options.flushError) throw new Error('flush failed'); } };
  if (options.noSetter) delete team.setEnabled;
  const services = {
    agents: { list: () => [agent, other, child] },
    subagents: { rootOf: a => a === child ? agent : a },
    agentTeams: team,
    connection: options.connection === undefined ? { requestRejection: () => undefined } : options.connection,
    sessionController: { modelCatalog: async () => ({ groups: [{ id: 'catalog', models: [{ id: 'not-authorized' }] }] }) },
    webServer: { register: value => { handler = value.handler; return () => {}; } },
    tools: { register: value => { tool = value; return () => {}; } },
  };
  const ctx = { logger: { info() {}, warn() {} }, get: n => services[n], on: (n, fn) => { (subscriptions[n] ||= []).push(fn); }, inject(names, callback) { if (names.every(n => services[n])) callback({ ...services, get: n => services[n], effect: fn => fn() }); } };
  apply(ctx, { stateFile: path.join(dir, 'state.json'), settingsFile: path.join(dir, 'settings.json') });
  async function request(url, body) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.url = '/token2biq/' + url; req.method = body === undefined ? 'GET' : 'POST'; req.headers = { 'content-type': 'application/json', origin: 'http://127.0.0.1:62746' };
    let status = 200, text = '';
    const res = { set statusCode(v) { status = v; }, writeHead(v) { status = v; }, end(v) { text = v || ''; } };
    await handler(req, res);
    return { status, data: text ? JSON.parse(text) : null };
  }
  return { request, tool, agent, other, child, events, sections, setCalls, subscriptions, team };
}

test('start and settings never grant catalog routes or append official authorization', async t => {
  const h = harness(t);
  await h.tool.execute({ action: 'settings', settings: { roleModels: { generate: 'custom::model' } } }, { agent: h.agent });
  await h.tool.execute({ action: 'start', mode: 'S1', goal: 'test' }, { agent: h.agent });
  assert.deepEqual(h.events.filter(e => e[0] === 'subagent/model-selection-policy'), []);
});

test('HTTP access check exception fails closed before returning state', async t => {
  const h = harness(t, { connection: { requestRejection() { throw new Error('unavailable'); } } });
  const out = await h.request('state');
  assert.equal(out.status, 503); assert.equal(out.data, null);
});

test('missing HTTP access authority fails closed', async t => {
  const h = harness(t, { connection: null });
  assert.equal((await h.request('state')).status, 503);
});

test('explicit host switch uses exact root official setter and reads resulting state', async t => {
  const h = harness(t);
  const before = await h.request('host?sessionId=other-session');
  assert.equal(before.data.team.enabled, false);
  assert.equal(before.data.team.canEnable, true);
  const changed = await h.request('host/team', { sessionId: 'other-session', enabled: true });
  assert.equal(changed.data.ok, true); assert.equal(changed.data.persisted, true);
  assert.deepEqual(h.setCalls, [[h.other, true]]);
  assert.equal((await h.request('host?sessionId=other-session')).data.team.enabled, true);
  assert.equal(h.events.filter(e => e[0] === 'team/mode').length, 1);
  assert.ok(h.sections.length > 0, 'a previously disabled root gains plugin policy after enabling');
});

test('unknown session and descendants cannot enable another tree', async t => {
  const h = harness(t);
  for (const sessionId of ['missing', 'child-session', '']) {
    const out = await h.request('host/team', { sessionId, enabled: true });
    assert.equal(out.data.ok, false);
  }
  assert.equal(h.setCalls.length, 0);
});

test('host without official setter reports unsupported without mutation', async t => {
  const h = harness(t, { noSetter: true });
  const out = await h.request('host/team', { sessionId: 'root-session', enabled: true });
  assert.equal(out.data.ok, false); assert.equal(out.data.team.supported, false);
  assert.equal(h.events.length, 0);
});

test('official persistence failure reports live enabled state without claiming durability', async t => {
  const h = harness(t, { flushError: true });
  const out = await h.request('host/team', { sessionId: 'root-session', enabled: true });
  assert.equal(out.data.ok, false); assert.equal(out.data.persisted, false);
  assert.equal(out.data.team.enabled, true); assert.match(out.data.error, /持久化|flush/);
});

test('prompt follows official team toggle after agent creation without replacing official sections', async t => {
  const h = harness(t);
  const policy = h.sections[0];
  assert.ok(policy, 'provider must exist before Teams is enabled');
  assert.equal(typeof policy.text, 'function');
  assert.equal(policy.text({}), '');
  await h.team.setEnabled(h.agent, true);
  assert.match(policy.text({}), /token2biq/);
  await h.request('session', { sessionId: 'root-session', enabled: false, mode: 'S4' });
  assert.doesNotMatch(policy.text({}), /MUST.*start/);
  await h.team.setEnabled(h.agent, false);
  assert.equal(policy.text({}), '');
});

test('bundle patch never overrides official subagent provider or model-selection switches', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(patch, /^- id: tool-subagent/m);
});
