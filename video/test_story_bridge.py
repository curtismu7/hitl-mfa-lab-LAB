#!/usr/bin/env python3
"""Tests for the video's bridge to the shared Story code. Run: python3 video/test_story_bridge.py   (needs node; the real-browser checks in InABrowser run when Playwright and its Chromium are installed and are skipped otherwise)
The golden numbers are what take.py's own formulas gave before it moved to the shared hold.js (max(5.0, words*0.30+2.2) and min(10.0, max(6.0, words*0.25+3.0)))."""
import json, os, shutil, subprocess, sys, tempfile, threading, unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import captions, story_bridge

HAVE_NODE = shutil.which("node") is not None
W = lambda n: " ".join(f"w{i}" for i in range(n))

def node(code):
    r = subprocess.run(["node", "-e", code], capture_output=True, text=True, timeout=30)
    if r.returncode: raise AssertionError(r.stderr)
    return r.stdout.strip()

class Classic(unittest.TestCase):
    def test_the_vendored_modules_become_plain_scripts(self):
        for name in ("hold.js", "overlay.js"):
            out = story_bridge.classic(name)
            self.assertNotRegex(out, r"(?m)^\s*(export|import)\b")
            self.assertIn("function", out)

    def test_a_module_with_an_import_is_refused_not_silently_broken(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "x.js").write_text("import { a } from './a.js';\nexport const b = 1;\n")
            old = story_bridge.STORY_DIR; story_bridge.STORY_DIR = Path(d)
            try: self.assertRaises(ValueError, story_bridge.classic, "x.js")
            finally: story_bridge.STORY_DIR = old

    @unittest.skipUnless(HAVE_NODE, "node not available")
    def test_the_overlay_script_is_valid_javascript_that_defines_the_pieces_take_py_uses(self):
        script = story_bridge.overlay_script()
        self.assertIn("window.__cm", script); self.assertIn("window.__storyHold", script)
        out = node("const vm = require('vm'); new vm.Script(" + json.dumps(script) + "); console.log('ok')")
        self.assertEqual(out, "ok")

class Holds(unittest.TestCase):
    @unittest.skipUnless(HAVE_NODE, "node not available")
    def test_normal_speed_equals_the_numbers_take_py_always_produced(self):
        hold = story_bridge.classic("hold.js")
        code = hold + """
        const w = (n) => Array.from({ length: n }, (_, i) => 'w' + i).join(' ');
        const slide = (n) => ({ lead: w(n), colA: { lines: [] }, colB: { lines: [] }, verdict: 'v' });
        console.log(JSON.stringify({
          bubble: [1, 9, 10, 20, 60].map((n) => bubbleHold(w(n), [])),
          quirk: [bubbleHold(w(10), ['asks: a b c']), bubbleHold(w(20), ['one two', 'three'])],
          slide: [1, 12, 20, 40, 80].map((n) => slideHold(slide(n))),
        }));"""
        got = json.loads(node(code))
        self.assertEqual(got["bubble"], [5.0, 5.0, 5.2, 8.2, 20.2])
        self.assertEqual(got["quirk"], [6.1, 8.8])
        self.assertEqual(got["slide"], [6.0, 6.25, 8.25, 10.0, 10.0])

class Payload(unittest.TestCase):
    CFG = {"image": None, "wide": False, "title": "T", "lead": "L", "col_a_heading": "A", "col_a_lines": ["a1"], "col_b_heading": "B", "col_b_lines": ["b1", "b2"], "verdict": "V"}

    def test_a_captions_slide_in_the_shared_overlays_shape(self):
        p = story_bridge.slide_payload(self.CFG, "/nonexistent")
        self.assertEqual(p, {"image": None, "header": None, "title": "T", "lead": "L", "verdict": "V", "wide": False, "colA": {"heading": "A", "lines": ["a1"]}, "colB": {"heading": "B", "lines": ["b1", "b2"]}})
        self.assertEqual(story_bridge.slide_payload({**self.CFG, "header": "A2A"}, "/nonexistent")["header"], "A2A")   # rule 29: the first page names the demo

    def test_an_image_comes_from_the_local_assets_folder_as_a_data_uri(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "shot.jpg").write_bytes(b"\xff\xd8\xff")
            p = story_bridge.slide_payload({**self.CFG, "image": "shot.jpg", "wide": True}, d)
        self.assertTrue(p["image"].startswith("data:image/jpeg;base64,")); self.assertTrue(p["wide"])

class Wording(unittest.TestCase):
    STORY = {
        "opening": {"header": "H", "title": "O", "lead": "l", "verdict": "v", "colA": {"heading": "a", "lines": ["x"]}, "colB": {"heading": "b", "lines": ["y"]}, "image": None, "wide": False},
        "closing": {"title": "C", "lead": "l", "verdict": "v", "colA": {"heading": "a", "lines": ["x"]}, "colB": {"heading": "b", "lines": ["y"]}, "image": None, "wide": False},
        "slides": {"part2": {"title": "P", "lead": "l", "verdict": "v", "colA": {"heading": "a", "lines": ["x", "z"]}, "colB": {"heading": "b", "lines": ["y"]}, "image": "console.jpg", "wide": True}},
        "steps": {"p1_intro": {"title": "Ask", "text": "Type."}},
    }

    def test_the_story_document_becomes_the_flat_shapes_take_py_uses(self):
        o, c, steps, slides = captions.from_story(self.STORY)
        self.assertEqual(o["col_a_lines"], ["x"]); self.assertEqual(c["title"], "C")
        self.assertEqual(o["header"], "H"); self.assertIsNone(c["header"])
        self.assertEqual(slides["part2"]["image"], "console.jpg"); self.assertTrue(slides["part2"]["wide"]); self.assertEqual(slides["part2"]["col_a_lines"], ["x", "z"])
        self.assertEqual(steps, {"p1_intro": {"title": "Ask", "text": "Type."}})

    def test_a_document_missing_a_part_is_an_error(self):
        self.assertRaises(ValueError, captions.from_story, {"opening": {}})

    def _serve(self, status, doc):
        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(status["code"]); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(json.dumps(doc["doc"]).encode())
            def log_message(self, *a): pass
        srv = HTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv, f"http://127.0.0.1:{srv.server_address[1]}/"

    def test_load_reads_the_running_labs_api_story(self):
        status, doc = {"code": 200}, {"doc": self.STORY}
        srv, url = self._serve(status, doc)
        try: self.assertEqual(captions.load(url)[1]["title"], "C")
        finally: srv.shutdown(); srv.server_close()

    def test_a_lab_that_cannot_give_the_wording_is_a_clear_error_naming_the_problem(self):
        status, doc = {"code": 500}, {"doc": {"error": "Story wording could not be read: captions.md: no \"# Opening Slide\" section found"}}
        srv, url = self._serve(status, doc)
        try:
            with self.assertRaises(ValueError) as cm: captions.load(url)
            self.assertIn("no \"# Opening Slide\"", str(cm.exception))        # the lab's own message, not a bare 'HTTP Error 500'
            status["code"] = 200
            self.assertRaises(ValueError, captions.load, url)                   # an error document with a 200 is an error too
        finally: srv.shutdown(); srv.server_close()
        with self.assertRaises(ValueError) as cm: captions.load("http://127.0.0.1:1/")
        self.assertIn("not reachable", str(cm.exception))

    def test_stale_wording_is_refused_unless_you_say_otherwise(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "captions.md"; f.write_text("the current captions.md")
            import hashlib
            good = {**self.STORY, "sourceSha256": hashlib.sha256(f.read_bytes()).hexdigest()}
            srv, url = self._serve({"code": 200}, {"doc": good})
            with mock.patch.dict(os.environ): os.environ.pop("ALLOW_STALE_WORDING", None); self._stale_checks(f, good)

    def _stale_checks(self, f, good):
        if True:
            srv, url = self._serve({"code": 200}, {"doc": good})
            try: self.assertEqual(captions.load(url, f)[0]["title"], "O")              # the lab serves this very file
            finally: srv.shutdown(); srv.server_close()
            for doc in ({**self.STORY, "sourceSha256": "0" * 64}, self.STORY):          # another file's hash, or no hash at all (an older lab)
                srv, url = self._serve({"code": 200}, {"doc": doc})
                try:
                    with self.assertRaises(ValueError) as cm: captions.load(url, f)
                    self.assertIn("stale", str(cm.exception))
                    with mock.patch.dict(os.environ, {"ALLOW_STALE_WORDING": "1"}): self.assertEqual(captions.load(url, f)[0]["title"], "O")
                finally: srv.shutdown(); srv.server_close()

    def test_a_missing_local_file_and_a_server_that_is_not_the_lab_are_clear_errors(self):
        srv, url = self._serve({"code": 200}, {"doc": self.STORY})
        try:
            with mock.patch.dict(os.environ): 
                os.environ.pop("ALLOW_STALE_WORDING", None)
                with self.assertRaises(ValueError) as cm: captions.load(url, "/nonexistent/captions.md")
                self.assertIn("cannot read", str(cm.exception))
        finally: srv.shutdown(); srv.server_close()
        srv, url = self._serve({"code": 200}, {"doc": ["not", "the", "wording"]})
        try: self.assertRaises(ValueError, captions.load, url)
        finally: srv.shutdown(); srv.server_close()

    def test_a_slide_missing_a_part_is_a_value_error_not_a_key_error(self):
        broken = {**self.STORY, "slides": {"x": {"title": "t"}}}
        self.assertRaises(ValueError, captions.from_story, broken)

class TakePyHasNoCopyOfSharedLogic(unittest.TestCase):
    def test_take_py_uses_the_bridge_and_defines_no_overlay_or_hold_formula_of_its_own(self):
        src = (Path(__file__).resolve().parent / "take.py").read_text()
        self.assertIn("from story_bridge import", src); self.assertIn("captions.load(APP", src)
        for gone in ('OVERLAY = r"""', "def hold(", "def hold_slide(", "* 0.30 + 2.2", "* 0.25 + 3.0", ".cm-slide .card"):
            self.assertNotIn(gone, src, f"take.py must not carry its own copy of shared logic ({gone!r})")

try:
    import playwright.sync_api as _pw
    HAVE_PLAYWRIGHT = True
except ImportError:
    HAVE_PLAYWRIGHT = False

@unittest.skipUnless(HAVE_PLAYWRIGHT, "playwright not installed (the browser checks run on a machine that records the video)")
class InABrowser(unittest.TestCase):
    """The injected overlay in a real page: what take.py calls is what the shared overlay draws, and nothing of ours leaks into the page."""
    PAGE = "<!doctype html><html><head><title>p</title></head><body><button id='t' style='position:absolute;left:300px;top:300px'>target</button></body></html>"

    def setUp(self):
        self.p = _pw.sync_playwright().start(); self.addCleanup(self.p.stop)
        try: self.b = self.p.chromium.launch(headless=True)
        except Exception as e: self.skipTest(f"no Chromium for Playwright here ({str(e).splitlines()[0][:80]})")
        self.addCleanup(self.b.close)
        self.page = self.b.new_context(viewport={"width": 1920, "height": 1080}).new_page()
        self.page.add_init_script("window.__cmScale = 1.3;"); self.page.add_init_script(story_bridge.overlay_script())
        self.page.goto("data:text/html," + self.PAGE); self.page.wait_for_selector("#t")

    def test_cap_and_slide_draw_what_take_py_sends_and_clear_removes_them(self):
        self.page.evaluate("o => window.__cm.cap(o)", dict(n=4, total=25, title="Ask", text="Type it.", target="#t", lines=["asks: x"], prefer="right", place=None))
        self.assertEqual(self.page.inner_text(".story-bub h3"), "Ask"); self.assertEqual(self.page.inner_text(".story-bub .of"), "4 of 25")
        self.assertEqual(self.page.locator(".story-bub li").count(), 1); self.assertEqual(self.page.locator(".story-hl").count(), 1)
        cfg = Payload.CFG; payload = story_bridge.slide_payload(cfg, "/nonexistent")
        self.page.evaluate("o => window.__cm.slide(o)", payload)
        self.assertEqual(self.page.inner_text(".story-slide h1"), "T"); self.assertEqual(self.page.locator(".story-slide li").count(), 3)
        self.assertEqual(self.page.inner_text(".story-slide .col.colb h2"), "B")
        self.page.evaluate("() => window.__cm.clear()")
        self.assertEqual(self.page.locator(".story-bub, .story-hl, .story-slide").count(), 0)

    def test_a_caption_is_drawn_once_and_never_follows_the_page(self):
        self.page.evaluate("o => window.__cm.cap(o)", dict(n=1, total=1, title="t", text="x", target="#t", lines=None, prefer="right", place=None))
        before = self.page.evaluate("() => [document.querySelector('.story-hl').style.top, document.querySelector('.story-bub').style.top]")
        self.page.evaluate("() => { document.getElementById('t').style.top = '700px'; window.dispatchEvent(new Event('resize')); document.dispatchEvent(new Event('scroll')); }")
        self.page.wait_for_timeout(120)
        self.assertEqual(self.page.evaluate("() => [document.querySelector('.story-hl').style.top, document.querySelector('.story-bub').style.top]"), before)

    def test_stacking_is_bubble_then_pill_then_slide_as_before(self):
        self.page.evaluate("o => window.__cm.cap(o)", dict(n=1, total=1, title="t", text="x", target=None, lines=None, prefer=None, place=None))
        self.page.evaluate("o => window.__cm.slide(o)", story_bridge.slide_payload(Payload.CFG, "/nonexistent"))
        z = self.page.evaluate("() => ({ slide: +getComputedStyle(document.querySelector('.story-slide')).zIndex, pill: +getComputedStyle(document.querySelector('.cm-pill')).zIndex })")
        self.assertGreater(z["slide"], z["pill"])
        self.page.evaluate("() => window.__cm.clear()")
        self.page.evaluate("o => window.__cm.cap(o)", dict(n=1, total=1, title="t", text="x", target=None, lines=None, prefer=None, place=None))
        bub = self.page.evaluate("() => +getComputedStyle(document.querySelector('.story-bub')).zIndex"); self.assertGreater(z["pill"], bub)

    def test_nothing_of_the_shared_code_leaks_into_the_page_and_a_second_injection_is_harmless(self):
        leaked = self.page.evaluate("() => ['words', 'holdMs', 'createOverlay', 'bubbleHold', 'slideHold', 'OVERLAY_Z', 'SPEEDS'].filter((n) => typeof window[n] !== 'undefined')")
        self.assertEqual(leaked, [])
        self.page.evaluate(story_bridge.overlay_script())                       # run it again in the same page
        self.assertEqual(self.page.evaluate("() => typeof window.__cm.cap"), "function")

    def test_the_hold_of_a_real_captions_slide_is_the_old_formula_and_extra_and_cap_are_gone(self):
        cfg = {**Payload.CFG, "lead": W(20), "col_a_lines": ["a b c"], "col_b_lines": ["d e"], "verdict": "v w"}
        payload = story_bridge.slide_payload(cfg, "/nonexistent")
        words = len((cfg["lead"] + " " + " ".join(cfg["col_a_lines"]) + " " + " ".join(cfg["col_b_lines"]) + " " + cfg["verdict"]).split())
        self.assertEqual(story_bridge.hold_slide(self.page, payload), min(10.0, max(6.0, words * 0.25 + 3.0)))
        self.assertEqual(story_bridge.hold_bubble(self.page, W(10), ["asks: a b c"]), max(5.0, len((W(10) + "asks: a b c").split()) * 0.30 + 2.2))

if __name__ == "__main__":
    unittest.main(verbosity=2)
