// Token 2b IQ 插件状态文件路径解析（宿主侧）。
import path from 'node:path';
import os from 'node:os';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function resolveStateFile(explicit) {
  if (explicit) return explicit;
  return path.join(dshHome(), 'token2biq', 'state.json');
}

export function resolveSettingsFile(explicit) {
  if (explicit) return explicit;
  return path.join(dshHome(), 'token2biq', 'settings.json');
}
