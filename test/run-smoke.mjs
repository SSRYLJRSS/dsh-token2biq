#!/usr/bin/env node
// `npm run test:smoke` 入口：逐个跑 test/smoke-*.mjs 与 test/render-smoke.mjs。
// 这些是 *.mjs，不在 node:test 自动发现范围；每个脚本独立进程 + 独立临时 DSH_HOME。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const preload = path.join(here, '_isolation-preload.cjs');

const files = fs
  .readdirSync(here)
  .filter((f) => (f.startsWith('smoke-') && f.endsWith('.mjs')) || f === 'render-smoke.mjs')
  .sort();

if (files.length === 0) {
  console.error('[smoke] 未找到 smoke-*.mjs / render-smoke.mjs');
  process.exit(1);
}

const failed = [];
for (const file of files) {
  process.stdout.write('\n[smoke] > ' + file + '\n');
  const res = spawnSync(process.execPath, ['--require', preload, path.join('test', file)], {
    cwd: root,
    stdio: 'inherit',
  });
  if (res.error || res.status !== 0) {
    failed.push({ file, status: res.status, reason: res.error ? res.error.message : 'exit ' + res.status });
  }
}

if (failed.length) {
  console.error('\n[smoke] ' + failed.length + '/' + files.length + ' 个脚本失败：');
  for (const f of failed) console.error('  x ' + f.file + ' — ' + f.reason);
  process.exit(1);
}
console.log('\n[smoke] ' + files.length + '/' + files.length + ' 个脚本通过');
