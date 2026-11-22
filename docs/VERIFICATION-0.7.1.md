# 0.7.1 实测记录（2026-11-22）

本文件只记录 0.7.1 维护版实际跑过的命令与结果；方法论见 [VERIFICATION.md](VERIFICATION.md)。

## 环境

- DSH 0.2.2-rc.5
- dsh-token2biq 0.7.1（由 0.7.0 维护修复，无新增功能）

## 全量验证

- `node --test test/maintenance-round2.test.js` → 12 pass / 0 fail
- `npm test` → 390 tests / 389 pass / 1 skip / 0 fail
- `npm run check` → 13 files pass
- `npm run pack:check` → 21 files pass
- `npm run test:smoke` → 5/5 scripts pass

## 安装副本

- 安装副本 lib 6 个改动文件 `node --check` 全部通过；`index.js` 可导入 `apply/readJson/compactToolResult`
- 源码与安装副本 sha256 一致

## 发布产物

- tag `v0.7.1`
- Release 资产：`dsh-token2biq-0.7.1.tgz`（固定版本）与 `dsh-token2biq.tgz`（latest）

## dsh-market

条目 `data/plugins/SSRYLJRSS__dsh-token2biq.yml` 已在 awesome-dsh-plugin 主分支，分类 workflow；本版更新 Release tarball。
