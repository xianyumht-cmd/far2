/**
 * 兼容层：同源 milk-tea 需要 ./pay 的 getDiamondBalance。
 *
 * far2 没有独立的付费模块，点券（1002）在背包里就是一条物品记录，
 * 这里直接读背包汇总，不引入新的协议调用。
 */

const { getBag, getBagItems } = require('./warehouse');

const DIAMOND_ITEM_ID = 1002;

async function getDiamondBalance() {
    const bag = await getBag();
    const items = getBagItems(bag) || [];
    let total = 0;
    for (const item of items) {
        const id = Number(item && (item.id ?? item.item_id));
        if (id !== DIAMOND_ITEM_ID) continue;
        total += Number(item && item.count) || 0;
    }
    return total;
}

module.exports = { getDiamondBalance, DIAMOND_ITEM_ID };
