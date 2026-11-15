"""从同源 activitypb.proto 生成 far2 用的 activity-ext.proto。

做的事：
  1. 去掉 ActivityService 的 service 块（far2 自己那份 activitypb.proto 里已经有了）；
  2. 去掉与 far2 冲突的三个消息（GetGroupRequest / GetGroupReply / ListReply 同名定义）；
  3. 把 GetGroupReply 改名为 ExtGroupReply（字段号不动，线上字节完全一致）；
  4. 头部加说明，落盘到 core/src/proto/activity-ext.proto。
"""

from __future__ import annotations

import io
import re
import sys

SRC = r"D:\project2\ref_liyangpengs_qq-farm-bot\qq-farm-bot-master\core\src\proto\activitypb.proto"
DST = r"D:\project2\far2\core\src\proto\activity-ext.proto"

DROP_MESSAGES = {"GetGroupRequest", "GetGroupReply", "ListRequest", "ListReply"}


def split_blocks(text: str):
    """把文本切成 (kind, name, body) 粗块。"""
    blocks = []
    i = 0
    pattern = re.compile(r"^(service|message|enum)\s+(\w+)\s*\{", re.M)
    while True:
        m = pattern.search(text, i)
        if not m:
            blocks.append(("tail", "", text[i:]))
            break
        blocks.append(("head", "", text[i:m.start()]))
        kind, name = m.group(1), m.group(2)
        depth = 1
        j = m.end()
        while j < len(text) and depth:
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
            j += 1
        blocks.append((kind, name, text[m.start():j]))
        i = j
    return blocks


def main() -> int:
    text = io.open(SRC, encoding="utf-8").read()
    # far2 自己那份 activitypb.proto 已有的消息名：ext 文件里必须剔掉，否则 protobufjs 会报
    # duplicate name（两个文件同包）。
    existing = set(
        re.findall(
            r"^message\s+(\w+)",
            io.open(r"D:\project2\far2\core\src\proto\activitypb.proto", encoding="utf-8").read(),
            re.M,
        )
    )
    out = []
    dropped, renamed = [], []
    for kind, name, body in split_blocks(text):
        if kind == "head":
            # 丢掉原文件的 syntax/package/import 头，只保留注释；语法头由本脚本统一生成
            body = "".join(
                line + "\n"
                for line in body.splitlines()
                if not re.match(r"^\s*(syntax|package|import)\b", line)
            )
            out.append(body)
            continue
        if kind == "service":
            dropped.append(name)
            continue
        if kind == "message" and (name in DROP_MESSAGES or name in existing):
            if name == "GetGroupRequest":
                dropped.append(name)
            elif name not in DROP_MESSAGES:
                dropped.append(name)
            continue
        if kind == "message" and name == "GetGroupReply":
            renamed.append(name)
            body = body.replace("GetGroupReply", "ExtGroupReply", 1)
        out.append(body)

    header = (
        "syntax = \"proto3\";\n\n"
        "package gamepb.activitypb;\n\n"
        "// 活动超集协议（来自同源 liyangpengs/qq-farm-bot 的 activitypb.proto，wire 层逐字段保留）。\n"
        "// far2 原有的 activitypb.proto 保持不动；本文件只补充：\n"
        "//   - ActivityData 及各活动子结构（星座/公益红花/七夕/青梅/天气/奶茶/宠日记）\n"
        "//   - ActivityService.Operate 的全部选择器请求/回包\n"
        "// 与 far2 冲突的三个消息（GetGroupRequest / GetGroupReply / ListReply）已剔除，\n"
        "// 其中 GetGroupReply 改名为 ExtGroupReply（字段号不变）。\n\n"
        "import \"corepb.proto\";\n"
        "import \"autumn-activities.proto\";\n"
        "import \"milk-tea.proto\";\n"
        "import \"pet-diary.proto\";\n\n"
    )
    # 干掉原文件里的 syntax/package/import 头部，只保留消息块
    body_text = "".join(out)
    # 补回被剔除的 GetGroupReply 的超集版本（字段号 1，wire 与 far2 的 GetGroupReply 同构）
    tail = (
        "\n// GetGroupReply 的超集视图：field 1 = ActivityData（比 far2 的 ActivityNode 多出各活动子结构）\n"
        "message ExtGroupReply {\n"
        "    ActivityData group = 1;\n"
        "}\n"
    )
    io.open(DST, "w", encoding="utf-8", newline="\n").write(header + (body_text.lstrip()) + tail)

    print(f"dropped: {dropped}")
    print(f"renamed: {renamed}")
    print(f"written: {DST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
