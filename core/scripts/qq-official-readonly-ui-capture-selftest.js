const assert = require('node:assert/strict');
const {
    MARKER,
    capturePolicy,
    buildPayload,
    parseWire,
    phaseForTimestamp,
} = require('./qq-official-readonly-ui-capture');

function vi(value) {
    let n = Number(value) || 0;
    const out = [];
    do {
        let b = n & 0x7f;
        n = Math.floor(n / 128);
        if (n > 0) b |= 0x80;
        out.push(b);
    } while (n > 0);
    return Buffer.from(out);
}

function fieldVarint(field, value) {
    return Buffer.concat([vi(field * 8), vi(value)]);
}

function fieldBytes(field, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    return Buffer.concat([vi(field * 8 + 2), vi(bytes.length), bytes]);
}

function test(name, fn) {
    try {
        fn();
        console.log(`✅ ${name} PASS`);
    } catch (error) {
        console.error(`❌ ${name} FAIL`);
        throw error;
    }
}

function main() {
    console.log('FAR2 Official Miniapp Readonly UI Capture Self-Test');
    console.log('安全: 纯本地 fixture；不读取真实 QQ、不联网、不发送 RPC。\n');

    test('known illustrated read captures body', () => {
        const p = capturePolicy('gamepb.illustratedpb.IllustratedService', 'GetIllustratedListV2');
        assert.equal(p.capture, true);
        assert.equal(p.body, true);
        assert.equal(p.reason, 'known-read');
    });

    test('unknown read-looking service is discoverable with body', () => {
        const p = capturePolicy('gamepb.rarecroppb.RareCropService', 'GetRareIllustratedList');
        assert.equal(p.capture, true);
        assert.equal(p.body, true);
        assert.equal(p.reason, 'read-looking-method');
    });

    test('unknown mutation method is metadata-only', () => {
        const p = capturePolicy('gamepb.rarecroppb.RareCropService', 'ClaimReward');
        assert.equal(p.capture, true);
        assert.equal(p.body, false);
        assert.equal(p.reason, 'metadata-only-unknown-method');
    });

    test('login/auth/payment/report traffic is excluded', () => {
        for (const [service, method] of [
            ['gamepb.userpb.UserService', 'Login'],
            ['gamepb.authpb.AuthService', 'GetToken'],
            ['gamepb.paymentpb.PaymentService', 'GetOrder'],
            ['gamepb.reportpb.ReportService', 'List'],
        ]) {
            const p = capturePolicy(service, method);
            assert.equal(p.capture, false, `${service}.${method}`);
            assert.equal(p.body, false, `${service}.${method}`);
        }
    });

    test('non-gamepb traffic is ignored', () => {
        const p = capturePolicy('gatepb.GateService', 'GetAnything');
        assert.equal(p.capture, false);
    });

    test('payload installs outgoing and incoming hooks without custom sends', () => {
        const payload = buildPayload();
        assert.ok(payload.includes(MARKER));
        assert.ok(payload.includes("record(data,'out','WebSocket.send')"));
        assert.ok(payload.includes("'in',label+'.onMessage'"));
        assert.ok(payload.includes("'in','WebSocket.message'"));
        assert.ok(payload.includes('metadata-only-unknown-method'));
        assert.ok(payload.includes('sensitive'));
        assert.equal(payload.includes('sendMsgAsync'), false);
        assert.equal(payload.includes('fetch('), false);
        assert.equal(payload.includes('XMLHttpRequest'), false);
    });

    test('generic protobuf parser keeps varint, text and nested structure', () => {
        const nested = Buffer.concat([
            fieldVarint(1, 21037),
            fieldBytes(2, '珍稀作物'),
        ]);
        const message = Buffer.concat([
            fieldVarint(1, 2),
            fieldBytes(2, '普通图鉴'),
            fieldBytes(3, nested),
        ]);
        const fields = parseWire(message);
        assert.equal(fields[0].field, 1);
        assert.equal(fields[0].value, 2);
        assert.equal(fields[1].text, '普通图鉴');
        assert.equal(fields[2].field, 3);
        assert.ok(Array.isArray(fields[2].message));
        assert.equal(fields[2].message[0].value, 21037);
        assert.equal(fields[2].message[1].text, '珍稀作物');
    });

    test('phase attribution uses explicit user operation windows', () => {
        const phases = [
            { name: 'illustrated-all', startMs: 1000, endMs: 2000 },
            { name: 'known-1x1-detail', startMs: 2001, endMs: 3000 },
        ];
        assert.equal(phaseForTimestamp(new Date(1500).toISOString(), phases), 'illustrated-all');
        assert.equal(phaseForTimestamp(new Date(2500).toISOString(), phases), 'known-1x1-detail');
        assert.equal(phaseForTimestamp(new Date(5000).toISOString(), phases), 'outside-phase');
    });

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        realQqCacheTouched: false,
        networkTouched: false,
        rpcTouched: false,
        writeOperationTouched: false,
        loginTrafficCaptured: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error(`\n❌ Official Readonly UI Capture Self-Test FAIL: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
}
