import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-usage-'));
process.env.AHR_CODEX_USAGE_LOG = path.join(root, 'codex-usage.jsonl');
process.env.AHR_CLAUDE_USAGE_LOG = path.join(root, 'claude-usage.jsonl');

const usageCore = await import(`../usage-core.js?usage-test=${Date.now()}`);

const normalized = usageCore.normalizeCodexTurnUsage({
  input_tokens: 1200,
  cached_input_tokens: 300,
  output_tokens: 456,
  total_tokens: 1956,
}, {
  session_id: 'hub-session',
  native_session_id: 'codex-thread',
  cwd: root,
  model: 'default',
  turn_ts: new Date().toISOString(),
});

assert.equal(normalized.engine, 'codex');
assert.equal(normalized.input_tokens, 1200);
assert.equal(normalized.cache_read_tokens, 300);
assert.equal(normalized.cache_read_is_subset, true);
assert.equal(normalized.output_tokens, 456);
assert.equal(normalized.total_tokens, 1956);

assert.equal(usageCore.recordCodexTurnUsage(normalized), true);

const rawLog = fs.readFileSync(process.env.AHR_CODEX_USAGE_LOG, 'utf8').trim();
assert.equal(JSON.parse(rawLog).native_session_id, 'codex-thread');

const usage = usageCore.getUsage({ force: true });
assert.equal(usage.codex.usage_available, true);
assert.equal(usage.codex.today.tokens, 1956);
assert.equal(usage.codex.today.turns, 1);
assert.equal(usage.codex.window5h.tokens, 1956);

const claude = usageCore.normalizeClaudeTurnUsage({
  input_tokens: 2000,
  cache_creation_input_tokens: 100,
  cache_read_input_tokens: 50,
  output_tokens: 321,
}, {
  session_id: 'claude-session',
  cwd: root,
  turn_ts: '2026-05-29T00:00:00.000Z',
});

assert.equal(claude.engine, 'claude');
assert.equal(claude.cache_creation_tokens, 100);
assert.equal(claude.cache_read_tokens, 50);
assert.equal(claude.total_tokens, 2471);
assert.equal(usageCore.formatTurnUsageLine(claude), 'Claude turn out 321 / in 2k / total 2k');

fs.writeFileSync(process.env.AHR_CLAUDE_USAGE_LOG, JSON.stringify(claude) + '\n', 'utf8');
const latestClaude = usageCore.readLatestUsageEntry('claude');
assert.equal(latestClaude.session_id, 'claude-session');
assert.equal(usageCore.usageEntryKey(latestClaude), 'claude:claude-session:2026-05-29T00:00:00.000Z:321:2471');

console.log('usage-core turn usage ok');
