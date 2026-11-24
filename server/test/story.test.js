import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CAPTIONS_PATH, loadCaptions, resetCaptionsCache, storyResponse } from '../src/storyRoute.js';
import { parity } from '../src/story/captions.js';
import { checkPin } from '../../scripts/story-checkPin.mjs';
import { EXTRA_SAMPLE_KEYS, SAMPLE_NOTE, STEPS, scriptKeys } from '../../web/src/storyScript.js';

const root = new URL('../..', import.meta.url).pathname;

test('story: the vendored Story files match their pin (an edited copy fails CI)', () => {
  assert.deepEqual(checkPin(root), []);
});

test('story: every caption key has a step in the script and every step has wording (the parity test)', () => {
  const problems = parity(loadCaptions(), scriptKeys(), { allowUnused: [] });
  assert.deepEqual(problems, []);
});

test('story: the parity check really fails when the wording and the script drift', () => {
  const captions = loadCaptions();
  const missing = { ...captions, steps: Object.fromEntries(Object.entries(captions.steps).filter(([k]) => k !== 'hold')) };
  assert.deepEqual(parity(missing, scriptKeys(), { allowUnused: [] }), ['the demo has step "hold" but captions.md does not']);
  const extra = { ...scriptKeys(), steps: [...scriptKeys().steps, 'brand_new'] };
  assert.deepEqual(parity(captions, extra, { allowUnused: [] }), ['the demo has step "brand_new" but captions.md does not']);
});

test('story: the script has the same number of numbered bubbles as the recorded video (10 live, 10 simulated)', () => {
  const video = readFileSync(`${root}video/take.py`, 'utf8');
  assert.match(video, /TOTAL = 10/);
  const bubbles = (mode) => [...STEPS, SAMPLE_NOTE].filter((s) => s.type === 'bubble' && (!s.modes || s.modes.includes(mode))).length;
  assert.equal(bubbles('real'), 10);
  assert.equal(bubbles('mock'), 10);
});

test('story: the bubbles come in the same order as in take.py, and the sample_* pairs sit on the same steps', () => {
  const video = readFileSync(`${root}video/take.py`, 'utf8');
  const order = [...video.matchAll(/bubble\(\d+, STEPS\["(?:sample_)?([a-z_]+)"(?:_if_SAMPLE)?/g)].map((m) => m[1]);
  const realOrder = [...new Set(order)];
  assert.deepEqual(STEPS.filter((s) => s.type === 'bubble').map((s) => s.key), realOrder);
  for (const s of STEPS.filter((x) => x.type === 'bubble')) {
    assert.ok(s.sampleKey === `sample_${s.key}` || s.sampleKey === undefined, `${s.key} pairs with its sample_ wording`);
  }
});

test('story: no step carries a made-up fixed hold (only the video gives secs, and this take gives none)', () => {
  const video = readFileSync(`${root}video/take.py`, 'utf8');
  const fromVideo = {};
  for (const m of video.matchAll(/bubble\("([a-z0-9_]+)"[^\n]*?\bsecs=([0-9.]+)/g)) fromVideo[m[1]] = Number(m[2]);
  const fromScript = STEPS.filter((s) => s.fixedSecs != null);
  assert.deepEqual(fromScript.map((s) => s.key), Object.keys(fromVideo));
});

test('story (rule 29): the first page the viewer sees, in Real and in Mock, has a header naming the demo', () => {
  const captions = loadCaptions();
  assert.ok(captions.opening.header, 'the Opening Slide has a header');
  assert.equal(captions.slides.sample_note.header, captions.opening.header, 'sample_note (the Mock first page) carries the header too');
});

test('story: the wording is public-safe (no internal hostnames, ids, keys or real hosts)', () => {
  const raw = readFileSync(CAPTIONS_PATH, 'utf8');
  for (const bad of [/ping-devops/i, /127\.0\.0\.1/, /localhost/i, /HMLAB_[A-Z_]+/, /api[_-]?key/i, /client[_-]?secret/i, /Bearer [A-Za-z0-9+/_-]{20,}/, /procyon\.(ai|local)/]) {
    assert.ok(!bad.test(raw), `the wording mentions ${bad}`);
  }
  // X-Procyon-Approval-Id is the lab's own public header name (README): allowed, but never a procyon.* host.
  assert.match(raw, /X-Procyon-Approval-Id/);
});

test('story: the route answers 200 with the wording and its hash', () => {
  resetCaptionsCache();
  const r = storyResponse();
  assert.equal(r.status, 200);
  assert.equal(r.body.opening.header, 'HITL MFA: the agent\'s sensitive action, approved on your phone');
  assert.match(r.body.sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(r.body.sourceSha256, storyResponse().body.sourceSha256);
});

test('story: an edit to captions.md shows on the next request without a restart', () => {
  resetCaptionsCache();
  const dir = mkdtempSync(join(tmpdir(), 'hmlab-story-'));
  const tmp = join(dir, 'captions.md');
  copyFileSync(CAPTIONS_PATH, tmp);
  const before = storyResponse(tmp).body;
  writeFileSync(tmp, readFileSync(CAPTIONS_PATH, 'utf8').replace('approved on your phone', 'approved on the phone'));
  const after = storyResponse(tmp).body;
  assert.equal(after.opening.header, 'HITL MFA: the agent\'s sensitive action, approved on the phone');
  assert.notEqual(before.sourceSha256, after.sourceSha256);
  unlinkSync(tmp);
});

test('story: a broken wording file is a 500 that names the problem and never a server path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmlab-story-'));
  const tmp = join(dir, 'captions.md');
  writeFileSync(tmp, '# Step: x\n## Title\nno text section\n');
  const r = storyResponse(tmp);
  assert.equal(r.status, 500);
  assert.match(r.body.error, /needs both a "## Title" and a "## Text" section/);
  assert.ok(!r.body.error.includes(tmp), 'no server path in the message');
});

test('story: the route is served by the app (GET /api/story) and a POST to it is not a write', async () => {
  const http = await import('node:http');
  const { createApp } = await import('../src/app.js');
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  server.on('request', createApp({ port, env: { MODE: 'mock' }, logLine: () => {} }));
  const base = `http://127.0.0.1:${port}`;
  try {
    const get = await fetch(`${base}/api/story`);
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.opening.header, 'HITL MFA: the agent\'s sensitive action, approved on your phone');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('video: captions.py reads the running lab, not a private parser (the stale-wording check is in the route hash)', () => {
  const cap = readFileSync(`${root}video/captions.py`, 'utf8');
  assert.match(cap, /api\/story/);
  assert.match(cap, /sourceSha256/);
  assert.ok(!/def _load\(\)/.test(cap), 'captions.py has no parser of its own');
});
