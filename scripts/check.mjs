#!/usr/bin/env node
// 逐文件 `node --check`：单命令传多个文件只报首项错误，必须逐进程检查。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const all = process.argv.includes('--all');
const roots = all ? ['lib', 'test', 'scripts'] : ['lib'];
const exts = new Set(['.js', '.mjs', '.cjs']);

function walk(dir) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.isFile() && exts.has(path.extname(ent.name))) out.push(p);
  }
  return out;
}

const files = roots.flatMap((d) => walk(path.join(root, d))).sort();
if (files.length === 0) {
  console.error('[check] 未找到可检查的文件');
  process.exit(1);
}

const failed = [];
for (const abs of files) {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  const res = spawnSync(process.execPath, ['--check', rel], { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) failed.push({ rel, msg: (res.stderr || res.stdout || '').trim() });
}

if (failed.length) {
  for (const f of failed) console.error('[check] x ' + f.rel + '\n' + f.msg.split('\n').slice(0, 6).join('\n'));
  console.error('[check] ' + failed.length + '/' + files.length + ' 个文件语法错误');
  process.exit(1);
}
console.log('[check] ' + files.length + ' 个文件通过（逐文件 node --check）');
