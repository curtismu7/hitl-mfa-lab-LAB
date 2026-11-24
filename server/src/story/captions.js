// captions.js: reads captions.md (the ONE wording file, shared by the live Story and the recorded video) into the shape /api/story serves, and checks
// that the wording and a demo's steps agree (the parity test). Pure, no imports, no network, no file access: the lab reads the file and passes the text.
// Vendor to server/src/story/captions.js, byte-for-byte; never edit a lab's copy.
//
// captions.md format (the same one the video's captions.py has always read):
//   an optional leading <!-- comment -->; sections separated by a line holding only "---"; each section starts with a "# " heading:
//   "# Opening Slide", "# Closing Slide", "# Slide: <key>" or "# Step: <key>".
//   A step has "## Title" and "## Text". A slide has "## Title", "## Lead", "## Column A: <label>", "## Column B: <label>" (each a list of "- " lines),
//   "## Verdict", optionally "## Header" (a line above the title naming the demo; REQUIRED on the Opening Slide, rule 29) and "## Image" (a file name; shown only when a local assets folder supplies it) and "## Layout" (wide).
//   Live values go in {braces} (for example {status}); the page fills them from the DOM.

export class CaptionsError extends Error {
  constructor(message) { super(`captions.md: ${message}`); this.name = 'CaptionsError'; }
}
const fail = (m) => { throw new CaptionsError(m); };

// Line endings are normalised first (a Windows or autocrlf checkout), and a closing --- with no newline after it still ends the last section.
const splitSections = (text) => String(text).replace(/\r\n?/g, '\n').replace(/^\s*<!--[\s\S]*?-->\s*/, '').split(/\n---[ \t]*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);

function splitFields(body) {
  const fields = {};
  const re = /^##[ \t]+(.+?)[ \t]*\n([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/gm;   // (?![\s\S]) is end of text: with the m flag a bare $ would stop at the end of the first line
  let m;
  while ((m = re.exec(body)) !== null) fields[m[1].trim()] = m[2].trim();
  return fields;
}

const bullets = (raw) => {
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());
  if (!lines.length) fail(`a column heading has no "- " bullet lines under it: ${JSON.stringify(raw.slice(0, 120))}`);
  return lines;
};

function slideFrom(fields, which) {
  for (const k of ['Title', 'Lead', 'Verdict']) if (!fields[k]) fail(`${which} is missing a "## ${k}" section`);
  const a = Object.keys(fields).find((k) => k.startsWith('Column A:'));
  const b = Object.keys(fields).find((k) => k.startsWith('Column B:'));
  if (!a || !b) fail(`${which} needs both a "## Column A: ..." and a "## Column B: ..." heading`);
  return {
    title: fields.Title, lead: fields.Lead, verdict: fields.Verdict,
    header: (fields.Header || '').trim() || null,   // the demo's own name, shown above the title on the first page
    colA: { heading: a.split(':').slice(1).join(':').trim(), lines: bullets(fields[a]) },
    colB: { heading: b.split(':').slice(1).join(':').trim(), lines: bullets(fields[b]) },
    image: (fields.Image || '').trim() || null,
    wide: (fields.Layout || '').trim().toLowerCase() === 'wide',
  };
}

// -> { opening, closing, slides: {key: slide}, steps: {key: {title, text}} }
export function parseCaptions(text) {
  let opening = null; let closing = null; const slides = {}; const steps = {};
  for (const sec of splitSections(text)) {
    const head = /^#[ \t]+(.+?)[ \t]*\n([\s\S]*)$/.exec(sec);
    if (!head) fail(`a section has no "# " heading on its first line: ${JSON.stringify(sec.slice(0, 120))}`);
    const heading = head[1].trim(); const fields = splitFields(head[2]);
    if (heading === 'Opening Slide') {
      opening = slideFrom(fields, 'Opening Slide');
      // Owner rule (2026-11-24, STANDALONE-RULES rule 29): the first page of every demo and video says what is being shown.
      if (!opening.header) fail('the Opening Slide needs a "## Header" that names what the demo shows (rule 29: every first page has a title)');
    }
    else if (heading === 'Closing Slide') closing = slideFrom(fields, 'Closing Slide');
    else if (heading.startsWith('Slide:')) { const key = heading.slice(6).trim(); if (slides[key]) fail(`slide "${key}" appears twice`); slides[key] = slideFrom(fields, `Slide "${key}"`); }
    else if (heading.startsWith('Step:')) {
      const key = heading.slice(5).trim();
      if (steps[key]) fail(`step "${key}" appears twice`);
      if (!fields.Title || !fields.Text) fail(`step "${key}" needs both a "## Title" and a "## Text" section`);
      steps[key] = { title: fields.Title, text: fields.Text };
    } else fail(`unrecognised section heading "# ${heading}" (expected "Opening Slide", "Closing Slide", "Slide: <key>" or "Step: <key>")`);
  }
  if (!opening) fail('no "# Opening Slide" section found');
  if (!closing) fail('no "# Closing Slide" section found');
  return { opening, closing, slides, steps };
}

// The parity test: every key in captions.md has a step in the demo, and the reverse. `scriptKeys` = { steps: [...], slides: [...] } of the demo's script
// (the opening and closing slides are the keys "opening" and "closing"). Returns the problems; a lab's test asserts it is empty, so a mismatch fails the
// build and never fails silently at runtime. `scriptKeys.sampleKeys` are the Mock wording keys the steps use (a missing one would silently drop a scene in Mock). `allowUnused` lists caption keys the demo deliberately does not use (the video's sample-only wording).
export function parity(captions, scriptKeys, { allowUnused = [] } = {}) {
  const have = { steps: Object.keys(captions.steps), slides: ['opening', 'closing', ...Object.keys(captions.slides)] };
  const problems = [];
  for (const kind of ['steps', 'slides']) {
    const want = new Set([...(scriptKeys[kind] || []), ...(kind === 'steps' ? scriptKeys.sampleKeys || [] : [])]); const has = new Set(have[kind]);   // a step's Mock wording (sampleKey) must exist too
    for (const k of want) if (!has.has(k)) problems.push(`the demo has ${kind.slice(0, -1)} "${k}" but captions.md does not`);
    for (const k of has) if (!want.has(k) && !allowUnused.includes(k)) problems.push(`captions.md has ${kind.slice(0, -1)} "${k}" but the demo does not`);
  }
  return problems;
}
