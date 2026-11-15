/**
 * 兼容层：同源 weather-activity 通过 ./farm/land-analysis 读地块，
 * far2 的实现放在 services/farm-land-analyzer.js，这里做形状转发。
 */

const analyzer = require('../farm-land-analyzer');

module.exports = {
    buildLandMap: analyzer.buildLandMap,
    getCurrentPhase: analyzer.getCurrentPhase,
    getDisplayLandContext: analyzer.getDisplayLandContext,
    getSlaveLandIds: analyzer.getSlaveLandIds,
    hasPlantData: analyzer.hasPlantData,
};
