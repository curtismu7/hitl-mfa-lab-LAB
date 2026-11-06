import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// index.js starts the server at import time, so it cannot be imported in a test. Pin its order instead: the network guard
// is installed before the env file is read, the doctor runs, or any server starts.
test('the entry installs the netguard first, before it can open any socket', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const m = /^installNetguard\(\);/m.exec(src); // a real statement at the start of a line, not inside a comment
  assert.ok(m, 'installNetguard() is called as a statement');
  const guard = m.index;
  for (const later of ['runChecks()', 'startHttpServer({', 'loadEnvFile(']) assert.ok(src.indexOf(later) > guard, `${later} comes after the guard`);
  assert.ok(src.indexOf("import { installNetguard }") < guard);
});
