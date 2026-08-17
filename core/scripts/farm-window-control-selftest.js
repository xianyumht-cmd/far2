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
} = require('../src/services/farm-window-control');

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

    const hidden = writeFarmWindowControl(true, { updatedBy: 'selftest' });
    assert.equal(hidden.hidden, true);
    assert.equal(readFarmWindowControl().hidden, true);

    fs.writeFileSync(controlFile, '{partial-json', 'utf8');
    assert.equal(readFarmWindowControl().hidden, true);

    console.log('✅ farm window control state self-test PASS');
} finally {
    delete process.env.FAR2_FARM_WINDOW_CONTROL_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
}
