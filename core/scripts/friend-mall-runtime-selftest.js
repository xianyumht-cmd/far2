const assert = require('node:assert/strict');

const networkPath = require.resolve('../src/utils/network');
const friendPath = require.resolve('../src/services/friend');
const mallPath = require.resolve('../src/services/mall');
const network = require(networkPath);
const { types } = require('../src/utils/proto');

async function testFriendApplicationsRpc() {
    const originalSendMsgAsync = network.sendMsgAsync;
    let calls = 0;
    try {
        network.sendMsgAsync = async (service, method, body) => {
            calls += 1;
            assert.equal(service, 'gamepb.friendpb.FriendService');
            assert.equal(method, 'GetApplications');
            types.GetApplicationsRequest.decode(body);
            const reply = types.GetApplicationsReply.create({
                applications: [{ gid: 12345, name: '测试好友', level: 9 }],
                block_applications: false,
            });
            return { body: types.GetApplicationsReply.encode(reply).finish() };
        };

        delete require.cache[friendPath];
        const { getApplications } = require(friendPath);
        assert.equal(typeof getApplications, 'function');
        const reply = await getApplications();
        assert.equal(calls, 1);
        assert.equal(reply.applications.length, 1);
        assert.equal(Number(reply.applications[0].gid), 12345);
        assert.equal(reply.applications[0].name, '测试好友');
    } finally {
        network.sendMsgAsync = originalSendMsgAsync;
        delete require.cache[friendPath];
    }
}

async function testOrganicMallPurchaseSuccessPath() {
    const originalSendMsgAsync = network.sendMsgAsync;
    const originalGetUserState = network.getUserState;
    let purchaseCalls = 0;
    try {
        network.getUserState = () => ({ ticket: 1 });
        network.sendMsgAsync = async (service, method, body) => {
            assert.equal(service, 'gamepb.mallpb.MallService');
            if (method === 'GetMallListBySlotType') {
                const request = types.GetMallListBySlotTypeRequest.decode(body);
                assert.equal(request.slot_type, 1);
                const goods = types.MallGoods.create({
                    goods_id: 1002,
                    name: '有机化肥',
                    price: Buffer.from([0x10, 0x01]),
                });
                const reply = types.GetMallListBySlotTypeResponse.create({
                    goods_list: [types.MallGoods.encode(goods).finish()],
                });
                return { body: types.GetMallListBySlotTypeResponse.encode(reply).finish() };
            }
            if (method === 'Purchase') {
                const request = types.PurchaseRequest.decode(body);
                assert.equal(request.goods_id, 1002);
                assert.equal(request.count, 1);
                purchaseCalls += 1;
                const reply = types.PurchaseResponse.create({ goods_id: 1002, count: 1 });
                return { body: types.PurchaseResponse.encode(reply).finish() };
            }
            throw new Error(`unexpected mall method: ${method}`);
        };

        delete require.cache[mallPath];
        const mall = require(mallPath);
        const bought = await mall.autoBuyOrganicFertilizer(true);
        assert.equal(bought, 1);
        assert.equal(purchaseCalls, 1);
    } finally {
        network.sendMsgAsync = originalSendMsgAsync;
        network.getUserState = originalGetUserState;
        delete require.cache[mallPath];
    }
}

async function main() {
    console.log('FAR2 Friend Applications + Mall Purchase Runtime Regression Self-Test');
    console.log('安全: 使用真实 protobuf + fake sendMsgAsync，不连接 QQ、不进行真实购买。\n');
    await testFriendApplicationsRpc();
    console.log('✅ pending friend applications GetApplications RPC PASS');
    await testOrganicMallPurchaseSuccessPath();
    console.log('✅ organic fertilizer successful purchase path PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        realQqTouched: false,
        realPurchaseTouched: false,
        friendApplicationsRpcCovered: true,
        organicPurchaseSuccessCovered: true,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Friend/Mall Runtime Regression Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
