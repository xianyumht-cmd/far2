from pathlib import Path

friend_path = Path('core/src/services/friend.js')
friend = friend_path.read_text(encoding='utf-8')
marker = 'async function acceptFriends(gids) {'
if friend.count(marker) != 1:
    raise SystemExit('friend acceptFriends anchor changed')
if 'async function getApplications() {' in friend:
    raise SystemExit('getApplications already exists')
implementation = """async function getApplications() {
    if (!types.GetApplicationsRequest || !types.GetApplicationsReply) {
        throw new Error('GetApplications 接口类型未加载');
    }
    const body = types.GetApplicationsRequest.encode(types.GetApplicationsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetApplications', body);
    return types.GetApplicationsReply.decode(replyBody);
}

"""
friend = friend.replace(marker, implementation + marker, 1)
export_anchor = '    getFriendsList,\n    getFriendLandsDetail,'
if friend.count(export_anchor) != 1:
    raise SystemExit('friend export anchor changed')
friend = friend.replace(export_anchor, '    getFriendsList,\n    getApplications,\n    getFriendLandsDetail,', 1)
friend_path.write_text(friend, encoding='utf-8')

mall_path = Path('core/src/services/mall.js')
mall = mall_path.read_text(encoding='utf-8')
organic_function_end = """            count: totalBought,
            type,
        });
    }
    
    return totalBought;
}

async function autoBuyFertilizerViaMall"""
fixed_organic_function_end = """            count: totalBought,
            type: 'organic',
        });
    }
    
    return totalBought;
}

async function autoBuyFertilizerViaMall"""
if mall.count(organic_function_end) != 1:
    raise SystemExit('mall organic success log anchor changed')
mall = mall.replace(organic_function_end, fixed_organic_function_end, 1)
mall_path.write_text(mall, encoding='utf-8')

package_path = Path('core/package.json')
package_text = package_path.read_text(encoding='utf-8')
script_anchor = '    "friend:mutation-selftest": "node scripts/friend-mutation-readonly-selftest.js",\n'
if package_text.count(script_anchor) != 1:
    raise SystemExit('package script anchor changed')
package_text = package_text.replace(
    script_anchor,
    script_anchor + '    "friend:mall-runtime-selftest": "node scripts/friend-mall-runtime-selftest.js",\n',
    1,
)
regression_anchor = '&& pnpm friend:mutation-selftest && pnpm bag:use-ux-selftest'
if package_text.count(regression_anchor) != 1:
    raise SystemExit('regression chain anchor changed')
package_text = package_text.replace(
    regression_anchor,
    '&& pnpm friend:mutation-selftest && pnpm friend:mall-runtime-selftest && pnpm bag:use-ux-selftest',
    1,
)
package_path.write_text(package_text, encoding='utf-8')
