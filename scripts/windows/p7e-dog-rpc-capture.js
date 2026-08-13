const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const outDir = path.join(os.tmpdir(), 'FAR2-P7E');
fs.mkdirSync(outDir, { recursive: true });
process.chdir(outDir);
require(path.resolve(__dirname, '../../core/scripts/qq-dog-rpc-capture.js'));
