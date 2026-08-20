'use strict';

const path = require('node:path');

const EXPECTED_APP_ID = 'wx5306c5978fdb76e4';
const productionCore = String(process.env.FAR2_PRODUCTION_CORE || '').trim();
const accountName = String(process.env.FAR2_WECHAT_ACCOUNT_NAME || '微信农场').trim() || '微信农场';

function emit(result, exitCode = 0) {
    process.stdout.write(`FAR2_ENROLL_RESULT=${JSON.stringify(result)}\n`);
    process.exitCode = exitCode;
}

if (!productionCore) {
    emit({ ok: false, reason: 'production_core_missing' }, 2);
    return;
}

let store;
try {
    store = require(path.join(productionCore, 'src/models/store.js'));
} catch (err) {
    emit({ ok: false, reason: 'production_store_load_failed', message: err && err.message ? err.message : String(err) }, 2);
    return;
}

try {
    const before = store.getAccounts();
    const beforeAccounts = Array.isArray(before && before.accounts) ? before.accounts : [];
    const existingWx = beforeAccounts.filter(account => String(account && account.platform || '').toLowerCase() === 'wx');
    if (existingWx.length > 0) {
        emit({ ok: false, reason: 'wx_account_already_exists', wxCount: existingWx.length }, 3);
        return;
    }

    const beforeIds = new Set(beforeAccounts.map(account => String(account && account.id || '')));
    const ownerCandidates = [...new Set(beforeAccounts
        .map(account => String(account && account.username || '').trim())
        .filter(Boolean))];
    const username = ownerCandidates.length === 1 && ownerCandidates[0].toLowerCase() === 'admin'
        ? ownerCandidates[0]
        : '';

    const added = store.addOrUpdateAccount({
        name: accountName,
        platform: 'wx',
        username,
    });
    const addedAccounts = Array.isArray(added && added.accounts) ? added.accounts : [];
    const created = addedAccounts.find(account => !beforeIds.has(String(account && account.id || '')));
    if (!created || !created.id) {
        emit({ ok: false, reason: 'new_account_id_not_found' }, 4);
        return;
    }

    const accountId = String(created.id);
    store.addOrUpdateAccount({
        id: accountId,
        platform: 'wx',
        codeRefreshEnabled: true,
        codeRefreshMode: 'windows_wechat',
        wechatAppId: EXPECTED_APP_ID,
        lastCodeRefreshAt: 0,
        lastCodeRefreshOk: false,
        lastCodeRefreshError: '',
        lastCodeRefreshReason: 'production_enrollment',
        lastCodeSource: '',
    });

    const finalData = store.getAccounts();
    const finalAccounts = Array.isArray(finalData && finalData.accounts) ? finalData.accounts : [];
    const finalAccount = finalAccounts.find(account => String(account && account.id || '') === accountId);
    const configured = !!finalAccount
        && String(finalAccount.platform || '').toLowerCase() === 'wx'
        && finalAccount.codeRefreshEnabled === true
        && String(finalAccount.codeRefreshMode || '').toLowerCase() === 'windows_wechat'
        && String(finalAccount.wechatAppId || '') === EXPECTED_APP_ID;

    if (!configured) {
        try { store.deleteAccount(accountId); } catch {}
        emit({ ok: false, reason: 'wx_account_configuration_failed' }, 5);
        return;
    }

    emit({
        ok: true,
        accountId,
        accountName: String(finalAccount.name || accountName),
        usernameAssigned: !!String(finalAccount.username || '').trim(),
        owner: String(finalAccount.username || '').trim() || 'unassigned',
        platform: 'wx',
        appId: EXPECTED_APP_ID,
        codeRefreshEnabled: true,
        codeRefreshMode: 'windows_wechat',
        initialCodeLength: String(finalAccount.code || '').length,
        totalAccounts: finalAccounts.length,
        qqAccounts: finalAccounts.filter(account => String(account && account.platform || 'qq').toLowerCase() !== 'wx').length,
    });
} catch (err) {
    emit({ ok: false, reason: 'production_enrollment_failed', message: err && err.message ? err.message : String(err) }, 6);
}
