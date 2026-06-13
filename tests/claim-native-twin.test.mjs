import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Regression: claiming a native Claude twin must not drop hub-appended messages that
// already live on the twin. claimClaudeNativeSession() merges them into the owner before
// removeSession(deleteLog:true) deletes the twin's hub JSONL.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-claim-twin-'));
const stateDir = path.join(root, 'state');
process.env.AHR_STATE_DIR = stateDir;

const { createSession, appendMsg, loadMessages, hubMessageCount, sessions } = await import('../store.js');
const { claimClaudeNativeSession } = await import('../engines.js');

const sessDir = path.join(stateDir, 'sessions');

try {
  // Owner = the live hub session that will claim the native id.
  const owner = createSession({ name: 'owner', agentType: 'claude', cwd: root });

  // Native twin with its own hub JSONL holding a hub-appended message.
  const twinId = 'native-twin-id';
  const twin = {
    id: twinId, name: 'twin', status: 'idle', agentType: 'claude', cwd: root,
    source: 'native', nativePath: path.join(root, 'twin-native.jsonl'),
    engineRefs: { claude: null, codex: null }, msgCount: 0, messages: [],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  sessions.set(twinId, twin);
  appendMsg(twin, { role: 'assistant', engine: 'claude', text: 'hub message on twin' });
  assert.equal(hubMessageCount(twinId), 1, 'twin should have one hub message before claim');

  const twinLog = path.join(sessDir, `${twinId}.jsonl`);
  assert.ok(fs.existsSync(twinLog), 'twin hub JSONL should exist before claim');

  const result = claimClaudeNativeSession(owner, twinId);

  // Twin gone, its log deleted, its message preserved on the owner.
  assert.equal(result.removedTwin, true, 'twin should be removed');
  assert.equal(result.movedMessages, 1, 'one hub message should have moved to owner');
  assert.equal(sessions.has(twinId), false, 'twin should be out of the sessions map');
  assert.equal(fs.existsSync(twinLog), false, 'twin hub JSONL should be deleted');

  const ownerMsgs = loadMessages(owner.id, 0);
  assert.ok(
    ownerMsgs.some(m => m.text === 'hub message on twin'),
    'owner should now carry the twin hub message',
  );

  // Claiming a twin with an empty hub log must still work and move nothing.
  const twin2Id = 'native-twin-empty';
  sessions.set(twin2Id, {
    id: twin2Id, name: 'twin2', status: 'idle', agentType: 'claude', cwd: root,
    source: 'native', nativePath: path.join(root, 'twin2-native.jsonl'),
    engineRefs: { claude: null, codex: null }, msgCount: 0, messages: [],
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  const owner2 = createSession({ name: 'owner2', agentType: 'claude', cwd: root });
  const result2 = claimClaudeNativeSession(owner2, twin2Id);
  assert.equal(result2.movedMessages, 0, 'empty twin should move no messages');
  assert.equal(result2.removedTwin, true, 'empty twin should still be removed');

  // updatedAt must NOT regress when moved twin messages are older than the owner, and
  // msgCount must accumulate the moved entries.
  const OLD_A = 1_000_000_000_000;
  const OLD_B = 1_500_000_000_000;
  const OWNER_RECENT = 2_000_000_000_000;
  const owner3 = createSession({ name: 'owner3', agentType: 'claude', cwd: root });
  owner3.updatedAt = OWNER_RECENT;
  owner3.msgCount = 5;
  const twin3Id = 'native-twin-older';
  const twin3 = {
    id: twin3Id, name: 'twin3', status: 'idle', agentType: 'claude', cwd: root,
    source: 'native', nativePath: path.join(root, 'twin3-native.jsonl'),
    engineRefs: { claude: null, codex: null }, msgCount: 0, messages: [],
    createdAt: OLD_A, updatedAt: OLD_B,
  };
  sessions.set(twin3Id, twin3);
  appendMsg(twin3, { role: 'assistant', engine: 'claude', text: 'older one', ts: OLD_A });
  appendMsg(twin3, { role: 'assistant', engine: 'claude', text: 'older two', ts: OLD_B });
  const result3 = claimClaudeNativeSession(owner3, twin3Id);
  assert.equal(result3.movedMessages, 2, 'two older messages should move');
  assert.equal(owner3.updatedAt, OWNER_RECENT, 'owner updatedAt must not regress below older moved ts');
  assert.equal(owner3.msgCount, 7, 'owner msgCount should be 5 + 2 moved');

  // updatedAt must advance when a moved twin message is newer than the owner.
  const NEW_TS = 3_000_000_000_000;
  const owner4 = createSession({ name: 'owner4', agentType: 'claude', cwd: root });
  owner4.updatedAt = OLD_A;
  const twin4Id = 'native-twin-newer';
  const twin4 = {
    id: twin4Id, name: 'twin4', status: 'idle', agentType: 'claude', cwd: root,
    source: 'native', nativePath: path.join(root, 'twin4-native.jsonl'),
    engineRefs: { claude: null, codex: null }, msgCount: 0, messages: [],
    createdAt: OLD_A, updatedAt: NEW_TS,
  };
  sessions.set(twin4Id, twin4);
  appendMsg(twin4, { role: 'assistant', engine: 'claude', text: 'newer', ts: NEW_TS });
  claimClaudeNativeSession(owner4, twin4Id);
  assert.equal(owner4.updatedAt, NEW_TS, 'owner updatedAt should advance to newer moved ts');

  console.log('claim native twin preserves hub messages ok');
} finally {
  sessions.clear();
  // Let the debounced persistIndex timer fire before deleting the temp state dir.
  await new Promise(resolve => setTimeout(resolve, 350));
  fs.rmSync(root, { recursive: true, force: true });
}
