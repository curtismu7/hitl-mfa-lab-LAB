"""Loads the video's wording from the lab's GET /api/story into the shapes take.py uses: OPENING_SLIDE, CLOSING_SLIDE, SLIDES (a dict of slide key -> slide with
title/lead/col_a_heading/col_a_lines/col_b_heading/col_b_lines/verdict and optionally image and wide) and STEPS (a dict of step key -> {title, text}).

There is ONE parser of captions.md: the shared Story parser in the lab's server (server/src/story/captions.js, vendored from AI-DEMO-Standalone/shared/story). The live Story
and this video both read what it serves, so they cannot disagree about the wording. Edit captions.md (the format is described at its top), not this file. The lab must be
running (take.py runs against it anyway).
"""
import hashlib, json, os, urllib.error, urllib.request
from pathlib import Path

def _flat(slide):
    try:
        return {
            "image": slide.get("image"), "wide": bool(slide.get("wide")), "header": slide.get("header"), "title": slide["title"], "lead": slide["lead"],
            "col_a_heading": slide["colA"]["heading"], "col_a_lines": list(slide["colA"]["lines"]),
            "col_b_heading": slide["colB"]["heading"], "col_b_lines": list(slide["colB"]["lines"]),
            "verdict": slide["verdict"],
        }
    except (KeyError, TypeError) as e:
        raise ValueError(f"/api/story: a slide is missing {e}") from None

def from_story(story):
    """The /api/story document -> (opening, closing, steps, slides)."""
    for k in ("opening", "closing", "slides", "steps"):
        if k not in story:
            raise ValueError(f"/api/story: the wording has no '{k}'")
    try:
        steps = {k: {"title": v["title"], "text": v["text"]} for k, v in story["steps"].items()}
    except (KeyError, TypeError) as e:
        raise ValueError(f"/api/story: a step is missing {e}") from None
    return _flat(story["opening"]), _flat(story["closing"]), steps, {k: _flat(v) for k, v in story["slides"].items()}

def load(app_url, local_file=None, timeout=15):
    """Fetch the wording from the running lab and convert it. With `local_file` (the repo's captions.md) the lab must be serving THAT file's bytes: a lab built before an edit would
    otherwise record stale wording without a sign (set ALLOW_STALE_WORDING=1 to record anyway)."""
    try:
        with urllib.request.urlopen(app_url.rstrip("/") + "/api/story", timeout=timeout) as r:
            story = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:   # the lab answers 500 with {"error": "...names the problem..."} when captions.md is broken
        try: detail = json.loads(e.read().decode()).get("error")
        except Exception: detail = None
        raise ValueError(detail or f"/api/story answered HTTP {e.code}") from None
    except (urllib.error.URLError, OSError) as e:
        raise ValueError(f"the lab is not reachable at {app_url} ({e}): the video reads its wording from the running lab") from None
    if not isinstance(story, dict):
        raise ValueError(f"{app_url} answered /api/story with something that is not the Story wording (is this the lab?)")
    if "error" in story:
        raise ValueError(story["error"])
    if local_file is not None and os.environ.get("ALLOW_STALE_WORDING") != "1":
        try: want = hashlib.sha256(Path(local_file).read_bytes()).hexdigest()
        except OSError as e: raise ValueError(f"cannot read {local_file} to check the lab's wording against it ({e})") from None
        if story.get("sourceSha256") != want:
            raise ValueError("the lab is serving a different captions.md than " + str(local_file) + " (its wording is stale or from another checkout): restart it with "
                             "`docker compose up -d --build` (the compose file mounts the file, so a plain restart also picks it up), or set ALLOW_STALE_WORDING=1 to record anyway")
    return from_story(story)
