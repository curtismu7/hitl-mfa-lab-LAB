// hold.js: how long a Story bubble or slide is held when Play for me runs. THE one copy of the video's timing: the recorded video (take.py) and the live
// Story use these numbers, and a test fails if they ever differ. Pure, no imports, no DOM. Vendor byte-for-byte; never edit a lab's copy.
//
// Normal speed is an EXACT match of the video's hold() and hold_slide():
//   bubble: max(5.0, words x 0.30 + 2.2) seconds, or the step's own fixed seconds (a prompt step holds 4.5 or 5.0)
//   slide : min(10.0, max(6.0, words x 0.25 + 3.0)) seconds   (owner rule 2026-11-22: no slide is held longer than 10 s at Normal)
// "words" is Python's str.split(): runs of whitespace separate words.

export const SPEEDS = Object.freeze({ slower: 1.5, normal: 1, faster: 0.67 });
export const SPEED_NAMES = Object.freeze(['slower', 'normal', 'faster']);

export const words = (text) => String(text ?? '').split(/\s+/).filter(Boolean).length;

// The video builds the bubble's hold text as caption text + " ".join(lines): NO space between the text and the first line, so the last word of the text
// and the first word of the first line count as one word. That quirk is kept on purpose so Normal is exact; do not "fix" it here without changing take.py.
export function bubbleHold(text, lines = [], fixedSecs = null) {
  if (fixedSecs !== null && fixedSecs !== undefined) return fixedSecs;
  return Math.max(5.0, words(String(text ?? '') + (lines || []).join(' ')) * 0.30 + 2.2);
}

// The slide's hold text is lead + column A lines + column B lines + verdict (the title is not counted).
export function slideHold(slide) {
  const text = [slide.lead, ...(slide.colA?.lines || []), ...(slide.colB?.lines || []), slide.verdict].join(' ');
  return Math.min(10.0, Math.max(6.0, words(text) * 0.25 + 3.0));
}

export const speedFactor = (name) => (name in SPEEDS ? SPEEDS[name] : 1);
export const holdMs = (secs, speed = 'normal') => Math.round(secs * speedFactor(speed) * 1000);
