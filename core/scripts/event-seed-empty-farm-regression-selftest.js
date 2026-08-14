const assert = require('node:assert/strict');
const {
  inspectSeedEvidence,
  buildBagSeedInventory,
  createEventSeedPriorityService,
} = require('../src/services/event-seed-priority');
const { shouldBlockShopFallback } = require('../src/services/event-seed-shop-guard');
const { createFarmOrchestrator } = require('../src/services/farm-orchestrator');

async function main() {
  console.log('FAR2 Event Seed Empty-Farm Regression Self-Test');
  console.log('安全: 纯 fixture，不连接 QQ、不购买、不真实种植。\\n');

  const refs = new Set([80001, 21037]);
  const fertilizer = { id: 80001, type: 7, name: '化肥(1小时)', interaction_type: 'use' };

  const fert = inspectSeedEvidence(80001, fertilizer, null, refs);
  assert.equal(fert.activityReferenced, true);
  assert.equal(fert.candidate, false);

  const unknown = inspectSeedEvidence(21037, null, null, refs);
  assert.equal(unknown.candidate, true);
  assert.equal(unknown.confidence, 'medium');

  const inv = buildBagSeedInventory([
    { id: 80001, count: 3 },
    { id: 21037, count: 28 },
  ], {
    getItemById: id => Number(id) === 80001 ? fertilizer : null,
    getPlantBySeedId: () => null,
    activityItemIds: refs,
  });
  assert.deepEqual(inv.unresolvedCandidates.map(x => x.seedId), [21037]);
  console.log('✅ fertilizer excluded; namespace unknown retained PASS');

  const service = createEventSeedPriorityService({
    getBag: async () => ({ item_bag: { items: [
      { id: 80001, count: 3 },
      { id: 21037, count: 28 },
    ] } }),
    getBagItems: r => r.item_bag.items,
    getItemById: id => Number(id) === 80001 ? fertilizer : null,
    getPlantBySeedId: () => null,
    getShopInfo: async () => ({ goods_list: [{ item_id: 20002 }] }),
    listActivityOverview: async () => ({
      activities: [{ drawInfo: { rewards: [
        { item: { id: 80001 } },
        { item: { id: 21037 } },
      ] } }],
    }),
    getBagSeedPriority: () => [],
    discoveryStateStore: { record: () => {} },
    log: () => {},
    logWarn: () => {},
    sleep: async () => {},
  });
  const prepass = await service.runBeforeShop({
    landIds: [1, 2, 3, 4],
    state: { level: 113 },
    accountId: 'fixture',
  });
  assert.deepEqual(prepass.unresolvedSeedIds, [21037]);
  assert.equal(shouldBlockShopFallback(prepass), false);
  console.log('✅ medium unknown cannot lock ordinary shop planting PASS');

  assert.equal(shouldBlockShopFallback({
    blockShopFallback: true,
    unresolvedSeedIds: [21050],
    prioritySeedIds: [],
    inspection: { inventory: { unresolvedCandidates: [{
      seedId: 21050, confidence: 'high', activityReferenced: true,
    }] } },
  }), true);
  console.log('✅ high-confidence seed evidence remains fail-closed PASS');

  const records = [];
  const orchestrator = createFarmOrchestrator({
    getAllLands: async () => ({ lands: [
      { id: 1, unlocked: true, plant: null },
      { id: 2, unlocked: true, plant: null },
    ] }),
    getUserState: () => ({ gid: 1, level: 113, gold: 99999 }),
    isAutomationOn: key => key === 'farm',
    getAutomation: () => ({ fertilizer: 'none' }),
    getPlantingStrategy: () => 'level',
    getPrioritize2x2Crops: () => false,
    getBagSeedPriority: () => [],
    getBagSeedFallbackStrategy: () => 'level',
    runPrioritized2x2Prepass: async ({ landIds }) => ({
      remainingLandIds: [...landIds], plantedLandIds: [],
    }),
    plantFromShop: async () => ({ plantedLands: [] }),
    runFertilizerByConfig: async () => ({ normal: 0, organic: 0 }),
    recordOperation: (name, count) => records.push([name, count]),
    log: () => {},
    logWarn: () => {},
    getServerTimeSec: () => 1000,
  });
  const result = await orchestrator.runFarmOperation('all');
  assert.equal(result.actions.some(x => /^种植/u.test(x)), false);
  assert.equal(records.some(([name]) => name === 'plant'), false);
  console.log('✅ zero real planting no longer reports fake 种植N PASS');

  console.log('\\n=== RESULT ===');
  console.log(JSON.stringify({
    ok: true,
    realQqTouched: false,
    realPlantRpcTouched: false,
  }, null, 2));
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
