import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-context-controls-'));
process.env.AHR_STATE_DIR = stateDir;

const {
  appendContextControl,
  appendMsg,
  loadMessages,
  pendingContextFromControls,
  sessions,
  syncMessageCount,
} = await import('../store.js');

const id = 'context-controls-test';

function putSession() {
  const now = Date.now();
  const s = {
    id,
    name: 'context controls test',
    status: 'idle',
    agentType: 'claude',
    cwd: process.cwd(),
    model: null,
    autoAllow: false,
    archived: false,
    engineRefs: { claude: 'old-claude', codex: 'old-codex' },
    lastEngine: 'claude',
    pid: null,
    msgCount: 0,
    createdAt: now,
    updatedAt: now,
    messages: [],
    proc: null,
    cancelled: false,
  };
  sessions.set(id, s);
  return s;
}

try {
  const s = putSession();
  appendMsg(s, { role: 'user', text: 'first user' });
  appendMsg(s, { role: 'assistant', engine: 'claude', text: 'first assistant' });
  appendMsg(s, { role: 'user', text: 'second user' });
  appendMsg(s, { role: 'assistant', engine: 'claude', text: 'second assistant' });

  appendContextControl(s, {
    op: 'rewind',
    turn: 2,
    context: 'User: first user\n\nAssistant: first assistant',
    contextMode: 'transcript',
    text: 'rewound before turn #2',
  });

  let msgs = loadMessages(id, 0);
  assert.deepEqual(msgs.map(m => m.text), [
    'first user',
    'first assistant',
    'rewound before turn #2',
  ]);
  assert.equal(pendingContextFromControls(s).mode, 'transcript');

  appendMsg(s, { role: 'user', text: 'new user after rewind' });
  assert.equal(pendingContextFromControls(s), null);
  msgs = loadMessages(id, 0);
  assert.deepEqual(msgs.map(m => m.text), [
    'first user',
    'first assistant',
    'rewound before turn #2',
    'new user after rewind',
  ]);

  appendContextControl(s, {
    op: 'compact',
    context: 'compact summary',
    contextMode: 'summary',
    text: 'compacted',
  });
  syncMessageCount(s);

  msgs = loadMessages(id, 0);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, 'compact');
  assert.equal(msgs[0].context, 'compact summary');
  assert.equal(pendingContextFromControls(s).text, 'compact summary');
  assert.equal(s.msgCount, 1);

  console.log('context control projection ok');
} finally {
  sessions.delete(id);
  await new Promise(resolve => setTimeout(resolve, 350));
  fs.rmSync(stateDir, { recursive: true, force: true });
}
