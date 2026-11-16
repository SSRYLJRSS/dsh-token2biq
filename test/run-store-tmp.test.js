// 快照落盘的残留清理回归：flush 的 tmp 变量必须活到 finally，启动必须扫掉历史残留。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore } from '../lib/run-store.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 't2b-store-')); }

test('启动时清掉历史残留 .tmp（早先 try 内 const 遮蔽导致清理是死代码）', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ runs: {}, version: 1 }), 'utf8');
  for (const n of ['1.1', '2.2', '3.3']) fs.writeFileSync(file + '.' + n + '.tmp', '{}', 'utf8');
  const store = new RunStore({ file });
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, '启动必须清掉历史 .tmp，否则无限堆积');
  assert.ok(store.state && store.state.runs, '快照本身仍要能正常加载');
});

test('flush 成功后不留 .tmp', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.json');
  const store = new RunStore({ file });
  assert.equal(store.flush(), true);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0);
  assert.ok(fs.existsSync(file), '快照必须真的落盘');
});
