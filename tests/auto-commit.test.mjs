import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { captureGitSnapshot, formatAutoCommitResult, runCodexAutoCommit } from '../auto-commit.js';

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    errors: 'replace',
    windowsHide: true,
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed\n${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-auto-commit-'));
  run('git', ['init'], dir);
  run('git', ['config', 'user.name', 'Agent Hub Test'], dir);
  run('git', ['config', 'user.email', 'agent-hub-test@example.invalid'], dir);
  fs.writeFileSync(path.join(dir, '.claude-auto-commit'), '', 'utf8');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'base\n', 'utf8');
  run('git', ['add', '.'], dir);
  run('git', ['commit', '-m', 'test: initial'], dir);
  return dir;
}

function commitCount(cwd) {
  return Number(run('git', ['rev-list', '--count', 'HEAD'], cwd));
}

const repo = initRepo();

try {
  const beforeClean = captureGitSnapshot(repo);
  assert.equal(beforeClean.ok, true);
  fs.writeFileSync(path.join(repo, 'new.txt'), 'created during codex turn\n', 'utf8');

  const committed = runCodexAutoCommit(beforeClean);
  assert.equal(committed.ok, true);
  assert.equal(committed.committed, true);
  assert.deepEqual(committed.paths, ['new.txt']);
  assert.match(committed.diff, /\+created during codex turn/);
  assert.match(formatAutoCommitResult(committed), /```diff\n/);
  assert.equal(commitCount(repo), 2);
  assert.equal(run('git', ['status', '--porcelain'], repo), '');

  fs.appendFileSync(path.join(repo, 'tracked.txt'), 'dirty before turn\n', 'utf8');
  const beforeDirty = captureGitSnapshot(repo);
  assert.equal(beforeDirty.ok, true);
  fs.appendFileSync(path.join(repo, 'tracked.txt'), 'changed during codex turn\n', 'utf8');

  const skipped = runCodexAutoCommit(beforeDirty);
  assert.equal(skipped.ok, true);
  assert.equal(skipped.committed, false);
  assert.deepEqual(skipped.skippedDirty, ['tracked.txt']);
  assert.equal(commitCount(repo), 2);
  assert.match(run('git', ['status', '--porcelain'], repo), /^M tracked\.txt$/);

  console.log('auto-commit fallback ok');
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}
