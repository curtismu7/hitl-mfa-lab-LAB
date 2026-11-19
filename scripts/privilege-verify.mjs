#!/usr/bin/env node
// Owner-run. Settles the two things this lab labels UNVERIFIED about YOUR Privilege gateway:
//   1. does a held call answer HTTP 403 (JSON-RPC -32600, status pending_approval) or a 200 whose text says pending_approval?
//   2. is the approval id the retry must carry the SAME as the instruction id in the held answer, or the id the console shows?
//
//   node scripts/privilege-verify.mjs            (asks before it sends anything)
//   node scripts/privilege-verify.mjs --yes      (skips the first confirmation)
//
// It uses the SAME client the lab's Real mode uses (server/src/privilegeReal.js), with the settings in the .env beside the compose file:
// HMLAB_REAL_URL, HMLAB_REAL_AGENT_KEY, HMLAB_REAL_TOOL (+ optional HMLAB_REAL_ARGS). It never runs inside the server and never prints the key.
// What it does to your tenant: ONE real tools/call that your "Require human approval" policy should hold, which opens ONE request under
// HITL Requests (it expires on its own). You approve it yourself in the console, with PingID on your phone. A retry follows with the id.
// Agents never run this: it needs your key and your phone.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { realConfigFrom } from '../server/src/config.js';
import { createPrivilegeReal, RealError } from '../server/src/privilegeReal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env */ }

const args = new Set(process.argv.slice(2));
const cfg = realConfigFrom(process.env);
const out = (s = '') => console.log(s);
if (!cfg.ok) {
  out('privilege-verify needs the Real settings in the .env beside the compose file:');
  out(`  ${cfg.problem}`);
  out('  HMLAB_REAL_URL (the door MCP URL), HMLAB_REAL_AGENT_KEY, HMLAB_REAL_TOOL (the tool your human-approval policy holds)');
  process.exit(2);
}

const rl = readline.createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
const ask = async (prompt) => { process.stdout.write(`${prompt} `); const { value, done } = await lines.next(); return done ? '' : String(value).trim(); };

const real = createPrivilegeReal({ env: process.env });
const call = async (approvalId = null) => {
  try { return await real.call({ approvalId }); } catch (e) {
    if (e instanceof RealError) { out(`  could not complete the call: ${e.message}`); return null; }
    throw e;
  }
};
const shapeOf = (r) => (r.outcome === 'held'
  ? (r.basis === 'observed' ? `HTTP ${r.http} with a JSON-RPC error (pending_approval): OBSERVED` : `HTTP ${r.http} whose text says pending_approval: INFERRED from the words`)
  : r.outcome === 'executed' ? (r.approvalPresented ? `HTTP ${r.http}: the tool RAN with approval id ${r.approvalPresented}` : `HTTP ${r.http}: the tool RAN (no human-approval policy held this call)`)
    : `HTTP ${r.http}: ${r.outcome}${r.message ? ` (${r.message})` : ''}`);

out(`Gateway door : ${cfg.origin}${new URL(cfg.url).pathname}`);
out(`Tool         : ${cfg.tool}`);
out('This sends ONE real call and opens ONE request under HITL Requests in your console.');
if (!args.has('--yes') && !/^y(es)?$/i.test(await ask('Send it? [y/N]'))) { out('Nothing was sent.'); process.exit(0); }

out('\nStep 1: the held call');
const first = await call();
if (!first) process.exit(1);
out(`  answer shape : ${shapeOf(first)}`);
const report = { shape: shapeOf(first), instruction_id: first.held?.instruction_id ?? null, retry_header: first.held?.retry_header ?? null, approvalIdIs: 'unknown' };
if (first.outcome !== 'held') {
  out('\nThe call was not held, so there is nothing to approve. Check that your "Require human approval" policy is Active and matches this tool and door.');
} else {
  const h = first.held;
  out(`  instruction id: ${h.instruction_id || '(none returned)'}`);
  out(`  retry header  : ${h.retry_header}`);
  if (h.policy_ids?.length) out(`  policy        : ${h.policy_ids.join(', ')}`);
  if (h.reason) out(`  reason        : ${h.reason}`);
  if (h.expires_at) out(`  request expires: ${h.expires_at}`);
  out('\nStep 2: approve it yourself');
  out('  In the Privilege console open HITL Requests, find the request under Awaiting, approve it,');
  out('  and confirm with PingID on your phone. Then come back here.');
  out('  Note the id the console shows for that request (if it shows one).');
  const go = await ask('Press Enter once approved (or type "skip" to stop):');
  if (/^skip$/i.test(go)) { out('Stopped before the retry.'); } else {
    out('\nStep 3: the retry');
    let ok = null;
    if (h.instruction_id) {
      out(`  retrying with the INSTRUCTION id (${h.instruction_id}) ...`);
      const second = await call(h.instruction_id);
      if (second) {
        out(`  answer shape : ${shapeOf(second)}`);
        if (second.outcome === 'executed') { report.approvalIdIs = 'the instruction id (the retry with it ran)'; ok = true; }
      }
    }
    if (!ok) {
      const consoleId = await ask('The retry did not run. Type the request id the console shows (or press Enter to stop):');
      if (consoleId) {
        if (consoleId === h.instruction_id) report.approvalIdIs = 'the same string as the instruction id, but the retry still did not run: it may have expired, or been rejected';
        else {
          out(`  retrying with the CONSOLE id (${consoleId}) ...`);
          const third = await call(consoleId);
          if (third) {
            out(`  answer shape : ${shapeOf(third)}`);
            report.approvalIdIs = third.outcome === 'executed' ? 'the console id, NOT the instruction id' : 'neither id worked: the approval may have expired (retry within the window), or been rejected';
          }
        }
      }
    }
  }
}
out('\n--- paste this back (no secrets in it) ---');
out(`held call answer   : ${report.shape}`);
out(`instruction id     : ${report.instruction_id ? report.instruction_id.replace(/[A-Za-z0-9]/g, (c, i) => (i < 4 ? c : 'x')) : '(none)'}  (shape only)`);
out(`retry header       : ${report.retry_header || '(unknown)'}`);
out(`approval id is     : ${report.approvalIdIs}`);
rl.close();
