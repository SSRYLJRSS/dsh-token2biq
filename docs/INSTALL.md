# 安装与升级指南

本文覆盖四条安装路径、常见失败原因和修复命令。目标版本：**0.7.0**，DSH 兼容范围 **>=0.2.2-rc.3 <0.3.0-0**。

## 1. 推荐：Desktop 插件市场

1. 打开 **DeepSeek Harness Desktop → 设置 → 插件**。
2. 搜索 `dsh-token2biq`，点击安装。
3. **完整退出 DSH**（不是只关窗口），再重新启动。首次加载会写入宿主配置；若宿主没有热重载，再重启一次让配置生效。

市场按注册表的 **GitHub 源**安装。包内零运行时依赖、没有 build 脚本；插件加载时会自动补好 Agent Teams 与子代理模型选择两项宿主配置，不需要本机编译。

## 2. 命令行：GitHub 源

```sh
dsh plugin --profile desktop add github:SSRYLJRSS/dsh-token2biq
```

把 `desktop` 换成实际 profile 名（`dsh plugin --profile <name>`）。安装完成后同样要**完整重启 DSH**。

> 若报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`：PowerShell 先执行 `$env:NODE_OPTIONS='--use-system-ca'` 再运行；这是本机 Node 不信任 GitHub 证书链。

验证：

```sh
dsh plugin --profile desktop why dsh-token2biq
# 输出应显示 dsh-token2biq 0.7.0 及其来源 GitHub
```

## 3. 预构建 tarball（可选）

```sh
# 固定版本（可复现，推荐）
dsh plugin --profile desktop add https://github.com/SSRYLJRSS/dsh-token2biq/releases/download/v0.7.0/dsh-token2biq-0.7.0.tgz

# 或始终取最新 release
dsh plugin --profile desktop add https://github.com/SSRYLJRSS/dsh-token2biq/releases/latest/download/dsh-token2biq.tgz
```

> 包内零依赖、无安装脚本，不需要 `allowBuilds`。若报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，说明本机 Node 不信任 GitHub Release 的证书链：改用第 2 节的 GitHub 源，或在启动 DSH 前设置 `NODE_OPTIONS=--use-system-ca`。

## 4. 本地源码 link：仅开发/排障

```sh
git clone https://github.com/SSRYLJRSS/dsh-token2biq.git
dsh plugin --profile desktop add link:/absolute/path/to/dsh-token2biq
```

`link:` 会在 profile 的 `node_modules/dsh-token2biq` 创建一个**目录联接（junction）**。这适合本地改代码，但会挡住后续的市场/云端安装。

## 常见失败 1：安装一直停在“安装中”

日志位置：

```
%USERPROFILE%\.dsh\profiles\<profile>\.plugin-manager\logs\operation-*\pnpm.log
```

如果看到：

```
[ERR_PNPM_EPERM] [importPackage ...\node_modules\dsh-token2biq]
EPERM: operation not permitted, rename
'...\dsh-token2biq_tmp_<pid>_<n>' -> '...\dsh-token2biq'
```

说明 profile 里有一个旧的 `node_modules/dsh-token2biq` 目录联接，pnpm 无法用新目录覆盖它。**这不是网络问题，也不是包本身安装失败。**

Windows 删除残留联接（只删链接，不删源码）：

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-token2biq"
if (Test-Path $p) { (Get-Item $p -Force).Delete() }
```

macOS / Linux：

```sh
rm -f ~/.dsh/profiles/desktop/node_modules/dsh-token2biq
```

然后重新在插件市场点安装，或执行上面的 GitHub 源 / tarball 安装命令。

## 常见失败 2：GitHub 源码安装报 ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED

pnpm 11 对 git 依赖默认不执行 `prepare` 构建脚本。本包没有 build 脚本，通常不会触发；若插件管理器仍提示待授权的 `allowBuilds`，按提示允许构建即可，也可以改用**预构建 tarball** 绕过。

## 常见失败 3：安装成功但面板没出现

- 确认已**完整退出并重启 DSH**；宿主侧 JS 只在启动时加载。
- 确认安装的是当前 profile：`dsh plugin --profile desktop why dsh-token2biq`。
- 查看 `~/.dsh/logs/` 里的宿主日志，搜索 `[token2biq]`。

## 版本与兼容声明

- 包版本：`0.7.0`
- `package.json` 顶层 `engines.dsh`：`>=0.2.2-rc.3 <0.3.0-0`
- `package.json` 的 `dsh.compatibility.dsh`：同上
- 市场与宿主优先读取 `engines.dsh`；如果缺失，会显示“无版本声明 / 兼容未知”

## 兼容性与放宽前提

- 当前只声明并验证 DSH `>=0.2.2-rc.3 <0.3.0-0`；上界 `0.3.0-0` 本轮**不放宽**（0.3 的插件 API 尚未验证，贸然放宽会把「未知兼容」包装成「支持」）。
- 放宽上界的前提：在目标 0.3.x 宿主上跑通 `npm run check && npm test && npm run test:smoke`，且 `token2biq` 工具与共享任务板/子代理模型选择在真实会话中可用；之后再同步修改 `package.json` 的 `engines.dsh` 与 `dsh.compatibility.dsh`（两者必须一致）。
- `npm run test:compat` 在未提供 `DSH_VERSION` 时直接 skip（退出 0）；提供后打印声明区间与宿主版本，供 CI 做兼容核验。

## 自动配置宿主（安装后首次加载）

插件加载时会向 profile 的 `cordis.patch.yml` 追加：

- `- id: agent-team` → `config.defaultEnabled: true`、`maxTasks: 256`
- `- id: subagent-model-selection-settings` → `config.enabled: true` + 从 `settings.yaml` 扫描到的 `allowedModels`

安全边界：不改 `settings.yaml`；只追加；同 id 已有配置不覆盖；写前备份 `cordis.patch.yml.bak-token2biq-<时间戳>`；临时文件 + 原子替换 + 写后校验；失败回滚。首次加载写入后重启 DSH 生效；若宿主没有热重载，再重启一次。

**活动 profile 定位**：显式 `profile` → 设置 `provisionProfile` → `DSH_PROFILE` → 安装路径 `profiles/<name>/node_modules` 反解 → 枚举 `profiles/*`（仅唯一命中）。多 profile 无可靠来源时不写文件，`token2biq action=provision` 返回 `ok:false` 与 `candidates`。最近一次结果（含失败原因）在 `action=state` 的 `provisionStatus` 可见。

## 回滚

1. 在插件市场卸载，或 `dsh plugin --profile desktop remove dsh-token2biq`。
2. 如需撤销自动配置，把最近的 `cordis.patch.yml.bak-token2biq-*` 复制回 `cordis.patch.yml`。
3. 重启 DSH。
