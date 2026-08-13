from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 anchor, found {count}')
    return text.replace(old, new, 1)


# proto.js: read-only Activity aliases only. Do not expose OperateRequest/Reply.
path = Path('core/src/utils/proto.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "        getResourcePath('proto', 'careerpb.proto'),\n",
    "        getResourcePath('proto', 'careerpb.proto'),\n        getResourcePath('proto', 'activitypb.proto'),\n",
    'proto activity file load',
)
text = replace_once(
    text,
    """    // 个人生涯（P5A 只读 CareerInfoGet）
    types.CareerStatItem = root.lookupType('gamepb.careerpb.CareerStatItem');
    types.CareerLevelStat = root.lookupType('gamepb.careerpb.CareerLevelStat');
    types.CareerInfoGetRequest = root.lookupType('gamepb.careerpb.CareerInfoGetRequest');
    types.CareerInfoGetReply = root.lookupType('gamepb.careerpb.CareerInfoGetReply');

    // Proto 加载完成""",
    """    // 个人生涯（P5A 只读 CareerInfoGet）
    types.CareerStatItem = root.lookupType('gamepb.careerpb.CareerStatItem');
    types.CareerLevelStat = root.lookupType('gamepb.careerpb.CareerLevelStat');
    types.CareerInfoGetRequest = root.lookupType('gamepb.careerpb.CareerInfoGetRequest');
    types.CareerInfoGetReply = root.lookupType('gamepb.careerpb.CareerInfoGetReply');

    // 活动中心（P5C-A 只读 List/GetGroup；刻意不加载 Operate）
    types.ActivityListRequest = root.lookupType('gamepb.activitypb.ListRequest');
    types.ActivityListReply = root.lookupType('gamepb.activitypb.ListReply');
    types.ActivityGetGroupRequest = root.lookupType('gamepb.activitypb.GetGroupRequest');
    types.ActivityGetGroupReply = root.lookupType('gamepb.activitypb.GetGroupReply');
    types.ActivityInfo = root.lookupType('gamepb.activitypb.ActivityInfo');
    types.ActivityNode = root.lookupType('gamepb.activitypb.ActivityNode');
    types.ActivityRandomShopInfo = root.lookupType('gamepb.activitypb.RandomShopInfo');
    types.ActivityExchangeShopInfo = root.lookupType('gamepb.activitypb.ExchangeShopInfo');
    types.ActivityDrawInfo = root.lookupType('gamepb.activitypb.DrawInfo');

    // Proto 加载完成""",
    'proto activity aliases',
)
path.write_text(text, encoding='utf-8')


# worker.js
path = Path('core/src/core/worker.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    """            case 'getAvatarFrames':
                result = await require('../services/appearance').getAvatarFrameOverview();
                break;
            case 'getShopProfiles':""",
    """            case 'getAvatarFrames':
                result = await require('../services/appearance').getAvatarFrameOverview();
                break;
            case 'listActivities':
                result = await require('../services/activity-readonly').listActivityOverview();
                break;
            case 'getShopProfiles':""",
    'worker activity case',
)
path.write_text(text, encoding='utf-8')


# data-provider.js
path = Path('core/src/runtime/data-provider.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "        getAvatarFrames: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getAvatarFrames'),\n        getShopProfiles:",
    "        getAvatarFrames: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getAvatarFrames'),\n        listActivities: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'listActivities'),\n        getShopProfiles:",
    'provider activity method',
)
path.write_text(text, encoding='utf-8')


# admin.js: account-scoped GET only.
path = Path('core/src/controllers/admin.js')
text = path.read_text(encoding='utf-8')
anchor = """    // API: 每日礼包状态总览
    app.get('/api/daily-gifts', async (req, res) => {"""
route = """    // API: 活动发现层（P5C-A 只读；仅 ActivityService.List，无 Operate）
    app.get('/api/activities', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            if (!provider || typeof provider.listActivities !== 'function') {
                return res.status(503).json({ ok: false, error: '活动只读发现接口不可用' });
            }
            const data = await provider.listActivities(id);
            return res.json({ ok: true, data });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

"""
text = replace_once(text, anchor, route + anchor, 'admin activity GET route')
path.write_text(text, encoding='utf-8')


# menu.ts: top-level activity center after Catalog.
path = Path('web/src/router/menu.ts')
text = path.read_text(encoding='utf-8')
anchor = """  {
    path: 'catalog',
    name: 'catalog',
    label: '图鉴',
    icon: 'i-carbon-book',
    component: () => import('@/views/Catalog.vue'),
  },
  {
    path: 'personal',"""
replacement = """  {
    path: 'catalog',
    name: 'catalog',
    label: '图鉴',
    icon: 'i-carbon-book',
    component: () => import('@/views/Catalog.vue'),
  },
  {
    path: 'activities',
    name: 'activities',
    label: '活动',
    icon: 'i-carbon-events',
    component: () => import('@/views/Activities.vue'),
  },
  {
    path: 'personal',"""
text = replace_once(text, anchor, replacement, 'activity menu item')
path.write_text(text, encoding='utf-8')


# self-test commands
for filename in ('core/package.json', 'package.json'):
    path = Path(filename)
    text = path.read_text(encoding='utf-8')
    if filename == 'core/package.json':
        old = '    "avatar-frame:readonly-selftest": "node scripts/avatar-frame-readonly-selftest.js",\n'
        new = old + '    "activity:readonly-selftest": "node scripts/activity-readonly-selftest.js",\n'
    else:
        old = '    "avatar-frame:readonly-selftest": "pnpm -C core avatar-frame:readonly-selftest",\n'
        new = old + '    "activity:readonly-selftest": "pnpm -C core activity:readonly-selftest",\n'
    text = replace_once(text, old, new, f'{filename} activity selftest')
    path.write_text(text, encoding='utf-8')

print('P5C activity read-only integration patch applied')
