from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, got {count}: {old!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once(
    'core/scripts/qq-session-recovery-test.js',
    "  const offline = await waitUntil(() => {",
    "  await waitUntil(() => {",
)

replace_once(
    'core/src/controllers/admin.js',
    "const crypto = require('node:crypto');\n",
    "",
)
replace_once(
    'core/src/controllers/admin.js',
    "const hashPassword = (pwd) => crypto.createHash('sha256').update(String(pwd || '')).digest('hex');\n",
    "",
)
replace_once(
    'core/src/controllers/admin.js',
    "        } catch (e) {\n            // 忽略获取好友列表失败\n",
    "        } catch {\n            // 忽略获取好友列表失败\n",
)
replace_once(
    'core/src/controllers/admin.js',
    "        } catch (e) {\n            // 忽略获取好友列表失败\n",
    "        } catch {\n            // 忽略获取好友列表失败\n",
)

replace_once(
    'core/src/controllers/catalog-api.js',
    "        let tracked;\n        tracked = run.finally(() => {",
    "        const tracked = run.finally(() => {",
)

replace_once(
    'core/src/core/worker.js',
    "const { getAutomation, getPreferredSeed, getConfigSnapshot, applyConfigSnapshot, getFertilizerBuyType, getFertilizerBuyCount } = require('../models/store');",
    "const { getAutomation, getPreferredSeed, getConfigSnapshot, applyConfigSnapshot } = require('../models/store');",
)
replace_once(
    'core/src/core/worker.js',
    "const { autoBuyOrganicFertilizer, autoBuyFertilizer, checkAndBuyFertilizerBoth, buyFreeGifts, getFreeGiftDailyState } = require('../services/mall');",
    "const { autoBuyFertilizer, checkAndBuyFertilizerBoth, buyFreeGifts, getFreeGiftDailyState } = require('../services/mall');",
)
replace_once(
    'core/src/core/worker.js',
    "const { setInitialValues, resetSessionGains, recordOperation, initStatsWithPersistence, saveStats } = require('../services/stats');",
    "const { resetSessionGains, recordOperation, initStatsWithPersistence, saveStats } = require('../services/stats');",
)

replace_once(
    'core/src/models/store.js',
    "    } catch (e) {\n        // 忽略读取错误\n",
    "    } catch {\n        // 忽略读取错误\n",
)
replace_once(
    'core/src/models/store.js',
    "    } catch (e) {\n        // 忽略写入错误\n",
    "    } catch {\n        // 忽略写入错误\n",
)

replace_once(
    'core/src/models/user-store.js',
    "    } catch (e) {\n        loginLogs = [];\n",
    "    } catch {\n        loginLogs = [];\n",
)

replace_once(
    'core/src/runtime/runtime-engine.js',
    "const { updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig } = require('../config/config')",
    "const { updateRuntimeConfig } = require('../config/config')",
)

replace_once(
    'core/src/services/startup-crop-registry.js',
    "    getPlantByFruitId,\n",
    "",
)

replace_once(
    'core/src/utils/crypto-wasm.js',
    "                try { exports.E(); } catch (e) { }",
    "                try { exports.E(); } catch { }",
)

print('phase4 batch5 exact cleanup patch applied')
