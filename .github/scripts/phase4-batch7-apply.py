from pathlib import Path

p = Path('core/src/models/user-store.js')
text = p.read_text(encoding='utf-8')

start_marker = "// 保存用户微信登录配置\nfunction saveWxLoginConfig(username, config) {"
end_marker = "\ninitDefaultAdmin();\n"
start = text.find(start_marker)
end = text.find(end_marker, start)
if start == -1 or end == -1:
    raise SystemExit('user-store dead helper block anchors not found')
block = text[start:end]
required_names = ['saveWxLoginConfig', 'getWxLoginConfig', 'getUserAccountLimit', 'canAddAccount']
for name in required_names:
    if block.count(f'function {name}(') != 1:
        raise SystemExit(f'expected one {name} definition in removable block')
text = text[:start] + text[end + 1:]

old = """function saveCardClaimRecords() {
    ensureDataDir();
    try {
        writeJsonFileAtomic(CARD_CLAIM_FILE, {
            enabled: cardClaimEnabled,
            records: cardClaimRecords
        });
    } catch (e) {
        throw e;
    }
}
"""
new = """function saveCardClaimRecords() {
    ensureDataDir();
    writeJsonFileAtomic(CARD_CLAIM_FILE, {
        enabled: cardClaimEnabled,
        records: cardClaimRecords
    });
}
"""
if text.count(old) != 1:
    raise SystemExit(f'expected one saveCardClaimRecords useless-catch block, got {text.count(old)}')
text = text.replace(old, new, 1)

p.write_text(text, encoding='utf-8')
print('phase4 batch7 user-store dead code cleanup applied')
