# FAR2 P1 — 图鉴 / 商店只读协议探测 — 2026-08-13

状态：**SOURCE COMPLETE / LIVE PROTOCOL CHECK PENDING**

## 目标

按 `FEATURE_GAP_AUDIT_2026-08-13.md` 的 P1 开始追赶 2026-04 之后的功能，但不根据旧更新日志猜实现。

第一步只验证当前线上协议：

- 图鉴 V2 是否仍可读取；
- ShopProfiles 是否仍可读取；
- ShopInfo 是否仍可读取；
- 当前服务器实际返回哪些商店类型、图鉴条目和商品字段。

## 当前实现

WebUI：

```text
/catalog
```

菜单：`图鉴`

只读 API：

```text
GET /api/catalog/illustrated
GET /api/catalog/shops
GET /api/catalog/shops/:shopId
```

Worker 只新增：

```text
getIllustrated
getShopProfiles
getShopInfo
```

协议读取：

```text
gamepb.illustratedpb.IllustratedService / GetIllustratedListV2
gamepb.shoppb.ShopService / ShopProfiles
gamepb.shoppb.ShopService / ShopInfo
```

商店 `ShopInfo` 的 Service/Method 与 FAR2 当前自动种植链已有调用保持一致；图鉴 Service 名来自仓库现有 protobuf 命名，需要本次真实线上探测确认。

## 安全边界

当前版本明确不包含：

- 图鉴奖励领取；
- BuyGoods；
- 宠物操作；
- 变异操作；
- 任何自动购买。

`reward_info` 原始 bytes 不透传到 WebUI。

API 强制使用当前 `x-account-id` 并沿用现有账号权限隔离；普通用户不能跨账号读取。

## 真实验证后怎么继续

如果图鉴和种子商店均可读：

1. 把“只读探测版”升级成正式图鉴/种子商店；
2. 解码并展示图鉴奖励；
3. 增加图鉴奖励领取；
4. 图鉴未解锁且商店可购买种子联动；
5. 最后才增加单买 / 一键各买 1 份，并加二次确认和预计总成本。

如果某个 RPC 失败：

- 保留错误原文；
- 根据当前真实错误修 Service/Method/字段；
- 不回头复制或假设 4～6 月私有版本实现。
