// 0.6.2：版本/兼容声明与发布 payload 回归。
// 市场与宿主读取顶层 engines.dsh；缺失时会被判定为“无版本声明 / 兼容未知”。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('package.json 版本与 DSH 兼容声明齐全', () => {
  assert.equal(pkg.name, 'dsh-token2biq');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.engines?.dsh, '>=0.2.2-rc.3 <0.3.0-0');
  assert.equal(pkg.dsh?.compatibility?.dsh, pkg.engines.dsh);
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(fs.existsSync(path.join(root, 'cordis.patch.yml')));
});

test('发布 payload 只含运行所需文件，且主入口存在', () => {
  for (const entry of ['lib/', 'cordis.patch.yml', 'locale/', 'icon.svg', 'README.md', 'README.en.md']) {
    assert.ok(pkg.files.includes(entry), 'files 缺少 ' + entry);
  }
  assert.ok(fs.existsSync(path.join(root, pkg.main)));
  assert.equal(pkg.dependencies, undefined, '保持零运行时依赖');
});
