// checkPin.mjs: the ONE pin check for a lab that vendors shared/story. Vendor to scripts/story-checkPin.mjs (byte-for-byte) and call it from the lab's pin test:
//     import { checkPin } from '../scripts/story-checkPin.mjs';
//     assert.deepEqual(checkPin(labRoot), []);
// or run it: node scripts/story-checkPin.mjs <labRoot>   (exit 0 ok, 1 with the problems on stderr, 2 with the usage when no path is given).
// The pin file (web/src/story/story.sha256) lists each vendored file as "<sha256>  <path relative to the lab root>". It FAILS when the pin file is missing or
// unreadable, a vendored file is missing, not pinned, not a regular file (a symlink, a directory) or resolves outside the lab, a hash differs (a lab edited
// its copy: change shared/story first, then re-vendor and re-pin), or an unknown file sits beside the vendored ones.
// In this folder:  node checkPin.mjs --write   regenerates story.sha256 from the files here.   Dependency-free (node:fs, node:path, node:crypto, node:url).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PIN_FILE = 'web/src/story/story.sha256';
// shared file -> where a lab vendors it. hold.js goes to BOTH sides (the server reads captions, the page runs the story); the two copies are byte-identical.
export const VENDORED = {
  'hold.js': ['web/src/story/hold.js', 'server/src/story/hold.js'],
  'captions.js': ['server/src/story/captions.js'],
  'overlay.js': ['web/src/story/overlay.js'], 'engine.js': ['web/src/story/engine.js'],
  'StoryToggle.jsx': ['web/src/story/StoryToggle.jsx'], 'StoryBar.jsx': ['web/src/story/StoryBar.jsx'],
  'story.css': ['web/src/story/story.css'], 'story.test.jsx': ['web/src/story/story.test.jsx'],
};
export const TARGETS = Object.values(VENDORED).flat();
const DIRS = ['web/src/story', 'server/src/story'];

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const canonical = (rel) => typeof rel === 'string' && rel !== '' && !rel.startsWith('/') && !rel.includes('\\') && rel.split('/').every((p) => p !== '' && p !== '.' && p !== '..');
const lst = (file) => { try { return fs.lstatSync(file); } catch { return null; } };

export function pinText(sharedDir) {
  return TARGETS.map((t) => { const from = Object.keys(VENDORED).find((k) => VENDORED[k].includes(t)); return `${sha(path.join(sharedDir, from))}  ${t}`; }).join('\n') + '\n';
}

export function checkPin(labRoot, { pinFile = PIN_FILE } = {}) {
  const problems = [];
  let root;
  try { root = fs.realpathSync(path.resolve(String(labRoot))); } catch { return [`${String(labRoot)}: the lab folder does not exist`]; }
  const pst = lst(path.join(root, pinFile));
  if (!pst) return [`${pinFile}: the pin file is missing`];
  if (!pst.isFile()) return [`${pinFile}: the pin file is not a regular file`];
  const pinned = new Map();
  for (const line of fs.readFileSync(path.join(root, pinFile), 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [hash, rel, ...rest] = line.trim().split(/\s+/);
    if (!/^[0-9a-f]{64}$/.test(hash || '') || rest.length || !canonical(rel)) { problems.push(`${pinFile}: cannot read the line "${line.slice(0, 80)}"`); continue; }
    if (!TARGETS.includes(rel)) { problems.push(`${pinFile}: ${rel} is not a vendored story file`); continue; }
    if (pinned.has(rel)) { problems.push(`${pinFile}: ${rel} is pinned twice`); continue; }
    pinned.set(rel, hash);
  }
  for (const rel of TARGETS) {
    const file = path.join(root, rel); const st = lst(file);
    if (!st) { problems.push(`${rel}: missing from the lab`); continue; }
    if (!pinned.has(rel)) { problems.push(`${rel}: exists in the lab but is not in the pin file`); continue; }
    if (st.isSymbolicLink() || !st.isFile()) { problems.push(`${rel}: must be a regular file, not a symlink, directory or device`); continue; }
    let real; try { real = fs.realpathSync(file); } catch { problems.push(`${rel}: cannot be resolved`); continue; }
    if (!real.startsWith(`${root}${path.sep}`)) { problems.push(`${rel}: resolves outside the lab`); continue; }
    if (sha(file) !== pinned.get(rel)) problems.push(`${rel}: modified (re-vendor it byte-for-byte from shared/story)`);
  }
  const known = new Set([...TARGETS, PIN_FILE]);
  for (const dir of DIRS) {
    let names = []; try { names = fs.readdirSync(path.join(root, dir)); } catch { /* the folder is not there: its files were reported missing */ }
    for (const n of names) if (!known.has(`${dir}/${n}`)) problems.push(`${dir}/${n}: is not in the pin file (nothing else may live beside the vendored files)`);
  }
  return problems;
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === '--write') {
    const here = path.dirname(fileURLToPath(import.meta.url));
    fs.writeFileSync(path.join(here, 'story.sha256'), pinText(here)); console.log('story.sha256 written');
  } else if (!process.argv[2]) { console.error('usage: node story-checkPin.mjs <labRoot>'); process.exit(2); }
  else { const problems = checkPin(process.argv[2]); if (problems.length) { console.error(problems.join('\n')); process.exit(1); } console.log('story pin ok'); }
}
