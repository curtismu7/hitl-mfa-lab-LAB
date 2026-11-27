#!/usr/bin/env python3
"""The HITL MFA take: opens its own visible 'Google Chrome for Testing' window on the lab at
http://127.0.0.1:7680 (the PRIVILEGE scenario on the Transfer gate tab), screen-records only that
window's page area, and runs the hold -> HITL Requests -> PingID approval -> retry -> boundary flow
with numbered captions. Adapted from the AWS A2A take (privilege-a2a-anthropic-demo-LAB/video).

Usage: python3 take.py <work_dir>
  work_dir gets: ready.json (window geometry), go.flag (you create it), take.mp4, take.log, result.json

Three modes:
  REHEARSE=1  headless, fast, no video. Runs against the MOCK side by default (it POSTs /api/mode
              {"source":"mock"}, which reloads the page) and prints a warning, because a rehearsal
              against Real would either fire a real gateway call or just sit in the Real panel's
              checklist without any flow to caption. REHEARSE_REAL=1 forces the real side for
              selector-only checks without sending the call.
  SAMPLE=1    headless, full timing, records with Playwright, writes sample.mp4. Switches the lab to
              mock (POST /api/mode {"source":"mock"}), labels itself SAMPLE, and uses the sample_*
              captions.
  default     the REAL take: refuses to run unless /api/info says source=real. Same window/capture
              machinery as the reference (green-marker calibration, MONITOR presets, ffmpeg
              avfoundation). Sends the real call, then WAYS — polls the real call endpoint (quiet
              retries every 3 s, like the lab's own loop) while the owner approves the PingID push
              on their phone, with a generous timeout, and verifies the approval landed (the retry
              came back executed) before continuing.

Before the real take (from SCRIPT.md "Checks before recording"): the lab in Real mode (.env has the
HMLAB_REAL_* settings, owner-run), the owner's phone with PingID paired to the approver named in the
gateway's AI policy, and the green-marker calibration for the current monitor layout.
"""
import json, os, re, signal, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
import base64
import captions
from story_bridge import overlay_script, slide_payload, hold_bubble, hold_slide

WORK = Path(sys.argv[1] if len(sys.argv) > 1 else "take-work").resolve()
MONITOR = os.environ.get("MONITOR", "medium")        # "medium" (an external monitor) or "laptop" (the built-in display)
# Each preset's own global top-left in Quartz/Chromium coordinates (top-left origin, Y grows downward).
# Re-calibrate after any monitor change (VIDEO-BEST-PRACTICES.md, "Before every recording").
PRESETS = {"medium": {"origin": (-1920, -905), "win": (-1900, -875)}, "laptop": {"origin": (0, 0), "win": (40, 60)}}
_preset = PRESETS.get(MONITOR, PRESETS["medium"])
ORIGIN_X, ORIGIN_Y = int(os.environ.get("DISPLAY_X", _preset["origin"][0])), int(os.environ.get("DISPLAY_Y", _preset["origin"][1]))
WIN_X, WIN_Y = int(os.environ.get("WIN_X", _preset["win"][0])), int(os.environ.get("WIN_Y", _preset["win"][1]))
WIN_W, WIN_H = 1440, 980
REHEARSE = os.environ.get("REHEARSE") == "1"
SAMPLE = os.environ.get("SAMPLE") == "1"
HEADLESS_REAL = os.environ.get("HEADLESS_REAL") == "1"   # the REAL take, recorded headless by Playwright (screen locked or off)
HEADLESS = REHEARSE or SAMPLE or HEADLESS_REAL
RECORD_PW = (SAMPLE or HEADLESS_REAL) and not REHEARSE
WAIT_GO = os.environ.get("WAIT_GO") == "1"
THEME = os.environ.get("THEME", "light")
APP = os.environ.get("APP_URL", "http://127.0.0.1:7680")
SCENARIO = os.environ.get("SCENARIO", "privilege-pingid")   # the lab's PRIVILEGE scenario chip
# The wording comes from the RUNNING LAB (GET /api/story): one parser, one file, the video cannot drift from the live Story.
LOCAL_CAPTIONS = Path(__file__).resolve().parent / "captions.md"
OPENING_SLIDE, CLOSING_SLIDE, STEPS, SLIDES = captions.load(APP, local_file=LOCAL_CAPTIONS)
# Real take: how long we keep polling while the owner approves the PingID push on their phone.
APPROVAL_WAIT_S = int(os.environ.get("APPROVAL_WAIT_S", "180"))   # generous: a human is deciding
POLL_S = 3.0                                                      # the lab's own retry cadence
HEADERS = {"content-type": "application/json"}

def log(*a):
    WORK.mkdir(parents=True, exist_ok=True)
    with (WORK / "take.log").open("a") as f:
        print(*a, file=f, flush=True)

def api(path, payload=None):
    """Call the lab's API from Python, as the page does: with a workspace header (the UI's calls are
    per-workspace; the take has its own, so its calls never touch a browser tab's state)."""
    last = None
    for attempt in range(5):
        try:
            req = urllib.request.Request(APP + path, data=json.dumps(payload or {}).encode() if payload is not None else None,
                                         headers={**HEADERS, "x-workspace": "w-videotake"},
                                         method="GET" if payload is None else "POST")
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # transient 429/5xx/refused must not kill the take mid-poll
            last = e
            log(f"api {path} attempt {attempt+1} failed: {e}; retrying")
            time.sleep(3)
    raise last

def list_screen_devices():
    """The avfoundation device numbers currently labelled "Capture screen N" - never hardcoded, since a
    camera connecting or disconnecting (including an iPhone via Continuity Camera) shifts every index after it."""
    out = subprocess.run(["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
                         capture_output=True, text=True, timeout=15).stderr
    return [int(m.group(1)) for m in re.finditer(r"\[(\d+)\] Capture screen \d+", out)]

def detect_capture_device(work):
    """Which of the current "Capture screen N" devices actually shows this window: paint the page solid green,
    grab one frame from each candidate, and pick whichever has a large contiguous green run. Raises with a
    clear message if none match, rather than silently recording the wrong screen."""
    from PIL import Image
    candidates = list_screen_devices()
    if not candidates:
        raise RuntimeError("no avfoundation 'Capture screen N' device found - is Screen Recording permission granted?")
    best = (None, 0)
    for dev in candidates:
        frame = work / f"_calib_{dev}.png"
        r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation",
                           "-framerate", "30", "-pixel_format", "uyvy422", "-i", f"{dev}:none", "-frames:v", "1", str(frame)],
                          capture_output=True, timeout=15)
        if r.returncode != 0 or not frame.exists():
            continue
        im = Image.open(frame).convert("RGB")
        w, h = im.size
        px = im.load()
        matched = 0
        for y in range(0, h, 3):
            run = 0
            for x in range(w):
                px_r, px_g, px_b = px[x, y]
                if px_g > 120 and px_g > px_r * 2.2 and px_g > px_b * 2.2:
                    run += 1
                    if run > w * 0.3:
                        matched += run
                else:
                    run = 0
        frame.unlink(missing_ok=True)
        log("calibration: device", dev, "matched", matched)
        if matched > best[1]:
            best = (dev, matched)
    if best[0] is None:
        raise RuntimeError(f"calibration found the green marker on none of {candidates} - the window may be off-screen for this MONITOR preset")
    return best[0]


TOTAL = 12   # numbered caption bubbles in the real take (the sample take numbers its own 10)

# The pop-up code and the hold formulas are the shared Story code (story_bridge.py): the video and the live Story cannot drift.
def page_slide(cfg):
    """captions.py's flat slide -> the shared overlay's shape (an image comes from the local gitignored assets folder)."""
    return slide_payload(cfg, Path(__file__).resolve().parent / "assets")

def first_sentence(s, limit=150):
    s = (s or "").strip().split("\n")[0]
    cut = s.find(". ")
    s = s[:cut + 1] if cut > 0 else s
    return s if len(s) <= limit else s[:limit].rsplit(" ", 1)[0] + "..."

def switch_source(page, source):
    """The lab's Mock/Real switch. The page reloads itself on success, so wait for the fresh banner."""
    r = api("/api/mode", {"source": source})
    if r.get("source") != source:
        raise RuntimeError(f"could not switch the lab to {source}: {r}")
    page.wait_for_timeout(1500)
    page.reload(); page.wait_for_selector("[data-testid=mode-badge]"); page.wait_for_timeout(1200)
    log("lab switched to", source)

def main():
    WORK.mkdir(parents=True, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="hmlab-take-")
    (Path(profile) / "Default").mkdir(parents=True, exist_ok=True)
    (Path(profile) / "Default" / "Preferences").write_text(json.dumps({
        "credentials_enable_service": False, "credentials_enable_autosignin": False,
        "profile": {"password_manager_enabled": False}, "autofill": {"profile_enabled": False, "credit_card_enabled": False}}))
    result = {"ok": False}
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            profile, headless=HEADLESS, no_viewport=not HEADLESS, viewport={"width": WIN_W, "height": 900} if HEADLESS else None,
            color_scheme="light",
            **({"record_video_dir": str(WORK / "pw-video"), "record_video_size": {"width": WIN_W, "height": 900}} if RECORD_PW else {}),
            args=[f"--window-position={WIN_X},{WIN_Y}", f"--window-size={WIN_W},{WIN_H}", "--no-first-run", "--no-default-browser-check"])
        ctx.add_init_script("window.__pillText = " + json.dumps("SAMPLE: mock gateway and mock phone, not a real run" if SAMPLE else None) + ";")
        ctx.add_init_script(overlay_script())
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(APP + "/"); page.wait_for_selector("[data-testid=mode-badge]")
        page.select_option("#theme-select", THEME) if page.locator("#theme-select").count() else None
        if not HEADLESS:
            subprocess.run(["osascript", "-e", 'tell application "System Events" to set frontmost of (first process whose name is "Google Chrome for Testing") to true'], capture_output=True)
        page.bring_to_front(); page.wait_for_timeout(1500)

        if HEADLESS:
            DEV = None
        elif os.environ.get("CAPTURE_DEVICE"):
            DEV = os.environ["CAPTURE_DEVICE"]; log("capture device: forced via CAPTURE_DEVICE=", DEV)
        else:
            page.evaluate("""() => { document.body.style.setProperty('background', '#00FF00', 'important');
                document.body.style.setProperty('min-height', '100vh', 'important'); }""")
            page.wait_for_timeout(500)
            DEV = str(detect_capture_device(WORK))
            page.evaluate("() => { document.body.style.removeProperty('background'); document.body.style.removeProperty('min-height'); }")
            log("capture device: auto-detected", DEV, "for MONITOR=", MONITOR, "at", (WIN_X, WIN_Y))

        g = page.evaluate("() => ({screenX: window.screenX, screenY: window.screenY, outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio})")
        dpr = g["dpr"] or 1
        g["crop"] = {"w": round(g["innerW"] * dpr), "h": round(g["innerH"] * dpr),
                     "x": round((g["screenX"] - ORIGIN_X) * dpr), "y": round((g["screenY"] - ORIGIN_Y + (g["outerH"] - g["innerH"])) * dpr)}
        (WORK / "ready.json").write_text(json.dumps(g)); log("ready", g)
        page.evaluate("o => window.__cm.cap(o)", dict(n=0, total=TOTAL, title="Test frame", text="This is the recording area. Nothing is being recorded yet.", target="[data-testid=banner]"))
        if WAIT_GO:
            log("waiting for go.flag")
            while not (WORK / "go.flag").exists():
                if (WORK / "abort.flag").exists():
                    log("aborted"); ctx.close(); return
                time.sleep(0.5)
        else:
            page.wait_for_timeout(2000)
        page.evaluate("() => window.__cm.clear()")
        c = g["crop"]
        ff = None if HEADLESS else subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation", "-framerate", "30", "-capture_cursor", "1",
                               "-pixel_format", "uyvy422", "-i", f"{DEV}:none", "-vf", f"crop={c['w']}:{c['h']}:{c['x']}:{c['y']}",
                               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", "-t", "900", str(WORK / "take.mp4")],
                              stdin=subprocess.PIPE, stderr=open(WORK / "ffmpeg.log", "w"))
        log("rehearsal" if REHEARSE else "sample recording started (playwright)" if SAMPLE else "recording started"); time.sleep(0.2 if REHEARSE else 1.5)
        shots = os.environ.get("REHEARSE_SHOTS")

        def bubble(n, title, text, target=None, lines=None, secs=None, prefer=None):
            page.evaluate("o => window.__cm.cap(o)", dict(n=n, total=TOTAL, title=title, text=text, target=target, lines=lines, prefer=prefer))
            if REHEARSE and shots:
                page.wait_for_timeout(300); Path(shots).mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(Path(shots) / f"step-{n:02d}.png"))
            # The hold is the shared formula, evaluated in the page (Normal speed IS the live Story's Normal speed).
            secs_eff = secs if secs is not None else hold_bubble(page, text + " ".join(lines or []))
            page.wait_for_timeout(int(secs_eff * 1000 * (0.04 if REHEARSE else 1)))

        def show_slide(cfg, extra=0.0, name="slide", cap=30.0):
            payload = page_slide(cfg)
            page.evaluate("o => window.__cm.slide(o)", payload)
            if REHEARSE and shots:
                page.wait_for_timeout(300); Path(shots).mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(Path(shots) / f"{name}.png"))
            # The shared hold formula, evaluated in the page (owner rule 2026-11-22: no slide is held longer than 10 s; the take's old caps are gone with them).
            total_ms = int(hold_slide(page, payload) * 1000 * (0.04 if REHEARSE else 1))
            pre_ms = min(6000, int(total_ms * 0.45))
            page.wait_for_timeout(pre_ms)
            page.evaluate("() => window.__cm.scrollSlide()")   # the shared overlay scrolls a tall card to its verdict
            page.wait_for_timeout(max(0, total_ms - pre_ms))

        # The real PingID push, screenshotted on the approver's phone right after the run.
        # The owner drops the screenshot at video/assets/phone-push.png (AirDrop from the iPhone);
        # nothing in the video claims the capture saw the phone — the caption says how it was taken.
        PHONE_SHOT = Path(__file__).resolve().parent / "assets" / "phone-push.png"

        def show_photo(title, caption, secs=8.0, name="photo-phone"):
            if not PHONE_SHOT.exists():
                log("no phone screenshot at", PHONE_SHOT, "— skipping the phone insert (the caption slides carry the moment)")
                return False
            # The shared overlay's image slide: the photo beside the caption (slide_payload reads the file from the gitignored assets folder).
            payload = slide_payload(dict(image="phone-push.png", wide=True, header=None, title=title, lead=caption,
                                         col_a_heading="", col_a_lines=[], col_b_heading="", col_b_lines=[], verdict=""),
                                    Path(__file__).resolve().parent / "assets")
            page.evaluate("o => window.__cm.slide(o)", payload)
            if REHEARSE and shots:
                page.wait_for_timeout(300); Path(shots).mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(Path(shots) / f"{name}.png"))
            page.wait_for_timeout(int(secs * 1000 * (0.04 if REHEARSE else 1)))
            page.evaluate("() => window.__cm.clear()")
            return True

        # ---- checks before recording (SCRIPT.md) ----
        info = api("/api/info")
        log("api/info:", info)
        if SAMPLE or REHEARSE:
            switch_source(page, "mock")
            if REHEARSE and not SAMPLE:
                print("REHEARSE: switched the lab to MOCK for this run (a rehearsal must not fire a real gateway "
                      "call); use REHEARSE_REAL=1 to stay on Real without sending the call. Switch back with "
                      "POST /api/mode {\"source\":\"real\"} if you need to.", flush=True)
                log("WARNING: rehearsal switched the lab to MOCK; the real take switches it back to real itself")
            info = api("/api/info")
            assert info["source"] == "mock", info
        else:
            if info.get("source") != "real" or not info.get("realAvailable"):
                raise RuntimeError(f"the real take needs the lab in Real mode (api/info says source={info.get('source')!r}, "
                                   f"realAvailable={info.get('realAvailable')!r}); refusing to record a mock")
            real = api("/api/privilege/real")
            log("api/privilege/real:", real)
            if not real.get("ok"):
                raise RuntimeError(f"the real gateway is not configured: {real}")
            if SAMPLE is False and REHEARSE is False and os.environ.get("REHEARSE_REAL") != "1":
                pass  # the real take proceeds: the owner is driving and approves the push on their phone

        try:
            if SAMPLE:
                show_slide(SLIDES["sample_note"], extra=2.0, name="sample_note", cap=16.0)
            show_slide(OPENING_SLIDE, extra=0.0, name="opening", cap=40.0)
            page.evaluate("() => window.__cm.clear()")
            page.goto(APP + "/"); page.wait_for_selector("[data-testid=mode-badge]"); page.wait_for_timeout(1200)
            badge = page.inner_text("[data-testid=mode-badge]").strip()
            banner = page.inner_text("[data-testid=banner]").strip()
            log("mode badge:", badge, "| banner:", banner[:120])
            if not SAMPLE and not REHEARSE and badge.strip().lower() != "real":
                raise RuntimeError(f"the real take needs the header badge to say Real (it says {badge!r})")
            # Scene 1: the lab, the banner, the mode pill
            bubble(1, STEPS["sample_intro" if SAMPLE else "intro"]["title"], STEPS["sample_intro" if SAMPLE else "intro"]["text"],
                   "[data-testid=banner]", prefer="below", lines=[first_sentence(banner)])
            page.evaluate("() => window.__cm.clear()")
            show_slide(SLIDES["real_vs_sim"], extra=2.0, name="slide-real-vs-sim", cap=44.0)
            page.evaluate("() => window.__cm.clear()")
            # ---- pick the PRIVILEGE scenario chip ----
            chip = page.locator('[data-testid=step-pick] [data-scenario=privilege-pingid]').first
            chip.scroll_into_view_if_needed()
            bubble(2, STEPS["sample_pick" if SAMPLE else "pick"]["title"], STEPS["sample_pick" if SAMPLE else "pick"]["text"],
                   "[data-testid=step-pick]", prefer="below", lines=["scenario: " + SCENARIO])
            if SAMPLE or REHEARSE:
                page.evaluate("() => window.__cm.clear()")
                chip.click()
                # The mock hold: the scenario run answers 403 pending_approval with an instruction id,
                # and the PrivilegeModal (HITL Requests) opens.
                page.wait_for_selector('[data-testid=privilege-modal]', timeout=30000); page.wait_for_timeout(600)
                page.wait_for_function("document.querySelector('[data-testid=privilege-status]')?.textContent === 'pending'", timeout=15000)
                row = page.inner_text('[data-testid=privilege-queue]').strip()
                instruction_id = page.locator('[data-testid=privilege-queue] td code').first.inner_text().strip()
                log("mock hold:", instruction_id, "| queue row:", row[:120])
                bubble(3, STEPS["sample_hold"]["title"], STEPS["sample_hold"]["text"], '[data-testid=privilege-modal]', prefer="left",
                       lines=["403 · -32600 · pending_approval"])
                bubble(4, STEPS["sample_instruction"]["title"], STEPS["sample_instruction"]["text"], '[data-testid=privilege-queue]', prefer="left",
                       lines=["instruction id: " + instruction_id])
                page.evaluate("() => window.__cm.clear()")
                # ---- the push, and the approval on the mock phone ----
                page.click('[data-testid=privilege-approve]')   # moves to the PingID stage: the phone dialog appears
                page.wait_for_selector('[data-testid=pingid-phone-screen]', timeout=15000); page.wait_for_timeout(600)
                bubble(5, STEPS["sample_push"]["title"], STEPS["sample_push"]["text"], '[data-testid=pingid-phone-screen]', prefer="left")
                page.evaluate("() => window.__cm.clear()")
                bubble(6, STEPS["sample_approve"]["title"], STEPS["sample_approve"]["text"], '[data-testid=pingid-phone-screen]', prefer="left",
                       lines=["tap Approve on the mock phone"])
                page.click('[data-testid=pingid-approve]')
                page.wait_for_selector('[data-testid=verdict]', timeout=90000)
                page.wait_for_function("(document.querySelector('[data-testid=verdict]')?.textContent || '').includes('PERMITTED') || (document.querySelector('[data-testid=verdict]')?.textContent || '').includes('allow')", timeout=90000)
                page.wait_for_timeout(800)
                verdict = page.inner_text('[data-testid=verdict]').strip()
                receipt = page.locator('[data-testid=receipt]')
                log("mock executed:", verdict[:120], "| receipt:", receipt.inner_text().strip()[:120] if receipt.count() else "none")
                bubble(7, STEPS["sample_retry"]["title"], STEPS["sample_retry"]["text"], '[data-testid=verdict]', prefer="below",
                       lines=["X-Procyon-Approval-Id: " + instruction_id])
                bubble(8, STEPS["sample_executed"]["title"], STEPS["sample_executed"]["text"], '[data-testid=verdict]', prefer="below",
                       lines=[first_sentence(verdict)] + (["receipt: " + receipt.inner_text().strip()[:80]] if receipt.count() else []))
                page.evaluate("() => window.__cm.clear()")
                # ---- the boundary: a higher amount still held (the mock gate re-challenges) ----
                # The manual call must declare the privilege step-up so the gate re-presents the (now used)
                # approval id: a plain $600 call would stop at the MFA band instead, which is a different beat.
                amt = page.locator('[data-testid=step-try]')
                if amt.count():
                    amt.locator("summary").click()   # the "try your own call" panel is collapsed by default
                    page.wait_for_selector('[data-testid=call-amount]', state="visible", timeout=15000)
                    page.fill('[data-testid=call-amount]', "600")
                    page.select_option('[data-testid=call-declared]', "privilege")
                    page.click('[data-testid=call-run]')
                    try:
                        page.wait_for_selector('[data-testid=privilege-modal], [data-testid=block]', timeout=30000)
                        page.wait_for_timeout(600)
                    except Exception:
                        pass
                boundary_ok = page.locator('[data-testid=privilege-modal]').count() > 0 or page.locator('[data-testid=block]').count() > 0
                log("boundary beat held again:", boundary_ok)
                result["boundary_ok"] = boundary_ok
                bubble(9, STEPS["sample_boundary"]["title"], STEPS["sample_boundary"]["text"], '[data-testid=verdict]', prefer="below",
                       lines=["a higher call under the same approval: still held"])
                page.evaluate("() => window.__cm.clear()")
                bubble(10, STEPS["sample_audit"]["title"], STEPS["sample_audit"]["text"], '[data-testid=hops]', prefer="below")
                result.update(mode="sample", hold_id=instruction_id, executed=verdict[:120])
                ok = bool(instruction_id) and "PERMITTED" in verdict.upper()
            else:
                # ---- the REAL take: two mock use cases on the page's own gate (consent, MFA OTP), then the real PingID call ----
                def mock_chip(sid):
                    c = page.locator(f'[data-testid=step-pick] [data-scenario={sid}]').first
                    c.scroll_into_view_if_needed(); c.click()
                    return c

                # Use case 1 — consent: the modal asks, a human approves, the transfer runs.
                mock_chip("consent-hitl")
                page.wait_for_selector('[data-testid=consent-modal]', timeout=60000)
                page.wait_for_timeout(600)
                bubble(2, STEPS["consent_video"]["title"], STEPS["consent_video"]["text"], '[data-testid=consent-modal]', prefer="left")
                page.click('[data-testid=consent-approve]')
                page.wait_for_function("(document.querySelector('[data-testid=verdict]')?.textContent || '').includes('PERMITTED')", timeout=60000)
                page.wait_for_timeout(1200)
                page.evaluate("() => window.__cm.clear()")
                # Use case 2 — MFA step-up: the modal asks for the one-time code; presence proven, policy re-evaluates to PERMIT.
                mock_chip("mfa-step-up")
                page.wait_for_selector('[data-testid=mfa-modal]', timeout=60000)
                page.wait_for_timeout(600)
                bubble(3, STEPS["mfa_video"]["title"], STEPS["mfa_video"]["text"], '[data-testid=mfa-modal]', prefer="left",
                       lines=["OTP: 123123 (the labelled demo bypass)"])
                page.fill('[data-testid=mfa-otp]', "123123")
                page.click('[data-testid=mfa-verify]')
                page.wait_for_function("(document.querySelector('[data-testid=verdict]')?.textContent || '').includes('PERMITTED')", timeout=60000)
                page.wait_for_timeout(1200)
                page.evaluate("() => window.__cm.clear()")
                # Use case 3 — the real Privilege + PingID walk.
                bubble(4, STEPS["pick"]["title"], STEPS["pick"]["text"], "[data-testid=step-pick]", prefer="below",
                       lines=["tool: " + real.get("tool", "?"), "door: " + str(real.get("host", "?"))])
                page.evaluate("() => window.__cm.clear()")
                # The Real panel replaces the mock agent call while the PRIVILEGE scenario is selected in Real mode.
                chip.click()
                page.wait_for_selector('[data-testid=real-panel]', timeout=30000)
                page.wait_for_timeout(600)
                page.click('[data-testid=real-call]')
                # The first answer is the hold: outcome=held, 403 pending_approval, an instruction id.
                # The id is read from the API response, not the trace panel: the panel renders asynchronously and the
                # 2026-11-25 take executed fine but the panel read came back empty twice, flagging the film not-ok.
                page.wait_for_function("document.querySelector('[data-testid=real-empty]') === null", timeout=60000)
                held = api("/api/privilege/real/call", {})
                instruction_id = (held.get("held") or {}).get("instruction_id", "")
                if not instruction_id:
                    m = re.search(r"ins_[A-Za-z0-9_-]+", page.inner_text('[data-testid=gateway-trace]'))
                    instruction_id = m.group(0) if m else ""
                if not instruction_id:
                    # A single identical call reuses the open hold, so the retry above answered from the same
                    # instruction; the panel may still be catching up. Last resort: read it there.
                    for _ in range(10):
                        page.wait_for_timeout(1000)
                        m = re.search(r"ins_[A-Za-z0-9_-]+", page.inner_text('[data-testid=gateway-trace]'))
                        if m:
                            instruction_id = m.group(0); break
                    if instruction_id:
                        log("instruction id (trace fallback):", instruction_id)
                trace_text = page.inner_text('[data-testid=gateway-trace]').strip()
                log("real hold trace:", trace_text[:300]); log("instruction id:", instruction_id)
                if "pending_approval" not in trace_text:
                    raise RuntimeError("the real call did not come back held (pending_approval missing from the trace); "
                                       "check the gateway policy before recording: " + trace_text[:200])
                result["hold_id"] = instruction_id
                bubble(5, STEPS["hold"]["title"], STEPS["hold"]["text"], '[data-testid=gateway-trace] details.gw-ex', prefer="left",
                       lines=["HTTP 403 · -32600 · pending_approval"])
                bubble(6, STEPS["instruction"]["title"], STEPS["instruction"]["text"], '[data-testid=real-approval]', prefer="below",
                       lines=["instruction id: " + (instruction_id or "(read it off the trace)")])
                page.evaluate("() => window.__cm.clear()")
                # The push: Privilege sent it to the approvers' phones when the hold was minted. The take WAITS:
                # a generous poll of the same call (quiet retries, like the lab's own loop) while the owner decides.
                bubble(7, STEPS["push"]["title"], STEPS["push"]["text"], '[data-testid=real-waiting]', prefer="below",
                       lines=["the PingID push is on the approver's phone"])
                approved = False
                deadline = time.time() + APPROVAL_WAIT_S
                tries = 0
                while time.time() < deadline:
                    if (WORK / "abort.flag").exists():
                        log("aborted while waiting for the approval"); break
                    tries += 1
                    r = api("/api/privilege/real/call", {"approvalId": instruction_id} if instruction_id else {})
                    outcome = r.get("outcome")
                    log(f"poll {tries}: outcome={outcome}")
                    # Each retry mints a NEW hold id (the gateway grants are single-use and amount-bound);
                    # the approver's decision binds to the LATEST id, so track it or the grant never matches.
                    if outcome == "held":
                        new_id = (r.get("held") or {}).get("instruction_id", "")
                        if new_id and new_id != instruction_id:
                            instruction_id = new_id
                            log("poll minted a new hold id, tracking it:", instruction_id)
                    if outcome == "executed":
                        approved = True
                        # Show the executed answer in the panel: the page's own retry loop also polls, so drive it through the UI.
                        if instruction_id and page.locator('[data-testid=real-approval]').count():
                            page.fill('[data-testid=real-approval]', instruction_id)
                            page.click('[data-testid=real-retry]')
                        page.wait_for_timeout(4000)
                        break
                    if outcome not in ("held",):
                        log("unexpected outcome while waiting:", outcome, str(r)[:300])
                    if page.locator('[data-testid=real-waiting]').count():
                        page.evaluate("""() => { const w = document.querySelector('[data-testid=real-waiting]');
                            if (w && !w.dataset.cmNote) { w.dataset.cmNote = '1';
                                const p = document.createElement('p'); p.style.fontWeight = '700';
                                p.textContent = 'Waiting for the approver to decide on their phone (PingID push)...'; w.appendChild(p); } }""")
                    time.sleep(POLL_S)
                result["approved"] = approved
                if not approved:
                    raise RuntimeError(f"the approval did not land within {APPROVAL_WAIT_S}s — the owner never approved the push, "
                                       "or the gateway's answer was not an executed call; not recording a take that implies a success")
                page.wait_for_function("(document.querySelector('[data-testid=verdict]')?.textContent || '').length > 0", timeout=60000)
                page.wait_for_timeout(800)
                verdict = page.inner_text('[data-testid=verdict]').strip()
                log("real executed verdict:", verdict[:200])
                bubble(8, STEPS["approve"]["title"], STEPS["approve"]["text"], '[data-testid=real-waiting]', prefer="below",
                       lines=[f"approved on the phone after ~{int(APPROVAL_WAIT_S - (deadline - time.time()))}s of waiting"])
                # The phone itself: the owner's screenshot of the real PingID push, taken right
                # after the run (AirDrop to video/assets/phone-push.png). Skipped cleanly if absent.
                show_photo("The push that arrived",
                           "The real PingID push on the approver's phone — screenshotted right after the run, not during the capture.")
                bubble(9, STEPS["retry"]["title"], STEPS["retry"]["text"], '[data-testid=gateway-trace] details.gw-ex:last-of-type', prefer="left",
                       lines=["X-Procyon-Approval-Id: " + (instruction_id or "?")])
                bubble(10, STEPS["executed"]["title"], STEPS["executed"]["text"], '[data-testid=verdict]', prefer="below",
                       lines=[first_sentence(verdict)])
                page.evaluate("() => window.__cm.clear()")
                # ---- the boundary: present the spent id again for a higher call; the gateway must hold it again ----
                bubble(11, STEPS["boundary"]["title"], STEPS["boundary"]["text"], '[data-testid=real-approval]', prefer="below",
                       lines=["the same id, presented again: the gateway must not pass it"])
                if page.locator('[data-testid=real-approval]').count():
                    page.fill('[data-testid=real-approval]', instruction_id)
                    page.click('[data-testid=real-retry]')
                else:
                    log("approval field gone (page already advanced); boundary beat via the receipt retry is skipped")
                page.wait_for_timeout(8000)
                still = page.inner_text('[data-testid=gateway-trace]').strip()
                boundary_ok = "pending_approval" in still or "held" in still.lower()
                result["boundary_ok"] = boundary_ok
                log("boundary beat: still held =", boundary_ok)
                if not boundary_ok:
                    log("WARNING: the boundary beat did not show a fresh hold; check the gateway's amount binding before claiming it")
                page.evaluate("() => window.__cm.clear()")
                bubble(12, STEPS["audit"]["title"], STEPS["audit"]["text"], '[data-testid=gateway-trace]', prefer="below")
                result.update(mode="real", verdict=verdict[:200])
                ok = approved and bool(instruction_id)
            page.evaluate("() => window.__cm.clear()")
            show_slide(SLIDES["retry_rule"], extra=2.0, name="slide-retry-rule", cap=44.0)
            page.evaluate("() => window.__cm.clear()")
            closing = dict(CLOSING_SLIDE)
            if SAMPLE:
                closing["lead"] = STEPS["sample_closing_lead"]["text"]
                closing["col_a_lines"] = [STEPS["sample_closing_bullet"]["text"], *CLOSING_SLIDE["col_a_lines"][1:]]
            elif not result.get("boundary_ok"):
                closing["col_a_lines"] = [l for l in closing["col_a_lines"] if "larger amount" not in l]
                closing["lead"] = closing["lead"].replace(", one execution — and a second call still held", ", one execution")
            show_slide(closing, extra=3.0, name="closing", cap=48.0)
            result["ok"] = ok
        finally:
            log("stopping recording")
            if ff is not None:
                try: ff.send_signal(signal.SIGINT)
                except Exception: pass
                try: ff.wait(timeout=30)
                except Exception: ff.kill()
            (WORK / "result.json").write_text(json.dumps(result, indent=1))
            (WORK / "done.flag").write_text("done")
        vpath = page.video.path() if RECORD_PW and page.video else None
        ctx.close()
        if vpath:
            out = WORK / "sample.mp4"
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(vpath), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(out)], check=True)
            log("sample video:", out)

if __name__ == "__main__":
    main()
