// 隔离回归：证明测试不会写真实 ~/.dsh，且每个测试进程拿到独立临时 DSH_HOME。
// 这些断言在 preload 缺失时会**立刻失败**——它守的就是「state.json 写失败 / 真实快照被污染」这类事故。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStateFile, resolveSettingsFile } from '../lib/paths.js';
import { SettingsStore } from '../lib/settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(here, '_isolation-preload.cjs');
const realHome = path.join(os.homedir(), '.dsh');

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

test('preload 必须注入每进程独立 DSH_HOME（否则测试会写真实 ~/.dsh）', () => {
  if (process.env.T2BIQ_TEST_ISOLATION !== '1' || !process.env.DSH_HOME) {
    assert.fail(
      'DSH_HOME 未注入：请用 `npm test`（test/run.mjs 会 --require test/_isolation-preload.cjs）。'
      + ' 直接 `node --test` 会写真实 ~/.dsh/token2biq/{state,settings}.json。',
    );
  }
  const home = path.resolve(process.env.DSH_HOME);
  assert.ok(fs.existsSync(home), 'DSH_HOME 目录应已创建：' + home);
  assert.ok(inside(home, os.tmpdir()), 'DSH_HOME 必须位于系统临时目录：' + home);
  assert.notEqual(home, path.resolve(realHome), 'DSH_HOME 不得落到真实 ~/.dsh');
  // 不得顺手改 HOME / USERPROFILE 去实现隔离
  for (const key of ['HOME', 'USERPROFILE']) {
    const v = process.env[key];
    if (v) assert.ok(!inside(path.resolve(v), home), key + ' 被改到隔离目录内：' + v);
  }
});

test('默认路径解析必须落在临时 DSH_HOME，而不是真实 ~/.dsh', () => {
  const state = path.resolve(resolveStateFile());
  const settings = path.resolve(resolveSettingsFile());
  assert.ok(inside(state, process.env.DSH_HOME), 'resolveStateFile() 逃逸到隔离目录外：' + state);
  assert.ok(inside(settings, process.env.DSH_HOME), 'resolveSettingsFile() 逃逸到隔离目录外：' + settings);
  assert.ok(!inside(state, realHome), 'resolveStateFile() 指向真实 ~/.dsh：' + state);
  assert.ok(!inside(settings, realHome), 'resolveSettingsFile() 指向真实 ~/.dsh：' + settings);
});

// 未注入 preload 时跳过本用例：否则「验证隔离失败」的那次运行本身就会写真实 ~/.dsh。
test('默认构造的 SettingsStore 只写临时目录，真实 ~/.dsh 快照字节不变', { skip: process.env.T2BIQ_TEST_ISOLATION === '1' ? false : '需要 preload 注入隔离 DSH_HOME' }, () => {
  const realSettings = path.join(realHome, 'token2biq', 'settings.json');
  const before = readIfExists(realSettings);

  const store = new SettingsStore(); // 不传 file → 走默认解析（若隔离失效就落真实目录）
  store.update({ rolePools: { review: ['a::b'] } });

  assert.ok(inside(store.file, process.env.DSH_HOME), 'SettingsStore 落到了隔离目录外：' + store.file);
  assert.ok(fs.existsSync(store.file), '应写入隔离目录：' + store.file);
  assert.equal(readIfExists(realSettings), before, '真实 ~/.dsh/token2biq/settings.json 被测试改写');
});

test('并发进程各自独立 DSH_HOME，退出后清理临时目录', () => {
  const script = 'process.stdout.write(process.env.DSH_HOME || "")';
  const run = () => spawnSync(process.execPath, ['--require', PRELOAD, '-e', script], {
    cwd: here,
    encoding: 'utf8',
  }).stdout.trim();

  const a = run();
  const b = run();
  assert.ok(a && b, '子进程应输出 DSH_HOME');
  assert.notEqual(a, b, '两个测试进程共享了同一个临时 DSH_HOME：' + a);
  assert.ok(!fs.existsSync(a), '子进程退出后应清理临时 DSH_HOME：' + a);
  assert.ok(!fs.existsSync(b), '子进程退出后应清理临时 DSH_HOME：' + b);
});
