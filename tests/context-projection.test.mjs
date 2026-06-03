import assert from 'node:assert/strict';

import { projectContextMessages, projectContextText } from '../context-projection.js';
import { formatCodexCommandExecution } from '../tool-display.js';

const toolUse = `${'\u23f5'} Write ${JSON.stringify({
  file_path: 'src/app.js',
  content: 'new file content that should not be inherited',
})}`;
const projectedToolUse = projectContextText(toolUse);
assert.equal(projectedToolUse, `${'\u23f5'} Write: src/app.js`);
assert.doesNotMatch(projectedToolUse, /new file content/);

const sensitiveToolUse = `${'\u23f5'} Write ${JSON.stringify({
  file_path: '.env',
  content: 'placeholder-value',
})}`;
const projectedSensitive = projectContextText(sensitiveToolUse);
assert.match(projectedSensitive, /sensitive path hidden/);
assert.doesNotMatch(projectedSensitive, /placeholder-value/);

assert.equal(projectContextText(`${'\u23f4'} noisy tool result\nlarge output\nmore output`), '');

const commandText = formatCodexCommandExecution({
  type: 'command_execution',
  command: 'npm test',
  aggregated_output: `prefix-${'x'.repeat(1600)}-tail`,
  exit_code: 0,
});
const projectedCommand = projectContextText(commandText);
assert.match(projectedCommand, /Command: npm test/);
assert.match(projectedCommand, /-tail/);
assert.doesNotMatch(projectedCommand, /prefix-/);

const failedCommandText = formatCodexCommandExecution({
  type: 'command_execution',
  command: 'npm run test:bridge-native',
  aggregated_output: 'failed assertion',
  exit_code: 1,
});
const projectedFailedCommand = projectContextText(failedCommandText);
assert.match(projectedFailedCommand, /Exit: 1/);
assert.match(projectedFailedCommand, /failed assertion/);

const projectedMessages = projectContextMessages([
  { role: 'system', kind: 'tool-diff', text: 'Tool diff\n\n```diff\n+large\n```' },
  { role: 'system', kind: 'compact', context: 'keep this summary', text: 'Session compacted.' },
  { role: 'user', text: `${'\u23f4'} tool result only` },
  { role: 'assistant', text: 'final answer' },
]);

assert.equal(projectedMessages.length, 2);
assert.equal(projectedMessages[0].context, 'keep this summary');
assert.equal(projectedMessages[1].text, 'final answer');

console.log('context projection ok');
