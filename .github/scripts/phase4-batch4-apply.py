from pathlib import Path

friend_path = Path('core/src/services/friend.js')
friend = friend_path.read_text(encoding='utf-8')
old_store = """    getFriendBlacklist,
    setFriendBlacklist,
    getPlantBlacklist,"""
new_store = """    getFriendBlacklist,
    getPlantBlacklist,"""
if friend.count(old_store) != 1:
    raise SystemExit('friend store destructuring anchor changed')
friend = friend.replace(old_store, new_store, 1)
old_catch = """                    } catch (e) {
                        // 单个好友失败不影响整体"""
new_catch = """                    } catch {
                        // 单个好友失败不影响整体"""
if friend.count(old_catch) != 1:
    raise SystemExit('friend unused catch anchor changed')
friend = friend.replace(old_catch, new_catch, 1)
friend_path.write_text(friend, encoding='utf-8')

mall_path = Path('core/src/services/mall.js')
mall = mall_path.read_text(encoding='utf-8')
replacements = [
    ('const CHECK_BUY_COOLDOWN_MS = 60 * 1000;\n', ''),
    ('let lastCheckBuyAt = 0;\n', ''),
    ("    const { sleep, randomDelay } = require('../utils/utils');\n", "    const { sleep } = require('../utils/utils');\n"),
]
for old, new in replacements:
    if mall.count(old) != 1:
        raise SystemExit(f'mall anchor changed: {old.strip()}')
    mall = mall.replace(old, new, 1)
mall_path.write_text(mall, encoding='utf-8')
