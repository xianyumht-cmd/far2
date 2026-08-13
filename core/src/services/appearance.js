const { getBagDetail } = require('./warehouse');

const AVATAR_FRAME_ITEM_TYPE = 10;

function buildAvatarFrameOverview(bagDetail) {
    const items = Array.isArray(bagDetail && bagDetail.items) ? bagDetail.items : [];
    const frames = items
        .filter(item => Number(item && item.itemType) === AVATAR_FRAME_ITEM_TYPE)
        .filter(item => Number(item && item.count) > 0)
        .map(item => ({
            id: Number(item.id) || 0,
            count: Math.max(0, Number(item.count) || 0),
            name: String(item.name || `头像框#${item.id || 0}`).trim(),
            image: String(item.image || ''),
            level: Math.max(0, Number(item.level) || 0),
            priceId: Math.max(0, Number(item.priceId) || 0),
            price: Math.max(0, Number(item.price) || 0),
            priceUnit: String(item.priceUnit || '').trim(),
            interactionType: String(item.interactionType || '').trim(),
            itemType: AVATAR_FRAME_ITEM_TYPE,
        }))
        .filter(item => item.id > 0)
        .sort((a, b) => {
            const levelDiff = b.level - a.level;
            if (levelDiff !== 0) return levelDiff;
            const countDiff = b.count - a.count;
            if (countDiff !== 0) return countDiff;
            return a.id - b.id;
        });

    return {
        itemType: AVATAR_FRAME_ITEM_TYPE,
        totalKinds: frames.length,
        totalCount: frames.reduce((sum, item) => sum + item.count, 0),
        frames,
        equipped: {
            supported: false,
            reason: 'equip_avatar_frames_structure_unverified',
        },
        protocol: {
            service: 'gamepb.itempb.ItemService',
            method: 'Bag',
            readOnly: true,
            source: 'existing_bag_detail',
        },
    };
}

async function getAvatarFrameOverview() {
    const bag = await getBagDetail();
    return buildAvatarFrameOverview(bag);
}

module.exports = {
    AVATAR_FRAME_ITEM_TYPE,
    buildAvatarFrameOverview,
    getAvatarFrameOverview,
};
