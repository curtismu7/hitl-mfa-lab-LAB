# Story mode spec (HITL MFA lab)

**Status:** draft   **Owner:** Curtis (decides scope)
**Process tier:** 1 (lab prototype only the owner sees).
**Contract:** `shared/story/README.md` in AI-DEMO-Standalone; runbook `shared/story/ADDING-TO-A-LAB.md`. Reference lab: `privilege-a2a-anthropic-demo-LAB`.

## Goal
Add the family **Demo | Story** toggle to the HITL MFA lab AND move its recorded video (`video/take.py`) onto the shared code in the same change (runbook sections 1–9), so the live walk-through and the film can never drift.

## What exists here (differs from the A2A reference)
- **A video, but its own overlay.** `video/take.py` injects its own `OVERLAY` IIFE (`cm-*` classes) and its own parser (`video/captions.py`, Python). Section 9 replaces both: `video/story_bridge.py` injects the vendored `overlay.js`/`hold.js` (`createOverlay({ follow: false })`), `captions.py` reads the running lab's `GET /api/story` and refuses a stale file by `sourceSha256`, and the wording file gains the shared format's requirements (rule-29 `## Header` on the opening slide and on `sample_note`).
- **Wording exists** (`video/captions.md`: 4 slides + 10 bubbles + sample_* variants). It needs: `## Header` sections, renames to the shared heading shapes (`# Slide: <key>`), and the steps keyed exactly as the script names them.
- **All-React app, one page.** The toggle goes in `App.jsx`'s TopMenu `extra` slot; run events fire from `PolicyGate`'s runs (agent call, real call, scenario run) as `hmlab:run-start` / `hmlab:run-end`; Reset already dispatches through `workspace.js`.
- **Real take is owner-run.** Story walks Mock; Real-mode walk only exercises selectors (REHEARSE_REAL-style, never sending the call).

## Design
- Vendored byte for byte from `shared/story` at its merged commit, pinned by `web/src/story/story.sha256` + `scripts/story-checkPin.mjs`. Never edited.
- Server: `server/src/storyRoute.js` (plain-JS port of the A2A `src/story.ts`, including `sourceSha256`) + `GET /api/story`; Dockerfile copies `video/captions.md` into the image; docker-compose mounts it read-only.
- Web: `storyScript.js` (one entry per caption key, in take.py's order), `storyWiring.js` (host: press selectors for `real-call` / mock run buttons, tab-less single page, the live fact lines take.py reads: banner first sentence, instruction id, verdict, receipt), `StoryRoot.jsx`, `StoryBoundary.jsx`, the toggle in `App.jsx`.
- Video: `video/story_bridge.py` (vendored overlay+hold as one injected function), `captions.py` rewritten to fetch `/api/story` (no parser of its own; refuses a different file by sha), `test/storyBridge.test.ts` + node wrapper, take.py's scene list unchanged (same keys, same order), `show_photo` kept (the phone insert is the take's own).

## Acceptance criteria
1. Pin check passes; editing a vendored file fails CI.
2. Parity both ways between `video/captions.md` and `storyScript.js`, sample keys included; drift fails the build.
3. take.py-derived tests (the A2A lab's): bubble order, TOTAL=10 both modes, mode flags (sample_* ↔ real pairs), fixed holds read from take.py (`secs=`), questions/targets match.
4. Rule 29: the opening slide and `sample_note` carry `## Header`.
5. `GET /api/story`: 200 + hash; a broken file is a 500 naming the problem, never a path; an edit shows without a restart.
6. The route/captions contract: `captions.py` refuses a lab serving different bytes than the checkout's captions.md.
7. Story walks in Mock offline end to end (10 bubbles, 4 slides); the wording says simulated where the run is; nothing claims a live gateway call in Mock.
8. Wiring tests: host events, press-and-wait, targets, skipped steps, the mode-conditional bubbles.
9. Demo mode unchanged; `npm test` green (server, web, scripts).
10. `walk.py` exit 0 at 1920×1080 and 1800×1169, screenshots read; `play.py` exit 0.
11. Rehearsal pixel-compare: OLD and NEW `take.py` run with `REHEARSE=1 SAMPLE=1 REHEARSE_SHOTS=<dir>`; stills identical modulo known random ids (old take run twice to learn its own variance).
12. Image built on the Air holds the wording file (`docker --context air`), and the loaded-captions probe parses 10 steps + 4 slides.

## Unhappy paths
- Real not configured: Story still walks in Mock; the real-panel bubble targets are absent in Mock and skip quietly.
- A run fails or is DENIED: the bubble shows the verdict the page shows; no wording claims a permit that did not happen.
- The approval wait (real take) times out: take.py already refuses; Story never drives the real call — the viewer presses.
- The viewer resets mid-story: `hmlab:reset` ends waiters.
- Esc while the consent modal, MFA modal or CIBA phone panel is open: tested; decided by test and noted.

## Out of scope
Editing the shared TopMenu or any vendored file; recording the final video (owner-run, after merge, per `VIDEO.md`); changing the decision contract or any API; screenshots in the repo; cluster or tenant changes.

## Protected / must not break
Mock/Real mode contract (rule 19, `POST /api/mode` shape); the decision contract; vendored TopMenu, run-observability, diagram-kit pins; `tokens.css` colour rule; the real call path (Story never sends it); no PingID/PingOne calls added.

## Verification plan
`npm test` in the worktree; `node scripts/story-checkPin.mjs .`; `walk.py` both sizes + `play.py` on a local run; rehearsal pixel-compare old vs new take (old run twice for variance); Docker image probe on the Air; `/code-review` on the lab's own code; PR open until the owner says "merge N". No deploy beyond local Docker.
