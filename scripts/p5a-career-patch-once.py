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
    "        getResourcePath('proto', 'dogpb.proto'),\n",
    "        getResourcePath('proto', 'dogpb.proto'),\n        getResourcePath('proto', 'careerpb.proto'),\n",
    'proto career file load',
)
text = replace_once(
    text,
    """    // 护主犬（P4A 只读 GetDogInfo）
    types.DogInfo = root.lookupType('gamepb.dogpb.DogInfo');
    types.DogFood = root.lookupType('gamepb.dogpb.DogFood');
    types.GetDogInfoRequest = root.lookupType('gamepb.dogpb.GetDogInfoRequest');
    types.GetDogInfoReply = root.lookupType('gamepb.dogpb.GetDogInfoReply');

    // Proto 加载完成""",
    """    // 护主犬（P4A 只读 GetDogInfo）
    types.DogInfo = root.lookupType('gamepb.dogpb.DogInfo');
    types.DogFood = root.lookupType('gamepb.dogpb.DogFood');
    types.GetDogInfoRequest = root.lookupType('gamepb.dogpb.GetDogInfoRequest');
    types.GetDogInfoReply = root.lookupType('gamepb.dogpb.GetDogInfoReply');

    // 个人生涯（P5A 只读 CareerInfoGet）
    types.CareerStatItem = root.lookupType('gamepb.careerpb.CareerStatItem');
    types.CareerLevelStat = root.lookupType('gamepb.careerpb.CareerLevelStat');
    types.CareerInfoGetRequest = root.lookupType('gamepb.careerpb.CareerInfoGetRequest');
    types.CareerInfoGetReply = root.lookupType('gamepb.careerpb.CareerInfoGetReply');

    // Proto 加载完成""",
    'proto career types',
)
path.write_text(text, encoding='utf-8')


# worker.js
path = Path('core/src/core/worker.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    """            case 'getDogInfo':
                result = await require('../services/dog').getDogInfoOverview();
                break;
            case 'getShopProfiles':""",
    """            case 'getDogInfo':
                result = await require('../services/dog').getDogInfoOverview();
                break;
            case 'getCareerInfo':
                result = await require('../services/career').getCareerOverview();
                break;
            case 'getShopProfiles':""",
    'worker career API case',
)
path.write_text(text, encoding='utf-8')


# data-provider.js
path = Path('core/src/runtime/data-provider.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "        getDogInfo: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getDogInfo'),\n        getShopProfiles:",
    "        getDogInfo: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getDogInfo'),\n        getCareerInfo: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCareerInfo'),\n        getShopProfiles:",
    'provider career method',
)
path.write_text(text, encoding='utf-8')


# admin.js: authenticated GET only.
path = Path('core/src/controllers/admin.js')
text = path.read_text(encoding='utf-8')
anchor = """    // API: 每日礼包状态总览
    app.get('/api/daily-gifts', async (req, res) => {"""
route = """    // API: 个人生涯（P5A 只读；不提供领奖/修改资料接口）
    app.get('/api/career/info', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            if (!provider || typeof provider.getCareerInfo !== 'function') {
                return res.status(503).json({ ok: false, error: '个人生涯只读接口不可用' });
            }
            const data = await provider.getCareerInfo(id);
            return res.json({ ok: true, data });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

"""
text = replace_once(text, anchor, route + anchor, 'admin career GET route')
path.write_text(text, encoding='utf-8')


# Personal.vue fifth tab.
path = Path('web/src/views/Personal.vue')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "import BagPanel from '@/components/BagPanel.vue'\nimport DogPanel from '@/components/DogPanel.vue'\nimport FarmPanel from '@/components/FarmPanel.vue'",
    "import BagPanel from '@/components/BagPanel.vue'\nimport CareerPanel from '@/components/CareerPanel.vue'\nimport DogPanel from '@/components/DogPanel.vue'\nimport FarmPanel from '@/components/FarmPanel.vue'",
    'personal career import',
)
text = replace_once(
    text,
    "const currentTab = ref<'farm' | 'bag' | 'task' | 'dog'>('farm')",
    "const currentTab = ref<'farm' | 'bag' | 'task' | 'dog' | 'career'>('farm')",
    'personal career tab type',
)
old_dog_button = """      <button
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
new_buttons = old_dog_button + """
      <button
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'career'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'career' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'career'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-chart-histogram text-lg" />
          <span>个人生涯</span>
        </div>
      </button>"""
text = replace_once(text, old_dog_button, new_buttons, 'personal career button')
text = replace_once(
    text,
    ":is=\"currentTab === 'farm' ? FarmPanel : (currentTab === 'bag' ? BagPanel : (currentTab === 'task' ? TaskPanel : DogPanel))\"",
    ":is=\"currentTab === 'farm' ? FarmPanel : (currentTab === 'bag' ? BagPanel : (currentTab === 'task' ? TaskPanel : (currentTab === 'dog' ? DogPanel : CareerPanel)))\"",
    'personal career component',
)
path.write_text(text, encoding='utf-8')


# self-test commands
for filename in ('core/package.json', 'package.json'):
    path = Path(filename)
    text = path.read_text(encoding='utf-8')
    if filename == 'core/package.json':
        old = '    "dog:readonly-selftest": "node scripts/dog-readonly-selftest.js",\n'
        new = old + '    "career:readonly-selftest": "node scripts/career-readonly-selftest.js",\n'
    else:
        old = '    "dog:readonly-selftest": "pnpm -C core dog:readonly-selftest",\n'
        new = old + '    "career:readonly-selftest": "pnpm -C core career:readonly-selftest",\n'
    text = replace_once(text, old, new, f'{filename} career selftest')
    path.write_text(text, encoding='utf-8')

print('P5A career read-only integration patch applied')
