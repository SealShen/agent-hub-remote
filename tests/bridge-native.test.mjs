import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-bridge-native-'));
const stateDir = path.join(root, 'state');
process.env.AHR_STATE_DIR = stateDir;

const { bridgeMessagesForSession } = await import('../engines.js');
const { sessions } = await import('../store.js');

const id = 'bridge-native-test';
const scratchDir = path.join(root, 'scratch');
const nativePath = path.join(scratchDir, `${id}.jsonl`);

function claudeLine(type, role, text, offsetMs) {
  return JSON.stringify({
    type,
    timestamp: new Date(1770000000000 + offsetMs).toISOString(),
    message: { role, content: [{ type: 'text', text }] },
  });
}

fs.mkdirSync(scratchDir, { recursive: true });
fs.writeFileSync(nativePath, [
  claudeLine('user', 'user', 'native user context', 0),
  claudeLine('assistant', 'assistant', 'native assistant context', 1000),
].join('\n') + '\n', 'utf8');

sessions.set(id, {
  id,
  source: 'native',
  agentType: 'claude',
  nativePath,
  messages: [],
});

try {
  const msgs = bridgeMessagesForSession(sessions.get(id));
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].text, 'native user context');
  assert.equal(msgs[1].text, 'native assistant context');
  console.log('bridge native session inheritance ok');
} finally {
  sessions.delete(id);
  fs.rmSync(root, { recursive: true, force: true });
}
