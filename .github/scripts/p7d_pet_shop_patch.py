from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one anchor, found {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

catalog = 'core/src/services/catalog.js'
api = 'core/src/controllers/catalog-api.js'
ui = 'web/src/views/Catalog.vue'
test = 'core/scripts/catalog-actions-selftest.js'

replace_once(
    catalog,
    "const { getBagSeeds } = require('./warehouse');\n\nconst SHOP_TYPE_LABELS = { 1: '道具商店', 2: '种子商店', 3: '宠物商店' };\nconst ILLUSTRATED_TYPE_LABELS = { 1: '作物图鉴', 2: '变异图鉴' };\nconst SEED_SHOP_TYPE = 2;\n",
    "const { getBagSeeds } = require('./warehouse');\nconst { getDogInfoOverview } = require('./dog');\n\nconst SHOP_TYPE_LABELS = { 1: '道具商店', 2: '种子商店', 3: '宠物商店' };\nconst ILLUSTRATED_TYPE_LABELS = { 1: '作物图鉴', 2: '变异图鉴' };\nconst SEED_SHOP_TYPE = 2;\nconst PET_SHOP_TYPE = 3;\nconst KNOWN_DOG_NAMES = {\n    90001: '田园犬',\n    90002: '牧羊犬',\n    90003: '斑点狗',\n    90011: '柯基',\n    90021: '护主犬',\n};\n",
)

replace_once(
    catalog,
    """    const item = getItemById(id);\n    if (item && item.name) return String(item.name);\n    const plantName = getPlantNameBySeedId(id);\n""",
    """    const item = getItemById(id);\n    if (item && item.name) return String(item.name);\n    if (KNOWN_DOG_NAMES[id]) return KNOWN_DOG_NAMES[id];\n    const plantName = getPlantNameBySeedId(id);\n""",
)

replace_once(
    catalog,
    """async function getSeedShopSnapshot() {\n    const profiles = await getShopProfilesOverview();\n    const seedShop = profiles.shops.find(shop => shop.shopType === SEED_SHOP_TYPE);\n    if (!seedShop || !seedShop.shopId) throw new Error('当前服务器未返回种子商店');\n    return { seedShop, info: await getShopInfoById(seedShop.shopId) };\n}\n\nasync function getMissingSeedPurchasePlan() {\n""",
    """async function getSeedShopSnapshot() {\n    const profiles = await getShopProfilesOverview();\n    const seedShop = profiles.shops.find(shop => shop.shopType === SEED_SHOP_TYPE);\n    if (!seedShop || !seedShop.shopId) throw new Error('当前服务器未返回种子商店');\n    return { seedShop, info: await getShopInfoById(seedShop.shopId) };\n}\n\nasync function getPetShopSnapshot() {\n    const profiles = await getShopProfilesOverview();\n    const petShop = profiles.shops.find(shop => shop.shopType === PET_SHOP_TYPE);\n    if (!petShop || !petShop.shopId) throw new Error('当前服务器未返回宠物商店');\n    return { petShop, info: await getShopInfoById(petShop.shopId) };\n}\n\nfunction getPetGoodsBlockReason(goods) {\n    if (!goods || !goods.goodsId) return '该商品不属于当前宠物商店';\n    if (!goods.unlocked) return '该宠物商品尚未解锁';\n    if (goods.limitCount > 0 && goods.boughtNum >= goods.limitCount) return '该宠物商品已达限购';\n    return '';\n}\n\nasync function getMissingSeedPurchasePlan() {\n""",
)

replace_once(
    catalog,
    """async function buySeedGoodsSafely(goodsId) {\n    const id = toNum(goodsId);\n    if (!id) throw new Error('Invalid goodsId');\n    const { info } = await getSeedShopSnapshot();\n    const goods = info.goods.find(row => row.goodsId === id);\n    if (!goods) throw new Error('该商品不属于当前种子商店');\n    if (!goods.unlocked) throw new Error('该种子商品尚未解锁');\n    if (goods.limitCount > 0 && goods.boughtNum >= goods.limitCount) throw new Error('该种子商品已达限购');\n    const bagSeeds = await getBagSeeds();\n    const owned = (Array.isArray(bagSeeds) ? bagSeeds : []).find(row => toNum(row && row.seedId) === goods.itemId);\n    if (owned && toNum(owned.count) > 0) throw new Error('背包已有该种子，本功能不会重复购买');\n    return normalizePurchaseReply(goods, await sendBuyGoods(goods.goodsId, goods.price));\n}\n\nasync function buyAllMissingIllustratedSeeds() {\n""",
    """async function buySeedGoodsSafely(goodsId) {\n    const id = toNum(goodsId);\n    if (!id) throw new Error('Invalid goodsId');\n    const { info } = await getSeedShopSnapshot();\n    const goods = info.goods.find(row => row.goodsId === id);\n    if (!goods) throw new Error('该商品不属于当前种子商店');\n    if (!goods.unlocked) throw new Error('该种子商品尚未解锁');\n    if (goods.limitCount > 0 && goods.boughtNum >= goods.limitCount) throw new Error('该种子商品已达限购');\n    const bagSeeds = await getBagSeeds();\n    const owned = (Array.isArray(bagSeeds) ? bagSeeds : []).find(row => toNum(row && row.seedId) === goods.itemId);\n    if (owned && toNum(owned.count) > 0) throw new Error('背包已有该种子，本功能不会重复购买');\n    return normalizePurchaseReply(goods, await sendBuyGoods(goods.goodsId, goods.price));\n}\n\nfunction normalizePetPurchaseReply(goods, reply) {\n    return {\n        goodsId: goods.goodsId,\n        itemId: goods.itemId,\n        dogId: goods.itemId,\n        name: goods.name,\n        price: goods.price,\n        count: Math.max(1, goods.itemCount || 1),\n        getItems: (Array.isArray(reply && reply.get_items) ? reply.get_items : []).map(normalizeRewardItem),\n        costItems: (Array.isArray(reply && reply.cost_items) ? reply.cost_items : []).map(normalizeRewardItem),\n    };\n}\n\nasync function buyPetGoodsSafely(goodsId) {\n    const id = toNum(goodsId);\n    if (!id) return { ok: false, reason: 'invalid_goods', error: 'Invalid goodsId' };\n\n    // Always re-read the server pet shop immediately before the write. Client price/shop data is never trusted.\n    const { petShop, info } = await getPetShopSnapshot();\n    const goods = info.goods.find(row => row.goodsId === id);\n    const blockReason = getPetGoodsBlockReason(goods);\n    if (blockReason) {\n        return {\n            ok: false,\n            reason: !goods ? 'not_pet_shop' : (!goods.unlocked ? 'locked' : 'limit_reached'),\n            error: blockReason,\n            shop: petShop,\n            goods: goods || null,\n        };\n    }\n\n    const reply = await sendBuyGoods(goods.goodsId, goods.price);\n    const purchase = normalizePetPurchaseReply(goods, reply);\n    let dogInfo = null;\n    let dogInfoError = '';\n    try {\n        dogInfo = await getDogInfoOverview();\n    }\n    catch (err) {\n        dogInfoError = err && err.message ? err.message : String(err || 'unknown');\n    }\n    return { ok: true, shop: petShop, purchase, dogInfo, dogInfoError };\n}\n\nasync function buyAllMissingIllustratedSeeds() {\n""",
)

replace_once(
    catalog,
    """    if (action === 'buyIllustratedSeed') return buySeedGoodsSafely(input.goodsId);\n    if (action === 'buyAllMissingIllustratedSeeds') return buyAllMissingIllustratedSeeds();\n    throw new Error(`Unsupported catalog action: ${action || '(empty)'}`);\n""",
    """    if (action === 'buyIllustratedSeed') return buySeedGoodsSafely(input.goodsId);\n    if (action === 'buyAllMissingIllustratedSeeds') return buyAllMissingIllustratedSeeds();\n    if (action === 'buyPetGoods') return buyPetGoodsSafely(input.goodsId);\n    throw new Error(`Unsupported catalog action: ${action || '(empty)'}`);\n""",
)

replace_once(
    catalog,
    """module.exports = {\n    getIllustratedOverview,\n""",
    """module.exports = {\n    buildCatalogItemName,\n    getPetGoodsBlockReason,\n    getIllustratedOverview,\n""",
)

replace_once(
    api,
    """    app.get('/api/catalog/shops', async (req, res) => {\n""",
    """    app.post('/api/catalog/pet-shop/buy', async (req, res) => {\n        const accountId = requireAccount(req, res);\n        if (!accountId) return;\n        const goodsId = Number(req.body && req.body.goodsId);\n        if (!Number.isSafeInteger(goodsId) || goodsId <= 0) {\n            return res.status(400).json({ ok: false, error: 'Invalid goodsId' });\n        }\n        try {\n            const data = await enqueueAccountCatalog(accountId, () => runCatalogActionForAccount(accountId, {\n                action: 'buyPetGoods',\n                goodsId,\n            }));\n            if (data && data.ok === false) {\n                return res.status(409).json({ ok: false, error: data.error || '当前宠物商品不可购买', data });\n            }\n            return res.json({ ok: true, data });\n        }\n        catch (err) {\n            if (err && err.statusCode === 503) return res.status(503).json({ ok: false, error: err.message });\n            return fail(res, err);\n        }\n    });\n\n    app.get('/api/catalog/shops', async (req, res) => {\n""",
)

replace_once(
    ui,
    """function conditionText(condition: { type: number, param: number }) {\n    if (condition.type === 1)\n        return `Lv${condition.param}`\n    if (condition.type === 2)\n        return '需解锁卡'\n    return `条件${condition.type}:${condition.param}`\n}\n\nfunction clearActionState() {\n""",
    """function conditionText(condition: { type: number, param: number }) {\n  if (condition.type === 1)\n    return `Lv${condition.param}`\n  if (condition.type === 2)\n    return '需解锁卡'\n  return `条件${condition.type}:${condition.param}`\n}\n\nfunction petGoodsBlockReason(goods: ShopGoods) {\n  if (!goods.unlocked)\n    return '尚未解锁'\n  if (goods.limitCount > 0 && goods.boughtNum >= goods.limitCount)\n    return '已达限购'\n  return ''\n}\n\nfunction rewardText(items: Array<{ name?: string, id?: number, count?: number }> = []) {\n  return items.map(item => `${item.name || `物品${item.id || 0}`}×${Math.max(1, Number(item.count) || 1)}`).join('、')\n}\n\nfunction clearActionState() {\n""",
)

replace_once(
    ui,
    """async function loadShopInfo(shopId: number) {\n""",
    """async function buyPetGoods(goods: ShopGoods) {\n  if (selectedShop.value?.shopType !== 3)\n    return\n  const blocked = petGoodsBlockReason(goods)\n  if (blocked) {\n    actionError.value = `当前不可购买：${blocked}`\n    return\n  }\n  if (!window.confirm(`购买「${goods.name}」1 份？\\n服务器当前显示价格：${numberText(goods.price)} 金币\\n\\n提交时会重新读取服务器价格、解锁和限购状态。`))\n    return\n\n  clearActionState()\n  actionLoading.value = `pet-buy-${goods.goodsId}`\n  try {\n    const res = await api.post('/api/catalog/pet-shop/buy', { goodsId: goods.goodsId })\n    if (!res.data?.ok)\n      throw new Error(res.data?.error || '宠物购买失败')\n    const data = res.data.data || {}\n    const purchase = data.purchase || {}\n    const got = rewardText(purchase.getItems || [])\n    const cost = rewardText(purchase.costItems || [])\n    actionMessage.value = `宠物购买成功：${purchase.name || goods.name}，实际价格 ${numberText(purchase.price || goods.price)} 金币${got ? `；获得 ${got}` : ''}${cost ? `；消耗 ${cost}` : ''}。`\n    await loadShopInfo(selectedShopId.value)\n  }\n  catch (error: any) {\n    actionError.value = errorText(error, '宠物购买失败')\n    await loadShopInfo(selectedShopId.value)\n  }\n  finally {\n    actionLoading.value = ''\n  }\n}\n\nasync function loadShopInfo(shopId: number) {\n""",
)

replace_once(
    ui,
    """            <div v-if=\"goods.conditions.length\" class=\"mt-2 flex flex-wrap gap-1\">\n              <span v-for=\"condition in goods.conditions\" :key=\"`${condition.type}-${condition.param}`\" class=\"rounded bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300\">{{ conditionText(condition) }}</span>\n            </div>\n          </div>\n""",
    """            <div v-if=\"goods.conditions.length\" class=\"mt-2 flex flex-wrap gap-1\">\n              <span v-for=\"condition in goods.conditions\" :key=\"`${condition.type}-${condition.param}`\" class=\"rounded bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300\">{{ conditionText(condition) }}</span>\n            </div>\n            <div v-if=\"selectedShop?.shopType === 3\" class=\"mt-3 border-t border-gray-100 pt-3 dark:border-gray-700\">\n              <div v-if=\"petGoodsBlockReason(goods)\" class=\"rounded-lg bg-gray-50 px-3 py-2 text-center text-xs text-gray-500 dark:bg-gray-900/30\">\n                {{ petGoodsBlockReason(goods) }}\n              </div>\n              <button\n                v-else\n                class=\"w-full rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300\"\n                :disabled=\"busy\"\n                @click=\"buyPetGoods(goods)\"\n              >\n                {{ actionLoading === `pet-buy-${goods.goodsId}` ? '购买中...' : `购买 ${numberText(goods.price)} 金币` }}\n              </button>\n            </div>\n          </div>\n""",
)

replace_once(
    test,
    """const { registerCatalogApi } = require('../src/controllers/catalog-api');\n""",
    """const { registerCatalogApi } = require('../src/controllers/catalog-api');\nconst { buildCatalogItemName, getPetGoodsBlockReason } = require('../src/services/catalog');\n""",
)

replace_once(
    test,
    """    let buyActionCount = 0;\n    let plan = {\n""",
    """    let buyActionCount = 0;\n    let petBuyActionCount = 0;\n    let lastPetActionInput = null;\n    let plan = {\n""",
)

replace_once(
    test,
    """                if (action === 'buyIllustratedSeed') {\n                    buyActionCount++;\n                    const goodsId = Number(input.goodsId);\n                    return { goodsId, price: goodsId === 12 ? 20 : 10, count: 1 };\n                }\n                throw new Error(`unexpected action ${action}`);\n""",
    """                if (action === 'buyIllustratedSeed') {\n                    buyActionCount++;\n                    const goodsId = Number(input.goodsId);\n                    return { goodsId, price: goodsId === 12 ? 20 : 10, count: 1 };\n                }\n                if (action === 'buyPetGoods') {\n                    petBuyActionCount++;\n                    lastPetActionInput = { ...input };\n                    const goodsId = Number(input.goodsId);\n                    if (goodsId === 13) {\n                        return { ok: false, reason: 'limit_reached', error: '该宠物商品已达限购' };\n                    }\n                    return {\n                        ok: true,\n                        purchase: { goodsId, itemId: 90003, dogId: 90003, name: '斑点狗', price: 1000000, getItems: [], costItems: [] },\n                        dogInfo: { dogs: [{ id: 90003, active: 1 }] },\n                    };\n                }\n                throw new Error(`unexpected action ${action}`);\n""",
)

replace_once(
    test,
    """        const forbidden = await request('/api/catalog/illustrated/claim', {\n            method: 'POST', body: '{}', headers: { 'x-account-id': '2' },\n        });\n        assert.equal(forbidden.status, 403);\n        console.log('✅ cross-account mutation denied PASS');\n\n        console.log('\\n=== RESULT ===');\n""",
    """        assert.equal(buildCatalogItemName(90011), '柯基');\n        assert.equal(getPetGoodsBlockReason({ goodsId: 13, unlocked: true, boughtNum: 1, limitCount: 1 }), '该宠物商品已达限购');\n        assert.equal(getPetGoodsBlockReason({ goodsId: 14, unlocked: true, boughtNum: 0, limitCount: 1 }), '');\n        console.log('✅ pet catalog name + limit state PASS');\n\n        const invalidPetBuy = await request('/api/catalog/pet-shop/buy', {\n            method: 'POST', body: JSON.stringify({ goodsId: 0, price: 1 }),\n        });\n        assert.equal(invalidPetBuy.status, 400);\n        console.log('✅ invalid pet purchase rejected PASS');\n\n        const petLimit = await request('/api/catalog/pet-shop/buy', {\n            method: 'POST', body: JSON.stringify({ goodsId: 13, price: 1 }),\n        });\n        assert.equal(petLimit.status, 409);\n        assert.equal(petLimit.body.data.reason, 'limit_reached');\n        console.log('✅ pet limit revalidation surfaced as conflict PASS');\n\n        const petBuy = await request('/api/catalog/pet-shop/buy', {\n            method: 'POST', body: JSON.stringify({ goodsId: 14, price: 1 }),\n        });\n        assert.equal(petBuy.status, 200);\n        assert.equal(petBuy.body.data.purchase.price, 1000000);\n        assert.equal(lastPetActionInput.goodsId, 14);\n        assert.equal(Object.prototype.hasOwnProperty.call(lastPetActionInput, 'price'), false);\n        console.log('✅ pet purchase ignores client price PASS');\n\n        const beforeForbiddenPetBuy = petBuyActionCount;\n        const forbiddenPetBuy = await request('/api/catalog/pet-shop/buy', {\n            method: 'POST', body: JSON.stringify({ goodsId: 14 }), headers: { 'x-account-id': '2' },\n        });\n        assert.equal(forbiddenPetBuy.status, 403);\n        assert.equal(petBuyActionCount, beforeForbiddenPetBuy);\n        console.log('✅ cross-account pet purchase denied PASS');\n\n        const forbidden = await request('/api/catalog/illustrated/claim', {\n            method: 'POST', body: '{}', headers: { 'x-account-id': '2' },\n        });\n        assert.equal(forbidden.status, 403);\n        console.log('✅ cross-account mutation denied PASS');\n\n        console.log('\\n=== RESULT ===');\n""",
)

replace_once(
    test,
    """            staleBulkRejected: true,\n            realQqTouched: false,\n            realPurchaseTouched: false,\n""",
    """            staleBulkRejected: true,\n            petPurchaseLimitProtected: true,\n            petClientPriceTrusted: false,\n            petCrossAccountDenied: true,\n            realQqTouched: false,\n            realPurchaseTouched: false,\n""",
)

print('P7D pet shop patch applied')
