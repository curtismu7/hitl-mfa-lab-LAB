// The Story script: one entry per caption key, in the order the recorded video walks the lab (video/take.py). Pure data, no DOM: the page wiring turns each
// entry into an engine step (a selector, a press prompt, a live line). The wording is in video/captions.md; test/story.test.js checks the two agree, and
// that the order, the numbered-bubble counts and the fixed holds equal take.py's.
//
//   target   a CSS selector | { selector } an element | { selector, check } only while the named page-state check holds
//            A bubble whose target is not there is skipped.
//   press    the page's own button the viewer (or Play) presses: { selector }
//   modes    ['mock'] / ['real']: shown only in that mode. sampleKey: the Mock wording key.
//   lines    the name of a live value the page reads for the bubble's fact lines (the page wiring)
// Hold times for Play for me are not here: they come from the wording and the shared hold.js (the video's own formulas), except `fixedSecs`.

const REAL_STEP = 'privilege-pingid';   // the PRIVILEGE scenario chip, the one the video walks

export const STEPS = [
  { key: 'intro', type: 'bubble', trigger: 'load', target: '[data-testid=banner]', prefer: 'below', lines: 'banner1', sampleKey: 'sample_intro' },

  // the real take's prologue: two mock use cases on the page's own gate, shown in the film (and in a live Real Story walk) before the Privilege door
  { key: 'consent_video', type: 'bubble', trigger: 'load', target: '[data-testid=consent-modal]', prefer: 'left', modes: ['real'] },
  { key: 'mfa_video', type: 'bubble', trigger: 'load', target: '[data-testid=mfa-modal]', prefer: 'left', modes: ['real'] },
  { key: 'pick', type: 'bubble', trigger: 'load', target: '[data-testid=step-pick]', prefer: 'below', lines: 'scenario', sampleKey: 'sample_pick',
    prompt: { press: { selector: `[data-testid=step-pick] [data-scenario=privilege-pingid]` } }, fixedSecs: null },
  { key: 'hold', type: 'bubble', trigger: 'run-done', target: { selector: '[data-testid=privilege-modal]', real: '[data-testid=gateway-trace] details.gw-ex' }, prefer: 'left', lines: 'hold', sampleKey: 'sample_hold' },
  { key: 'instruction', type: 'bubble', trigger: 'run-done', target: { selector: '[data-testid=privilege-queue]', real: '[data-testid=real-approval]' }, prefer: 'left', lines: 'instructionId', sampleKey: 'sample_instruction' },
  { key: 'push', type: 'bubble', trigger: 'load', target: { selector: '[data-testid=pingid-phone-screen]', real: '[data-testid=real-waiting]' }, prefer: 'left', lines: 'push', sampleKey: 'sample_push' },
  { key: 'approve', type: 'bubble', trigger: 'run-done', target: { selector: '[data-testid=pingid-phone-screen]', real: '[data-testid=real-waiting]' }, prefer: 'left', lines: 'approve', sampleKey: 'sample_approve' },
  { key: 'retry', type: 'bubble', trigger: 'run-done', target: { selector: '[data-testid=verdict]', real: '[data-testid=gateway-trace] details.gw-ex:last-of-type' }, prefer: 'below', lines: 'retryId', sampleKey: 'sample_retry' },
  { key: 'executed', type: 'bubble', trigger: 'run-done', target: '[data-testid=verdict]', prefer: 'below', lines: 'verdict1', sampleKey: 'sample_executed' },
  { key: 'boundary', type: 'bubble', trigger: 'run-done', target: '[data-testid=verdict]', prefer: 'below', lines: 'boundary', sampleKey: 'sample_boundary' },
  { key: 'audit', type: 'bubble', trigger: 'load', target: { selector: '[data-testid=hops]', real: '[data-testid=gateway-trace]' }, prefer: 'below', sampleKey: 'sample_audit' },

  // the slides the video shows between the bubbles
  { key: 'real_vs_sim', type: 'slide', trigger: 'load' },
  { key: 'retry_rule', type: 'slide', trigger: 'load' },

  // ---- the end
  { key: 'closing', type: 'slide', trigger: 'load' },
];

// The sample take's first page: a slide a mode shows before the opening (rule 29: it carries the header too).
export const SAMPLE_NOTE = { key: 'sample_note', type: 'slide', trigger: 'load', modes: ['mock'], before: 'opening' };

// Mock wording the script uses that is not a step of its own: the closing slide's two replaced lines (the simulated run never claims a live one).
export const EXTRA_SAMPLE_KEYS = ['sample_closing_lead', 'sample_closing_bullet'];

export function scriptKeys() {
  const steps = STEPS.filter((s) => s.type === 'bubble').map((s) => s.key);
  // The engine shows the opening and closing slides by key 'opening'/'closing'; sample_note is a mode slide the script carries too.
  const slides = ['opening', 'closing', ...STEPS.filter((s) => s.type === 'slide').map((s) => s.key), SAMPLE_NOTE.key];
  return {
    steps, slides,
    sampleKeys: [...STEPS.map((s) => s.sampleKey).filter(Boolean), ...EXTRA_SAMPLE_KEYS],
  };
}
