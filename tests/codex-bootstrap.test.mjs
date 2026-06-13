import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-codex-bootstrap-'));
process.env.AHR_STATE_DIR = path.join(root, 'state');

const { codexPromptForSession, codexWorkspaceBootstrap } = await import('../engines.js');

const homeDir = path.join(root, 'home');
const workspaceRoot = path.join(homeDir, 'workspace');
const workspaceChild = path.join(workspaceRoot, 'child');
const bootstrapText = [
  '# Codex workspace bootstrap',
  '',
  'Before non-trivial work in this workspace, read docs/ARCHITECTURE.md.',
  '',
  '---',
].join('\n');

const configPath = path.join(root, 'codex-bootstrap.json');
fs.writeFileSync(
  configPath,
  JSON.stringify({ workspaceRoot, bootstrap: bootstrapText }),
  'utf8',
);

try {
  // Inside the configured workspace: bootstrap is returned verbatim.
  const bootstrap = codexWorkspaceBootstrap(workspaceChild, { homeDir, configPath });
  assert.equal(bootstrap, bootstrapText);

  // Outside the workspace: no injection.
  assert.equal(
    codexWorkspaceBootstrap(path.join(homeDir, 'elsewhere'), { homeDir, configPath }),
    '',
  );

  // No config file at all: no injection.
  assert.equal(
    codexWorkspaceBootstrap(workspaceChild, { homeDir, configPath: path.join(root, 'missing.json') }),
    '',
  );

  // ~ in workspaceRoot expands to homeDir.
  const tildeConfig = path.join(root, 'codex-bootstrap-tilde.json');
  fs.writeFileSync(
    tildeConfig,
    JSON.stringify({ workspaceRoot: '~/workspace', bootstrap: bootstrapText }),
    'utf8',
  );
  assert.equal(
    codexWorkspaceBootstrap(workspaceChild, { homeDir, configPath: tildeConfig }),
    bootstrapText,
  );

  // codexPromptForSession prepends the bootstrap to the prompt.
  const prompt = codexPromptForSession({ cwd: workspaceRoot }, 'do the task', { homeDir, configPath });
  assert.ok(prompt.startsWith('# Codex workspace bootstrap'));
  assert.ok(prompt.endsWith('do the task'));

  // No bootstrap when cwd is outside the workspace.
  assert.equal(
    codexPromptForSession({ cwd: path.join(homeDir, 'elsewhere') }, 'do the task', { homeDir, configPath }),
    'do the task',
  );

  console.log('codex bootstrap prompt ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
