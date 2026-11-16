'use strict';
// 测试进程级隔离：每个子进程各自 mkdtemp 独立 DSH_HOME（唯一 → 并发安全），退出清理。
// 只改 DSH_HOME，不碰 HOME / USERPROFILE / CODEX_HOME。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FLAG = Symbol.for('dsh-token2biq.test-isolation');

if (!globalThis[FLAG]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-home-'));
  process.env.DSH_HOME = dir;
  // 哨兵：宿主环境可能已自带 DSH_HOME，不能用它判断隔离是否生效
  process.env.T2BIQ_TEST_ISOLATION = '1';
  process.once('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 尽力而为：残留目录在系统临时区，不影响仓库 */
    }
  });
  globalThis[FLAG] = { dir };
  if (process.env.T2BIQ_TEST_ISOLATION_VERBOSE === '1') {
    try { process.stderr.write('[isolation] DSH_HOME=' + dir + '\n'); } catch { /* ignore */ }
  }
}
