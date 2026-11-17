import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectModelRefs, findEntryBlock, applyProvision, runAutoProvision,
  resolveProfileDetailed, AGENT_TEAM_ID, MODEL_SELECTION_ID,
} from '../lib/autoprovision.js';
import { normalizeProvisionProfile } from '../lib/settings.js';

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

// ---- P0-1：活动 profile 解析（跨机器/首次使用不再默认 desktop） ----

function makeHomeWith(profiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't2bq-prof-'));
  for (const p of profiles) fs.mkdirSync(path.join(root, 'profiles', p), { recursive: true });
  return root;
}
function withEnv(v, fn) {
  const old = process.env.DSH_PROFILE;
  if (v == null) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = v;
  try { return fn(); } finally {
    if (old == null) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = old;
  }
}

test('P0-1：tmp DSH_HOME 只有 web → 枚举唯一命中 web（不再默认 desktop）', () => {
  const root = makeHomeWith(['web']);
  withEnv(null, () => {
    const rr = resolveProfileDetailed({ home: root });
    assert.equal(rr.ok, true);
    assert.equal(rr.profile, 'web');
    assert.equal(rr.source, 'enumerated');
  });
});

test('P0-1：desktop+web 歧义 → ok:false + 候选，且 applyProvision 不写任何文件', () => {
  const root = makeHomeWith(['desktop', 'web']);
  withEnv(null, () => {
    const rr = resolveProfileDetailed({ home: root });
    assert.equal(rr.ok, false);
    assert.equal(rr.source, 'ambiguous');
    assert.deepEqual(rr.candidates, ['desktop', 'web']);
    const ap = applyProvision({ home: root });
    assert.equal(ap.ok, false);
    assert.deepEqual(ap.candidates, ['desktop', 'web']);
    assert.equal(fs.existsSync(path.join(root, 'profiles', 'desktop', 'cordis.patch.yml')), false);
    assert.equal(fs.existsSync(path.join(root, 'profiles', 'web', 'cordis.patch.yml')), false);
  });
});

test('P0-1：优先级 显式 > provisionProfile > DSH_PROFILE > 枚举；非法名被忽略', () => {
  const root = makeHomeWith(['desktop', 'web', 'work']);
  withEnv('web', () => {
    assert.equal(resolveProfileDetailed({ home: root, profile: 'work', provisionProfile: 'desktop' }).profile, 'work');
    assert.equal(resolveProfileDetailed({ home: root, provisionProfile: 'desktop' }).profile, 'desktop');
    assert.equal(resolveProfileDetailed({ home: root }).profile, 'web');
    assert.equal(resolveProfileDetailed({ home: root, profile: '../evil' }).profile, 'web', '非法 profile 名必须被忽略');
  });
});

test('P0-1：provisionProfile 设置写入指定 profile；normalize 校验非法名', () => {
  const root = makeHomeWith(['web']);
  fs.writeFileSync(path.join(root, 'settings.yaml'), SETTINGS_YAML, 'utf8');
  withEnv(null, () => {
    const rr = applyProvision({ home: root, provisionProfile: 'web' });
    assert.equal(rr.ok, true);
    assert.equal(rr.profileTargeted, 'web');
    assert.ok(fs.existsSync(path.join(root, 'profiles', 'web', 'cordis.patch.yml')));
  });
  assert.equal(normalizeProvisionProfile('work'), 'work');
  assert.equal(normalizeProvisionProfile(' ../evil '), null);
  assert.equal(normalizeProvisionProfile('a/b'), null);
  assert.equal(normalizeProvisionProfile('..'), null);
  assert.equal(normalizeProvisionProfile(123), null);
});

// ---- P2-2：已有本插件条目增量追加缺失模型 ----

test('P2-2：本插件写入的 enabled 条目按最新 models 增量追加缺失模型（保留已有内容）', () => {
  const { root, patch, settings } = tmpHome();
  fs.writeFileSync(settings, SETTINGS_YAML, 'utf8');
  fs.writeFileSync(patch, '', 'utf8');
  assert.equal(applyProvision({ home: root, profile: 'desktop' }).changed, true);
  // 用户/宿主新增一个模型后重跑：应增量追加，不重写整块。
  const yaml2 = [
    'llm-pi-ai:', '  providers:', '    magpie:', '      displayName: Magpie', '      models:',
    '        - id: workbuddy/hy4std', '          name: Hy4',
    '        - id: workbuddy/glm-5.3-flash', '          name: GLM',
    '        - id: workbuddy/new-model', '          name: New',
  ].join('\n') + '\n';
  fs.writeFileSync(settings, yaml2, 'utf8');
  const r2 = applyProvision({ home: root, profile: 'desktop' });
  assert.equal(r2.ok, true);
  assert.equal(r2.changed, true);
  assert.deepEqual(r2.merged, [MODEL_SELECTION_ID]);
  const after = fs.readFileSync(patch, 'utf8');
  assert.ok(after.includes('workbuddy/new-model'), '缺失模型应被追加');
  assert.ok(after.includes('workbuddy/hy4std'), '已有模型必须保留');
  assert.ok(after.includes('workbuddy/glm-5.3-flash'), '已有模型必须保留');
  assert.match(after, /defaultEnabled: true/);
});

test('P2-2：enabled!=true 或非本插件条目 → 不改其 allowedModels（skipped）', () => {
  const { root, patch, settings } = tmpHome();
  fs.writeFileSync(settings, SETTINGS_YAML, 'utf8');
  const userBlock = [
    '- id: subagent-model-selection-settings',
    '  config:',
    '    enabled: false',
    '    allowedModels:',
    '      - provider: magpie',
    '        model: workbuddy/hy4std',
    '',
  ].join('\n');
  fs.writeFileSync(patch, userBlock, 'utf8');
  const rr = applyProvision({ home: root, profile: 'desktop' });
  assert.equal(rr.ok, true);
  assert.ok(rr.skipped.some((s) => s.id === MODEL_SELECTION_ID));
  assert.equal((rr.merged || []).includes(MODEL_SELECTION_ID), false);
  const after = fs.readFileSync(patch, 'utf8');
  assert.match(after, /enabled: false/, '用户 enabled:false 必须保留');
  assert.ok(!after.includes('workbuddy/glm-5.3-flash'), '不应把模型塞进用户/非本插件条目');
});

test('P0-1：profiles 枚举排除备份/临时目录，desktop.bak 不再造成假 ambiguous', () => {
  const root = makeHomeWith(['desktop', 'desktop.bak', 'desktop-tmp', '~tmp']);
  withEnv(null, () => {
    const rr = resolveProfileDetailed({ home: root });
    assert.equal(rr.ok, true, '备份目录不应被当成候选');
    assert.equal(rr.profile, 'desktop');
    assert.equal(rr.source, 'enumerated');
    assert.deepEqual(rr.candidates, ['desktop']);
  });
});
