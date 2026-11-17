# 设置 V3 升级说明

状态：production 设置模型为 `version: 3`（0.6.0 起）。version 3 在 version 2 基础上新增 `reasoning: { default: "auto", byRole: {}, byModel: {} }`（思考强度，见 [0.6 优化说明](OPTIMIZATION-0.6.md)）；旧配置自动迁移补默认。

## 数据模型

`settings.json` 顶层只持久化：

```json
{
  "version": 2,
  "defaultMode": "Auto",
  "forceTeam": "auto",
  "allowModels": [],
  "rolePools": {
    "research": [], "plan": [], "generate": [], "review": [],
    "judge": [], "verify": [], "redteam": [], "regression": []
  },
  "parallelReviews": 3,
  "independentReview": false,
  "pipelineGate": "off",
  "tokenBudget": 0,
  "autoProvision": false,
  "provisionProfile": "",
  "reasoning": { "default": "auto", "byRole": {}, "byModel": {} }
}
```

- `rolePools` 的 8 个 key 永远存在；空数组表示「跟随主对话」；数组顺序就是优先级，第一项为该角色的主模型。
- `roleModels` 只是内存中的只读派生字段（每个角色池的首项），不会写入磁盘。
- `parallelReviews` 为 S4「完整加强」的并行审模型数，范围 1..5，默认 3；实际并行数取它与已选模型数的较小者。
- 已删除：`strongModel`、`normalModel`、`reviewModels`、`maxReviewers`、`requireDifferentVendor`。

## 旧配置迁移

- 旧 `roleModels` 的单值会转成对应角色池的首项。
- 旧 `reviewModels` 会排序后迁移到 `review` / `judge` / `redteam`（最多 5 个）；显式 `rolePools` 优先，显式空数组不会被旧值复活。
- 旧 `strongModel` / `normalModel` **不迁移**；它们的旧预设已取消，需要重新指定角色模型。
- 保存后旧字段会被清掉。

## 界面

- 「模型」页：主模型固定「跟随主对话」；8 个角色可单独指定，评审 / 裁决 / 红队可多选（最多 5 个、可排序、首个为主模型），增加 `+N` 折叠；支持模型搜索、清空、全部恢复。
- 「高级」页：新会话默认档位、强制用团队、S4 并行审模型数、严格流程、独立评委。
- 保存 payload 固定发送 8 个 `rolePools` key + 5 个高级字段；不发送旧字段，也不改动白名单 / 预算 / 自动 Provision 的服务器旧值。
