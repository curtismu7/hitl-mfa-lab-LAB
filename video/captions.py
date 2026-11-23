"""Loads the video's wording from captions.md (the file to edit) into the shapes take.py imports:
OPENING_SLIDE, CLOSING_SLIDE and SLIDES (a dict of slide-key -> slide; each slide is a dict with
title/lead/col_a_heading/col_a_lines/col_b_heading/col_b_lines/verdict and, optionally, image: a file name under
assets/ shown beside the columns) and STEPS (a dict of step-key -> {title, text}). A "# Slide: <key>" section adds a
slide between the caption steps. Edit captions.md, not this file.

Parsing rule, matching the format described at the top of captions.md: the file is a sequence of sections,
each starting with a top-level heading ("# Opening Slide", "# Closing Slide", or "# Step: <key>"), separated
by a line containing only "---". Within a section, "## Title" / "## Text" / "## Lead" / "## Verdict" hold one
paragraph of plain text; "## Column A: <label>" / "## Column B: <label>" hold a bullet list (lines starting
with "- ") under a heading whose own trailing text after the colon is the column's visible label.
"""
import re
from pathlib import Path

_PATH = Path(__file__).parent / "captions.md"


def _fail(msg):
    raise ValueError(f"captions.md: {msg}")


def _split_sections(text):
    # Drop the leading HTML comment (the editing instructions) before splitting.
    text = re.sub(r"^\s*<!--.*?-->\s*", "", text, count=1, flags=re.S)
    return [s.strip() for s in text.split("\n---\n") if s.strip()]


def _split_fields(section_body):
    """{field_name: raw_text} for a section's "## Field" subsections, in order."""
    fields = {}
    order = []
    for m in re.finditer(r"^##\s+(.+?)\s*\n(.*?)(?=\n##\s|\Z)", section_body, re.S | re.M):
        name, body = m.group(1).strip(), m.group(2).strip()
        fields[name] = body
        order.append(name)
    return fields, order


def _bullets(raw):
    lines = [l[2:].strip() for l in raw.splitlines() if l.strip().startswith("- ")]
    if not lines:
        _fail(f"a column heading has no '- ' bullet lines under it:\n{raw[:200]!r}")
    return lines


def _slide_fields(fields, which):
    try:
        title = fields["Title"]
        lead = fields["Lead"]
        verdict = fields["Verdict"]
    except KeyError as e:
        _fail(f"{which} is missing a '## {e.args[0]}' section")
    col_a_name = next((k for k in fields if k.startswith("Column A:")), None)
    col_b_name = next((k for k in fields if k.startswith("Column B:")), None)
    if not col_a_name or not col_b_name:
        _fail(f"{which} needs both a '## Column A: ...' and a '## Column B: ...' heading")
    return {
        "image": fields.get("Image", "").strip() or None,
        "title": title, "lead": lead,
        "col_a_heading": col_a_name.split(":", 1)[1].strip(), "col_a_lines": _bullets(fields[col_a_name]),
        "col_b_heading": col_b_name.split(":", 1)[1].strip(), "col_b_lines": _bullets(fields[col_b_name]),
        "verdict": verdict,
    }


def _load():
    if not _PATH.exists():
        _fail(f"not found at {_PATH}")
    sections = _split_sections(_PATH.read_text())
    opening = closing = None
    steps = {}
    slides = {}
    for sec in sections:
        head_m = re.match(r"^#\s+(.+?)\s*\n(.*)", sec, re.S)
        if not head_m:
            _fail(f"a section has no '# ' heading on its first line:\n{sec[:200]!r}")
        heading, body = head_m.group(1).strip(), head_m.group(2)
        fields, _ = _split_fields(body)
        if heading == "Opening Slide":
            opening = _slide_fields(fields, "Opening Slide")
        elif heading == "Closing Slide":
            closing = _slide_fields(fields, "Closing Slide")
        elif heading.startswith("Slide:"):
            slides[heading.split(":", 1)[1].strip()] = _slide_fields(fields, f"Slide '{heading}'")
        elif heading.startswith("Step:"):
            key = heading.split(":", 1)[1].strip()
            if "Title" not in fields or "Text" not in fields:
                _fail(f"step '{key}' needs both a '## Title' and a '## Text' section")
            steps[key] = {"title": fields["Title"], "text": fields["Text"]}
        else:
            _fail(f"unrecognised section heading '# {heading}' (expected 'Opening Slide', 'Closing Slide', 'Slide: <key>' or 'Step: <key>')")
    if opening is None:
        _fail("no '# Opening Slide' section found")
    if closing is None:
        _fail("no '# Closing Slide' section found")
    return opening, closing, steps, slides


OPENING_SLIDE, CLOSING_SLIDE, STEPS, SLIDES = _load()
