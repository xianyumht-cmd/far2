'use strict';

// P4 diagnostic compatibility shim.
//
// The original P4 gateway probe sent the first Login frame from the WebSocket
// `open` callback, resolved that promise, and only then attached the `message`
// listener used to receive the Login reply. A fast gateway can reply (and even
// close) inside that gap, making a successful/failed Login response invisible
// to the probe.
//
// Defer only the FIRST send on the exact FAR2 farm gateway socket to the next
// event-loop turn. The awaiting code attaches its response listener before the
// bytes are actually sent. This does not inspect, print, persist, or modify the
// frame contents.

const WebSocket = require('ws');

const marker = Symbol.for('far2.wechat.p4.gateway-racefix');

if (!WebSocket.prototype[marker]) {
  const originalSend = WebSocket.prototype.send;

  Object.defineProperty(WebSocket.prototype, marker, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  WebSocket.prototype.send = function far2P4GatewayRaceSafeSend(...args) {
    const url = String(this && this.url || '');
    const isFarmGateway = url.startsWith('wss://gate-obt.nqf.qq.com/prod/ws');

    if (isFarmGateway && !this.__far2P4FirstGatewaySendDeferred) {
      this.__far2P4FirstGatewaySendDeferred = true;
      setImmediate(() => {
        try {
          Reflect.apply(originalSend, this, args);
        } catch (err) {
          try { this.emit('error', err); } catch {}
        }
      });
      return undefined;
    }

    return Reflect.apply(originalSend, this, args);
  };
}
