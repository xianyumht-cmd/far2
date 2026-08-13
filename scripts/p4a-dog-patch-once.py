from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 anchor, found {count}')
    return text.replace(old, new, 1)


# proto.js
path = Path('core/src/utils/proto.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "        getResourcePath('proto', 'interactpb.proto'),\n",
    "        getResourcePath('proto', 'interactpb.proto'),\n        getResourcePath('proto', 'dogpb.proto'),\n",
    'proto dog file load',
)
text = replace_once(
    text,
    """    types.ItemNotify = root.lookupType('gamepb.itempb.ItemNotify');
    types.GoodsUnlockNotify = root.lookupType('gamepb.shoppb.GoodsUnlockNotify');
    types.TaskInfoNotify = root.lookupType('gamepb.taskpb.TaskInfoNotify');

    // Proto 加载完成""",
    """    types.ItemNotify = root.lookupType('gamepb.itempb.ItemNotify');
    types.GoodsUnlockNotify = root.lookupType('gamepb.shoppb.GoodsUnlockNotify');
    types.TaskInfoNotify = root.lookupType('gamepb.taskpb.TaskInfoNotify');

    // 护主犬（P4A 只读 GetDogInfo）
    types.DogInfo = root.lookupType('gamepb.dogpb.DogInfo');
    types.DogFood = root.lookupType('gamepb.dogpb.DogFood');
    types.GetDogInfoRequest = root.lookupType('gamepb.dogpb.GetDogInfoRequest');
    types.GetDogInfoReply = root.lookupType('gamepb.dogpb.GetDogInfoReply');

    // Proto 加载完成""",
    'proto dog types',
)
path.write_text(text, encoding='utf-8')


# worker.js
path = Path('core/src/core/worker.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    """            case 'getIllustrated':
                result = await require('../services/catalog').getIllustratedOverview();
                break;
            case 'getShopProfiles':""",
    """            case 'getIllustrated':
                result = await require('../services/catalog').getIllustratedOverview();
                break;
            case 'getDogInfo':
                result = await require('../services/dog').getDogInfoOverview();
                break;
            case 'getShopProfiles':""",
    'worker dog API case',
)
path.write_text(text, encoding='utf-8')


# data-provider.js
path = Path('core/src/runtime/data-provider.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "        getIllustrated: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getIllustrated'),\n        getShopProfiles:",
    "        getIllustrated: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getIllustrated'),\n        getDogInfo: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getDogInfo'),\n        getShopProfiles:",
    'provider dog method',
)
path.write_text(text, encoding='utf-8')


# admin.js: GET only, no ClaimSkillGifts route.
path = Path('core/src/controllers/admin.js')
text = path.read_text(encoding='utf-8')
anchor = """    // API: 每日礼包状态总览
    app.get('/api/daily-gifts', async (req, res) => {"""
dog_route = """    // API: 护主犬状态（P4A 只读；不提供领取/喂食/修改接口）
    app.get('/api/dog/info', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            if (!provider || typeof provider.getDogInfo !== 'function') {
                return res.status(503).json({ ok: false, error: '护主犬只读接口不可用' });
            }
            const data = await provider.getDogInfo(id);
            return res.json({ ok: true, data });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

"""
text = replace_once(text, anchor, dog_route + anchor, 'admin dog GET route')
path.write_text(text, encoding='utf-8')


# Personal.vue
path = Path('web/src/views/Personal.vue')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "import BagPanel from '@/components/BagPanel.vue'\nimport FarmPanel from '@/components/FarmPanel.vue'\nimport TaskPanel from '@/components/TaskPanel.vue'\n\nconst currentTab = ref<'farm' | 'bag' | 'task'>('farm')",
    "import BagPanel from '@/components/BagPanel.vue'\nimport DogPanel from '@/components/DogPanel.vue'\nimport FarmPanel from '@/components/FarmPanel.vue'\nimport TaskPanel from '@/components/TaskPanel.vue'\n\nconst currentTab = ref<'farm' | 'bag' | 'task' | 'dog'>('farm')",
    'personal dog import/tab type',
)
old_task_button = """      <button
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'task'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'task' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'task'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-task text-lg" />
          <span>我的任务</span>
        </div>
      </button>"""
new_buttons = old_task_button + """
      <button
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'dog'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'dog' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'dog'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-paw text-lg" />
          <span>护主犬</span>
        </div>
      </button>"""
text = replace_once(text, old_task_button, new_buttons, 'personal dog button')
text = replace_once(
    text,
    ":is=\"currentTab === 'farm' ? FarmPanel : (currentTab === 'bag' ? BagPanel : TaskPanel)\"",
    ":is=\"currentTab === 'farm' ? FarmPanel : (currentTab === 'bag' ? BagPanel : (currentTab === 'task' ? TaskPanel : DogPanel))\"",
    'personal dog component',
)
path.write_text(text, encoding='utf-8')


# scripts
for filename in ('core/package.json', 'package.json'):
    path = Path(filename)
    text = path.read_text(encoding='utf-8')
    if filename == 'core/package.json':
        old = '    "mutation:readonly-selftest": "node scripts/mutation-readonly-selftest.js",\n'
        new = old + '    "dog:readonly-selftest": "node scripts/dog-readonly-selftest.js",\n'
    else:
        old = '    "mutation:readonly-selftest": "pnpm -C core mutation:readonly-selftest",\n'
        new = old + '    "dog:readonly-selftest": "pnpm -C core dog:readonly-selftest",\n'
    text = replace_once(text, old, new, f'{filename} dog selftest')
    path.write_text(text, encoding='utf-8')

print('P4A dog read-only integration patch applied')
