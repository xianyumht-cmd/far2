/**
 * 兼容层：给同源移植过来的 weather-activity 提供 ./friend/api 的形状。
 * 实现直接复用 far2 自己 services/friend.js 里的 Enter/Leave（含护主犬探测）。
 */

const friend = require('../friend');

async function enterFriendFarm(gid, _reason) {
    return friend.enterFriendFarm(gid);
}

async function leaveFriendFarm(gid) {
    return friend.leaveFriendFarm(gid);
}

module.exports = { enterFriendFarm, leaveFriendFarm };
