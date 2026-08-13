from pathlib import Path

warehouse_path = Path('core/src/services/warehouse.js')
worker_path = Path('core/src/core/worker.js')
bag_panel_path = Path('web/src/components/BagPanel.vue')
core_pkg_path = Path('core/package.json')
root_pkg_path = Path('package.json')


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one anchor, found {count}')
    return source.replace(old, new, 1)

# ---- warehouse: normalize UseReply.items and keep raw useItem available ----
warehouse = warehouse_path.read_text(encoding='utf-8')
anchor = """function getBagItems(bagReply) {
    if (bagReply && bagReply.item_bag && bagReply.item_bag.items && bagReply.item_bag.items.length) {
        return bagReply.item_bag.items;
    }
    return bagReply && bagReply.items ? bagReply.items : [];
}

"""
helper = r'''function normalizeUseRewardItem(item) {
    const id = toNum(item && item.id);
    const count = Math.max(0, toNum(item && item.count));
    const uid = Math.max(0, toNum(item && item.uid));
    const info = getItemById(id) || null;
    let name = info && info.name ? String(info.name) : '';
    let category = 'item';

    if (id === 1 || id === 1001) {
        name = '金币';
        category = 'gold';
    } else if (id === 1101) {
        name = '经验';
        category = 'exp';
    } else if (getPlantByFruitId(id)) {
        if (!name) name = `${getFruitName(id)}果实`;
        category = 'fruit';
    } else if (getPlantBySeedId(id)) {
        const plant = getPlantBySeedId(id);
        if (!name) name = `${plant && plant.name ? plant.name : '未知'}种子`;
        category = 'seed';
    }
    if (!name) name = `物品${id}`;

    return {
        id,
        count,
        uid,
        name,
        image: getItemImageById(id) || '',
        category,
        itemType: info ? (Number(info.type) || 0) : 0,
        isNew: !!(item && item.is_new),
    };
}

function normalizeUseItemReply(reply, itemId, count) {
    const requestedCount = Math.max(1, Math.floor(Number(count) || 1));
    const rewards = Array.isArray(reply && reply.items)
        ? reply.items.map(normalizeUseRewardItem).filter((item) => item.id > 0 && item.count > 0)
        : [];
    return {
        usedItemId: Math.max(0, toNum(itemId)),
        usedCount: requestedCount,
        rewards,
    };
}

async function useItemWithDetail(itemId, count = 1, landIds = []) {
    const normalizedCount = Math.max(1, Math.floor(Number(count) || 1));
    const reply = await useItem(itemId, normalizedCount, landIds);
    return normalizeUseItemReply(reply, itemId, normalizedCount);
}

'''
warehouse = replace_once(warehouse, anchor, anchor + helper, 'warehouse normalization helper')
warehouse = replace_once(
    warehouse,
    """    useItem,
    batchUseItems,
""",
    """    useItem,
    useItemWithDetail,
    normalizeUseRewardItem,
    normalizeUseItemReply,
    batchUseItems,
""",
    'warehouse exports',
)
warehouse_path.write_text(warehouse, encoding='utf-8')

# ---- worker: API useItem returns normalized JSON detail ----
worker = worker_path.read_text(encoding='utf-8')
old_worker = """            case 'useItem': {
                const { useItem: _useItem } = require('../services/warehouse');
                const itemId = Number(args[0]) || 0;
                const count = Math.max(1, Number(args[1]) || 1);
                result = await _useItem(itemId, count, []);
                break;
            }
"""
new_worker = """            case 'useItem': {
                const { useItemWithDetail: _useItemWithDetail } = require('../services/warehouse');
                const itemId = Number(args[0]) || 0;
                const count = Math.max(1, Math.floor(Number(args[1]) || 1));
                result = await _useItemWithDetail(itemId, count, []);
                break;
            }
"""
worker = replace_once(worker, old_worker, new_worker, 'worker useItem API')
worker_path.write_text(worker, encoding='utf-8')

# ---- BagPanel: separate quantity modal; ConfirmModal remains sell-only ----
panel = bag_panel_path.read_text(encoding='utf-8')
panel = replace_once(
    panel,
    """  action: '' as 'sell' | 'use' | 'batchSell',
""",
    """  action: '' as 'sell' | 'batchSell',
""",
    'confirm action union',
)

state_anchor = """const batchMode = ref(false)
const selectedForBatch = ref<Set<number>>(new Set())
const batchSellResult = ref<{ gold: number, goldBean: number } | null>(null)

"""
use_state = """const useModal = ref({
  show: false,
  loading: false,
  item: null as any,
  count: 1,
})
const lastUseResult = ref<{
  itemName: string
  usedCount: number
  rewards: Array<{ id: number, count: number, name: string, image?: string, category?: string }>
} | null>(null)

"""
panel = replace_once(panel, state_anchor, state_anchor + use_state, 'bag use state')

old_handle_use = """function handleUseClick(item: any) {
  confirmModal.value = {
    show: true,
    title: '确认使用',
    message: `确定要使用全部 ${item.name || `物品${item.id}`} 吗?\\n数量：${item.count || 0}`,
    type: 'primary',
    loading: false,
    action: 'use',
    item,
    selectedItems: [],
  }
}

"""
new_handle_use = """function handleUseClick(item: any) {
  const maxCount = Math.max(1, Math.floor(Number(item?.count) || 1))
  useModal.value = {
    show: true,
    loading: false,
    item,
    count: Math.min(1, maxCount),
  }
}

function normalizeUseCount() {
  const maxCount = Math.max(1, Math.floor(Number(useModal.value.item?.count) || 1))
  const next = Math.floor(Number(useModal.value.count) || 1)
  useModal.value.count = Math.min(maxCount, Math.max(1, next))
}

async function handleUseConfirm() {
  if (!currentAccountId.value || !useModal.value.item)
    return

  normalizeUseCount()
  const item = useModal.value.item
  const count = useModal.value.count
  useModal.value.loading = true
  try {
    const res = await bagStore.useItem(currentAccountId.value, Number(item.id), count)
    if (res.ok) {
      const data = res.data || {}
      const rewards = Array.isArray(data.rewards) ? data.rewards : []
      lastUseResult.value = {
        itemName: item.name || `物品${item.id}`,
        usedCount: Number(data.usedCount || count),
        rewards,
      }
      const rewardText = rewards.length > 0
        ? rewards.map((reward: any) => `${reward.name || `物品${reward.id}`}x${reward.count || 0}`).join('，')
        : '服务器未返回奖励明细'
      toastStore.success(`已使用 ${count} 个 ${item.name || `物品${item.id}`}；${rewardText}`)
      useModal.value.show = false
      await loadBag()
    }
    else {
      toastStore.error(`使用失败: ${res.error || '未知错误'}`)
    }
  }
  catch (e: any) {
    toastStore.error(`使用失败: ${e.message || '未知错误'}`)
  }
  finally {
    useModal.value.loading = false
  }
}

function handleUseCancel() {
  if (useModal.value.loading)
    return
  useModal.value.show = false
}

"""
panel = replace_once(panel, old_handle_use, new_handle_use, 'use click/confirm functions')

old_use_branch = """    else if (action === 'use' && item) {
      const res = await bagStore.useItem(currentAccountId.value, Number(item.id), Number(item.count || 1))
      if (res.ok) {
        toastStore.success(`已使用 ${item.name || `物品${item.id}`}`)
        await loadBag()
      }
      else {
        toastStore.error(`使用失败: ${res.error || '未知错误'}`)
      }
    }
"""
if old_use_branch not in panel:
    raise SystemExit('old ConfirmModal use branch missing')
panel = panel.replace(old_use_branch, '', 1)

panel = replace_once(panel, 'title="使用全部"', 'title="选择使用数量"', 'use button title')

result_anchor = """      <div class=\"grid grid-cols-2 gap-4 lg:grid-cols-5 md:grid-cols-4 sm:grid-cols-3 xl:grid-cols-6\">\n"""
result_block = """      <div v-if=\"lastUseResult\" class=\"mb-4 border border-emerald-200 rounded-lg bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-900/20\">\n        <div class=\"font-medium text-emerald-700 dark:text-emerald-300\">\n          已使用 {{ lastUseResult.itemName }} x{{ lastUseResult.usedCount }}\n        </div>\n        <div v-if=\"lastUseResult.rewards.length\" class=\"mt-2 flex flex-wrap gap-2\">\n          <span\n            v-for=\"reward in lastUseResult.rewards\"\n            :key=\"`${reward.id}-${reward.count}`\"\n            class=\"rounded-full bg-white px-2.5 py-1 text-gray-700 shadow-sm dark:bg-gray-800 dark:text-gray-200\"\n          >\n            {{ reward.name || `物品${reward.id}` }} x{{ reward.count }}\n          </span>\n        </div>\n        <div v-else class=\"mt-1 text-gray-500 dark:text-gray-400\">\n          服务器未返回奖励明细\n        </div>\n      </div>\n\n"""
panel = replace_once(panel, result_anchor, result_block + result_anchor, 'use result display')

modal_anchor = """    <ConfirmModal
      :show=\"confirmModal.show\"
"""
use_modal = """    <div v-if=\"useModal.show\" class=\"fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm\" @click=\"handleUseCancel\">\n      <div class=\"max-w-sm w-full rounded-xl bg-white p-6 shadow-2xl dark:bg-gray-800\" @click.stop>\n        <h3 class=\"text-xl text-gray-900 font-bold dark:text-gray-100\">\n          使用物品\n        </h3>\n        <div class=\"mt-2 text-sm text-gray-500 dark:text-gray-400\">\n          {{ useModal.item?.name || `物品${useModal.item?.id || ''}` }} · 当前 x{{ useModal.item?.count || 0 }}\n        </div>\n        <label class=\"mt-5 block text-sm text-gray-700 font-medium dark:text-gray-300\">\n          使用数量\n        </label>\n        <input\n          v-model.number=\"useModal.count\"\n          type=\"number\"\n          min=\"1\"\n          :max=\"Math.max(1, Number(useModal.item?.count || 1))\"\n          step=\"1\"\n          class=\"mt-2 w-full border border-gray-300 rounded-lg bg-white px-3 py-2 text-gray-900 outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500\"\n          @blur=\"normalizeUseCount\"\n        >\n        <div class=\"mt-2 text-xs text-gray-400\">\n          默认只使用 1 个，最多 {{ useModal.item?.count || 1 }} 个。确认后才会发送使用请求。\n        </div>\n        <div class=\"mt-6 flex justify-end gap-3\">\n          <button\n            class=\"rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-700 font-medium dark:bg-gray-700 dark:text-gray-200\"\n            :disabled=\"useModal.loading\"\n            @click=\"handleUseCancel\"\n          >\n            取消\n          </button>\n          <button\n            class=\"rounded-lg bg-green-600 px-4 py-2 text-sm text-white font-medium disabled:opacity-60 hover:bg-green-700\"\n            :disabled=\"useModal.loading\"\n            @click=\"handleUseConfirm\"\n          >\n            {{ useModal.loading ? '使用中...' : `确认使用 ${useModal.count} 个` }}\n          </button>\n        </div>\n      </div>\n    </div>\n\n"""
panel = replace_once(panel, modal_anchor, use_modal + modal_anchor, 'use quantity modal')

# ConfirmModal is now only sell/batchSell.
panel = replace_once(
    panel,
    ":confirm-text=\"confirmModal.action === 'sell' ? '确认出售' : confirmModal.action === 'batchSell' ? '确认出售' : '确认使用'\"",
    ":confirm-text=\"'确认出售'\"",
    'confirm modal text',
)

for required in [
    'async function handleUseConfirm()',
    '默认只使用 1 个',
    'lastUseResult.rewards',
    'bagStore.useItem(currentAccountId.value, Number(item.id), count)',
]:
    if required not in panel:
        raise SystemExit(f'BagPanel contract missing: {required}')
if "action: 'use'" in panel or "action === 'use'" in panel:
    raise SystemExit('old all-stack use ConfirmModal path still present')

bag_panel_path.write_text(panel, encoding='utf-8')

# ---- package scripts ----
for pkg_path in [core_pkg_path, root_pkg_path]:
    pkg = pkg_path.read_text(encoding='utf-8')
    anchor = '    "friend:mutation-selftest": '
    idx = pkg.find(anchor)
    if idx < 0:
        raise SystemExit(f'{pkg_path}: friend mutation selftest anchor missing')
    line_end = pkg.find('\n', idx)
    command = 'node scripts/bag-use-ux-selftest.js' if str(pkg_path).startswith('core/') else 'pnpm -C core bag:use-ux-selftest'
    new_line = f'    "bag:use-ux-selftest": "{command}",\n'
    if '"bag:use-ux-selftest"' not in pkg:
        pkg = pkg[:line_end + 1] + new_line + pkg[line_end + 1:]
    pkg_path.write_text(pkg, encoding='utf-8')

print('P7A bag use UX patch applied')
