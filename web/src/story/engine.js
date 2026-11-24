// engine.js: the Story walker. It decides WHICH step to show and WHEN, and draws nothing itself (overlay.js draws, the lab's host reads and drives the page).
// Next/Back never use a timer. Play for me (optional) advances on the video's holds (hold.js) at a viewer-chosen speed, and stops on any manual input.
// No DOM, no network, no imports beyond hold.js: the lab gives it a `host`, an `overlay` and (for tests) a clock. Vendor to web/src/story/engine.js,
// byte-for-byte; never edit a lab's copy. The contract is shared/story/README.md.
//
// A step (the demo's script, one per caption key):
//   { key, type: 'bubble' | 'slide', trigger: 'load' | 'run-done' | 'frame',
//     target,          // bubble: a CSS selector, an Element, or a function returning either. Missing at show time => the step is SKIPPED
//     prefer, place,   // bubble placement hints (overlay.cap)
//     modes,           // ['real'] / ['mock']: shown only in that mode (default: both)
//     sampleKey,       // Mock wording: the caption key used instead of `key` in Mock mode (the "sample_*" variants)
//     when,            // () => false hides the step (a conditional scene)
//     live,            // () => ({name: value}) read from the page; fills {name} in the wording
//     lines,           // (values) => [strings] shown as the bubble's fact lines
//     prompt,          // { text } : a prompt step. host.prefill(step) runs before it shows; the viewer presses Send (Play presses it for them)
//     fixedSecs,       // Play's own hold for this step (the video's 4.5 / 5.0 for a prompt step), else the formula
//     frameTimeoutMs,  // trigger 'frame': how long to wait for the target (default 2500)
//     tab, before, after,  // host.switchTab(tab); before(): may open a pop-out (may be async); after(): closes it when the step is left
//     transform }      // (slide, mode) => slide : a last tweak to a slide's wording
// host: { mode(), query(selector) -> Element|null, mark(), waitForRun(marker, timeoutMs) -> Promise<{ok, reason?}>, prefill(step), send(step), switchTab(tab), assetUrl(name),
//         runStarted(marker) -> boolean, runInFlight() -> boolean, onRun(cb) -> unsubscribe }   runInFlight/onRun (optional, recommended): let the wait for a run say whose turn it is (
//         nothing running = the viewer's: press Send) and accept a result the page already shows when the viewer sent the question early
//           runStarted (optional, recommended): true when a run began since mark(), so Play never sends a question the viewer already sent

import { bubbleHold, slideHold, holdMs, speedFactor, SPEED_NAMES } from './hold.js';

export const WAIT_TIMEOUT_MS = 180000;
export const FRAME_TIMEOUT_MS = 2500;
const FRAME_POLL_MS = 250;
const UNAVAILABLE = '(unavailable)';

// {name} -> the page's value. A value the page could not read shows as "(unavailable)" and is reported, never invented.
export function fillLive(text, values = {}) {
  const missing = [];
  const out = String(text ?? '').replace(/\{([a-z][A-Za-z0-9_]*)\}/g, (m, name) => {
    const v = values?.[name];
    if (v === undefined || v === null || v === '') { missing.push(name); return UNAVAILABLE; }
    return String(v);
  });
  return { text: out, missing };
}

export function createStory({ steps, captions, overlay, host, store = null, prefix = 'story', timers = null, waitTimeoutMs = WAIT_TIMEOUT_MS }) {
  const T = timers || { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (id) => globalThis.clearTimeout(id), now: () => Date.now() };
  const SPEED_KEY = `${prefix}.story.speed`;
  const read = (k) => { try { return store ? store.getItem(k) : null; } catch { return null; } };
  const write = (k, v) => { try { if (store) store.setItem(k, v); } catch { /* storage blocked: the choice is kept for this session only */ } };

  const st = { active: false, status: 'idle', index: -1, pos: -1, n: 0, total: 0, kind: null, key: null, playing: false, paused: false,
    speed: SPEED_NAMES.includes(read(SPEED_KEY)) ? read(SPEED_KEY) : 'normal', message: '', warnings: [], isPrompt: false, promptKind: null, waitingOn: null, stalledAt: -1 };
  const subs = new Set();
  let gen = 0; let shown = []; let marker = null; let current = null;
  let holdTimer = null; let scrollTimer = null; let holdEndsAt = 0; let holdRemaining = 0; let holdAction = null; let holdSlide = false; let curSecs = 0;
  let passed = new Set();   // steps the story has moved past: a prompt in here was already asked, so Play never sends it again

  const mode = () => (host.mode() === 'mock' ? 'mock' : 'real');
  const whenOk = (s) => { if (!s.when) return true; try { return s.when() !== false; } catch { warn(`"${s.key}": its condition could not be read, so the step is shown`); return true; } };
  const eligible = (s) => (!s.modes || s.modes.includes(mode())) && whenOk(s);
  const cleared = () => st.status === 'done' || st.status === 'stalled';   // the last step is no longer on screen, so Back shows it again
  const snapshot = () => ({ ...st, warnings: [...st.warnings], canBack: cleared() ? st.pos >= 0 : st.pos > 0 && st.status !== 'waiting', canNext: ['showing', 'stalled'].includes(st.status) });
  const emit = () => { const s = snapshot(); subs.forEach((f) => f(s)); };

  const clearHold = () => { if (holdTimer !== null) T.clearTimeout(holdTimer); if (scrollTimer !== null) T.clearTimeout(scrollTimer); holdTimer = scrollTimer = null; };
  const closeAfter = (s) => { if (s.after) { try { Promise.resolve(s.after()).catch(() => {}); } catch { /* closing a pop-out must not stop the story */ } } };
  const leave = async () => { const c = current; current = null; if (c && c.after) { try { await c.after(); } catch { /* closing a pop-out must not stop the story */ } } };
  const warn = (m) => { if (!st.warnings.includes(m)) st.warnings.push(m); };
  // A host or script callback that throws must never wedge the story: it is reported and the story carries on.
  const safe = (fn, fallback, message) => { try { return fn(); } catch { if (message) warn(message); return fallback; } };

  const targetOf = (s) => safe(() => {
    const t = typeof s.target === 'function' ? s.target() : s.target;
    return typeof t === 'string' ? host.query(t) : t || null;
  }, null, `"${s.key}": its target could not be found on the page`);
  // The number a bubble shows counts BUBBLES only (the video's 1 to 27): slides are not numbered. `total` is the bubbles shown so far plus the ones still to come that
  // apply to this run, so it falls as steps are skipped.
  const isBubble = (s) => s.type === 'bubble';
  const remainingAfter = (i) => steps.slice(i + 1).filter((s) => isBubble(s) && eligible(s)).length;

  function capOf(s) {
    if (s.type === 'slide') {
      let c = s.key === 'opening' ? captions.opening : s.key === 'closing' ? captions.closing : captions.slides?.[s.key];
      if (c && s.transform) c = s.transform(c, mode());
      return c || null;
    }
    return captions.steps?.[mode() === 'mock' && s.sampleKey ? s.sampleKey : s.key] || null;
  }

  async function waitFor(s, my, { skipWait }) {
    if (skipWait || s.trigger === 'load' || !s.trigger) return { ok: true };
    st.status = 'waiting'; st.index = steps.indexOf(s); st.key = s.key; st.isPrompt = false; st.promptKind = null;
    clearHold(); holdAction = null; holdRemaining = 0;
    overlay.clear();
    if (s.trigger === 'run-done') {
      const inFlight = () => safe(() => !!(host.runInFlight && host.runInFlight()), false);
      const started = () => safe(() => !!(host.runStarted && host.runStarted(marker)), false);
      // The viewer sent the question before this step (or before a reload) and its result is already on the page, with nothing running: show it, do not wait for another run.
      if (host.runInFlight && !inFlight() && !started() && targetOf(s)) return { ok: true };
      // Say who we are waiting on, and keep saying it truthfully as a run starts and ends: nothing running is the VIEWER's turn (press Send); a run in flight is the run's.
      const say = () => {
        const viewer = host.runInFlight ? !inFlight() && !started() : false;
        st.waitingOn = host.runInFlight ? (viewer ? 'viewer' : 'run') : null;
        st.message = !host.runInFlight ? 'Waiting for the run to finish. Press Send if you have not.' : viewer ? 'Your turn: press Send for the question above; the story carries on when the answer is in.' : 'Waiting for the run to finish.';
        emit();
      };
      say();
      const off = safe(() => (host.onRun ? host.onRun(() => { if (my === gen && st.status === 'waiting') say(); }) : null), null);
      let r;
      try { r = await host.waitForRun(marker, waitTimeoutMs); } catch { r = { ok: false, reason: 'The run could not be checked. Press Next to carry on, or Exit.' }; }
      finally { if (typeof off === 'function') safe(off, undefined); st.waitingOn = null; }
      return my === gen ? r : { ok: false, stale: true };
    }
    // 'frame': poll for the target. A target that never appears means the step does not apply to this run: it is skipped, not an error.
    st.message = 'Waiting for the next part to appear.'; emit();
    const limit = s.frameTimeoutMs ?? FRAME_TIMEOUT_MS; let waited = 0;
    while (my === gen && !targetOf(s) && waited < limit) { await new Promise((res) => T.setTimeout(res, FRAME_POLL_MS)); waited += FRAME_POLL_MS; }
    return my !== gen ? { ok: false, stale: true } : { ok: true };
  }

  // Find the next step to show, starting at index i, skipping the ones that do not apply to this run.
  async function advance(i, { skipWait = false } = {}) {
    const my = ++gen; clearHold(); await leave();
    if (my !== gen) return undefined;   // the viewer pressed Exit, Back or Next while a pop-out was closing
    for (; i < steps.length; i += 1) {
      const s = steps[i];
      if (!eligible(s)) continue;
      if (s.tab && host.switchTab) safe(() => host.switchTab(s.tab), undefined, `"${s.key}": its tab could not be opened`);   // before the target is looked for: it may live in that tab
      const w = await waitFor(s, my, { skipWait: skipWait && i === st.stalledAt });
      if (w.stale || my !== gen) return;
      if (!w.ok) { st.status = 'stalled'; st.stalledAt = i; st.message = w.reason || 'The run did not finish. Press Next to carry on, or Exit.'; if (st.playing) stopPlay(`Play stopped: ${st.message}`); emit(); return; }
      if (s.before) { try { await s.before(); } catch { warn(`step "${s.key}": its pop-out did not open`); } if (my !== gen) { closeAfter(s); return; } }
      if (s.type === 'bubble' && !targetOf(s)) { closeAfter(s); continue; }   // the target is not on this run: skip
      return present(i, my, { replay: false });
    }
    return finish();
  }

  function present(i, my, { replay }) {
    if (my !== gen) return undefined;
    const s = steps[i];
    const cap = capOf(s);
    if (!cap) {   // no wording: skip it, and close any pop-out its before() opened
      warn(`no wording for "${s.key}"`);
      closeAfter(s);
      return advance(i + 1);
    }
    current = s;
    if (!replay) { if (st.pos >= 0) passed.add(shown[st.pos]); shown = shown.slice(0, st.pos + 1); shown.push(i); st.pos = shown.length - 1; }
    if (s.prompt && !replay) { marker = safe(() => host.mark(), { runs: 0 }, `"${s.key}": the run counter could not be read`); safe(() => host.prefill(s), undefined, `"${s.key}": the question could not be filled in`); }   // Back never refills a prompt the viewer may have edited
    st.index = i; st.key = s.key; st.status = 'showing'; st.message = ''; st.isPrompt = !!s.prompt; st.promptKind = s.prompt ? (s.prompt.press ? 'press' : 'text') : null; st.stalledAt = -1;
    st.kind = s.type; st.n = shown.slice(0, st.pos + 1).filter((i) => isBubble(steps[i])).length; st.total = shown.filter((i) => isBubble(steps[i])).length + remainingAfter(shown[shown.length - 1]);
    if (s.type === 'slide') {
      overlay.slide({ ...cap, image: cap.image && host.assetUrl ? host.assetUrl(cap.image) : null });
      curSecs = slideHold(cap);
    } else {
      const values = s.live ? (() => { try { return s.live() || {}; } catch { return {}; } })() : {};
      const title = fillLive(cap.title, values); const text = fillLive(cap.text, values);
      [...title.missing, ...text.missing].forEach((m) => warn(`"${s.key}": {${m}} could not be read from the page`));
      let lines;
      if (s.lines) { try { lines = (s.lines(values) || []).filter(Boolean); } catch { warn(`"${s.key}": its fact lines could not be read from the page`); lines = []; } }
      overlay.cap({ n: st.n, total: st.total, title: title.text, text: text.text, target: () => targetOf(s), lines, prefer: s.prefer, place: s.place });
      curSecs = bubbleHold(text.text, lines || [], s.fixedSecs ?? null);
    }
    emit();
    prepareHold(s, curSecs);
    if (st.playing && !st.paused) startHold();
    return undefined;
  }

  // Show a step already shown once (Back, or Next after Back): its trigger has fired, but a pop-out has to be opened again.
  async function replayAt(pos) {
    gen += 1; const my = gen; clearHold(); await leave();
    if (my !== gen) return undefined;
    st.pos = pos;
    const s = steps[shown[pos]];
    if (s.tab && host.switchTab) safe(() => host.switchTab(s.tab), undefined, `"${s.key}": its tab could not be opened`);
    if (s.before) { try { await s.before(); } catch { warn(`step "${s.key}": its pop-out did not open`); } if (my !== gen) { closeAfter(s); return undefined; } }
    return present(shown[pos], my, { replay: true });
  }

  // ---- Play for me: the hold, scaled by the speed. Never used by Next/Back.
  // The hold belongs to the step on screen: it is prepared (action and time) whenever a step shows, so Pause then Resume can never fire an earlier step's hold.
  function prepareHold(s, secs) {
    clearHold();
    holdRemaining = holdMs(secs, st.speed); holdEndsAt = 0;
    const slide = s.type === 'slide';
    holdAction = async () => {
      holdTimer = null;
      // Send only the first time the prompt is shown: after Back the viewer may have edited or already sent the question.
      const asked = passed.has(shown[st.pos]) || safe(() => !!(host.runStarted && host.runStarted(marker)), false);   // the viewer may already have pressed Send
      if (s.prompt && !asked) {
        try { host.send(s); } catch { stopPlay('Play stopped: the question could not be sent.'); emit(); return; }
      }
      await next({ fromPlay: true });
    };
    holdSlide = slide;
  }
  function startHold() {
    if (!holdAction) return;
    clearHold();
    holdEndsAt = T.now() + holdRemaining;
    holdTimer = T.setTimeout(() => holdAction(), holdRemaining);
    if (holdSlide) {   // a tall slide scrolls to its verdict at 45% of the hold (at most 6 s in), as the video does
      const at = Math.min(Math.round(6000 * speedFactor(st.speed)), Math.round(holdRemaining * 0.45));
      scrollTimer = T.setTimeout(() => { scrollTimer = null; overlay.scrollSlide(); }, at);
    }
  }

  function stopPlay(message) {
    st.playing = false; st.paused = false; clearHold();
    if (message) st.message = message;
  }

  function finish() {
    clearHold(); overlay.clear(); stopPlay();
    st.status = 'done'; st.message = 'End of the story.'; st.isPrompt = false; st.promptKind = null; emit();
  }

  // ---- the viewer's controls
  async function start() {
    gen += 1; clearHold(); await leave(); overlay.clear();
    shown = []; marker = null; passed = new Set();
    Object.assign(st, { active: true, status: 'showing', index: -1, pos: -1, n: 0, total: 0, kind: null, key: null, playing: false, paused: false, message: '', warnings: [], isPrompt: false, promptKind: null, stalledAt: -1 });
    emit();
    return advance(0);
  }
  async function next({ fromPlay = false } = {}) {
    if (!st.active) return undefined;
    if (!fromPlay && st.playing) stopPlay();
    if (st.status === 'waiting') return undefined;                       // a run is in flight: nothing to skip to
    if (st.status === 'stalled') return advance(st.stalledAt, { skipWait: true });
    if (st.status === 'done') return undefined;
    if (st.pos < shown.length - 1) return replayAt(st.pos + 1);
    return advance(st.index + 1);
  }
  async function back() {
    if (!st.active || st.status === 'waiting' || st.pos < (cleared() ? 0 : 1)) return undefined;
    if (st.playing) stopPlay();
    return replayAt(cleared() ? st.pos : st.pos - 1);
  }
  async function exit() {
    gen += 1; clearHold(); await leave(); overlay.clear();
    Object.assign(st, { active: false, status: 'idle', playing: false, paused: false, message: '', isPrompt: false });
    emit();
  }
  function play() {
    if (!st.active || st.status === 'done') return;
    st.playing = true; st.paused = false; st.message = ''; emit();
    if (st.status === 'showing' && current) { prepareHold(current, curSecs); startHold(); }
  }
  function pause() {
    if (!st.playing || st.paused) return;
    st.paused = true;
    if (holdTimer !== null) { holdRemaining = Math.max(0, holdEndsAt - T.now()); }
    clearHold(); emit();
  }
  function resume() {
    if (!st.playing || !st.paused) return;
    st.paused = false;
    if (st.status === 'showing' && current) startHold();
    emit();
  }
  function setSpeed(name) {
    if (!SPEED_NAMES.includes(name)) return;
    st.speed = name; write(SPEED_KEY, name); emit();
  }
  // Any manual input (a click, a key) hands the story back to the viewer. Synthetic events from host.send are not manual: the host filters them.
  const manualInput = () => { if (st.playing) { stopPlay('Play stopped: you took over.'); emit(); } };

  return {
    start, next, back, exit, play, pause, resume, setSpeed, manualInput, restart: start,
    state: snapshot, subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
    destroy: () => { gen += 1; clearHold(); overlay.clear(); subs.clear(); },
  };
}
