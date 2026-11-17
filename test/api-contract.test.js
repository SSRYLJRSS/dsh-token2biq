// 契约检查器：插件与宿主之间只剩 5 个接缝方法（getTask 用于建档后回填真实 revision）。
// 官方在 0.2.2-rc.3 删除了 tryMembership / spawnTeammate / listMembers（静默降级为「只出计划」），
// 这里用「源码静态断言 + 官方源码可选比对」两道闸，防止再次漂移。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const REMOVED = ['tryMembership', 'spawnTeammate', 'listMembers', 'spawn_teammate'];
const ALLOWED = new Set(['isEnabled', 'createTask', 'getTask', 'rootOf', 'setEnabled']);

const codeLines = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

test('契约：lib/ 不得再引用 0.2.2-rc.3 已删除的 Agent Teams API', async () => {
  const files = (await fs.readdir(LIB)).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, 'lib/ 下应有 .js 文件');
  for (const f of files) {
    const code = codeLines(await fs.readFile(path.join(LIB, f), 'utf8'));
    for (const api of REMOVED) {
      assert.ok(!code.includes(api), f + ' 仍引用已删除的 ' + api + '（官方 0.2.2-rc.3 起不存在）');
    }
  }
});

test('契约：lib/ 只通过 isEnabled / createTask / getTask / rootOf 五个接缝调用宿主', async () => {
  const files = (await fs.readdir(LIB)).filter((f) => f.endsWith('.js'));
  const used = new Set();
  for (const f of files) {
    const code = codeLines(await fs.readFile(path.join(LIB, f), 'utf8'));
    for (const m of code.matchAll(/\b(?:agentTeams|subagents)\.([a-zA-Z]+)\(/g)) used.add(m[1]);
  }
  assert.ok(used.size > 0, '应至少调用一个接缝');
  for (const m of used) assert.ok(ALLOWED.has(m), '出现未声明的宿主接缝调用：' + m);
});

test('契约：官方源码可用时，五个接缝方法必须真实存在（缺失则跳过）', async (t) => {
  const base = process.env.DSH_OFFICIAL_SRC;
  if (!base) return t.skip('未设置 DSH_OFFICIAL_SRC，跳过官方源码比对');
  const team = await fs.readFile(path.join(base, 'dsh-agent-team/src/index.ts'), 'utf8');
  const sub = await fs.readFile(path.join(base, 'dsh-subagent/src/index.ts'), 'utf8');
  assert.match(team, /\bisEnabled\(/, 'agentTeam.isEnabled 丢失');
  assert.match(team, /\bcreateTask\(/, 'agentTeam.createTask 丢失');
  assert.match(team, /\bgetTask\(/, 'agentTeam.getTask 丢失');
  assert.match(sub, /\brootOf\(/, 'subagents.rootOf 丢失');
  assert.match(team, /\bsetEnabled\(/, 'agentTeams.setEnabled 丢失');
});
