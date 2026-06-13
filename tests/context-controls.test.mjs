import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-context-controls-'));
process.env.AHR_STATE_DIR = stateDir;

const {
  appendContextControl,
  appendMsg,
  hydrate,
  loadMessages,
  pendingContextFromControls,
  sessions,
  sessionsArr,
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
    contextReset: {
      op: 'rewind',
      turn: 2,
      previousEngineRefs: { claude: 'old-claude', codex: 'old-codex' },
    },
    text: 'rewound before turn #2',
  });

  let msgs = loadMessages(id, 0);
  assert.deepEqual(msgs.map(m => m.text), [
    'first user',
    'first assistant',
    'rewound before turn #2',
  ]);
  assert.equal(pendingContextFromControls(s).mode, 'transcript');
  assert.equal(pendingContextFromControls(s).freshThread, true);
  assert.equal(pendingContextFromControls(s).contextReset.previousEngineRefs.claude, 'old-claude');

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
    contextReset: {
      op: 'compact',
      previousEngineRefs: { claude: 'old-claude-2', codex: null },
    },
    text: 'compacted',
  });
  assert.equal(s.contextReset.previousEngineRefs.claude, 'old-claude-2');
  syncMessageCount(s);

  msgs = loadMessages(id, 0);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, 'compact');
  assert.equal(msgs[0].context, 'compact summary');
  assert.equal(msgs[0].contextReset.previousEngineRefs.claude, 'old-claude-2');
  assert.equal(pendingContextFromControls(s).text, 'compact summary');
  assert.equal(
    sessionsArr().find(x => x.id === id).contextReset.previousEngineRefs.claude,
    'old-claude-2',
    'session metadata should use the in-memory reset ids',
  );
  assert.equal(s.msgCount, 1);

  const noResetId = 'context-controls-no-reset';
  sessions.set(noResetId, {
    id: noResetId,
    name: 'no reset hot path test',
    status: 'idle',
    agentType: 'claude',
    cwd: process.cwd(),
    model: null,
    autoAllow: false,
    archived: false,
    engineRefs: { claude: null, codex: null },
    lastEngine: 'claude',
    pid: null,
    msgCount: 1,
    contextReset: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    proc: null,
    cancelled: false,
  });

  const realReadFileSync = fs.readFileSync;
  const noResetPath = path.join(stateDir, 'sessions', `${noResetId}.jsonl`);
  let noResetJsonlReads = 0;
  fs.readFileSync = function patchedReadFileSync(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(noResetPath)) noResetJsonlReads++;
    return realReadFileSync.call(this, file, ...args);
  };
  try {
    assert.equal(sessionsArr().find(x => x.id === noResetId).contextReset, null);
  } finally {
    fs.readFileSync = realReadFileSync;
    sessions.delete(noResetId);
  }
  assert.equal(noResetJsonlReads, 0, 'sessionsArr should not read JSONL for no-reset metadata');

  await new Promise(resolve => setTimeout(resolve, 350));
  sessions.clear();

  const hydrateId = 'context-controls-hydrate-reset';
  const hydrateReset = {
    op: 'compact',
    previousEngineRefs: { claude: 'hydrate-old-claude', codex: null },
  };
  const now = Date.now();
  fs.writeFileSync(path.join(stateDir, 'index.json'), JSON.stringify([{
    id: hydrateId,
    name: 'hydrate reset test',
    status: 'idle',
    agentType: 'claude',
    cwd: process.cwd(),
    model: null,
    autoAllow: false,
    archived: false,
    engineRefs: { claude: 'hydrate-old-claude', codex: null },
    lastEngine: 'claude',
    pid: null,
    msgCount: 1,
    source: null,
    nativePath: null,
    createdAt: now,
    updatedAt: now,
  }]));
  fs.writeFileSync(path.join(stateDir, 'sessions', `${hydrateId}.jsonl`), JSON.stringify({
    role: 'system',
    kind: 'context-control',
    op: 'compact',
    context: 'old compact summary',
    contextMode: 'summary',
    contextReset: hydrateReset,
    text: 'old compacted',
    ts: now,
  }) + '\n');
  assert.deepEqual(hydrate(), []);
  assert.equal(
    sessions.get(hydrateId).contextReset.previousEngineRefs.claude,
    'hydrate-old-claude',
    'hydrate should backfill contextReset once for old index records',
  );

  console.log('context control projection ok');
} finally {
  sessions.clear();
  await new Promise(resolve => setTimeout(resolve, 350));
  fs.rmSync(stateDir, { recursive: true, force: true });
}
