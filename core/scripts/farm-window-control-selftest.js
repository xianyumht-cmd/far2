const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-farm-window-'));
const controlFile = path.join(tempDir, 'farm-window-control.json');
process.env.FAR2_FARM_WINDOW_CONTROL_FILE = controlFile;

const {
    getControlFile,
    readFarmWindowControl,
    writeFarmWindowControl,
    readFarmWindowControllerStatus,
    restartFarmWindowControllers,
} = require('../src/services/farm-window-control');

function writeController(sessionId, hidden, updatedAt) {
    const file = path.join(tempDir, `farm-window-cloak-status-${sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify({
        version: 2,
        processId: 1000 + sessionId,
        sessionId,
        hidden,
        updatedAt,
    }), 'utf8');
}

try {
    assert.equal(getControlFile(), controlFile);

    const initial = readFarmWindowControl();
    assert.equal(initial.hidden, true);
    assert.equal(initial.updatedAt, 0);

    const visible = writeFarmWindowControl(false, { updatedBy: 'selftest' });
    assert.equal(visible.hidden, false);
    assert.equal(visible.updatedBy, 'selftest');
    assert.ok(visible.updatedAt > 0);
    assert.equal(readFarmWindowControl().hidden, false);

    const storedVisible = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
    assert.equal(storedVisible.hidden, false);

    writeController(1, false, Date.now());
    writeController(2, true, Date.now() - 60_000);
    let controller = readFarmWindowControllerStatus();
    assert.equal(controller.online, true);
    assert.equal(controller.onlineCount, 1);
    assert.equal(controller.totalCount, 2);
    assert.equal(controller.allApplied, true);
    assert.equal(controller.controllers[0].sessionId, 1);
    assert.equal(controller.controllers[0].online, true);
    assert.equal(controller.controllers[1].sessionId, 2);
    assert.equal(controller.controllers[1].online, false);

    const hidden = writeFarmWindowControl(true, { updatedBy: 'selftest' });
    assert.equal(hidden.hidden, true);
    assert.equal(readFarmWindowControl().hidden, true);
    controller = readFarmWindowControllerStatus();
    assert.equal(controller.allApplied, false);

    writeController(1, true, Date.now());
    controller = readFarmWindowControllerStatus();
    assert.equal(controller.allApplied, true);

    if (process.platform !== 'win32') {
        const reload = restartFarmWindowControllers();
        assert.equal(reload.supported, false);
        assert.equal(reload.reason, 'windows_only');
    }

    fs.writeFileSync(controlFile, '{partial-json', 'utf8');
    assert.equal(readFarmWindowControl().hidden, true);

    console.log('✅ farm window control state/controller self-test PASS');
} finally {
    delete process.env.FAR2_FARM_WINDOW_CONTROL_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
}
