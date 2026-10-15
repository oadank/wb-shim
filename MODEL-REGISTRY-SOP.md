# 新限免模型登记 SOP（2026-10-13 立；2026-10-14 补自动同步，人工登记降级为兜底）

## 🔴 2026-10-14 重大更新：到期日已自动同步，不再靠人翻页面

**官方数据源（权威）**：WorkBuddy 客户端自动拉取的官方产品配置：
```
C:\Users\oadan\.workbuddy\storage\user-*\scoped\*\wb-product-config.json
  → product-config-snapshot.data.modelPromotions[]   ← 促销数组
     { id, kind, modelIds[], hover.textZh, schedule: { validFrom, validUntil, daily } }
```
`validUntil` 是**权威到期时刻**（精确到秒）。🔴 语义：它是"次日 00:00"（如 `10/26/2026 00:00:00` 表示免费到 10-25 结束），所以真实截止 = `validUntil - 1 秒`。

**自动同步**：`promo-sync` 服务（`C:\D\opt\wb-shim\promo-sync.mjs`，nssm，每 30 分钟）读上述文件 → 与 `free-expiry.json` 比对 → 有差异就自动改登记表 + 私聊老大。
2026-10-14 实测：故意把 step-5 写成 10-20（官方是 10-25）→ 脚本 2 秒内纠正并通知。

**这意味着**：官方延期（hy3/hy4 从 10-25 延到 10-31 那种）**不再需要人工发现**——客户端拉到新配置，promo-sync 半小时内就跟上。

## 人工登记的定位（降级为兜底）
只有这两种情况才需要人工：
1. 模型在 `modelPromotions` 里**没有** validUntil（如纯 daily 时段促销，或全新模型官方还没配促销条目）
2. 客户端配置里也查不到的（理论上不存在，因为客户端是唯一入口）

## 人工登记步骤（兜底用）
1. 打开 WorkBuddy 客户端模型选择器 → 点该模型 → 看右侧详情页
2. 截图/抄录原文进 `evidence` 字段
3. `inferred: true`（人工）+ evidence 写明"页面无日期，按 X 推断"
4. 等 promo-sync 跑到（30 分钟内）会自动纠正为官方值并把 inferred 改 false

## 到期日格式对照
- 官方字段：`10/26/2026 00:00:00`（月/日/年）→ 本地时区（Asia/Shanghai）
- 国际版文案："Sep 11 – Oct 31"
- 统一转成 `YYYY-MM-DDT23:59:59+08:00` 存 expiry

## 已登记模型的复查周期
不需要人工复查了——promo-sync 每 30 分钟自动核对。但**每周应看一眼 `/router` 页面的「官方数据源」区块**，确认 mtime 是近期的（如果客户端久没开，快照会旧）。
