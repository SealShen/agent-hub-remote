import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { formatDiffBlock, hasSensitivePath, truncateText } from './tool-display.js';

const AUTO_COMMIT_MESSAGE = 'chore(auto-commit): persist Codex turn changes';
// Editor→reviewer handoff trailers. The Codex auto-commit is the "editor" half;
// these markers give the "reviewer" half (review-flow) a machine-readable target:
// review-flow flips `Review-status: pending` → `Reviewed-by:` + `Review-status: reviewed`.
const AUTO_COMMIT_EDITOR_TRAILER = process.env.AHR_AUTO_COMMIT_EDITOR
  || 'Co-Authored-By: Codex (agent-hub-remote) <codex@agent-hub-remote.local>';
function autoCommitTrailerArgs() {
  if (process.env.AHR_AUTO_COMMIT_NO_TRAILER === '1') return [];
  return [
    '--trailer', AUTO_COMMIT_EDITOR_TRAILER,
    '--trailer', 'Review-status: pending',
  ];
}
const _AUTO_COMMIT_DIFF_MAX = Number(process.env.AHR_AUTO_COMMIT_DIFF_MAX || 12000);
const AUTO_COMMIT_DIFF_MAX = Number.isFinite(_AUTO_COMMIT_DIFF_MAX) && _AUTO_COMMIT_DIFF_MAX > 0
  ? _AUTO_COMMIT_DIFF_MAX
  : 12000;

function runGit(args, cwd, timeout = 15000) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    errors: 'replace',
    windowsHide: true,
    timeout,
  });
  return {
    code: typeof res.status === 'number' ? res.status : 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

function parsePorcelainZ(raw) {
  const entries = new Map();
  const parts = raw.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const status = rec.slice(0, 2);
    const rel = rec.slice(3);
    if (!rel) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      const dest = parts[++i];
      if (dest) entries.set(dest.replaceAll('\\', '/'), status);
      continue;
    }
    entries.set(rel.replaceAll('\\', '/'), status);
  }
  return entries;
}

export function findGitRoot(cwd) {
  const res = runGit(['rev-parse', '--show-toplevel'], cwd, 5000);
  if (res.code !== 0) return null;
  return path.resolve(res.stdout.trim());
}

function hasAutoCommitMarker(repo) {
  return fs.existsSync(path.join(repo, '.codex-auto-commit')) ||
    fs.existsSync(path.join(repo, '.claude-auto-commit'));
}

export function captureGitSnapshot(cwd) {
  const repo = findGitRoot(cwd);
  if (!repo) return { ok: false, reason: 'not a git repo' };
  if (!hasAutoCommitMarker(repo)) return { ok: false, repo, reason: 'auto-commit marker missing' };
  const res = runGit(['status', '--porcelain=v1', '-z'], repo, 10000);
  if (res.code !== 0) {
    return { ok: false, repo, reason: res.stderr.trim() || 'git status failed' };
  }
  return { ok: true, repo, entries: parsePorcelainZ(res.stdout) };
}

function pathsChangedFromCleanBaseline(before, afterEntries) {
  const out = [];
  const skippedDirty = [];
  for (const [rel, status] of afterEntries) {
    if (before.entries.has(rel)) {
      skippedDirty.push(rel);
      continue;
    }
    if (status.trim()) out.push(rel);
  }
  return { paths: out, skippedDirty };
}

function pathspecArgs(paths) {
  return ['--', ...paths];
}

function captureStagedDiff(repo, paths) {
  if (hasSensitivePath(paths)) {
    return { text: '', hiddenReason: 'sensitive-looking path' };
  }
  const diff = runGit(['diff', '--cached', '--no-ext-diff', '--no-color', '--unified=3', ...pathspecArgs(paths)], repo, 15000);
  if (diff.code !== 0) {
    return { text: '', hiddenReason: diff.stderr.trim() || 'git diff failed' };
  }
  const clipped = truncateText(diff.stdout.trim(), AUTO_COMMIT_DIFF_MAX);
  return { text: clipped.text, truncated: clipped.truncated };
}

export function runCodexAutoCommit(before) {
  if (process.env.AHR_CODEX_AUTO_COMMIT_DISABLE === '1') {
    return { ok: true, committed: false, reason: 'disabled' };
  }
  if (!before?.ok || !before.repo) {
    return { ok: false, committed: false, reason: before?.reason || 'baseline unavailable' };
  }
  const after = runGit(['status', '--porcelain=v1', '-z'], before.repo, 10000);
  if (after.code !== 0) {
    return { ok: false, committed: false, reason: after.stderr.trim() || 'git status failed' };
  }
  const afterEntries = parsePorcelainZ(after.stdout);
  const { paths, skippedDirty } = pathsChangedFromCleanBaseline(before, afterEntries);
  if (!paths.length) {
    return {
      ok: true,
      committed: false,
      reason: skippedDirty.length ? 'only pre-existing dirty paths changed' : 'no clean-baseline changes',
      skippedDirty,
    };
  }

  const add = runGit(['add', '-A', ...pathspecArgs(paths)], before.repo, 15000);
  if (add.code !== 0) {
    return { ok: false, committed: false, reason: add.stderr.trim() || 'git add failed', paths, skippedDirty };
  }
  const stagedDiff = captureStagedDiff(before.repo, paths);
  const commit = runGit(['commit', '-m', AUTO_COMMIT_MESSAGE, ...autoCommitTrailerArgs(), ...pathspecArgs(paths)], before.repo, 30000);
  if (commit.code !== 0) {
    return { ok: false, committed: false, reason: commit.stderr.trim() || commit.stdout.trim() || 'git commit failed', paths, skippedDirty };
  }
  return {
    ok: true,
    committed: true,
    paths,
    skippedDirty,
    stdout: commit.stdout.trim(),
    diff: stagedDiff.text,
    diffHiddenReason: stagedDiff.hiddenReason,
    diffTruncated: stagedDiff.truncated,
  };
}

export function formatAutoCommitResult(result) {
  if (!result) return null;
  if (result.committed) {
    const suffix = result.skippedDirty?.length
      ? `; skipped ${result.skippedDirty.length} pre-existing dirty path(s)`
      : '';
    const paths = (result.paths || []).map(p => `- ${p}`).join('\n');
    let text = `Auto-commit: committed ${result.paths.length} path(s)${suffix}.`;
    if (paths) text += `\n\nPaths:\n${paths}`;
    if (result.diff) text += `\n\n${formatDiffBlock(result.diff)}`;
    else if (result.diffHiddenReason) text += `\n\nDiff hidden: ${result.diffHiddenReason}.`;
    return text;
  }
  if (result.skippedDirty?.length) {
    return `Auto-commit: skipped ${result.skippedDirty.length} pre-existing dirty path(s); no clean-baseline paths to commit.`;
  }
  if (!result.ok) {
    return `Auto-commit skipped: ${String(result.reason || 'unknown error').slice(0, 240)}`;
  }
  return null;
}
