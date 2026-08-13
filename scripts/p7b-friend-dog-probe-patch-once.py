from pathlib import Path

friend_path = Path('core/src/services/friend.js')
core_pkg_path = Path('core/package.json')
root_pkg_path = Path('package.json')

text = friend_path.read_text(encoding='utf-8')

def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one anchor, found {count}')
    return source.replace(old, new, 1)

text = replace_once(
    text,
    "const { buildMutationDetail } = require('./farm-mutation');\n",
    "const { buildMutationDetail } = require('./farm-mutation');\nconst { buildFriendDogProbe } = require('./friend-dog-probe');\n",
    'friend dog probe import',
)

old_enter = """async function enterFriendFarm(friendGid) {
    const body = types.VisitEnterRequest.encode(types.VisitEnterRequest.create({
        host_gid: toLong(friendGid),
        reason: 2,  // ENTER_REASON_FRIEND
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', body);
    return types.VisitEnterReply.decode(replyBody);
}
"""
new_enter = """async function enterFriendFarm(friendGid) {
    const body = types.VisitEnterRequest.encode(types.VisitEnterRequest.create({
        host_gid: toLong(friendGid),
        reason: 2,  // ENTER_REASON_FRIEND
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', body);
    const reply = types.VisitEnterReply.decode(replyBody);
    // 协议发现只复用这次 Enter 的 raw reply，不增加任何 Visit/Dog 请求。
    // field 3 的内部结构未被真实回包确认前，只保留 wire 摘要，不猜 Dog DTO。
    Object.defineProperty(reply, '__far2BriefDogProbe', {
        value: buildFriendDogProbe(replyBody),
        enumerable: false,
        configurable: false,
        writable: false,
    });
    return reply;
}
"""
text = replace_once(text, old_enter, new_enter, 'Visit.Enter raw probe')

old_detail_start = """        const enterReply = await enterFriendFarm(friendGid);
        const lands = enterReply.lands || [];
"""
new_detail_start = """        const enterReply = await enterFriendFarm(friendGid);
        const dogProbe = enterReply.__far2BriefDogProbe || null;
        const lands = enterReply.lands || [];
"""
text = replace_once(text, old_detail_start, new_detail_start, 'friend detail dog probe capture')

old_return = """        return {
            lands: landsList,
            summary: analyzed,
        };
    } catch {
        return { lands: [], summary: {} };
    }
}
"""
new_return = """        return {
            lands: landsList,
            summary: analyzed,
            dogProbe,
        };
    } catch {
        return { lands: [], summary: {}, dogProbe: null };
    }
}
"""
text = replace_once(text, old_return, new_return, 'friend detail dog probe response')

for required in [
    "const { buildFriendDogProbe } = require('./friend-dog-probe');",
    "Object.defineProperty(reply, '__far2BriefDogProbe'",
    'const dogProbe = enterReply.__far2BriefDogProbe || null;',
    'dogProbe,',
]:
    if required not in text:
        raise SystemExit(f'P7B contract anchor missing: {required}')

friend_path.write_text(text, encoding='utf-8')

for pkg_path in [core_pkg_path, root_pkg_path]:
    pkg = pkg_path.read_text(encoding='utf-8')
    anchor = '    "bag:use-ux-selftest": '
    idx = pkg.find(anchor)
    if idx < 0:
        raise SystemExit(f'{pkg_path}: bag use selftest anchor missing')
    line_end = pkg.find('\n', idx)
    command = 'node scripts/friend-dog-probe-selftest.js' if str(pkg_path).startswith('core/') else 'pnpm -C core friend:dog-probe-selftest'
    new_line = f'    "friend:dog-probe-selftest": "{command}",\n'
    if '"friend:dog-probe-selftest"' not in pkg:
        pkg = pkg[:line_end + 1] + new_line + pkg[line_end + 1:]
    pkg_path.write_text(pkg, encoding='utf-8')

print('P7B friend dog protocol probe patch applied')
