// Rule 27: the vendored shared/run-observability files match web/src/run-observability/run-observability.sha256 byte for byte.
// They come from curtismu7/AI-DEMO-Standalone shared/run-observability: change them there, re-pin, re-vendor; never edit them here.
// This lab reads no product logs (Mock rows are simulated, Real rows are replies the lab received), so it vendors the core only
// (no server/src/runObservabilityReaders.js); checkPin skips that pin line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPin } from './run-observability-checkPin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const VENDORED = ['server/src/runObservability.js', 'web/src/run-observability/RunObservability.jsx', 'web/src/run-observability/run-observability.css', 'web/src/run-observability/run-observability.test.jsx', 'web/src/run-observability/fixtures.js', 'web/src/run-observability/run-observability.sha256'];

test('every vendored run-observability file matches its pin, and the core is present', () => {
  assert.deepEqual(checkPin(root), []);
});

test('a vendored byte edited, or a file added to a vendored folder without the pin, fails the pin check', () => {
  const copy = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || os.tmpdir()), 'hitl-pin-'));
  try {
    for (const f of VENDORED) { fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true }); fs.copyFileSync(path.join(root, f), path.join(copy, f)); }
    assert.deepEqual(checkPin(copy), []);
    fs.writeFileSync(path.join(copy, 'server/src/runObservability.js'), `${read('server/src/runObservability.js')}\n// edited`);
    assert.ok(checkPin(copy).some((p) => /runObservability\.js/.test(p)), 'an edited core fails');
    fs.copyFileSync(path.join(root, 'server/src/runObservability.js'), path.join(copy, 'server/src/runObservability.js'));
    fs.writeFileSync(path.join(copy, 'web/src/run-observability/extra.js'), 'export {}');
    assert.ok(checkPin(copy).some((p) => /extra\.js/.test(p)), 'an unpinned file in the vendored folder fails');
    fs.rmSync(path.join(copy, 'web/src/run-observability/extra.js'));
    fs.writeFileSync(path.join(copy, 'server/src/runObservabilityExtra.js'), 'export {}');
    assert.ok(checkPin(copy).some((p) => /runObservabilityExtra\.js/.test(p)), 'an unpinned server/src/runObservability* file fails');
  } finally { fs.rmSync(copy, { recursive: true, force: true }); }
});

test('this lab reads no product logs: no readers file, and none of its own server files, compose file or .env.example names a reader, comments included', () => {
  assert.ok(!fs.existsSync(path.join(root, 'server/src/runObservabilityReaders.js')));
  const core = read('server/src/runObservability.js');
  assert.ok(!/^\s*import\s/m.test(core), 'the core has no imports');
  assert.ok(!/ElasticsearchReader|DockerLogReader|readersFromEnv|\bfetch\s*\(|node:http|node:fs/.test(core), 'the core names no reader, makes no request and reads no file');
  const NAMES = /ElasticsearchReader|DockerLogReader|readersFromEnv|runObservabilityReaders|RUN_OBS_/;
  // the vendored core's own comment and "no reader is configured" message name the variables a log-reading lab would set; every other server file is the lab's
  for (const f of fs.readdirSync(path.join(root, 'server/src')).filter((n) => n.endsWith('.js') && n !== 'runObservability.js')) assert.ok(!NAMES.test(read(`server/src/${f}`)), `server/src/${f} names a reader`);
  for (const f of ['docker-compose.yml', '.env.example', 'Dockerfile']) assert.ok(!/RUN_OBS_/.test(read(f)), `${f} sets a run-observability reader variable`);
  // nor does any of the lab's own web files (the vendored folder, whose own tests and comments may, is the one exception)
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (`${dir}/${e.name}` === 'web/src/run-observability' ? [] : walk(`${dir}/${e.name}`)) : [`${dir}/${e.name}`]));
  const web = walk('web/src').filter((f) => /\.(jsx?|css|html)$/.test(f));
  assert.ok(web.length > 20, 'the scan found the lab\'s web files');
  for (const f of web) assert.ok(!/RUN_OBS_/.test(read(f)), `${f} carries the RUN_OBS_ prefix`);
});

test('compose never mounts the Docker socket', () => {
  for (const f of ['docker-compose.yml', 'Dockerfile']) assert.ok(!/docker\.sock/.test(read(f).replace(/#.*$/gm, '')), `${f} mounts the Docker socket`);
});
