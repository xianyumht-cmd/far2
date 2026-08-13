from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one anchor, found {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

worker = 'core/src/core/worker.js'
dog_state = 'core/src/services/friend-dog-state.js'
selftest = 'core/scripts/friend-dog-help-priority-selftest.js'

replace_once(
    worker,
    "const { checkFriends, startFriendCheckLoop, stopFriendCheckLoop, refreshFriendCheckLoop, runBadOnceOnStartup, isHelpExpLimitReached, getFriendsList, getFriendLandsDetail, doFriendOperation } = require('../services/friend');\n",
    "const { checkFriends, startFriendCheckLoop, stopFriendCheckLoop, refreshFriendCheckLoop, runBadOnceOnStartup, isHelpExpLimitReached, getFriendsList, getFriendLandsDetail, doFriendOperation } = require('../services/friend');\nconst { getGuardDogGidSet, shouldRunHelpTickAfterExpLimit } = require('../services/friend-dog-state');\n",
)

replace_once(
    worker,
    """    // 检查是否开启了经验满不帮忙，且经验已达上限\n    const stopWhenExpLimit = !!auto.friend_help_exp_limit;\n    if (stopWhenExpLimit && isHelpExpLimitReached()) {\n        // 计算下次调度时间，但不执行巡查\n        const helpMs = randomIntervalMs(\n            CONFIG.helpCheckIntervalMin || 10000,\n            CONFIG.helpCheckIntervalMax || 10000\n        );\n        nextHelpRunAt = Date.now() + helpMs;\n        return;\n    }\n""",
    """    // 经验满后仍允许“已确认且仍有效的护主犬好友”进入 friend.js 的精确过滤。\n    // 没有已知有效护主犬时仍保持原来的跳过行为，避免额外扫描好友。\n    const stopWhenExpLimit = !!auto.friend_help_exp_limit;\n    const expLimitReached = stopWhenExpLimit && isHelpExpLimitReached();\n    const activeGuardDogCount = expLimitReached\n        ? getGuardDogGidSet(process.env.FARM_ACCOUNT_ID || '').size\n        : 0;\n    if (!shouldRunHelpTickAfterExpLimit({ stopWhenExpLimit, expLimitReached, activeGuardDogCount })) {\n        const helpMs = randomIntervalMs(\n            CONFIG.helpCheckIntervalMin || 10000,\n            CONFIG.helpCheckIntervalMax || 10000\n        );\n        nextHelpRunAt = Date.now() + helpMs;\n        return;\n    }\n""",
)

replace_once(
    dog_state,
    """function canContinueHelpAfterExpLimit(friend) {\n    return !!(friend && friend.hasGuardDog);\n}\n\nfunction clearFriendDogStateMemoryForTest() {\n""",
    """function canContinueHelpAfterExpLimit(friend) {\n    return !!(friend && friend.hasGuardDog);\n}\n\nfunction shouldRunHelpTickAfterExpLimit(options = {}) {\n    const stopWhenExpLimit = options.stopWhenExpLimit === true;\n    const expLimitReached = options.expLimitReached === true;\n    if (!stopWhenExpLimit || !expLimitReached) return true;\n    const activeGuardDogCount = Math.max(0, Number.parseInt(options.activeGuardDogCount, 10) || 0);\n    return activeGuardDogCount > 0;\n}\n\nfunction clearFriendDogStateMemoryForTest() {\n""",
)

replace_once(
    dog_state,
    """    compareHelpTargets,\n    canContinueHelpAfterExpLimit,\n    clearFriendDogStateMemoryForTest,\n""",
    """    compareHelpTargets,\n    canContinueHelpAfterExpLimit,\n    shouldRunHelpTickAfterExpLimit,\n    clearFriendDogStateMemoryForTest,\n""",
)

replace_once(
    selftest,
    """    compareHelpTargets,\n    canContinueHelpAfterExpLimit,\n} = require('../src/services/friend-dog-state');\n""",
    """    compareHelpTargets,\n    canContinueHelpAfterExpLimit,\n    shouldRunHelpTickAfterExpLimit,\n} = require('../src/services/friend-dog-state');\n""",
)

replace_once(
    selftest,
    """    assert.equal(canContinueHelpAfterExpLimit(targets[0]), true);\n    assert.equal(canContinueHelpAfterExpLimit(targets[2]), false);\n    console.log('✅ exp-limit continuation is guard-dog only PASS');\n\n    console.log('\\n=== RESULT ===');\n""",
    """    assert.equal(canContinueHelpAfterExpLimit(targets[0]), true);\n    assert.equal(canContinueHelpAfterExpLimit(targets[2]), false);\n    console.log('✅ exp-limit continuation is guard-dog only PASS');\n\n    assert.equal(shouldRunHelpTickAfterExpLimit({ stopWhenExpLimit: false, expLimitReached: true, activeGuardDogCount: 0 }), true);\n    assert.equal(shouldRunHelpTickAfterExpLimit({ stopWhenExpLimit: true, expLimitReached: false, activeGuardDogCount: 0 }), true);\n    assert.equal(shouldRunHelpTickAfterExpLimit({ stopWhenExpLimit: true, expLimitReached: true, activeGuardDogCount: 0 }), false);\n    assert.equal(shouldRunHelpTickAfterExpLimit({ stopWhenExpLimit: true, expLimitReached: true, activeGuardDogCount: 1 }), true);\n    console.log('✅ worker exp-limit gate re-enters help only for known active guard dogs PASS');\n\n    console.log('\\n=== RESULT ===');\n""",
)

print('P7C scheduler patch applied')
