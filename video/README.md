# HITL MFA video (standalone lab)

Follows the demo family's video standards: `VIDEO-BEST-PRACTICES.md` (in `privilege-a2a-anthropic-demo-LAB/video`).
Order of work: `SCRIPT.md` (sources first) -> `captions.md` (wording) -> **sample** -> review -> real take.

The lab must be running at **http://127.0.0.1:7680** (from the repo root: `HOST_PORT=7680 docker compose up --build -d`).

    # rehearsal (fast, headless, no video). Switches the lab to MOCK for the run and prints a warning:
    # a rehearsal must not fire a real gateway call. REHEARSE_SHOTS=dir keeps a still per caption.
    REHEARSE=1 python3 video/take.py video/out/rehearse

    # sample: mock gateway + mock phone, headless, full timing, labelled SAMPLE -> sample.mp4
    SAMPLE=1 python3 video/take.py video/out/sample-work

    # real take: the lab in Real mode, the owner's phone with PingID paired; opens its own Chrome
    # window and records it with ffmpeg. Follow "Before every recording" in VIDEO-BEST-PRACTICES.md
    # first (green-marker calibration after any monitor change).
    python3 video/take.py video/out/take-work

## Prerequisites

- **The lab running on 7680**, built (`web/` built into `server/public` or the compose image).
- **Real mode configured, owner-run**: `HMLAB_REAL_URL`, `HMLAB_REAL_AGENT_KEY`, `HMLAB_REAL_TOOL`
  (and optionally `HMLAB_REAL_ARGS`) in the lab's `.env`. `GET /api/info` must say
  `source: "real"`; the real take refuses to run otherwise and never switches the lab into Real itself.
- **The owner's phone with PingID enrolled**, and the approver named in the gateway's AI policy paired
  with the PingID app — with tenant MFA on, the hold itself sends the push (the lab's own checklist,
  shown in the Real panel, covers this).
- python3 with `playwright` and `pillow`, and `ffmpeg` on PATH.

## The check-list before the real take (from SCRIPT.md, "Checks before recording")

1. The banner and mode pill say Real, and only the PRIVILEGE scenario is real.
2. The held call's answer shows on screen as 403 with `pending_approval` and an instruction id — the
   take verifies this from the gateway trace before captioning it.
3. The PingID push arrives on the owner's phone (Real mode: Privilege sends it when the hold is minted;
   if no push arrives, tenant MFA is off — fix that in the console first).
4. The retry window is 90 s and the request stays open 120 s: the take retries inside the window or
   shows the lapse, never implying an open-ended window.
5. The amount-bound beat (caption 9) must show the presented id held again — the take logs it, and the
   closing slide drops the claim if it did not happen.
6. The take must not claim: the hold was made by a real Privilege tenant (the 403 shape is UNVERIFIED),
   the approval id equals the instruction id on a real tenant (the on-screen id box is editable), or
   that any refusal shown is a real PingID refusal (the lab's own contract codes).
7. The approver approves the push **on their phone** during the take: the take waits (default 180 s,
   `APPROVAL_WAIT_S` to change) polling the lab's status endpoint, then verifies the approval landed
   (outcome `executed`) before continuing.

## Notes

- The real take polls `POST /api/privilege/real/call` with the instruction id every 3 s while waiting —
  the same call and cadence as the lab's own retry loop — so its polling does not conflict with the page.
- `SAMPLE=1` and `REHEARSE=1` switch the lab to mock (`POST /api/mode {"source":"mock"}`) at start; the
  real take does not touch the mode switch. Switch back manually if a rehearsal left it on mock.
- `out/` is gitignored. `result.json` in the work dir records what the take actually verified — check it
  (and the contact sheet) before handing a take over.

## Headless real take (the one that worked, 2026-11-22)

The owner's screen stays locked; Playwright records headless:

    HEADLESS_REAL=1 python3 video/take.py /tmp/hmlab-real

The push arrives ~90 s in; the take polls up to 180 s (`APPROVAL_WAIT_S`). Ops lessons from the
successful take (all encoded in take.py now, but they cost the session hours — do not rediscover):

- **PingID silently throttles repeat push notifications.** Holds minted minutes apart delivered no
  push (two pushes at 19:29 and 19:51 UTC, then silence across four holds). Space takes 20+ minutes
  apart; one hold per take; no warmup probes that mint holds.
- The lab's own API rate-limits under polling — the take's poller retries transient 4xx/5xx.
- The local `pingid-gateway` compose containers can be externally restarted mid-take; check
  `docker ps` uptime before recording, and that `POST /api/privilege/real/call` answers.
- Gateway instruction ids are hex (`ins_<hex>`), not numeric.

## After the take

- The take outputs `pw-video/*.webm`; convert: `ffmpeg -i pw-video/*.webm -c:v libx264 -pix_fmt
  yuv420p -movflags +faststart real-take.mp4`, then a contact sheet:
  `ffmpeg -i real-take.mp4 -vf "fps=1/16,scale=360:-1,tile=4x4" -frames:v 1 contact-sheet.png`.
- **Phone insert (optional)**: AirDrop the PingID push screenshot to `video/assets/phone-push.png`
  BEFORE the take — take.py renders it full-screen at the approval beat and skips cleanly if absent.
  (The 2026-11-22 take was cut without it; the caption slides carry the moment.)
- **Boundary beat**: if a take aborts before the boundary (the spent receipt re-presented and held
  again), the fix is committed — the approval-field guard — so a fresh take captures it; the
  2026-11-22 take ends at the executed verdict and is complete through the story's climax.
