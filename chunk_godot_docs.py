#!/usr/bin/env python3
"""
chunk_godot_docs.py

Walks a cloned godot-docs repo, parses each .rst file, and splits it into
section-level chunks suitable for embedding into a vector store.

Godot's class reference .rst files (classes/*.rst) are auto-generated with a
consistent structure:
    - a comment header (generator info, DO NOT EDIT, XML source)
    - a title, underlined with '='
    - **Inherits:** / **Inherited By:** lines
    - section headers underlined with '-' (Description, Properties, Methods,
      Signals, Enumerations, Constants, Method Descriptions, Property
      Descriptions, etc.)

General docs/tutorials (everything outside classes/) use the same RST
convention (title underlined with a repeated punctuation character) but
without the generator header, and section depth can vary.

This script treats any line immediately followed by a full-width line of a
single repeated punctuation character (=, -, ~, ^, ") as a heading, and
splits the file into one chunk per section under that heading. It does NOT
require Sphinx or any RST parser library -- just line scanning, since
Godot's generated docs are very regular.

Output: a single JSON file containing a list of chunk dicts:
    {
        "id": "classes/class_node2d.rst#Description",
        "source_path": "classes/class_node2d.rst",
        "class_name": "Node2D",          # None for non-class docs
        "heading": "Description",
        "heading_path": ["Node2D", "Description"],
        "text": "...",
        "char_count": 1234
    }

Usage:
    python3 chunk_godot_docs.py /path/to/godot-docs-4.6 chunks.json
    python3 chunk_godot_docs.py /path/to/godot-docs-4.6 chunks.json --max-chars 1500
    python3 chunk_godot_docs.py /path/to/godot-docs-4.6 chunks.json --include classes
"""

import argparse
import json
import re
import sys
from pathlib import Path

HEADING_LINE_RE = re.compile(r"^([=\-~^\"'`#*+.:_])\1{2,}\s*$")


def is_underline(line: str) -> bool:
    stripped = line.rstrip("\n")
    if not stripped:
        return False
    return bool(HEADING_LINE_RE.match(stripped))


def parse_headings(lines):
    """
    Scan lines for (heading_text, underline_char, line_index_of_heading_text)
    triples. A heading is: a non-blank text line immediately followed by an
    underline line of length >= len(text line) using a single repeated
    punctuation character.
    """
    headings = []
    for i in range(len(lines) - 1):
        text_line = lines[i].rstrip("\n")
        next_line = lines[i + 1].rstrip("\n")
        if not text_line.strip():
            continue
        if is_underline(next_line) and len(next_line.strip()) >= max(3, len(text_line.strip()) - 2):
            underline_char = next_line.strip()[0]
            headings.append((text_line.strip(), underline_char, i))
    return headings


def build_heading_depth_map(headings):
    """
    Godot's generator is consistent PER FILE about which underline character
    means "title" vs "section" vs "subsection", but the exact character can
    vary between file types (class docs vs tutorials). We infer depth by the
    ORDER underline characters first appear in the file: first char seen =
    depth 0 (title), second distinct char = depth 1, etc.
    """
    order = []
    for _, char, _ in headings:
        if char not in order:
            order.append(char)
    return {char: depth for depth, char in enumerate(order)}


def strip_rst_comment_header(lines):
    """
    Godot class docs start with a block of '..' comment lines and blank/pipe
    filler lines before the real title. Skip past that so it doesn't get
    treated as content.
    """
    start = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("..") or stripped in ("", "|"):
            start = i + 1
            continue
        else:
            break
    return start


def _split_oversized_paragraph(para: str, budget: int):
    """
    Some RST content has no blank-line breaks at all within a single logical
    section -- most notably grid tables (rows separated by '+---+' border
    lines, not blank lines), which re.split(r"\n\s*\n", ...) cannot break up.
    For any paragraph still over budget after paragraph-level packing, fall
    back to splitting on individual lines so no chunk is ever emitted larger
    than the budget, regardless of internal structure.
    """
    if len(para) <= budget:
        return [para]

    lines = para.split("\n")
    parts, current = [], ""
    for line in lines:
        candidate = f"{current}\n{line}" if current else line
        if len(candidate) > budget and current:
            parts.append(current)
            current = line
        else:
            current = candidate
    if current:
        parts.append(current)

    # Edge case: a single line longer than the whole budget (shouldn't
    # happen with RST table rows in practice, but guard against it rather
    # than silently emitting an oversized chunk).
    final_parts = []
    for part in parts:
        if len(part) <= budget:
            final_parts.append(part)
        else:
            for i in range(0, len(part), budget):
                final_parts.append(part[i:i + budget])
    return final_parts


def _pack_paragraphs(body_text: str, budget: int):
    paragraphs = re.split(r"\n\s*\n", body_text)
    packed, current = [], ""
    for para in paragraphs:
        candidate = f"{current}\n\n{para}" if current else para
        if len(candidate) > budget and current:
            packed.append(current)
            current = para
        else:
            current = candidate
    if current:
        packed.append(current)

    # Guard: a single paragraph (e.g. one blank-line-delimited block) can
    # still exceed budget on its own -- most commonly an RST grid table,
    # which has no blank lines between rows for re.split to catch. Split
    # any such oversized piece by line so nothing bypasses --max-chars.
    final_packed = []
    for piece in packed:
        final_packed.extend(_split_oversized_paragraph(piece, budget))

    return final_packed if final_packed else [body_text[:budget]]


def _make_chunk(path, repo_root, heading_path, text, class_name=None, part_suffix=""):
    rel_path = str(path.relative_to(repo_root))
    heading = heading_path[-1] if heading_path else "(whole file)"
    chunk_id = f"{rel_path}#{'/'.join(heading_path)}{part_suffix}"
    return {
        "id": chunk_id,
        "source_path": rel_path,
        "class_name": class_name,
        "heading": heading,
        "heading_path": heading_path,
        "text": text,
        "char_count": len(text),
    }


def chunk_file(path: Path, repo_root: Path, max_chars: int):
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines(keepends=True)

    content_start = strip_rst_comment_header(lines)
    headings = [h for h in parse_headings(lines) if h[2] >= content_start]

    if not headings:
        # No detectable headings -- emit the whole file as one chunk.
        return [_make_chunk(path, repo_root, ["(whole file)"], text.strip())]

    depth_map = build_heading_depth_map(headings)

    # For classes/*.rst, the first (title-depth) heading is the class name
    # itself, e.g. "Node2D".
    class_name = None
    if "classes" in path.parts:
        title_headings = [h for h in headings if depth_map[h[1]] == 0]
        if title_headings:
            class_name = title_headings[0][0]

    chunks = []
    heading_stack = []  # list of (text, depth)

    for idx, (heading_text, underline_char, line_idx) in enumerate(headings):
        depth = depth_map[underline_char]

        heading_stack = [h for h in heading_stack if h[1] < depth]
        heading_stack.append((heading_text, depth))
        heading_path = [h[0] for h in heading_stack]

        body_start = line_idx + 2  # skip heading text + underline lines
        body_end = headings[idx + 1][2] if idx + 1 < len(headings) else len(lines)
        body_text = "".join(lines[body_start:body_end]).strip()

        if not body_text:
            continue

        heading_prefix = f"{' > '.join(heading_path)}\n\n"
        full_text = heading_prefix + body_text

        if len(full_text) <= max_chars:
            chunks.append(_make_chunk(path, repo_root, heading_path, full_text, class_name))
        else:
            budget = max_chars - len(heading_prefix)
            for part_idx, part_text in enumerate(_pack_paragraphs(body_text, budget)):
                chunks.append(
                    _make_chunk(
                        path,
                        repo_root,
                        heading_path,
                        heading_prefix + part_text,
                        class_name,
                        part_suffix=f" (part {part_idx + 1})",
                    )
                )

    return chunks


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("docs_dir", help="Path to the cloned godot-docs repo (e.g. godot-docs-4.6)")
    parser.add_argument("output_json", help="Path to write the chunk list as JSON")
    parser.add_argument("--max-chars", type=int, default=1200, help="Soft max characters per chunk (default: 1200)")
    parser.add_argument(
        "--include",
        default=None,
        help="Only process files whose relative path contains this substring, "
        "e.g. --include classes to index just the class reference",
    )
    args = parser.parse_args()

    docs_dir = Path(args.docs_dir).resolve()
    if not docs_dir.is_dir():
        print(f"Error: {docs_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    rst_files = sorted(docs_dir.rglob("*.rst"))
    if args.include:
        rst_files = [f for f in rst_files if args.include in str(f.relative_to(docs_dir))]

    if not rst_files:
        print(f"No .rst files found under {docs_dir} (include filter: {args.include!r})", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(rst_files)} .rst files to chunk...")

    all_chunks = []
    for i, path in enumerate(rst_files, 1):
        try:
            all_chunks.extend(chunk_file(path, docs_dir, args.max_chars))
        except Exception as e:
            print(f"  [warn] failed to chunk {path.relative_to(docs_dir)}: {e}", file=sys.stderr)
        if i % 200 == 0:
            print(f"  ...{i}/{len(rst_files)} files processed, {len(all_chunks)} chunks so far")

    out_path = Path(args.output_json)
    out_path.write_text(json.dumps(all_chunks, indent=2), encoding="utf-8")

    print(f"Done. Wrote {len(all_chunks)} chunks from {len(rst_files)} files to {out_path}")
    if all_chunks:
        avg_len = sum(c["char_count"] for c in all_chunks) / len(all_chunks)
        print(f"Average chunk length: {avg_len:.0f} chars")


if __name__ == "__main__":
    main()
