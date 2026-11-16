import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectModelRefs, findEntryBlock, applyProvision, runAutoProvision,
  AGENT_TEAM_ID, MODEL_SELECTION_ID,
} from '../lib/autoprovision.js';

function tmpHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't2bq-provision-'));
  const dir = path.join(root, 'profiles', 'desktop');
  fs.mkdirSync(dir, { recursive: true });
  return { root, patch: path.join(dir, 'cordis.patch.yml'), settings: path.join(root, 'settings.yaml') };
}

const SETTINGS_YAML = [
  'llm-pi-ai:',
  '  providers:',
  '    magpie:',
  '      displayName: Magpie',
  '      models:',
  '        - id: workbuddy/hy4std',
  '          name: Hy4',
  '        - id: workbuddy/glm-5.3-flash',
  '          name: GLM',
  '    wps-lingxi:',
  '      displayName: WPS',
  '      models:',
  '        - id: kimi-k3.1-pro',
  '          name: Kimi',
  '  other: 1',
  '',
].join('\n');

test('collectModelRefs 解析 providers.*.models[].id，忽略注释与其它块', () => {
  assert.deepEqual(collectModelRefs(SETTINGS_YAML), [
    { provider: 'magpie', model: 'workbuddy/glm-5.3-flash' },
    { provider: 'magpie', model: 'workbuddy/hy4std' },
    { provider: 'wps-lingxi', model: 'kimi-k3.1-pro' },
  ]);
  assert.deepEqual(collectModelRefs('', null), []);
});

test('findEntryBlock 只认顶层条目，且能取到下一顶层条目之前的整块', () => {
  const text = '- id: a\n  config:\n    x: 1\n    - nested: k\n- id: b\n  config: {}\n';
  const b = findEntryBlock(text, 'a');
  assert.ok(b);
  assert.equal(b.start, 0);
  assert.match(b.text, /x: 1/);
  assert.match(b.text, /nested: k/);
  assert.equal(findEntryBlock(text, 'missing'), null);
});

test('applyProvision 首次写入两条目、生成备份、原前缀不变', () => {
  const { root, patch, settings } = tmpHome();
  fs.writeFileSync(settings, SETTINGS_YAML, 'utf8');
  const original = '# 用户自己的补丁\n- id: ui-theme\n  config:\n    preference: dark\n';
  fs.writeFileSync(patch, original, 'utf8');

  const r = applyProvision({ home: root, profile: 'desktop' });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.deepEqual(r.added.sort(), [AGENT_TEAM_ID, MODEL_SELECTION_ID].sort());
  assert.equal(r.models.length, 3);
  assert.ok(r.backup && fs.existsSync(r.backup));
  assert.equal(fs.readFileSync(r.backup, 'utf8'), original);
  const after = fs.readFileSync(patch, 'utf8');
  assert.ok(after.startsWith(original), '原内容前缀必须保持不变');
  assert.ok(findEntryBlock(after, AGENT_TEAM_ID));
  assert.ok(findEntryBlock(after, MODEL_SELECTION_ID));
  assert.match(after, /defaultEnabled: true/);
  assert.match(after, /provider: magpie/);
});

test('applyProvision 幂等：二次运行 changed=false 且字节不变', () => {
  const { root, patch, settings } = tmpHome();
  fs.writeFileSync(settings, SETTINGS_YAML, 'utf8');
  fs.writeFileSync(patch, '', 'utf8');
  const r1 = applyProvision({ home: root, profile: 'desktop' });
  assert.equal(r1.changed, true);
  const once = fs.readFileSync(patch, 'utf8');
  const r2 = applyProvision({ home: root, profile: 'desktop' });
  assert.equal(r2.ok, true);
  assert.equal(r2.changed, false);
  assert.ok(r2.unchanged.includes(AGENT_TEAM_ID));
  assert.ok(r2.unchanged.includes(MODEL_SELECTION_ID));
  assert.equal(fs.readFileSync(patch, 'utf8'), once);
});

test('无模型时只写 agent-team 并给出 warning，绝不写空 allowedModels', () => {
  const { root, patch, settings } = tmpHome();
  fs.writeFileSync(settings, 'llm-pi-ai:\n  providers: {}\n', 'utf8');
  fs.writeFileSync(patch, '', 'utf8');
  const r = applyProvision({ home: root, profile: 'desktop' });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.deepEqual(r.added, [AGENT_TEAM_ID]);
  assert.ok(r.warning);
  const after = fs.readFileSync(patch, 'utf8');
  assert.equal(findEntryBlock(after, MODEL_SELECTION_ID), null);
});

test('已有同 id 自定义条目：跳过不覆盖', () => {
  const { root, patch, settings } = tmpHome();
  fs.writeFileSync(settings, SETTINGS_YAML, 'utf8');
  const original = [
    '- id: agent-team',
    '  config:',
    '    maxTasks: 64',
    '',
  ].join('\n');
  fs.writeFileSync(patch, original, 'utf8');
  const r = applyProvision({ home: root, profile: 'desktop' });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.added.includes(AGENT_TEAM_ID), false);
  assert.ok(r.skipped.some((s) => s.id === AGENT_TEAM_ID));
  const after = fs.readFileSync(patch, 'utf8');
  assert.ok(after.startsWith(original));
  assert.match(after, /maxTasks: 64/);
});

test('profile 目录不存在：安全返回 ok=false 且不创建目录', () => {
  const missing = path.join(os.tmpdir(), 't2bq-missing-' + Date.now());
  const r = applyProvision({ home: missing, profile: 'desktop' });
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(fs.existsSync(path.join(missing, 'profiles')), false);
});

test('写入失败：回滚到备份，原文件字节不变', () => {
  const { root, patch, settings } = tmpHome();
  fs.writeFileSync(settings, SETTINGS_YAML, 'utf8');
  const original = '- id: keep\n  config:\n    a: 1\n';
  fs.writeFileSync(patch, original, 'utf8');
  const realRename = fs.renameSync;
  let called = false;
  try {
    fs.renameSync = () => { called = true; throw new Error('simulated rename failure'); };
    const r = applyProvision({ home: root, profile: 'desktop' });
    assert.equal(r.ok, false);
    assert.equal(r.restored, true);
    assert.equal(called, true);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.readFileSync(patch, 'utf8'), original);
});

test('runAutoProvision 在 autoProvision=false 时完全不动宿主', () => {
  const { root, patch } = tmpHome();
  const r = runAutoProvision({ autoProvision: false, home: root, profile: 'desktop' });
  assert.equal(r.disabled, true);
  assert.equal(fs.existsSync(patch), false);
});
