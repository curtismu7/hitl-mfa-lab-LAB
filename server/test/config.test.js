import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedFrom, modeFrom, realAvailableFrom, realConfigFrom } from '../src/config.js';

test('MODE defaults to Real when configured, else Mock; only mock/real accepted', () => {
  assert.equal(modeFrom({}), 'mock');
  assert.equal(modeFrom({ MODE: 'mock' }), 'mock');
  assert.throws(() => modeFrom({ MODE: 'real' }), /not present/, 'Real requested without configuration is refused, never a silent fallback');
  const realEnv = { HMLAB_REAL_URL: 'https://gw.example/door/mcp', HMLAB_REAL_AGENT_KEY: 'k', HMLAB_REAL_TOOL: 'SomeTool' };
  assert.equal(modeFrom(realEnv), 'real', 'default follows Real when configured');
  assert.equal(modeFrom({ ...realEnv, MODE: 'mock' }), 'mock');
  assert.equal(modeFrom({ ...realEnv, MODE: 'real' }), 'real');
  for (const MODE of ['live', 'prod', 'Mock', 'x']) assert.throws(() => modeFrom({ ...realEnv, MODE }), /not available/, MODE);
});

test('realAvailableFrom needs URL, agent key and tool, and a URL that is allowed', () => {
  assert.equal(realAvailableFrom({}), false);
  assert.equal(realAvailableFrom({ HMLAB_REAL_URL: 'https://gw.example/d/mcp' }), false);
  assert.equal(realAvailableFrom({ HMLAB_REAL_URL: 'https://gw.example/d/mcp', HMLAB_REAL_AGENT_KEY: 'k' }), false);
  assert.equal(realAvailableFrom({ HMLAB_REAL_URL: 'https://gw.example/d/mcp', HMLAB_REAL_AGENT_KEY: 'k', HMLAB_REAL_TOOL: 'T' }), true);
});

test('hosted is only the exact string 1', () => {
  assert.equal(hostedFrom({}), false);
  assert.equal(hostedFrom({ HMLAB_HOSTED: '1' }), true);
  for (const v of ['true', '0', 'yes', '']) assert.equal(hostedFrom({ HMLAB_HOSTED: v }), false, v);
});

test('realConfigFrom validates the door URL, the tool and the args, and never carries the key', () => {
  const ok = { HMLAB_REAL_URL: 'https://Gateway.Example:8443/door/mcp', HMLAB_REAL_AGENT_KEY: 'sekret-key', HMLAB_REAL_TOOL: 'IndexMappingTool', HMLAB_REAL_ARGS: '{"index":"*"}' };
  const c = realConfigFrom(ok);
  assert.deepEqual({ ok: c.ok, host: c.host, origin: c.origin, tool: c.tool, args: c.args }, { ok: true, host: 'gateway.example', origin: 'https://gateway.example:8443', tool: 'IndexMappingTool', args: { index: '*' } });
  assert.ok(!JSON.stringify(c).includes('sekret-key'), 'the key is never in the config view');
  const bad = (patch) => realConfigFrom({ ...ok, ...patch });
  assert.equal(bad({ HMLAB_REAL_URL: 'http://gateway.example/mcp' }).ok, false, 'plain http is refused off loopback');
  assert.equal(bad({ HMLAB_REAL_URL: 'http://127.0.0.1:9/mcp' }).ok, true, 'http is allowed on loopback');
  assert.equal(bad({ HMLAB_REAL_URL: 'https://u:p@gateway.example/mcp' }).ok, false, 'credentials in the URL are refused');
  assert.equal(bad({ HMLAB_REAL_URL: 'ftp://gateway.example/' }).ok, false);
  assert.equal(bad({ HMLAB_REAL_URL: 'not a url' }).ok, false);
  assert.equal(bad({ HMLAB_REAL_TOOL: 'bad tool;rm' }).ok, false);
  assert.equal(bad({ HMLAB_REAL_ARGS: '[1]' }).ok, false);
  assert.equal(bad({ HMLAB_REAL_ARGS: '{bad' }).ok, false);
  assert.equal(bad({ HMLAB_REAL_ARGS: JSON.stringify({ a: 'x'.repeat(2100) }) }).ok, false);
  assert.equal(realConfigFrom({ ...ok, HMLAB_REAL_ARGS: undefined }).ok, true);
  assert.equal(realConfigFrom({}).any, false);
  assert.equal(realConfigFrom({ HMLAB_REAL_TOOL: 'T' }).any, true, 'a half-configured Real is reported, not hidden');
});

test('a hosted build never allows Real, and a private/link-local IP literal needs an explicit opt-in', () => {
  const ok = { HMLAB_REAL_URL: 'https://gateway.example/door/mcp', HMLAB_REAL_AGENT_KEY: 'k', HMLAB_REAL_TOOL: 'T' };
  assert.equal(realConfigFrom(ok).ok, true);
  const hosted = realConfigFrom({ ...ok, HMLAB_HOSTED: '1' });
  assert.equal(hosted.ok, false); assert.match(hosted.problem, /hosted/);
  assert.equal(realAvailableFrom({ ...ok, HMLAB_HOSTED: '1' }), false);
  for (const u of ['https://169.254.169.254/mcp', 'https://10.0.0.5/mcp', 'https://192.168.1.2/mcp', 'https://172.20.0.1/mcp', 'https://[fd00::1]/mcp', 'https://[::1]/mcp']) {
    assert.equal(realConfigFrom({ ...ok, HMLAB_REAL_URL: u }).ok, false, u);
    assert.equal(realConfigFrom({ ...ok, HMLAB_REAL_URL: u, HMLAB_REAL_ALLOW_PRIVATE: '1' }).ok, true, `${u} with the opt-in`);
  }
  assert.equal(realConfigFrom({ ...ok, HMLAB_REAL_URL: 'https://93.184.216.34/mcp' }).ok, true, 'a public literal is fine');
  assert.equal(realConfigFrom({ ...ok, HMLAB_REAL_URL: 'http://127.0.0.1:9/mcp' }).ok, true, 'loopback http for the owner\'s own stub');
  assert.equal(realConfigFrom({ ...ok, HMLAB_REAL_ALLOW_PRIVATE: '1' }).privateOk, true);
});

test('plain http is allowed on loopback, or on a host named in HMLAB_REAL_ALLOW_HTTP_HOSTS together with HMLAB_REAL_ALLOW_PRIVATE=1 (never otherwise)', () => {
  const base = { HMLAB_REAL_AGENT_KEY: 'k', HMLAB_REAL_TOOL: 'T', HMLAB_REAL_URL: 'http://host.docker.internal:8723/door/mcp' };
  assert.equal(realConfigFrom(base).ok, false, 'plain http to a non-loopback name is refused by default');
  assert.equal(realConfigFrom({ ...base, HMLAB_REAL_ALLOW_HTTP_HOSTS: 'host.docker.internal' }).ok, false, 'naming the host is not enough without the private opt-in');
  assert.equal(realConfigFrom({ ...base, HMLAB_REAL_ALLOW_PRIVATE: '1' }).ok, false, 'the private opt-in is not enough without naming the host');
  const ok = realConfigFrom({ ...base, HMLAB_REAL_ALLOW_HTTP_HOSTS: ' Host.Docker.Internal , other.example', HMLAB_REAL_ALLOW_PRIVATE: '1' });
  assert.equal(ok.ok, true); assert.equal(ok.host, 'host.docker.internal'); assert.equal(ok.privateOk, true); assert.equal(ok.allowHttp, true, 'the netguard is told this name may use plain http');
  assert.equal(realConfigFrom({ ...base, HMLAB_REAL_URL: 'http://127.0.0.1:9/mcp' }).allowHttp, false, 'loopback needs no such opt-in');
  assert.equal(realConfigFrom({ ...base, HMLAB_REAL_URL: 'https://gw.example/mcp' }).allowHttp, false, 'https is not plain http');
  const other = realConfigFrom({ ...base, HMLAB_REAL_URL: 'http://evil.example/mcp', HMLAB_REAL_ALLOW_HTTP_HOSTS: 'host.docker.internal', HMLAB_REAL_ALLOW_PRIVATE: '1' });
  assert.equal(other.ok, false, 'a host that is not named stays refused'); assert.match(other.problem, /must be https/);
});
