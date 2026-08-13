from pathlib import Path

path = Path('web/src/views/Friends.vue')
text = path.read_text(encoding='utf-8')

import_anchor = "import ConfirmModal from '@/components/ConfirmModal.vue'\n"
import_line = "import FriendDogProbe from '@/components/FriendDogProbe.vue'\n"
if import_line not in text:
    if import_anchor not in text:
        raise SystemExit('import anchor not found')
    text = text.replace(import_anchor, import_anchor + import_line, 1)

start = text.find('                <div\n                  v-if="friendDogProbes[friend.gid]"')
end_anchor = '                <div v-if="!friendLands[friend.gid] || friendLands[friend.gid]?.length === 0"'
end = text.find(end_anchor, start)
if start < 0 or end < 0:
    raise SystemExit(f'probe block anchors not found: start={start} end={end}')

replacement = '                <FriendDogProbe :probe="friendDogProbes[friend.gid]" />\n\n'
text = text[:start] + replacement + text[end:]
path.write_text(text, encoding='utf-8')
