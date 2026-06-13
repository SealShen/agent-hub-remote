import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import writeFileAtomic from 'write-file-atomic';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const stateDir = process.env.AHR_STATE_DIR ? path.resolve(process.env.AHR_STATE_DIR) : path.join(root, '.state');
const indexPath = path.join(stateDir, 'index.json');
const sessionsDir = path.join(stateDir, 'sessions');
const apply = process.argv.includes('--apply');

const items = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
if (!Array.isArray(items)) throw new Error(`${indexPath} is not an array`);

const ownersByNativeId = new Map();
for (const s of items) {
  const nativeId = s?.engineRefs?.claude;
  if (!nativeId || s.id === nativeId) continue;
  if (!ownersByNativeId.has(nativeId)) ownersByNativeId.set(nativeId, []);
  ownersByNativeId.get(nativeId).push(s);
}

const removals = [];
const ambiguous = [];
for (const native of items) {
  if (native?.source !== 'native' || native.agentType !== 'claude' || !native.id) continue;
  const owners = ownersByNativeId.get(native.id) || [];
  if (owners.length === 1) removals.push({ native, owner: owners[0] });
  else if (owners.length > 1) ambiguous.push({ native, owners });
}

const removeIds = new Set(removals.map(r => r.native.id));
const next = items.filter(s => !removeIds.has(s.id));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(stateDir, `index.json.${stamp}.bak`);

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  stateDir,
  indexPath,
  total: items.length,
  native: items.filter(s => s?.source === 'native').length,
  remove: removals.length,
  keep: next.length,
  ambiguous: ambiguous.length,
  removals: removals.map(r => ({ nativeId: r.native.id, ownerId: r.owner.id })),
}, null, 2));

if (!apply) {
  console.log('Dry run only. Re-run with --apply after reviewing the counts.');
  process.exit(0);
}

if (!removals.length) {
  console.log('No claimable native twins found; index unchanged.');
  process.exit(0);
}

fs.copyFileSync(indexPath, backupPath);

// Merge JSONL BEFORE writing the index so the persisted owner metadata (msgCount /
// updatedAt) reflects the merged messages. `owner` objects are the same references kept
// in `next`, so mutating them here is what gets written below.
let deletedJsonl = 0;
let mergedMessages = 0;
for (const { native, owner } of removals) {
  const p = path.join(sessionsDir, `${native.id}.jsonl`);
  if (!fs.existsSync(p)) continue;
  // Mirror store.absorbHubMessages: never drop hub-appended messages on the twin.
  // Move any non-empty hub JSONL content into the owner before deleting the twin log.
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  if (lines.length) {
    fs.appendFileSync(path.join(sessionsDir, `${owner.id}.jsonl`), lines.join('\n') + '\n');
    mergedMessages += lines.length;
    owner.msgCount = (owner.msgCount || 0) + lines.length;
    let maxTs = owner.updatedAt || 0;
    for (const l of lines) {
      try { const ts = JSON.parse(l).ts; if (typeof ts === 'number' && ts > maxTs) maxTs = ts; }
      catch { /* skip unparseable line for ts purposes */ }
    }
    owner.updatedAt = maxTs;
  }
  fs.rmSync(p, { force: true });
  deletedJsonl++;
}

writeFileAtomic.sync(indexPath, JSON.stringify(next));

console.log(`Applied. Backup: ${backupPath}. Removed ${removals.length} index entries, merged ${mergedMessages} hub messages into owners, and removed ${deletedJsonl} hub JSONL files.`);
