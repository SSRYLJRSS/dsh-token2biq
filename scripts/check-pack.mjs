#!/usr/bin/env node
// 发布产物校验：payload 必须含 lib 全部模块 + 元数据，且不得泄漏 test/docs/scripts/.github/*.tgz。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// 不用 shell:true（DEP0190 参数未转义）：优先用 npm 注入的 npm_execpath 以 node 直接执行 npm-cli.js
const npmCli = process.env.npm_execpath;
const res = npmCli && npmCli.endsWith('.js')
  ? spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' })
  : spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
if (res.error || res.status !== 0) {
  console.error('[pack] npm pack --dry-run 失败：' + (res.error ? res.error.message : (res.stderr || res.stdout)));
  process.exit(1);
}
const info = JSON.parse(res.stdout.trim())[0];

const norm = (p) => String(p).split(path.sep).join('/');
const files = new Set((info.files || []).map((f) => norm(f.path)));
const libModules = fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f);
const required = [...libModules, 'package.json', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'README.md', 'README.en.md'];
const forbidden = [/^test\//, /^docs\//, /^scripts\//, /^\.github\//, /\.tgz$/, /^\.probe-routing\.mjs$/, /^package\.json\.baseline$/, /^node_modules\//];

const missing = required.filter((f) => !files.has(f));
const leaked = [...files].filter((f) => forbidden.some((re) => re.test(f)));

if (missing.length || leaked.length) {
  if (missing.length) console.error('[pack] 缺少必需文件：\n  ' + missing.join('\n  '));
  if (leaked.length) console.error('[pack] 泄漏开发文件：\n  ' + leaked.join('\n  '));
  process.exit(1);
}
console.log('[pack] ' + files.size + ' 个文件；lib 模块 ' + libModules.length + ' 个齐全，无 test/docs/scripts/tgz 泄漏');
