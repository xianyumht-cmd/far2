const fs = require('node:fs');
const path = require('node:path');
const { ensureDataDir, getDataFile } = require('../config/runtime-paths');

const CONTROL_FILE_NAME = 'farm-window-control.json';

function getControlFile() {
    const override = String(process.env.FAR2_FARM_WINDOW_CONTROL_FILE || '').trim();
    if (override) {
        const file = path.resolve(override);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        return file;
    }

    ensureDataDir();
    return getDataFile(CONTROL_FILE_NAME);
}

function normalizeState(input = {}) {
    return {
        version: 1,
        hidden: input.hidden !== false,
        updatedAt: Number(input.updatedAt) || 0,
        updatedBy: String(input.updatedBy || ''),
    };
}

function readFarmWindowControl() {
    const file = getControlFile();
    if (!fs.existsSync(file)) return normalizeState({ hidden: true });

    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return normalizeState(parsed && typeof parsed === 'object' ? parsed : {});
    } catch {
        // Preserve the historical behavior if the control file is missing/corrupt:
        // farm windows stay hidden instead of suddenly appearing on the desktop.
        return normalizeState({ hidden: true });
    }
}

function writeFarmWindowControl(hidden, options = {}) {
    const file = getControlFile();
    const state = normalizeState({
        hidden: hidden === true,
        updatedAt: Date.now(),
        updatedBy: options.updatedBy || 'webui',
    });

    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return state;
}

module.exports = {
    CONTROL_FILE_NAME,
    getControlFile,
    readFarmWindowControl,
    writeFarmWindowControl,
};
