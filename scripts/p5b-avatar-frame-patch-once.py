from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 anchor, found {count}')
    return text.replace(old, new, 1)


# worker.js
path = Path('core/src/core/worker.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    """            case 'getCareerInfo':
                result = await require('../services/career').getCareerOverview();
                break;
            case 'getShopProfiles':""",
    """            case 'getCareerInfo':
                result = await require('../services/career').getCareerOverview();
                break;
            case 'getAvatarFrames':
                result = await require('../services/appearance').getAvatarFrameOverview();
                break;
            case 'getShopProfiles':""",
    'worker avatar frame API case',
)
path.write_text(text, encoding='utf-8')


# data-provider.js
path = Path('core/src/runtime/data-provider.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "        getCareerInfo: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCareerInfo'),\n        getShopProfiles:",
    "        getCareerInfo: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCareerInfo'),\n        getAvatarFrames: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getAvatarFrames'),\n        getShopProfiles:",
    'provider avatar frame method',
)
path.write_text(text, encoding='utf-8')


# admin.js: read-only GET built on existing Bag read path.
path = Path('core/src/controllers/admin.js')
text = path.read_text(encoding='utf-8')
anchor = """    // API: 每日礼包状态总览
    app.get('/api/daily-gifts', async (req, res) => {"""
route = """    // API: 头像框库存（P5B 只读；复用 Bag，不提供使用/佩戴接口）
    app.get('/api/appearance/avatar-frames', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            if (!provider || typeof provider.getAvatarFrames !== 'function') {
                return res.status(503).json({ ok: false, error: '头像框库存只读接口不可用' });
            }
            const data = await provider.getAvatarFrames(id);
            return res.json({ ok: true, data });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

"""
text = replace_once(text, anchor, route + anchor, 'admin avatar frame GET route')
path.write_text(text, encoding='utf-8')


# Personal.vue sixth tab.
path = Path('web/src/views/Personal.vue')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "import BagPanel from '@/components/BagPanel.vue'\nimport CareerPanel from '@/components/CareerPanel.vue'",
    "import AvatarFramePanel from '@/components/AvatarFramePanel.vue'\nimport BagPanel from '@/components/BagPanel.vue'\nimport CareerPanel from '@/components/CareerPanel.vue'",
    'personal avatar frame import',
)
text = replace_once(
    text,
    "const currentTab = ref<'farm' | 'bag' | 'task' | 'dog' | 'career'>('farm')",
    "const currentTab = ref<'farm' | 'bag' | 'task' | 'dog' | 'career' | 'appearance'>('farm')",
    'personal avatar frame tab type',
)
old_career_button = """      <button
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
new_buttons = old_career_button + """
      <button
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'appearance'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'appearance' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'appearance'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-user-avatar-filled-alt text-lg" />
          <span>头像框</span>
        </div>
      </button>"""
text = replace_once(text, old_career_button, new_buttons, 'personal avatar frame button')
text = replace_once(
    text,
    ":is=\"currentTab === 'farm' ? FarmPanel : (currentTab === 'bag' ? BagPanel : (currentTab === 'task' ? TaskPanel : (currentTab === 'dog' ? DogPanel : CareerPanel)))\"",
    ":is=\"currentTab === 'farm' ? FarmPanel : (currentTab === 'bag' ? BagPanel : (currentTab === 'task' ? TaskPanel : (currentTab === 'dog' ? DogPanel : (currentTab === 'career' ? CareerPanel : AvatarFramePanel))))\"",
    'personal avatar frame component',
)
path.write_text(text, encoding='utf-8')


# self-test commands
for filename in ('core/package.json', 'package.json'):
    path = Path(filename)
    text = path.read_text(encoding='utf-8')
    if filename == 'core/package.json':
        old = '    "career:readonly-selftest": "node scripts/career-readonly-selftest.js",\n'
        new = old + '    "avatar-frame:readonly-selftest": "node scripts/avatar-frame-readonly-selftest.js",\n'
    else:
        old = '    "career:readonly-selftest": "pnpm -C core career:readonly-selftest",\n'
        new = old + '    "avatar-frame:readonly-selftest": "pnpm -C core avatar-frame:readonly-selftest",\n'
    text = replace_once(text, old, new, f'{filename} avatar frame selftest')
    path.write_text(text, encoding='utf-8')

print('P5B avatar frame read-only integration patch applied')
