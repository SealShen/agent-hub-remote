import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-model-fallback-'));
process.env.AHR_STATE_DIR = path.join(root, 'state');

const {
  claudeModelAttemptChain,
  claudeModelFallbackArgs,
  isClaudeModelStartupFailure,
} = await import('../engines.js');

try {
  assert.deepEqual(claudeModelAttemptChain('sonnet'), ['sonnet', 'opus', 'haiku']);
  assert.deepEqual(claudeModelAttemptChain('opus'), ['opus', 'haiku']);
  assert.deepEqual(claudeModelAttemptChain('haiku'), ['haiku']);
  assert.deepEqual(claudeModelAttemptChain('claude-custom'), ['claude-custom']);

  assert.deepEqual(claudeModelFallbackArgs('sonnet'), ['--fallback-model', 'opus']);
  assert.deepEqual(claudeModelFallbackArgs('opus'), ['--fallback-model', 'haiku']);
  assert.deepEqual(claudeModelFallbackArgs('haiku'), []);

  assert.equal(
    isClaudeModelStartupFailure("There's an issue with the selected model (sonnet). It may not exist or you may not have access to it."),
    true,
  );
  assert.equal(isClaudeModelStartupFailure('tool call failed: permission denied'), false);

  console.log('claude model fallback helpers ok');
} finally {
  await new Promise(resolve => setTimeout(resolve, 50));
  fs.rmSync(root, { recursive: true, force: true });
}
