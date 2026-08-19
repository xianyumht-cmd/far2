'use strict';

// WorkerThread mode loads this bootstrap so the Windows WeChat gateway profile
// is installed before worker.js imports the shared network module.
require('../services/wechat-gateway-profile');
require('./worker');
