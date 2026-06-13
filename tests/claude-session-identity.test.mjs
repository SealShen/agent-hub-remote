import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-claude-session-id-'));
process.env.AHR_STATE_DIR = path.join(root, 'state');

const {
  claimClaudeNativeSession,
  claudeModelAttemptChain,
  claudeModelFallbackArgs,
  claudeSessionIdentityArgs,
  isClaudeModelStartupFailure,
  shouldStartFreshClaudeThread,
} = await import('../engines.js');
const { sessions, loadMessages } = await import('../store.js');

const hubId = '11111111-1111-4111-8111-111111111111';
const nativeId = '22222222-2222-4222-8222-222222222222';
const jsonl = path.join(process.env.AHR_STATE_DIR, 'sessions', `${nativeId}.jsonl`);

try {
  assert.deepEqual(
    claudeModelAttemptChain('sonnet'),
    ['sonnet', 'opus', 'haiku'],
    'sonnet should retry through the full preferred Claude model order',
  );
  assert.deepEqual(claudeModelAttemptChain('opus'), ['opus', 'haiku']);
  assert.deepEqual(claudeModelAttemptChain('haiku'), ['haiku']);
  assert.deepEqual(claudeModelFallbackArgs('sonnet'), ['--fallback-model', 'opus']);
  assert.deepEqual(claudeModelFallbackArgs('opus'), ['--fallback-model', 'haiku']);
  assert.deepEqual(claudeModelFallbackArgs('haiku'), []);
  assert.equal(
    isClaudeModelStartupFailure("There's an issue with the selected model (sonnet). It may not exist or you may not have access to it."),
    true,
  );
  assert.equal(isClaudeModelStartupFailure('tool call failed: permission denied'), false);

  assert.deepEqual(
    claudeSessionIdentityArgs({ id: hubId }, null),
    { args: ['--session-id', hubId], expectedSessionId: hubId },
  );
  assert.deepEqual(
    claudeSessionIdentityArgs({ id: hubId }, nativeId),
    { args: ['--resume', nativeId], expectedSessionId: null },
  );
  assert.deepEqual(
    claudeSessionIdentityArgs({ id: hubId }, null, { sessionIdOverride: nativeId }),
    { args: ['--session-id', nativeId], expectedSessionId: nativeId },
  );
  assert.equal(
    shouldStartFreshClaudeThread({ engine: 'claude', pendingContext: true }),
    true,
    'compact/rewind pending context must start a fresh Claude native thread',
  );
  assert.equal(
    shouldStartFreshClaudeThread({ engine: 'claude', prevEngine: 'codex' }),
    true,
    'cross-engine bridge into Claude must not reuse an old Claude native thread',
  );
  assert.equal(
    shouldStartFreshClaudeThread({ engine: 'codex', pendingContext: true }),
    false,
    'Codex allocates fresh threads through codex exec itself',
  );

  fs.mkdirSync(path.dirname(jsonl), { recursive: true });
  fs.writeFileSync(jsonl, '{"role":"system","text":"hub-side native twin"}\n', 'utf8');

  const hub = { id: hubId, engineRefs: { claude: null, codex: null }, updatedAt: Date.now(), cwd: root, msgCount: 0, messages: [] };
  sessions.set(hubId, hub);
  sessions.set(nativeId, {
    id: nativeId,
    source: 'native',
    agentType: 'claude',
    engineRefs: { claude: nativeId, codex: null },
    updatedAt: Date.now(),
    cwd: root,
  });

  const result = claimClaudeNativeSession(hub, nativeId);
  assert.equal(result.changed, true);
  assert.equal(result.removedTwin, true);
  assert.equal(hub.engineRefs.claude, nativeId);
  assert.equal(sessions.has(nativeId), false);
  // Twin log is removed only AFTER its hub-side message is merged into the owner —
  // the cleanup must not lose hub messages (regression guard).
  assert.equal(fs.existsSync(jsonl), false);
  assert.equal(result.movedMessages, 1);
  assert.ok(
    loadMessages(hubId, 0).some(m => m.text === 'hub-side native twin'),
    'twin hub message should survive on the owner',
  );

  console.log('claude session identity args + native twin cleanup ok');
} finally {
  sessions.clear();
  await new Promise(resolve => setTimeout(resolve, 350));
  fs.rmSync(root, { recursive: true, force: true });
}
