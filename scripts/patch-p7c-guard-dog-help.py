from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)

# ----- core/src/services/friend.js -----
p = Path('core/src/services/friend.js')
s = p.read_text(encoding='utf-8')

s = replace_once(
    s,
    "const { buildFriendDogProbe } = require('./friend-dog-probe');\n",
    "const { buildFriendDogProbe } = require('./friend-dog-probe');\nconst {\n    rememberFriendDogProbe,\n    getFriendDogInfo,\n    getGuardDogGidSet,\n    compareHelpTargets,\n    canContinueHelpAfterExpLimit,\n} = require('./friend-dog-state');\n",
    'friend import',
)

old_enter = """    const reply = types.VisitEnterReply.decode(replyBody);\n    // 协议发现只复用这次 Enter 的 raw reply，不增加任何 Visit/Dog 请求。\n    // field 3 的内部结构未被真实回包确认前，只保留 wire 摘要，不猜 Dog DTO。\n    Object.defineProperty(reply, '__far2BriefDogProbe', {\n        value: buildFriendDogProbe(replyBody),\n        enumerable: false,\n        configurable: false,\n        writable: false,\n    });\n    return reply;\n"""
new_enter = """    const reply = types.VisitEnterReply.decode(replyBody);\n    // 复用本次 Enter 的 raw reply 学习好友护主犬状态，不增加任何 Visit/Dog 请求。\n    const dogProbe = buildFriendDogProbe(replyBody);\n    const accountId = process.env.FARM_ACCOUNT_ID || '';\n    const dogInfo = rememberFriendDogProbe(accountId, friendGid, dogProbe, getServerTimeSec());\n    if (Array.isArray(friendsListCache)) {\n        const cachedFriend = friendsListCache.find(item => toNum(item && item.gid) === toNum(friendGid));\n        if (cachedFriend) {\n            cachedFriend.dogId = dogInfo ? dogInfo.dogId : 0;\n            cachedFriend.dogRemainingSeconds = dogInfo ? dogInfo.remainingSeconds : 0;\n            cachedFriend.hasGuardDog = !!(dogInfo && dogInfo.hasGuardDog);\n        }\n    }\n    Object.defineProperty(reply, '__far2BriefDogProbe', {\n        value: dogProbe,\n        enumerable: false,\n        configurable: false,\n        writable: false,\n    });\n    return reply;\n"""
s = replace_once(s, old_enter, new_enter, 'enterFriendFarm dog cache')

old_map = """        const reply = await getAllFriends(forceSync);\n        const friends = reply.game_friends || [];\n        const state = getUserState();\n        const result = friends\n            .filter(f => toNum(f.gid) !== state.gid && f.name !== '小小农夫' && f.remark !== '小小农夫')\n            .map(f => ({\n                gid: toNum(f.gid),\n                name: f.remark || f.name || `GID:${toNum(f.gid)}`,\n                avatarUrl: String(f.avatar_url || '').trim(),\n                level: toNum(f.level),\n                gold: toNum(f.gold),\n                plant: f.plant ? {\n                    stealNum: toNum(f.plant.steal_plant_num),\n                    dryNum: toNum(f.plant.dry_num),\n                    weedNum: toNum(f.plant.weed_num),\n                    insectNum: toNum(f.plant.insect_num),\n                } : null,\n            }))\n"""
new_map = """        const reply = await getAllFriends(forceSync);\n        const friends = reply.game_friends || [];\n        const state = getUserState();\n        const accountId = process.env.FARM_ACCOUNT_ID || '';\n        const nowSec = getServerTimeSec();\n        const result = friends\n            .filter(f => toNum(f.gid) !== state.gid && f.name !== '小小农夫' && f.remark !== '小小农夫')\n            .map(f => {\n                const gid = toNum(f.gid);\n                const dogInfo = getFriendDogInfo(accountId, gid, nowSec);\n                return {\n                    gid,\n                    name: f.remark || f.name || `GID:${gid}`,\n                    avatarUrl: String(f.avatar_url || '').trim(),\n                    level: toNum(f.level),\n                    gold: toNum(f.gold),\n                    dogId: dogInfo ? dogInfo.dogId : 0,\n                    dogRemainingSeconds: dogInfo ? dogInfo.remainingSeconds : 0,\n                    hasGuardDog: !!(dogInfo && dogInfo.hasGuardDog),\n                    plant: f.plant ? {\n                        stealNum: toNum(f.plant.steal_plant_num),\n                        dryNum: toNum(f.plant.dry_num),\n                        weedNum: toNum(f.plant.weed_num),\n                        insectNum: toNum(f.plant.insect_num),\n                    } : null,\n                };\n            })\n"""
s = replace_once(s, old_map, new_map, 'friends list dog DTO')

s = replace_once(
    s,
    "async function visitFriendForHelp(friend, totalActions, myGid, accountId, ignoreExpLimit = false) {\n",
    "async function visitFriendForHelp(friend, totalActions, myGid, accountId, ignoreExpLimit = false, continueAfterExpLimit = false) {\n",
    'visitFriendForHelp signature',
)

old_limit = """    const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;\n    if (!stopWhenExpLimit) canGetHelpExp = true;\n    if (stopWhenExpLimit && !canGetHelpExp) {\n        return { acted: false, entered: false };\n    }\n"""
new_limit = """    const configuredExpLimit = !!isAutomationOn('friend_help_exp_limit');\n    const stopWhenExpLimit = configuredExpLimit && !ignoreExpLimit;\n    if (!configuredExpLimit || ignoreExpLimit) canGetHelpExp = true;\n    if (stopWhenExpLimit && !continueAfterExpLimit && !canGetHelpExp) {\n        return { acted: false, entered: false };\n    }\n"""
s = replace_once(s, old_limit, new_limit, 'visitFriendForHelp exp setup')

s = replace_once(
    s,
    "        const allowByExp = (!stopWhenExpLimit) || (canGetExpByCandidates(op.expIds) && canGetHelpExp);\n",
    "        const allowByExp = continueAfterExpLimit || (!stopWhenExpLimit) || (canGetExpByCandidates(op.expIds) && canGetHelpExp);\n",
    'visitFriendForHelp exp allow',
)

old_lists = """        const blacklist = new Set(getFriendBlacklist(accountId));\n\n        const stealFriends = [];\n        const helpFriends = [];\n"""
new_lists = """        const blacklist = new Set(getFriendBlacklist(accountId));\n        const guardDogGidSet = getGuardDogGidSet(accountId, getServerTimeSec());\n\n        const stealFriends = [];\n        const helpFriends = [];\n"""
s = replace_once(s, old_lists, new_lists, 'guard dog set')

old_help_push = """            if ((dryNum > 0 || weedNum > 0 || insectNum > 0) && effectiveHelpEnabled) {\n                helpFriends.push({ gid, name, dryNum, weedNum, insectNum });\n            }\n"""
new_help_push = """            if ((dryNum > 0 || weedNum > 0 || insectNum > 0) && effectiveHelpEnabled) {\n                const hasGuardDog = guardDogGidSet.has(gid);\n                helpFriends.push({ gid, name, dryNum, weedNum, insectNum, hasGuardDog });\n            }\n"""
s = replace_once(s, old_help_push, new_help_push, 'help target dog flag')

old_sort = """        // 排序：帮助需求多的优先\n        helpFriends.sort((a, b) => {\n            const helpA = a.dryNum + a.weedNum + a.insectNum;\n            const helpB = b.dryNum + b.weedNum + b.insectNum;\n            return helpB - helpA;\n        });\n"""
new_sort = """        // 排序：已确认有护主犬的好友优先，其次按帮助需求数量。\n        helpFriends.sort(compareHelpTargets);\n"""
s = replace_once(s, old_sort, new_sort, 'help dog sort')

old_loop = """                // 检查是否还能获得帮助经验\n                // const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit');\n                const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;\n                if (stopWhenExpLimit && !canGetHelpExp) {\n                    log('好友', `批量帮助中断：经验已达上限`, { module: 'friend', event: '批量帮助中断', reason: 'exp_limit' });\n                    break;\n                }\n\n                try {\n                    // await visitFriendForHelp(friend, totalActions, state.gid, state.accountId);\n                    await visitFriendForHelp(friend, totalActions, state.gid, state.accountId, ignoreExpLimit);\n                    log('好友', `批量帮助第 ${i + 1} 个好友完成: ${friend.name}`, { module: 'friend', event: '批量帮助完成', index: i + 1, friendName: friend.name });\n"""
new_loop = """                // 经验达到上限后，仅继续帮助已确认仍有有效护主犬的好友。\n                const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;\n                const expLimitReached = stopWhenExpLimit && !canGetHelpExp;\n                if (expLimitReached && !canContinueHelpAfterExpLimit(friend)) {\n                    log('好友', `批量帮助中断：经验已达上限，护主犬好友已优先处理完毕`, {\n                        module: 'friend', event: '批量帮助中断', reason: 'exp_limit_non_guard_dog'\n                    });\n                    break;\n                }\n\n                try {\n                    await visitFriendForHelp(\n                        friend,\n                        totalActions,\n                        state.gid,\n                        state.accountId,\n                        ignoreExpLimit,\n                        !!friend.hasGuardDog,\n                    );\n                    log('好友', `批量帮助第 ${i + 1} 个好友完成: ${friend.name}${friend.hasGuardDog ? ' [护主犬优先]' : ''}`, {\n                        module: 'friend', event: '批量帮助完成', index: i + 1, friendName: friend.name, hasGuardDog: !!friend.hasGuardDog\n                    });\n"""
s = replace_once(s, old_loop, new_loop, 'help loop guard dog continuation')

p.write_text(s, encoding='utf-8')

# ----- web/src/stores/friend.ts -----
p = Path('web/src/stores/friend.ts')
s = p.read_text(encoding='utf-8')

anchor = """  function syncFriendPlantSummary(friendId: string, lands: any[], summary: any) {\n    const key = String(friendId)\n    const idx = friends.value.findIndex(f => String(f?.gid || '') === key)\n    if (idx < 0)\n      return\n\n    const nextPlant = buildPlantSummaryFromDetail(lands, summary)\n    friends.value[idx] = {\n      ...friends.value[idx],\n      plant: nextPlant,\n    }\n  }\n"""
addition = anchor + """\n  function syncFriendDogSummary(friendId: string, probe: any) {\n    const key = String(friendId)\n    const idx = friends.value.findIndex(f => String(f?.gid || '') === key)\n    if (idx < 0)\n      return\n\n    const dogId = Number(probe?.dogId) || 0\n    const remainingSeconds = Math.max(0, Number(probe?.remainingSeconds) || 0)\n    friends.value[idx] = {\n      ...friends.value[idx],\n      dogId,\n      dogRemainingSeconds: remainingSeconds,\n      hasGuardDog: dogId === 90021 && remainingSeconds > 0,\n    }\n  }\n"""
s = replace_once(s, anchor, addition, 'friend store dog sync helper')

old_fetch = """        friendLands.value[friendId] = lands\n        friendDogProbes.value[friendId] = res.data.data.dogProbe || null\n        syncFriendPlantSummary(friendId, lands, summary)\n"""
new_fetch = """        friendLands.value[friendId] = lands\n        friendDogProbes.value[friendId] = res.data.data.dogProbe || null\n        syncFriendPlantSummary(friendId, lands, summary)\n        syncFriendDogSummary(friendId, friendDogProbes.value[friendId])\n"""
s = replace_once(s, old_fetch, new_fetch, 'friend store apply dog summary')
p.write_text(s, encoding='utf-8')

# ----- web/src/views/Friends.vue -----
p = Path('web/src/views/Friends.vue')
s = p.read_text(encoding='utf-8')

s = replace_once(
    s,
    "const searchKeyword = ref('')\n",
    "const searchKeyword = ref('')\nconst guardDogOnly = ref(false)\n",
    'Friends guard filter state',
)

old_filtered = """const filteredFriends = computed(() => {\n  const keyword = searchKeyword.value.trim().toLowerCase()\n  const list = sortedFriends.value\n  if (!keyword)\n    return list\n\n  return list.filter((friend: any) => {\n    const name = String(friend?.name || '').toLowerCase()\n    const gid = String(friend?.gid || '')\n    const uin = String(friend?.uin || '')\n    return name.includes(keyword) || gid.includes(keyword) || uin.includes(keyword)\n  })\n})\n"""
new_filtered = """const guardDogFriendCount = computed(() => friends.value.filter((friend: any) => !!friend?.hasGuardDog).length)\n\nconst filteredFriends = computed(() => {\n  const keyword = searchKeyword.value.trim().toLowerCase()\n  let list = sortedFriends.value\n  if (guardDogOnly.value)\n    list = list.filter((friend: any) => !!friend?.hasGuardDog)\n  if (!keyword)\n    return list\n\n  return list.filter((friend: any) => {\n    const name = String(friend?.name || '').toLowerCase()\n    const gid = String(friend?.gid || '')\n    const uin = String(friend?.uin || '')\n    return name.includes(keyword) || gid.includes(keyword) || uin.includes(keyword)\n  })\n})\n"""
s = replace_once(s, old_filtered, new_filtered, 'Friends dog filter computed')

s = replace_once(
    s,
    "watch(searchKeyword, () => {\n  currentPage.value = 1\n})\n",
    "watch([searchKeyword, guardDogOnly], () => {\n  currentPage.value = 1\n})\n",
    'Friends filter watch',
)

old_toolbar = """          <div class=\"flex flex-wrap items-center gap-2 rounded-lg bg-white p-3 shadow dark:bg-gray-800\">\n            <div class=\"flex-1\" />\n            <button\n              class=\"rounded bg-gray-100 px-3 py-1.5 text-sm text-gray-600 transition dark:bg-gray-700 hover:bg-gray-200 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-600\"\n              :disabled=\"loading\"\n              @click=\"handleRefreshFriends\"\n            >\n"""
new_toolbar = """          <div class=\"flex flex-wrap items-center gap-2 rounded-lg bg-white p-3 shadow dark:bg-gray-800\">\n            <button\n              class=\"rounded px-3 py-1.5 text-sm transition\"\n              :class=\"guardDogOnly\n                ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'\n                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'\"\n              @click=\"guardDogOnly = !guardDogOnly\"\n            >\n              护主犬 {{ guardDogFriendCount }}\n            </button>\n            <span class=\"text-xs text-gray-400\">访问好友后自动学习，不额外扫描</span>\n            <div class=\"flex-1\" />\n            <button\n              class=\"rounded bg-gray-100 px-3 py-1.5 text-sm text-gray-600 transition dark:bg-gray-700 hover:bg-gray-200 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-600\"\n              :disabled=\"loading\"\n              @click=\"handleRefreshFriends\"\n            >\n"""
s = replace_once(s, old_toolbar, new_toolbar, 'Friends guard toolbar')

old_badge = """                    <span v-if=\"blacklistGidSet.has(Number(friend.gid))\" class=\"rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400\">已屏蔽</span>\n"""
new_badge = old_badge + """                    <span\n                      v-if=\"friend.hasGuardDog\"\n                      class=\"rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700 dark:bg-violet-900/30 dark:text-violet-300\"\n                    >\n                      护主犬\n                    </span>\n"""
s = replace_once(s, old_badge, new_badge, 'Friends guard badge')
p.write_text(s, encoding='utf-8')

# ----- package scripts -----
for package_path, script_value in [
    ('core/package.json', 'node scripts/friend-dog-help-priority-selftest.js'),
    ('package.json', 'pnpm -C core friend:dog-help-selftest'),
]:
    p = Path(package_path)
    s = p.read_text(encoding='utf-8')
    anchor = '    "friend:dog-probe-selftest": '
    idx = s.find(anchor)
    if idx < 0:
        raise SystemExit(f'{package_path}: dog probe script anchor missing')
    line_end = s.find('\n', idx)
    insert = f'    "friend:dog-help-selftest": "{script_value}",\n'
    s = s[:line_end + 1] + insert + s[line_end + 1:]
    p.write_text(s, encoding='utf-8')
