// 快照落盘的残留清理回归：flush 的 tmp 变量必须活到 finally，启动必须扫掉历史残留。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore } from '../lib/run-store.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 't2b-store-')); }

test('启动时只清掉陈旧且无活跃所有者的临时文件', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ runs: {}, version: 1 }), 'utf8');
  for (const n of ['legacy-a', 'legacy-b', 'legacy-c']) {
    const tmp = file + '.' + n + '.tmp';
    fs.writeFileSync(tmp, '{}', 'utf8');
    fs.utimesSync(tmp, new Date(0), new Date(0));
  }
  const store = new RunStore({ file });
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, '启动必须清掉历史 .tmp，否则无限堆积');
  assert.ok(store.state && store.state.runs, '快照本身仍要能正常加载');
});

test('flush 成功后不留 .tmp', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const store = new RunStore({ file });
  assert.equal(store.flush(), true);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0);
  assert.ok(fs.existsSync(file), '快照必须真的落盘');
});
