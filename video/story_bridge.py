"""The bridge between take.py (Python, drives a browser) and the shared Story code (JavaScript, vendored byte for byte in ../web/src/story/).

The recorded video and the live Story must look and time the same, so the video does NOT carry its own copy of the pop-up code or the hold formulas: it takes both from the
vendored shared files. This module turns them into classic scripts the browser can run at page start (the vendored files are ES modules: only their `export` keywords are
stripped, nothing else is changed), and gives take.py the three things it needs:
  overlay_script(scale, pill_text)  the init script that defines window.__cm (cap, slide, clear, scrollSlide) and window.__storyHold (bubbleHold, slideHold)
  slide_payload(cfg, assets_dir)    a captions slide (the flat shape captions.py returns) in the shape the shared overlay draws
  hold_bubble / hold_slide          evaluate the shared hold formulas in the page (so Normal speed IS the live Story's Normal speed)
Nothing here is a copy of shared logic: change the canonical files in AI-DEMO-Standalone/shared/story, re-vendor, and the video follows.
"""
import base64, json, re
from pathlib import Path

STORY_DIR = Path(__file__).resolve().parent.parent / "web" / "src" / "story"

def classic(name):
    """A vendored ES module as a classic script: `export` keywords removed, and nothing else. It must have no imports (hold.js and overlay.js have none)."""
    src = (STORY_DIR / name).read_text()
    out = re.sub(r"^export\s+(const|function|class|let)\s", r"\1 ", src, flags=re.M)
    if re.search(r"^\s*(export|import)\b", out, re.M):
        raise ValueError(f"{name}: not a plain module any more (an import or a non-trivial export): extend story_bridge.classic before using it")
    return out

# take.py's own additions around the shared overlay: the SAMPLE pill and nothing else (this lab has no reel pop-out and no row to hide).
GUARD = "  if (window.__cm) return;"   # a second injection in one page does nothing

GLUE_BODY = r"""
  const S = window.__cmScale || 1;
  const ov = createOverlay({ scale: S, follow: false });   // follow: false: a caption is drawn once and stays exactly there, as the video always did
  window.__cm = { clear: ov.clear, cap: (o) => ov.cap(o), slide: (o) => ov.slide(o), scrollSlide: ov.scrollSlide };
  window.__storyHold = { bubbleHold: bubbleHold, slideHold: slideHold };
  // Stacking as before: caption bubble < the SAMPLE pill < a slide (the shared overlay's slide is one above its bubble, so the slide is raised one more).
  const css = `.story-slide{z-index:${OVERLAY_Z + 7} !important}
  .cm-pill{position:fixed;right:14px;bottom:12px;z-index:${OVERLAY_Z + 6};background:#1d232b;color:#f2f4f7;border:1px solid #3a4350;border-radius:999px;padding:4px 14px;font:700 13px system-ui,sans-serif;pointer-events:none}`;
  const ensure = () => {
    if (!document.documentElement || document.getElementById('cm-style')) return;
    const st = document.createElement('style'); st.id = 'cm-style'; st.textContent = css; document.documentElement.appendChild(st);
    const pill = document.createElement('div'); pill.className = 'cm-pill'; pill.textContent = window.__pillText || ''; if (!window.__pillText) pill.style.display = 'none'; document.documentElement.appendChild(pill);
  };
  document.addEventListener('DOMContentLoaded', ensure); ensure();
"""

def overlay_script():
    """One self-contained function: the shared names (words, holdMs, createOverlay ...) stay inside it, so nothing of ours can collide with the page's own scripts, and running it
    twice in one page is harmless. Only window.__cm and window.__storyHold are visible to take.py."""
    return ";(() => {\n" + GUARD + "\n" + classic("hold.js") + "\n" + classic("overlay.js") + "\n" + GLUE_BODY + "})();\n"

def slide_payload(cfg, assets_dir):
    """captions.py's flat slide -> the shared overlay's shape. An image is read from the local, gitignored assets folder (nothing ships in the repo)."""
    image = None
    if cfg.get("image"):
        raw = (Path(assets_dir) / cfg["image"]).read_bytes()
        image = "data:image/jpeg;base64," + base64.b64encode(raw).decode()
    return dict(image=image, header=cfg.get("header"), title=cfg["title"], lead=cfg["lead"], verdict=cfg["verdict"], wide=bool(cfg.get("wide")),
                colA=dict(heading=cfg["col_a_heading"], lines=cfg["col_a_lines"]), colB=dict(heading=cfg["col_b_heading"], lines=cfg["col_b_lines"]))

def hold_bubble(page, text, lines=None):
    """Seconds a numbered caption is held: the shared formula, evaluated in the page (the video's own words-times-0.30-plus-2.2, minimum 5)."""
    return float(page.evaluate("([t, l]) => window.__storyHold.bubbleHold(t, l)", [text, list(lines or [])]))

def hold_slide(page, payload):
    """Seconds a slide is held: the shared formula (the video's own, capped at 10)."""
    return float(page.evaluate("(p) => window.__storyHold.slideHold(p)", payload))
