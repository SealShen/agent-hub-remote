import assert from 'node:assert/strict';

import {
  formatClaudeToolResult,
  formatClaudeToolUse,
  formatCodexCommandExecution,
  formatShellCommandBlock,
} from '../tool-display.js';

const edit = formatClaudeToolUse({
  type: 'tool_use',
  name: 'Edit',
  input: {
    file_path: 'C:\\Users\\owner\\.codex\\memories\\extensions\\ad_hoc\\notes\\note.md',
    old_string: 'old line',
    new_string: 'new line',
  },
});
assert.match(edit, /Edit: C:\\Users\\owner/);
assert.match(edit, /```diff/);
assert.match(edit, /-old line/);
assert.match(edit, /\+new line/);

const write = formatClaudeToolUse({
  type: 'tool_use',
  name: 'Write',
  input: {
    file_path: 'memory/example.md',
    content: 'remember this\n',
  },
});
assert.match(write, /--- \/dev\/null/);
assert.match(write, /\+remember this/);

const hidden = formatClaudeToolUse({
  type: 'tool_use',
  name: 'Write',
  input: {
    file_path: '.env',
    content: 'value',
  },
});
assert.match(hidden, /Diff hidden/);
assert.doesNotMatch(hidden, /value/);

const bash = formatClaudeToolUse({
  type: 'tool_use',
  name: 'Bash',
  input: {
    description: 'run the focused test',
    command: 'npm run test:bridge-native',
  },
});
assert.match(bash, /Bash: run the focused test/);
assert.match(bash, /```bash\nnpm run test:bridge-native\n```/);

const commandBlock = formatShellCommandBlock('git status --short');
assert.equal(commandBlock, '```bash\ngit status --short\n```');

const codexCommand = formatCodexCommandExecution({
  type: 'command_execution',
  command: 'git diff --check',
  aggregated_output: 'ok\n',
  exit_code: 0,
});
assert.equal(codexCommand, '```bash\ngit diff --check\n```\n\nok');

const resultDiff = formatClaudeToolResult({
  type: 'tool_result',
  content: 'diff --git a/a.txt b/a.txt\n@@\n-old\n+new',
});
assert.match(resultDiff, /Tool diff/);
assert.match(resultDiff, /\+new/);

console.log('tool display formatting ok');
