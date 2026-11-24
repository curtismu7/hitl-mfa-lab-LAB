// Story wiring: the lab's own glue between the shared Story engine (web/src/story/, vendored) and this page. It turns the script (storyScript.js) into
// engine steps and gives the engine a `host` that reads and drives the page: the run events, the press prompts, the live fact lines. It never edits the
// page's own markup; it clicks the page's own buttons with script-made events (isTrusted is false, so Play for me is not mistaken for the viewer's input).
//
// The page announces runs with hmlab:run-start and hmlab:run-end ({ ok }) — workspace.js fires them around every write (a scenario run, an agent call,
// a human beat, a real call). ok is false only when the request itself failed; a DENY or a hold (428/403) completes as data, so it is a run that ended ok.

import { STEPS, SAMPLE_NOTE } from './storyScript.js';

const text = (el) => (el && el.textContent ? el.textContent.trim() : '');

/** The first sentence, never cut mid-word (the video's first_sentence). */
export function firstSentence(s, limit = 150) {
  let t = String(s || '').trim().split('\n')[0] || '';
  const cut = t.indexOf('. ');
  if (cut > 0) t = t.slice(0, cut + 1);
  if (t.length <= limit) return t;
  const head = t.slice(0, limit);
  const sp = head.lastIndexOf(' ');
  return `${sp > 0 ? head.slice(0, sp) : head}...`;
}

export function createHost({ win = window, doc = document, mode = () => 'mock', settleMs = 400 } = {}) {
  const runs = { starts: 0, ends: 0, lastOk: true };
  const waiters = new Set();
  const timers = new Set();
  const watchers = new Set();
  const onStart = () => { runs.starts += 1; watchers.forEach((f) => f()); };
  const onEnd = (e) => {
    runs.ends += 1; runs.lastOk = e.detail ? e.detail.ok !== false : true;
    for (const w of [...waiters]) w(runs.lastOk);
    watchers.forEach((f) => f());
  };
  // A Reset empties the page: a step waiting for a run is told so.
  const onReset = () => { for (const w of [...waiters]) w(false, 'The page was reset. Press Next to carry on, or Exit.'); };
  win.addEventListener('hmlab:run-start', onStart);
  win.addEventListener('hmlab:run-end', onEnd);
  win.addEventListener('hmlab:reset', onReset);

  const q = (sel) => doc.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return {
    mode,
    query: q,
    mark: () => ({ starts: runs.starts, ends: runs.ends }),
    runStarted: (m) => runs.starts > m.starts,
    runInFlight: () => runs.starts > runs.ends,
    onRun: (cb) => { watchers.add(cb); return () => watchers.delete(cb); },
    waitForRun(m, timeoutMs) {
      return new Promise((resolve) => {
        const finish = (r) => { clearTimeout(t); timers.delete(t); waiters.delete(check); resolve(r); };
        const done = (ok, reason) => finish(ok ? { ok: true } : { ok: false, reason: reason || 'The run failed. Press Next to carry on, or Exit.' });
        const check = (ok, reason) => { if (reason || runs.ends > m.ends) done(ok, reason); };
        const t = setTimeout(() => finish({ ok: false, reason: 'The run did not finish in time. Press Next to carry on, or Exit.' }), timeoutMs);
        timers.add(t);
        if (runs.ends > m.ends) { done(runs.lastOk); return; }
        waiters.add(check);
      });
    },
    prefill() { /* no free-text question in this lab: a prompt step points at the page's own button */ },
    async send(step) {
      const press = step.prompt?.press ?? step.press;
      if (!press) throw new Error('the step has no button to press');
      const sel = typeof press === 'string' ? press : press.selector;
      // The page may still be rendering the panel that holds the button: give it a moment.
      for (let i = 0; ; i += 1) {
        const el = q(sel);
        if (el && !el.disabled) { el.click(); return; }
        if (i >= 20) throw new Error('the button is not available');
        await sleep(100);
      }
    },
    switchTab() { /* one page; nothing to switch */ },
    assetUrl: () => null,   // no screenshot ships; a slide is text-only
    dispose() { win.removeEventListener('hmlab:run-start', onStart); win.removeEventListener('hmlab:run-end', onEnd); win.removeEventListener('hmlab:reset', onReset); timers.forEach(clearTimeout); timers.clear(); waiters.clear(); watchers.clear(); },
    _sleep: sleep, _settleMs: settleMs,
  };
}

// ---- finding what a bubble points at
// A step's target is mode-dependent: the mock beat shows the Privilege modal / phone; the real path shows the gateway trace / waiting panel.
function targetFor(doc, t, host) {
  if (!t) return null;
  if (typeof t === 'string') return t;
  if (t.selector) {
    const real = t.real && host.mode() === 'real' ? t.real : null;
    return () => doc.querySelector(real || t.selector);
  }
  return null;
}

// ---- the live fact lines a bubble shows (what the video's take read from the page)
function linesFor(doc, step) {
  switch (step.lines) {
    case 'banner1': return () => [firstSentence(text(doc.querySelector('[data-testid=banner]')))];
    case 'scenario': return () => ['scenario: ' + ([...doc.querySelectorAll('[data-testid=step-pick] button')].find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent.trim() || 'privilege-pingid')];
    case 'hold': return () => ['403 · -32600 · pending_approval'];
    case 'instructionId': return () => { const code = doc.querySelector('[data-testid=privilege-queue] td code') || doc.querySelector('[data-testid=real-approval]'); const v = code ? (code.value || code.textContent).trim() : ''; return v ? ['instruction id: ' + v] : []; };
    case 'push': return () => ['the PingID push is on the approver\'s phone'];
    case 'approve': return () => ['tap Approve on the phone'];
    case 'retryId': return () => { const code = doc.querySelector('[data-testid=privilege-queue] td code') || doc.querySelector('[data-testid=real-approval]'); const v = code ? (code.value || code.textContent).trim() : ''; return v ? ['X-Procyon-Approval-Id: ' + v] : []; };
    case 'verdict1': return () => { const v = firstSentence(text(doc.querySelector('[data-testid=verdict]'))); const receipt = text(doc.querySelector('[data-testid=receipt]')); return [v, ...(receipt ? ['receipt: ' + receipt.slice(0, 80)] : [])].filter(Boolean); };
    case 'boundary': return () => ['a higher call under the same approval: still held'];
    default: return undefined;
  }
}

// Steps left out of the walk-through. None now.
export const NOT_YET = [];

/** The script as engine steps. `captions` is /api/story; it supplies the Mock closing slide's replacement lines. */
export function buildSteps({ captions, host, doc = document, win = window, script = STEPS, sampleNote = SAMPLE_NOTE, notYet = NOT_YET }) {
  const all = sampleNote ? [sampleNote, ...script] : script;
  return all.filter((s) => !notYet.includes(s.key)).map((s) => {
    const step = { key: s.key, type: s.type, trigger: s.trigger, modes: s.modes, sampleKey: s.sampleKey, prefer: s.prefer, place: s.place, fixedSecs: s.fixedSecs, frameTimeoutMs: s.frameTimeoutMs };
    if (s.prompt) step.prompt = s.prompt;
    if (s.type === 'bubble') {
      step.target = targetFor(doc, s.target, host);
      const lines = linesFor(doc, s);
      if (lines) step.lines = lines;
    }
    if (s.key === 'closing') {   // the simulated run never claims a live one: its two replaced lines come from the Mock wording
      step.transform = (slide, m) => (m === 'mock'
        ? { ...slide, lead: captions.steps.sample_closing_lead.text, colA: { ...slide.colA, lines: [captions.steps.sample_closing_bullet.text, ...slide.colA.lines.slice(1)] } }
        : slide);
    }
    return step;
  });
}
