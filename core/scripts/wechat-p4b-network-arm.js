'use strict';

const WebSocket = require('ws');

const ORIGINAL_SEND = WebSocket.prototype.send;
const TARGET_RE = /^ws:\/\/(?:127\.0\.0\.1|localhost):62000\/?$/i;
const SYNTHETIC_MARKER = '__far2_p4b_network_arm__';
const RETRY_MS = 25;
const MAX_ARM_MS = 30000;

function parseJson(data) {
  try {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function install() {
  if (WebSocket.prototype.__far2P4bNetworkArmInstalled) return;
  Object.defineProperty(WebSocket.prototype, '__far2P4bNetworkArmInstalled', {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  WebSocket.prototype.send = function far2P4bArmedSend(data, ...args) {
    const msg = parseJson(data);
    const url = String(this && this.url || '');

    if (
      msg
      && msg.method === 'Network.enable'
      && Number.isFinite(Number(msg.id))
      && TARGET_RE.test(url)
      && !this.__far2P4bNetworkArmState
    ) {
      const ws = this;
      const commandId = Number(msg.id);
      const state = {
        commandId,
        stopped: false,
        syntheticSent: false,
        interval: null,
        timeout: null,
      };
      this.__far2P4bNetworkArmState = state;

      const stop = () => {
        if (state.stopped) return;
        state.stopped = true;
        if (state.interval) clearInterval(state.interval);
        if (state.timeout) clearTimeout(state.timeout);
        try { ws.off('message', onMessage); } catch {}
      };

      const onMessage = (incoming, _isBinary, marker) => {
        if (marker === SYNTHETIC_MARKER) return;
        const response = parseJson(incoming);
        if (response && Number(response.id) === commandId) stop();
      };

      const sendReal = () => {
        if (state.stopped || ws.readyState !== WebSocket.OPEN) return;
        try { ORIGINAL_SEND.call(ws, data, ...args); } catch {}
      };

      ws.on('message', onMessage);
      sendReal();
      state.interval = setInterval(sendReal, RETRY_MS);
      state.timeout = setTimeout(stop, MAX_ARM_MS);

      // WMPFDebugger only forwards CDP commands while a miniapp debug client is
      // connected. P4B has to be armed before the user opens the farm, so let
      // the caller proceed while the real Network.enable command keeps retrying
      // in the background. The synthetic response never leaves this Node process.
      setImmediate(() => {
        if (state.stopped || state.syntheticSent || ws.readyState !== WebSocket.OPEN) return;
        state.syntheticSent = true;
        const synthetic = Buffer.from(JSON.stringify({ id: commandId, result: { far2ArmPending: true } }));
        ws.emit('message', synthetic, false, SYNTHETIC_MARKER);
      });
      return;
    }

    return ORIGINAL_SEND.call(this, data, ...args);
  };
}

install();
