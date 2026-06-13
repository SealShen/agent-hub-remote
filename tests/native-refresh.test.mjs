import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-native-refresh-'));
const stateDir = path.join(root, 'state');
const codexRoot = path.join(root, 'codex-sessions');
const claudeRoot = path.join(root, 'claude-projects');
const cwd = path.join(root, 'workspace');

process.env.AHR_STATE_DIR = stateDir;
process.env.AHR_CODEX_SESSIONS_DIR = codexRoot;
process.env.AHR_CLAUDE_PROJECTS_DIR = claudeRoot;

const {
  ingestProjects,
  loadMessages,
  sessions,
} = await import('../store.js');

const nativeId = 'codex-native-refresh-id';
const hubId = `codex-${nativeId}`;
const nativePath = path.join(codexRoot, '2026', '05', '25', `rollout-2026-05-25T12-00-00-${nativeId}.jsonl`);

function line(type, payload, offsetMs) {
  return JSON.stringify({
    type,
    timestamp: new Date(1770000000000 + offsetMs).toISOString(),
    payload,
  });
}

try {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(nativePath), { recursive: true });

  assert.equal(ingestProjects([cwd]), 0);

  fs.writeFileSync(nativePath, [
    line('session_meta', { id: nativeId, cwd }, 0),
    line('response_item', {
      type: 'message',
      role: 'user',
      // 實際 runtime 形狀：bootstrap 與使用者文字在「同一則」user message
      // （engines.js codexPromptForSession 前置注入）
      content: [{ type: 'input_text', text: '# Codex workspace bootstrap\n\nBefore non-trivial work in this workspace, read these files in order:\n\n---\n\nhello codex native refresh' }],
    }, 1000),
    line('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello from codex' }],
    }, 2000),
  ].join('\n') + '\n', 'utf8');

  assert.equal(ingestProjects([cwd]), 1);
  assert.equal(ingestProjects([cwd]), 0);
  assert.equal(sessions.has(hubId), true);

  const rec = sessions.get(hubId);
  assert.equal(rec.agentType, 'codex');
  assert.equal(rec.engineRefs.codex, nativeId);
  assert.equal(rec.nativePath, nativePath);
  assert.equal(rec.name, 'hello codex native refresh');

  const messages = loadMessages(hubId, 0);
  assert.deepEqual(messages.map(m => m.text), [
    'hello codex native refresh',
    'hello from codex',
  ]);
  assert.equal(messages[1].engine, 'codex');

  console.log('native codex refresh ingest ok');
} finally {
  sessions.delete(hubId);
  await new Promise(resolve => setTimeout(resolve, 350));
  fs.rmSync(root, { recursive: true, force: true });
}
