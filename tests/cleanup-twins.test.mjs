import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// cleanup-claude-native-twins.mjs --apply must merge twin hub JSONL into the owner AND
// persist updated owner msgCount/updatedAt in index.json (written after the merge, not before).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, '..', 'scripts', 'cleanup-claude-native-twins.mjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-cleanup-twins-'));
const stateDir = path.join(root, 'state');
const sessionsDir = path.join(stateDir, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

const ownerId = 'owner-aaaa';
const nativeId = 'native-bbbb';
const OLD = 1_000_000_000_000;
const NEW_A = 2_000_000_000_000;
const NEW_B = 2_500_000_000_000;

const index = [
  { id: ownerId, name: 'owner', status: 'idle', agentType: 'claude', cwd: root,
    engineRefs: { claude: nativeId, codex: null }, source: null, msgCount: 2, updatedAt: OLD },
  { id: nativeId, name: 'native', status: 'idle', agentType: 'claude', cwd: root,
    engineRefs: { claude: nativeId, codex: null }, source: 'native', msgCount: 2, updatedAt: NEW_B },
];
fs.writeFileSync(path.join(stateDir, 'index.json'), JSON.stringify(index), 'utf8');
fs.writeFileSync(path.join(sessionsDir, `${ownerId}.jsonl`),
  JSON.stringify({ role: 'user', text: 'owner existing', ts: OLD }) + '\n', 'utf8');
fs.writeFileSync(path.join(sessionsDir, `${nativeId}.jsonl`),
  JSON.stringify({ role: 'assistant', text: 'twin one', ts: NEW_A }) + '\n' +
  JSON.stringify({ role: 'assistant', text: 'twin two', ts: NEW_B }) + '\n', 'utf8');

try {
  execFileSync(process.execPath, [script, '--apply'],
    { env: { ...process.env, AHR_STATE_DIR: stateDir }, stdio: 'pipe' });

  const after = JSON.parse(fs.readFileSync(path.join(stateDir, 'index.json'), 'utf8'));
  const owner = after.find(s => s.id === ownerId);
  assert.ok(owner, 'owner should remain in index');
  assert.equal(after.some(s => s.id === nativeId), false, 'native twin should be removed from index');
  assert.equal(owner.msgCount, 4, 'owner msgCount should be 2 existing + 2 merged');
  assert.equal(owner.updatedAt, NEW_B, 'owner updatedAt should advance to newest merged ts');

  // Twin JSONL deleted; its messages now live in the owner JSONL.
  assert.equal(fs.existsSync(path.join(sessionsDir, `${nativeId}.jsonl`)), false, 'twin JSONL removed');
  const ownerLog = fs.readFileSync(path.join(sessionsDir, `${ownerId}.jsonl`), 'utf8');
  assert.ok(ownerLog.includes('twin one') && ownerLog.includes('twin two'), 'merged messages in owner log');

  console.log('cleanup twins index metadata ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
