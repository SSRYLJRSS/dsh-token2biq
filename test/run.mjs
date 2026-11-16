#!/usr/bin/env node
// `npm test` 入口：枚举 test/**/*.test.js，每个测试子进程各自 mkdtemp 独立 DSH_HOME。
// 显式传文件列表，不依赖不同 Node 版本的目录/通配符发现行为。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.isFile() && ent.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const files = walk(here).sort();
if (files.length === 0) {
  console.error('[test] 未找到任何 *.test.js');
  process.exit(1);
}

// 透传的只能是选项：位置参数会被 node --test 当成文件路径。
const extra = process.argv.slice(2);
const positional = extra.filter((a) => !a.startsWith('-'));
if (positional.length) {
  console.error('[test] 不支持位置参数：' + positional.join(' '));
  console.error('[test] 用法：npm test -- --test-name-pattern="..."');
  process.exit(2);
}

const rel = files.map((f) => path.relative(root, f));
const preload = path.join(here, '_isolation-preload.cjs');
// 选项在文件列表之前
const args = [...extra, '--test', '--require', preload, ...rel];

console.log('[test] ' + rel.length + ' 个测试文件；每个测试进程独立临时 DSH_HOME（退出清理）');
const res = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
if (res.error) {
  console.error('[test] 启动失败：' + res.error.message);
  process.exit(1);
}
process.exit(res.status == null ? 1 : res.status);
