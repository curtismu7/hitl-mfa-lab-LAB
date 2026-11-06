import { fileURLToPath } from 'node:url';
import { installNetguard } from './netguard.js';
import { startHttpServer, createApp } from './app.js';
import { allPassed, runChecks } from './doctor.js';
import { assertBindAllowed, bindHost, resolvePort } from './safety.js';
import { hostedFrom, modeFrom, realAvailableFrom } from './config.js';

installNetguard(); // before anything else can open a socket

try { process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url))); } catch { /* no .env */ }

const checks = await runChecks();
if (!allPassed(checks)) {
  for (const c of checks.filter((x) => x.level === 'fail')) console.error(`[hitl-mfa-lab] refusing to start: ${c.id}: ${c.detail}`);
  process.exit(1);
}
console.log(`[hitl-mfa-lab] starting in ${modeFrom()} mode`);
const host = assertBindAllowed(bindHost(), process.env);
const { url } = await startHttpServer({ port: resolvePort(), host, app: createApp({ hosted: hostedFrom(process.env) }) });
console.log(`[hitl-mfa-lab] lab at ${url} (loopback${realAvailableFrom() ? ', Real configured' : ', Mock only — no outbound network'})`);
console.log(`[hitl-mfa-lab] health: ${url}api/health`);
