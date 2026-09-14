const { createReleaseUpdater } = require('../services/release-updater');

let sharedUpdater = null;

function getUpdater() {
    if (!sharedUpdater) sharedUpdater = createReleaseUpdater();
    return sharedUpdater;
}

function isAdmin(req) {
    return !!(req && req.currentUser && req.currentUser.role === 'admin');
}

function requireAdmin(req, res) {
    if (isAdmin(req)) return true;
    res.status(403).json({ ok: false, error: '仅管理员可以检查或执行系统升级', errorCode: 'admin_required' });
    return false;
}

function sendError(res, error, fallbackCode) {
    const status = error && error.code === 'update_busy' ? 409 : 400;
    return res.status(status).json({
        ok: false,
        error: error && error.message ? error.message : String(error || 'unknown'),
        errorCode: error && error.code ? error.code : fallbackCode,
    });
}

function sendAccepted(res, updater, result) {
    if (!result.accepted) {
        return res.status(409).json({ ok: false, error: '已有升级任务正在执行', errorCode: result.reason || 'update_busy' });
    }
    return res.status(202).json({
        ok: true,
        data: {
            accepted: true,
            action: result.action,
            transport: result.transport,
            status: updater.status(),
        },
    });
}

function registerUpdateApi(app, options = {}) {
    if (!app) throw new Error('Update API requires express app');
    const updater = options.updater || getUpdater();

    app.get('/api/admin/update/status', (req, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            return res.json({ ok: true, data: updater.status() });
        } catch (error) {
            return sendError(res, error, 'update_status_failed');
        }
    });

    app.post('/api/admin/update/check', (req, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            return sendAccepted(res, updater, updater.beginCheck());
        } catch (error) {
            return sendError(res, error, 'update_check_failed');
        }
    });

    app.post('/api/admin/update/apply', (req, res) => {
        if (!requireAdmin(req, res)) return;
        try {
            return sendAccepted(res, updater, updater.beginApply());
        } catch (error) {
            return sendError(res, error, 'update_apply_failed');
        }
    });
}

module.exports = {
    registerUpdateApi,
    requireAdmin,
};
