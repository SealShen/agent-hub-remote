// 引擎層：spawn claude / codex + 跨模型 bridge（plan §二-A、§A2、§三-3、#5 #6）
//
// 身分模型（#5）：session.id 是身分；engineRefs{claude,codex} 是各引擎原生
//   resume 指標。lastEngine = 上一輪實際跑的引擎。
// resume（#4）：原生 resume 只在「同引擎且 engineRefs[engine] 有值」時發生；
//   無 --continue fallback；resume 失敗明示錯誤、不靜默接錯。
// 跨模型（§A2）：跨引擎時不接對方舊原生 thread，一律從 messages[] 重 bridge
//   —— 全文轉錄注入新引擎首 prompt，避免 local summarizer 造成慢速與不可控接續。
// Codex 防護（§三-3 / #12）：Windows 無 OS 沙箱，不靠 --sandbox；危險旗標只在
//   session.autoAllow=true 時帶（toggle 開啟需 action-token，spec §5.4），否則走
//   codex exec 預設 approval（非互動 → 自動拒絕）。旗標名稱屬易變事實，
//   修改此段前以當前 CLI 與官方文件重驗。

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { absorbHubMessages, appendMsg, loadMessages, persistIndex, removeSession, sessions, sessionsArr, STATE_DIR } from './store.js';
import {
  formatTurnUsageLine,
  getUsage,
  normalizeClaudeTurnUsage,
  normalizeCodexTurnUsage,
  recordCodexTurnUsage,
  usageEntryKey,
} from './usage-core.js';
import { captureGitSnapshot, formatAutoCommitResult, runCodexAutoCommit } from './auto-commit.js';
import { projectContextMessages } from './context-projection.js';
import { recordHarnessCoverage, recordHarnessOutcome } from './harness-outcomes.js';
import { formatClaudeToolResult, formatClaudeToolUse, formatCodexCommandExecution } from './tool-display.js';
import { spawnCli } from './cli-launch.js';
import { buildBridgeContext } from './bridge-context.js';
import { createContextObserver } from './context-metrics.js';
import { evidenceContextEpoch, filterEvidenceFiles } from './task-evidence-cache.js';
import { nativeHistoryWithinBudget } from './native-context-budget.js';

const codexBootstrapDir = path.dirname(fileURLToPath(import.meta.url));

const _STATUS_JSON = path.join(os.homedir(), '.claude', 'usage-status.json');

// rateLimitType → schema key expected by usage-core.js directRateLimit()
const _RL_KEY = { five_hour: 'five_hour', seven_day: 'seven_day' };

// Accumulate rate_limit_events from this process lifetime; flushed per-turn.
let _pendingRl = {};

function _flushRateLimits() {
  if (!Object.keys(_pendingRl).length) return;
  try {
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(_STATUS_JSON, 'utf-8')); } catch {}
    const raw = existing.raw ?? {};
    const rl = raw.rate_limits ?? {};
    for (const [k, v] of Object.entries(_pendingRl)) rl[k] = v;
    const payload = { _captured_at: Date.now() / 1000, raw: { ...raw, rate_limits: rl } };
    const dir = path.dirname(_STATUS_JSON);
    const tmp = path.join(dir, `.usage-status.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    fs.renameSync(tmp, _STATUS_JSON);
  } catch { /* non-fatal */ }
  _pendingRl = {};
}

function _captureRateLimitEvent(ev) {
  const info = ev.rate_limit_info;
  if (!info || !info.rateLimitType) return;
  const key = _RL_KEY[info.rateLimitType];
  if (!key) return;
  // rate_limit_event fires at request START (pre-turn). Flush the PREVIOUS
  // turn's accumulated data first (post-turn state), then store this new event.
  _flushRateLimits();
  _pendingRl[key] = {
    used_percentage: Math.round((info.utilization ?? 0) * 100 * 10) / 10,
    resets_at: info.resetsAt
      ? (info.resetsAt > 1e12 ? new Date(info.resetsAt).toISOString()
                               : new Date(info.resetsAt * 1000).toISOString())
      : undefined,
  };
}

// bare sonnet/opus/haiku 保留供舊 session 跨引擎過濾（bare `sonnet` 不被 /^claude-/ 涵蓋）；
// claude-sonnet-5 明列（雖 /^claude-/ 已涵蓋，列出較清楚）。防跨引擎 model carry-over（見 buildEngine 內濾）。
const CLAUDE_MODELS = new Set(['claude-sonnet-5', 'sonnet', 'opus', 'haiku', 'fable']);
// 預設與 fallback 鏈：sonnet -> opus -> haiku（順序為 owner 決策 2026-07-02）。
// 用 alias 而非完整 ID：alias = 「該家族最新版」，出新一代自動跟上。
const CLAUDE_MODEL_PRIORITY = ['sonnet', 'opus', 'haiku'];
const CODEX_UNSUPPORTED_MODELS = new Set(['gpt-5-codex']);
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

function isPathInside(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function expandHome(p, homeDir) {
  if (!p) return '';
  if (p === '~') return homeDir;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homeDir, p.slice(2));
  return p;
}

function expandConfiguredPath(p, homeDir) {
  if (!p) return '';
  const expanded = String(p).trim().replace(/%USERPROFILE%/gi, () => homeDir);
  return expandHome(expanded, homeDir);
}

function resolveConfiguredPath(p, homeDir) {
  const expanded = expandConfiguredPath(p, homeDir);
  return expanded ? path.resolve(expanded) : '';
}

function uniquePaths(paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    const resolved = p ? path.resolve(p) : '';
    const key = resolved.toLowerCase();
    if (!resolved || seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

// ── Authority bootstrap v2（agent_global_configs/plans/codex-ahr-bootstrap-gate-plan.md）──
// routing-derived 設定不再預組「請去讀這些檔」的指針文字（模型可能不照做），
// 改為注入當下由 host 實讀權威檔全文 + hash/timestamp 證據。手動設定
// {workspaceRoot, bootstrap}（legacy 指針格式，結尾 `\n---`）維持原樣支援。

export class CodexBootstrapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodexBootstrapError';
  }
}

function authorityPathKind(p) {
  const resolved = path.resolve(p || '');
  const base = path.basename(resolved).toLowerCase();
  const parent = path.basename(path.dirname(resolved)).toLowerCase();
  if (base === 'project_routing.md') return 'routing';
  if (base === 'claude.md' && parent === 'agent_global_configs') return 'global';
  if (base === 'claude.md') return 'project';
  return '';
}

function isCredentialLikePath(p) {
  const normalized = path.resolve(p || '').replace(/\//g, '\\').toLowerCase();
  const base = path.basename(normalized);
  return (
    base === '.env'
    || base.startsWith('.env.')
    || /^settings.*\.json$/i.test(base)
    || /\.(pem|key|p12|pfx)$/i.test(base)
    || /(^|[\\._-])(token|secret|password|credential)s?([\\._-]|$)/i.test(normalized)
  );
}

function assertAllowedAuthorityPath(p, root = '') {
  const resolved = path.resolve(p || '');
  if (!resolved || isCredentialLikePath(resolved)) {
    throw new CodexBootstrapError(`authority file path is not allowed: ${p}`);
  }
  const kind = authorityPathKind(resolved);
  if (!kind) {
    throw new CodexBootstrapError(`authority file must be PROJECT_ROUTING.md or CLAUDE.md: ${p}`);
  }
  if (kind === 'project' && root && !isPathInside(root, resolved)) {
    throw new CodexBootstrapError(`project authority file is outside workspace root: ${p}`);
  }
  return resolved;
}

function validateAuthorityChain(root, instructionPaths) {
  const paths = uniquePaths(instructionPaths).map((p) => assertAllowedAuthorityPath(p, root));
  const kinds = paths.map(authorityPathKind);
  if (kinds[0] !== 'routing') {
    throw new CodexBootstrapError(`authority chain must start with PROJECT_ROUTING.md: ${paths[0] || ''}`);
  }
  if (!kinds.includes('global')) {
    throw new CodexBootstrapError('authority chain is missing global CLAUDE.md');
  }
  if (!kinds.includes('project')) {
    throw new CodexBootstrapError('authority chain is missing project CLAUDE.md');
  }
  return paths;
}

// 嚴格讀權威檔：缺檔 / 非 UTF-8 / 含控制字元（\t\n\r 除外）一律 throw，由
// runEngine fail-closed 擋 thread。hash 算原始 bytes；文字僅剝 BOM，其餘不改寫。
function readAuthorityFile(p) {
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch {
    throw new CodexBootstrapError(`authority file missing or unreadable: ${p}`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new CodexBootstrapError(`authority file is not valid UTF-8: ${p}`);
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw new CodexBootstrapError(`authority file contains control characters: ${p}`);
  }
  return { text, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

function taskEvidenceAllowedRoots(root, homeDir) {
  return [
    root,
    path.join(homeDir, 'agent_global_configs'),
    path.join(homeDir, '.claude', 'projects'),
    path.join(homeDir, '.codex', 'skills'),
  ].map((p) => path.resolve(p));
}

function readTaskEvidenceFile(p, { root, homeDir }) {
  const resolved = resolveConfiguredPath(p, homeDir);
  const allowed = taskEvidenceAllowedRoots(root, homeDir).some((base) => isPathInside(base, resolved));
  if (!resolved || !allowed || isCredentialLikePath(resolved) || path.extname(resolved).toLowerCase() !== '.md') {
    throw new CodexBootstrapError(`task evidence file path is not allowed: ${p}`);
  }
  const file = readAuthorityFile(resolved);
  return { path: resolved, ...file };
}

function routeMatchesPrompt(route, prompt) {
  const haystack = String(prompt || '').toLocaleLowerCase();
  const all = Array.isArray(route?.matchAll) ? route.matchAll : [];
  const any = Array.isArray(route?.matchAny) ? route.matchAny : [];
  if (!all.length && !any.length) return false;
  if (all.some((term) => !haystack.includes(String(term).toLocaleLowerCase()))) return false;
  return !any.length || any.some((term) => haystack.includes(String(term).toLocaleLowerCase()));
}

function excerptMatchingLines(text, terms, contextLines = 0) {
  const lines = String(text || '').split(/\r?\n/);
  const needles = (Array.isArray(terms) ? terms : []).map((term) => String(term).toLocaleLowerCase());
  if (!needles.length) return [];
  const selected = new Set();
  const context = Math.max(0, Math.min(5, Number.parseInt(contextLines, 10) || 0));
  lines.forEach((line, index) => {
    const normalized = line.toLocaleLowerCase();
    if (!needles.some((term) => normalized.includes(term))) return;
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i += 1) {
      selected.add(i);
    }
  });
  return [...selected].sort((a, b) => a - b).map((index) => ({ line: index + 1, text: lines[index] }));
}

function loadTaskEvidence(root, prompt, routes, { homeDir }) {
  const matchedRoutes = (Array.isArray(routes) ? routes : []).filter((route) => routeMatchesPrompt(route, prompt));
  if (!matchedRoutes.length) return null;
  const files = [];
  for (const route of matchedRoutes) {
    if (!route?.id || !Array.isArray(route.sources) || !route.sources.length) {
      throw new CodexBootstrapError('matched task evidence route is missing id or sources');
    }
    for (const source of route.sources) {
      const file = readTaskEvidenceFile(source?.path, { root, homeDir });
      const excerpt = excerptMatchingLines(file.text, source?.terms, source?.contextLines);
      if (!excerpt.length) {
        throw new CodexBootstrapError(`task evidence terms did not match: ${file.path}`);
      }
      files.push({ routeId: route.id, path: file.path, sha256: file.sha256, excerpt });
    }
  }
  return { routeIds: matchedRoutes.map((route) => route.id), files };
}

function realPathTarget(p) {
  try {
    const real = (fs.realpathSync.native || fs.realpathSync)(p);
    const resolved = path.resolve(p);
    const realResolved = path.resolve(real);
    return resolved.toLowerCase() === realResolved.toLowerCase() ? '' : realResolved;
  } catch {
    return '';
  }
}

function addEntrypoint(out, kind, name, filePath) {
  if (!name || !filePath || isCredentialLikePath(filePath)) return;
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return;
  out.push({
    kind,
    name,
    path: resolved,
    target: realPathTarget(resolved) || undefined,
  });
}

function listDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function discoverCommandFiles(dir, kind) {
  const out = [];
  for (const entry of listDirSafe(dir)) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    const name = path.basename(entry.name, path.extname(entry.name));
    addEntrypoint(out, kind, name, path.join(dir, entry.name));
  }
  return out;
}

function discoverSkillDirs(dir, kind) {
  const out = [];
  for (const entry of listDirSafe(dir)) {
    if (entry.name.startsWith('.')) continue;
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    addEntrypoint(out, kind, entry.name, skillFile);
  }
  return out;
}

function uniqueEntrypoints(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const key = `${entry.kind}\0${entry.name.toLowerCase()}\0${entry.path.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function discoverBootstrapEntrypoints(root, { homeDir = os.homedir() } = {}) {
  const projectClaude = path.join(root, '.claude');
  const personalClaude = path.join(homeDir, '.claude');
  const codexSkills = path.join(homeDir, '.codex', 'skills');
  const entries = [
    ...discoverCommandFiles(path.join(projectClaude, 'commands'), 'project-command'),
    ...discoverSkillDirs(path.join(projectClaude, 'skills'), 'project-skill'),
    ...discoverCommandFiles(path.join(personalClaude, 'commands'), 'personal-command'),
    ...discoverSkillDirs(path.join(personalClaude, 'skills'), 'personal-skill'),
    ...discoverSkillDirs(codexSkills, 'codex-skill'),
    ...discoverSkillDirs(path.join(codexSkills, '.system'), 'codex-system-skill'),
  ];
  const order = new Map([
    ['project-command', 1],
    ['project-skill', 2],
    ['personal-command', 3],
    ['personal-skill', 4],
    ['codex-skill', 5],
    ['codex-system-skill', 6],
  ]);
  return uniqueEntrypoints(entries).sort((a, b) => {
    const byKind = (order.get(a.kind) || 99) - (order.get(b.kind) || 99);
    if (byKind) return byKind;
    return a.name.localeCompare(b.name);
  });
}

function formatEntrypointTarget(entry) {
  const target = entry.target ? ` (target: \`${entry.target}\`)` : '';
  return `\`${entry.path}\`${target}`;
}

function appendEntrypointSection(lines, entries) {
  const commandEntries = entries.filter((entry) => entry.kind.endsWith('-command'));
  lines.push(
    '## Discovered Command Entrypoints',
    '',
    'AHR discovered these command entrypoints before this prompt. This is a routing index only; their bodies were not loaded. When a task matches an entry, read the listed file directly instead of searching for it.',
    '',
    'Skill directories are intentionally not enumerated here; use the loaded instruction files and session skill routing when the task matches a skill.',
    '',
  );
  if (!commandEntries.length) {
    lines.push('(none)', '');
    return;
  }
  const labels = {
    'project-command': 'Project commands',
    'personal-command': 'Personal commands',
  };
  let current = '';
  for (const entry of commandEntries) {
    if (entry.kind !== current) {
      current = entry.kind;
      lines.push(`### ${labels[current] || current}`, '');
    }
    lines.push(`- \`/${entry.name}\` -> ${formatEntrypointTarget(entry)}`);
  }
  lines.push('');
}

// v2 注入文本：以帶 nonce 的唯一哨兵收尾。嵌入的指令檔內容含 `---` 水平線與
// ``` 圍欄，legacy `\n---\n\n` 終止符必誤切，故 ingest 對 v2 只認同 nonce 的
// end 哨兵（見 ingest.js stripCodexBootstrap）。
function buildAuthorityBootstrap(root, instructionPaths, opts = {}) {
  const paths = validateAuthorityChain(root, instructionPaths);
  if (!paths.length) return null;
  const nonce = crypto.randomUUID();
  const loadedAt = new Date().toISOString();
  const files = paths.map((p) => ({ path: p, ...readAuthorityFile(p) }));
  const entrypoints = discoverBootstrapEntrypoints(root, { homeDir: opts.homeDir });
  const lines = [
    '# Codex workspace bootstrap',
    `<!-- ahr:codex-workspace-bootstrap:v2 nonce=${nonce} -->`,
    '',
    'The following instruction files were already loaded by AHR before this prompt.',
    'Treat them as authority sources for this session.',
    'Do not re-open or re-search for these files. Act on the loaded content first; only search for task-specific sources that are not included below.',
    '',
    '## Loaded Authority Files',
    '',
  ];
  files.forEach((f, i) => {
    lines.push(`${i + 1}. \`${f.path}\``, `   sha256: ${f.sha256}`, `   loaded_at: ${loadedAt}`);
  });
  lines.push('');
  appendEntrypointSection(lines, entrypoints);
  lines.push('', '## File Contents', '');
  files.forEach((f, i) => {
    lines.push(
      `### \`${f.path}\``,
      '',
      `<!-- ahr:authority-file:start index=${i + 1} nonce=${nonce} -->`,
      f.text,
      `<!-- ahr:authority-file:end index=${i + 1} nonce=${nonce} -->`,
      '',
    );
  });
  lines.push(`<!-- ahr:codex-workspace-bootstrap:end nonce=${nonce} -->`);
  return {
    text: lines.join('\n'),
    evidence: {
      workspaceRoot: root,
      files: files.map((f) => ({ path: f.path, sha256: f.sha256 })),
      entrypoints,
      loadedAt,
      authority_loaded: true,
      nonce,
    },
  };
}

function routeLineToConfig(line, { homeDir, routingPath, globalInstructionPath }) {
  const m = line.match(/^\s*-\s+`([^`]+)`\s*->\s*`([^`]+)`/);
  if (!m) return null;
  const root = resolveConfiguredPath(m[1], homeDir);
  const projectInstruction = resolveConfiguredPath(m[2], homeDir);
  if (!root || !projectInstruction) return null;
  return { root, instructionPaths: [routingPath, globalInstructionPath, projectInstruction] };
}

function bulletPathFromLine(line) {
  const m = String(line || '').match(/^\s*-\s+`([^`]+)`/);
  return m ? m[1] : '';
}

function routeConfigsFromBullets(lines, { homeDir, routingPath, globalInstructionPath }) {
  const roots = [];
  const instructionFiles = [];
  for (const line of lines) {
    const rawPath = bulletPathFromLine(line);
    if (!rawPath) continue;
    const normalized = rawPath.replace(/\//g, '\\').toLowerCase();
    const resolved = resolveConfiguredPath(rawPath, homeDir);
    if (!resolved) continue;
    if (normalized.endsWith('\\claude.md')) {
      instructionFiles.push(resolved);
    } else if (!path.extname(resolved)) {
      roots.push(resolved);
    }
  }
  return roots
    .map((root) => {
      const projectInstruction = instructionFiles.find((p) => isPathInside(root, p));
      if (!root || !projectInstruction) return null;
      return { root, instructionPaths: [routingPath, globalInstructionPath, projectInstruction] };
    })
    .filter(Boolean);
}

function globalInstructionPathFromRouting(text, homeDir) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*\d+\.\s+`([^`]+)`/);
    if (!m) continue;
    const candidate = m[1].replace(/\//g, '\\').toLowerCase();
    if (candidate.endsWith('\\agent_global_configs\\claude.md')) {
      return resolveConfiguredPath(m[1], homeDir);
    }
  }
  return path.join(homeDir, 'agent_global_configs', 'CLAUDE.md');
}

function loadRoutingWorkspaceConfigs(routingPath, { homeDir }) {
  const resolvedRoutingPath = resolveConfiguredPath(routingPath, homeDir);
  if (!resolvedRoutingPath) throw new CodexBootstrapError('routingPath is required for Codex authority bootstrap');
  assertAllowedAuthorityPath(resolvedRoutingPath);
  const { text: raw } = readAuthorityFile(resolvedRoutingPath);
  const globalInstructionPath = globalInstructionPathFromRouting(raw, homeDir);
  const lines = String(raw).split(/\r?\n/);
  const configs = lines
    .map((line) => routeLineToConfig(line, {
      homeDir,
      routingPath: resolvedRoutingPath,
      globalInstructionPath,
    }))
    .filter(Boolean);
  const routed = configs.length ? configs : routeConfigsFromBullets(lines, {
    homeDir,
    routingPath: resolvedRoutingPath,
    globalInstructionPath,
  });
  if (!routed.length) {
    throw new CodexBootstrapError(`routing file has no workspace authority entries: ${resolvedRoutingPath}`);
  }
  return routed;
}

function loadCodexWorkspaceConfigs({ homeDir = os.homedir(), configPath } = {}) {
  const envConfigPath = process.env.AHR_CODEX_BOOTSTRAP_CONFIG || '';
  const defaultConfigPath = path.join(codexBootstrapDir, 'codex-bootstrap.local.json');
  const file = configPath || envConfigPath || defaultConfigPath;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    if (!configPath && !envConfigPath) {
      return loadRoutingWorkspaceConfigs(
        path.join(homeDir, 'agent_global_configs', 'PROJECT_ROUTING.md'),
        { homeDir },
      );
    }
    if (envConfigPath) {
      throw new CodexBootstrapError(`Codex bootstrap config missing or unreadable: ${file}`);
    }
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CodexBootstrapError(`Codex bootstrap config is not valid JSON: ${file}`);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  for (const entry of list) {
    if (entry && typeof entry.routingPath === 'string') {
      out.push(...loadRoutingWorkspaceConfigs(entry.routingPath, { homeDir }).map((cfg) => ({
        ...cfg,
        taskEvidenceRoutes: Array.isArray(entry.taskEvidenceRoutes) ? entry.taskEvidenceRoutes : [],
      })));
      continue;
    }
    out.push({
      root: resolveConfiguredPath(entry && entry.workspaceRoot, homeDir),
      bootstrap: entry && typeof entry.bootstrap === 'string' ? entry.bootstrap : '',
      taskEvidenceRoutes: Array.isArray(entry?.taskEvidenceRoutes) ? entry.taskEvidenceRoutes : [],
    });
  }
  return out.filter((e) => e.root && (e.bootstrap || (e.instructionPaths && e.instructionPaths.length)));
}

function codexWorkspaceConfig(cwd, opts = {}) {
  if (!cwd) return null;
  for (const cfg of loadCodexWorkspaceConfigs(opts)) {
    if (isPathInside(cfg.root, cwd)) return cfg;
  }
  return null;
}

export function codexBootstrapForCwd(cwd, opts = {}) {
  const cfg = codexWorkspaceConfig(cwd, opts);
  if (!cfg) return null;
  if (cfg.instructionPaths) return buildAuthorityBootstrap(cfg.root, cfg.instructionPaths, {
    ...opts,
    taskEvidenceRoutes: cfg.taskEvidenceRoutes,
  });
  return cfg.bootstrap ? { text: cfg.bootstrap, evidence: null } : null;
}

export function taskEvidenceForCwd(cwd, prompt, opts = {}) {
  const cfg = codexWorkspaceConfig(cwd, opts);
  if (!cfg) return null;
  const evidence = loadTaskEvidence(cfg.root, prompt, cfg.taskEvidenceRoutes, {
    homeDir: opts.homeDir || os.homedir(),
  });
  if (!evidence) return null;
  const candidates = evidence.files;
  if (opts.filterFiles) evidence.files = opts.filterFiles(evidence.files);
  const reused = candidates.filter(file => !evidence.files.includes(file));
  const lines = [
    '# AHR task evidence',
    '<!-- ahr:task-evidence:start -->',
    '',
    'AHR selected these excerpts mechanically from the current user message. Treat them as existing project evidence; do not replace them with generic assumptions.',
    '',
    `Matched routes: ${evidence.routeIds.map((id) => `\`${id}\``).join(', ')}`,
    '',
  ];
  if (reused.length) {
    lines.push('Previously supplied evidence: reuse it if still present. If compaction removed it, read the cited source before relying on it.');
    for (const file of [...new Map(reused.map(f => [f.path + f.sha256, f])).values()]) {
      lines.push(`- ${file.path} (sha256: ${file.sha256})`);
    }
    lines.push('');
  }
  let excerptBudget = 10_000;
  let truncated = false;
  evidence.files.forEach((file) => {
    const excerpt = [];
    let omitted = false;
    for (const item of file.excerpt) {
      const line = `${item.line}: ${item.text}`;
      if (line.length + 1 > excerptBudget) { omitted = true; truncated = true; continue; }
      excerpt.push(line);
      excerptBudget -= line.length + 1;
    }
    lines.push(
      `## \`${file.path}\``,
      '',
      `sha256: ${file.sha256}`,
      '',
      '```text',
      ...excerpt,
      '```',
      ...(omitted ? ['Additional matching lines omitted to fit the evidence budget. Read the cited source as needed; do not assume omitted evidence was included.'] : []),
      '',
    );
  });
  lines.push('<!-- ahr:task-evidence:end -->');
  const text = lines.join('\n');
  if (text.length > 16_000) throw new CodexBootstrapError('task evidence source references exceed the 16000-character budget');
  return { text, evidence, truncated };
}

export function codexWorkspaceBootstrap(cwd, opts = {}) {
  const built = codexBootstrapForCwd(cwd, opts);
  return built ? built.text : '';
}

export function codexPromptForSession(session, prompt, opts = {}) {
  const built = codexBootstrapForCwd(session?.cwd, opts);
  const taskEvidence = taskEvidenceForCwd(session?.cwd, prompt, opts);
  return [built?.text, taskEvidence?.text, prompt].filter(Boolean).join('\n\n');
}

export const CLAUDE_DEFAULT_MODEL = CLAUDE_MODEL_PRIORITY[0];

export function normalizedModelArg(engine, model) {
  const raw = model && model !== 'default' ? String(model) : null;
  if (engine === 'codex') {
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (CLAUDE_MODELS.has(lower) || /^claude-/i.test(raw)) return null;
    if (CODEX_UNSUPPORTED_MODELS.has(lower)) return null;
    return raw;
  }
  if (!raw || /^gpt-/i.test(raw)) return CLAUDE_DEFAULT_MODEL;
  return raw;
}

export function normalizedEffortArg(engine, effort) {
  const raw = effort && effort !== 'default' ? String(effort).trim().toLowerCase() : null;
  if (!raw) return null;
  if (engine === 'codex') return CODEX_EFFORTS.has(raw) ? raw : null;
  return CLAUDE_EFFORTS.has(raw) ? raw : null;
}

export function claudeModelFallbackArgs(modelArg) {
  const current = String(modelArg || '').toLowerCase();
  const idx = CLAUDE_MODEL_PRIORITY.indexOf(current);
  const next = idx >= 0 ? CLAUDE_MODEL_PRIORITY[idx + 1] : CLAUDE_MODEL_PRIORITY[0];
  return next ? ['--fallback-model', next] : [];
}

export function claudeModelAttemptChain(modelArg) {
  if (!modelArg) return [null];
  const raw = String(modelArg);
  const idx = CLAUDE_MODEL_PRIORITY.indexOf(raw.toLowerCase());
  return idx >= 0
    ? CLAUDE_MODEL_PRIORITY.slice(idx)
    : [raw, ...CLAUDE_MODEL_PRIORITY.filter(model => model !== raw.toLowerCase())];
}

export function isClaudeModelStartupFailure(reason) {
  const text = String(reason || '').toLowerCase();
  return /\bmodel\b/.test(text) && (
    /not available|not exist|does not exist|not found|no access|not have access|do not have access/.test(text) ||
    /overloaded|unavailable|selected model|fallback model/.test(text)
  );
}

export function isClaudeTransientUpstreamFailure(reason) {
  const text = String(reason || '').toLowerCase();
  return (
    /\b(?:api|http|status|status code|error)\D{0,24}(?:500|502|503|504|529)\b/.test(text) ||
    /\b(?:500|502|503|504|529)\D{0,24}(?:api|http|error|bad gateway|unavailable|timeout)\b/.test(text) ||
    /internal server error|bad gateway|service unavailable|gateway timeout|overloaded_error/.test(text)
  );
}

export function isClaudeRetryableStartupFailure(reason) {
  return isClaudeModelStartupFailure(reason) || isClaudeTransientUpstreamFailure(reason);
}

const AUTH_TEXT_RE = new RegExp(
  [
    'oauth session expired',
    'failed to authenticate',
    'could not be refreshed',
    'authentication_error',
    'invalid api key',
    'please run[^\\n]{0,20}/login',
    '\\bnot logged in\\b',
    '\\blog ?in (?:again|to continue)\\b',
  ].join('|'),
  'i',
);

export function detectAuthFailure(text) {
  return AUTH_TEXT_RE.test(String(text || ''));
}

export function verifyClaudeAuth({ timeoutMs = 10_000 } = {}) {
  return new Promise(resolve => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    let proc;
    try {
      proc = spawnCli('claude', ['auth', 'status', '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ loggedIn: null, error: String(e && e.message || e) });
    }
    let out = '';
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killTree(proc);
      done({ loggedIn: null, error: 'timeout' });
    }, timeoutMs);
    if (timer.unref) timer.unref();
    proc.stdout.on('data', d => { out = (out + d.toString()).slice(0, 8000); });
    proc.stderr.on('data', () => {});
    proc.on('error', e => done({ loggedIn: null, error: String(e && e.message || e) }));
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        done({
          loggedIn: typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : null,
          authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : null,
        });
      } catch {
        done({ loggedIn: null, error: 'unparseable' });
      }
    });
  });
}

const LIMIT_TEXT_RE = new RegExp(
  [
    "you'?ve hit your [^\\n]{0,60}limit",
    'usage limit reached',
    '\\b(?:session|weekly|usage|rate|5-hour|7-day)[ -]limit\\b[^\\n]{0,40}(?:reached|hit|exceeded)',
    'rate[ -]?limited',
  ].join('|'),
  'i',
);

export function detectUsageLimit(text) {
  return LIMIT_TEXT_RE.test(String(text || ''));
}

const MONTHS3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function parseLimitResetMs(text, now = Date.now()) {
  const s = String(text || '');
  const mEpoch = s.match(/limit reached\|(\d{10,13})/i);
  if (mEpoch) {
    const n = Number(mEpoch[1]);
    return n > 1e12 ? n : n * 1000;
  }
  const base = new Date(now);
  const mClock = s.match(/(?:resets?|try again)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  const clockParts = mClock
    ? {
        hour: (Number(mClock[1]) % 12) + (/pm/i.test(mClock[3]) ? 12 : 0),
        minute: mClock[2] ? Number(mClock[2]) : 0,
      }
    : null;
  const mMonth = s.match(/resets?\s+(?:at\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})\b/);
  if (mMonth) {
    const mo = MONTHS3.indexOf(mMonth[1].slice(0, 3).toLowerCase());
    if (mo >= 0) {
      const d = new Date(base.getFullYear(), mo, Number(mMonth[2]),
        clockParts ? clockParts.hour : 0, clockParts ? clockParts.minute : 0, 0, 0);
      if (d.getTime() <= now) d.setFullYear(d.getFullYear() + 1);
      return d.getTime();
    }
  }
  if (clockParts) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(),
      clockParts.hour, clockParts.minute, 0, 0);
    while (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const mRel = s.match(/try again in\s+(?:(\d+)\s*h(?:ou)?rs?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i);
  if (mRel && (mRel[1] || mRel[2])) {
    return now + (Number(mRel[1] || 0) * 3600 + Number(mRel[2] || 0) * 60) * 1000;
  }
  return null;
}

export function classifyRunFailure({ usedNativeResume, sawStreamEvent, texts, errorText = '', now = Date.now() }) {
  const joined = String(texts || '');
  if (detectUsageLimit(joined)) {
    return { kind: 'limit', resetAt: parseLimitResetMs(joined, now) };
  }
  if (detectAuthFailure(errorText)) return { kind: 'auth' };
  const pointerDead = /no conversation found|session (?:id )?(?:not found|does not exist)|invalid session id/i.test(joined);
  if (usedNativeResume && (pointerDead || !sawStreamEvent)) {
    return { kind: 'resume-failed' };
  }
  return { kind: 'other' };
}

let turnEndHook = null;
export function setTurnEndHook(fn) {
  turnEndHook = typeof fn === 'function' ? fn : null;
}
function emitTurnEnd(session, info) {
  if (!turnEndHook) return;
  try {
    turnEndHook(session, info);
  } catch (e) {
    console.error('[agent-hub-remote] turn-end hook 失敗', e.message);
  }
}

const AUTO_RESUME_TIMERS = new Map();
const AUTO_RESUME_MAX_ATTEMPTS = 3;
const AUTO_RESUME_GRACE_MS = 90_000;
const AUTO_RESUME_FALLBACK_MS = 30 * 60_000;
const AUTO_RESUME_PROMPT =
  '(自動接續) 稍早因用量上限中斷，額度已重置。請從中斷處繼續，完成上一則使用者訊息的回覆；若已完整回覆，簡短說明目前狀態即可。';

export function cancelAutoResume(session, { persist = true } = {}) {
  if (!session) return;
  const t = AUTO_RESUME_TIMERS.get(session.id);
  if (t) {
    clearTimeout(t);
    AUTO_RESUME_TIMERS.delete(session.id);
  }
  if (session.autoResume) {
    session.autoResume = null;
    if (persist) persistIndex();
  }
}

export function armAutoResume(session, broadcast) {
  const info = session.autoResume;
  if (!info || !info.at) return false;
  const prev = AUTO_RESUME_TIMERS.get(session.id);
  if (prev) clearTimeout(prev);
  const delay = Math.min(Math.max(0, info.at - Date.now()), 2 ** 31 - 1);
  const timer = setTimeout(() => {
    AUTO_RESUME_TIMERS.delete(session.id);
    fireAutoResume(session, broadcast);
  }, delay);
  if (timer.unref) timer.unref();
  AUTO_RESUME_TIMERS.set(session.id, timer);
  return true;
}

function fireAutoResume(session, broadcast) {
  if (!sessions.has(session.id) || !session.autoResume) return;
  session.autoResume = null;
  persistIndex();
  if (session.proc || session.status === 'running' || session.status === 'starting') return;
  const ts = appendMsg(session, { role: 'user', kind: 'auto-resume', text: AUTO_RESUME_PROMPT });
  broadcast({ type: 'msg', id: session.id, ts, role: 'user', kind: 'auto-resume', text: AUTO_RESUME_PROMPT });
  broadcast({ type: 'sessions', data: sessionsArr() });
  runEngine(session, AUTO_RESUME_PROMPT, { broadcast, isResumeTap: true })
    .catch(e => console.error('[agent-hub-remote] auto-resume runEngine 失敗', e));
}

export function armPersistedAutoResumes(broadcast) {
  let armed = 0;
  let stagger = 0;
  for (const s of sessions.values()) {
    if (!s.autoResume || !s.autoResume.at) continue;
    s._limitAttempts = s.autoResume.attempts || 1;
    if (s.autoResume.at <= Date.now()) {
      s.autoResume = { ...s.autoResume, at: Date.now() + 5_000 + stagger * 5_000 };
      stagger++;
    }
    if (armAutoResume(s, broadcast)) armed++;
  }
  return armed;
}

function handleUsageLimitFailure(session, broadcast, engine, resetAt) {
  session.status = 'limited';
  session._limitAttempts = (session._limitAttempts || 0) + 1;
  const engineName = engine === 'codex' ? 'Codex' : 'Claude';
  if (session._limitAttempts > AUTO_RESUME_MAX_ATTEMPTS) {
    cancelAutoResume(session, { persist: false });
    const text = `⏸ ${engineName} 用量仍受限（已自動重試 ${AUTO_RESUME_MAX_ATTEMPTS} 次），暫停自動接續。額度恢復後直接再送訊息即可原生續接，脈絡完整保留。`;
    const ts = appendMsg(session, { role: 'system', kind: 'limit', engine, text });
    broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'limit', text, engine });
    persistIndex();
    return;
  }
  const at = (resetAt && resetAt > Date.now() ? resetAt : Date.now() + AUTO_RESUME_FALLBACK_MS)
    + AUTO_RESUME_GRACE_MS;
  session.autoResume = {
    at,
    engine,
    reason: 'usage-limit',
    attempts: session._limitAttempts,
    setAt: Date.now(),
  };
  persistIndex();
  armAutoResume(session, broadcast);
  const hhmm = new Date(at).toTimeString().slice(0, 5);
  const text = `⏳ ${engineName} 用量已達上限——對話脈絡完整保留，${hhmm} 將自動接續（也可屆時直接再送訊息，會原生續接同一條 thread）。`;
  const ts = appendMsg(session, { role: 'system', kind: 'limit', engine, text });
  broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'limit', text, engine });
}

function handleAuthFailure(session, broadcast, engine) {
  session.status = 'auth-expired';
  cancelAutoResume(session, { persist: false });
  const engineName = engine === 'codex' ? 'Codex' : 'Claude';
  const text = engine === 'codex'
    ? `🔑 Codex 登入階段已過期且無法自動更新——對話紀錄完整保留。`
      + `此處尚未支援遠端重新登入，請到執行 AHR 的主機上執行 codex 登入，`
      + `完成後直接再送訊息即可原生續接同一條 thread。`
      + `（本輪不自動重試：憑證未更換前重試只會再失敗一次。）`
    : `🔑 ${engineName} 登入階段已過期且無法自動更新——對話紀錄完整保留。`
      + `重新登入後直接再送訊息即可原生續接同一條 thread。`
      + `（本輪不自動重試：憑證未更換前重試只會再失敗一次。）`;
  const ts = appendMsg(session, { role: 'system', kind: 'auth', engine, text });
  broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'auth', text, engine });
  persistIndex();
}

export function killTree(proc) {
  if (!proc || proc.killed || proc.exitCode != null) return false;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } else {
    proc.kill('SIGTERM');
  }
  return true;
}

function claudeUserLine(text) {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: String(text || '') }],
    },
    parent_tool_use_id: null,
  }) + '\n';
}

export function canAcceptLiveInput(session) {
  return !!(
    session &&
    session.proc &&
    session._activeEngine === 'claude' &&
    session._acceptsLiveInput &&
    session.proc.stdin &&
    session.proc.stdin.writable
  );
}

export function writeLiveInput(session, text) {
  if (!canAcceptLiveInput(session)) return false;
  session.proc.stdin.write(claudeUserLine(text), 'utf8');
  session._contextObserver?.record({ stage: 'live_input', prompt_chars: String(text).length });
  return true;
}

function pct(v) {
  return typeof v === 'number' && isFinite(v) ? `${v}%` : null;
}

function fmtTokens(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatUsageSnapshot(data, turnUsage = null) {
  if (!data || !data.ok) return null;
  const parts = [];
  const turnText = formatTurnUsageLine(turnUsage);
  if (turnText) parts.push(turnText);
  const c = data.claude || {};
  const q = c.quota || {};

  const sessionPct = pct(q.session_pct);
  const weeklyPct = pct(q.weekly_pct);
  if (q.available && (sessionPct || weeklyPct)) {
    parts.push(`Claude ${[sessionPct && `5h ${sessionPct}`, weeklyPct && `7d ${weeklyPct}`].filter(Boolean).join(' / ')}`);
  } else {
    const today = c.today || {};
    if (today.turns != null) {
      const toks = fmtTokens(today.tokens);
      const cost = typeof today.cost === 'number' ? `$${today.cost.toFixed(2)}` : null;
      parts.push(`Claude today ${[toks, cost, `${today.turns}t`].filter(Boolean).join(' / ')}`);
    }
  }

  const cx = data.codex || {};
  const cxQuota = cx.quota || cx;
  const primary = pct(cxQuota.primary_pct);
  const secondary = pct(cxQuota.secondary_pct);
  if (cxQuota.available && (primary || secondary)) {
    parts.push(`Codex ${[primary && `primary ${primary}`, secondary && `secondary ${secondary}`].filter(Boolean).join(' / ')}`);
  }

  return parts.length ? `Usage: ${parts.join(' | ')}` : null;
}

function appendUsageSnapshot(session, engine, broadcast, turnUsage = null) {
  let text = null;
  try {
    text = formatUsageSnapshot(getUsage({ force: true }), turnUsage);
  } catch (e) {
    console.error('[agent-hub-remote] usage snapshot failed', e.message);
  }
  broadcast({ type: 'usage_update' });
  if (!text) return;
  const key = turnUsage ? usageEntryKey(turnUsage) : null;
  if (key && loadMessages(session.id, 0).some(m => m.kind === 'usage' && m.usageKey === key)) return;
  const ts = appendMsg(session, { role: 'system', kind: 'usage', engine, text, usageKey: key });
  broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'usage', text, engine, usageKey: key });
}

function collectTurns(messages) {
  const turns = [];
  for (const m of messages) {
    if (m.role === 'system' && (m.kind === 'compact' || m.kind === 'rewind') && m.context) {
      turns.push({ role: 'context', text: String(m.context).trim() });
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!m.text || !String(m.text).trim()) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.text += '\n\n' + m.text;
    else turns.push({ role: m.role, text: String(m.text).trim() });
  }
  return turns;
}

export function bridgeMessagesForSession(session) {
  const loaded = loadMessages(session.id, 0);
  return loaded.length ? loaded : session.messages;
}

async function buildBridge(session, fromEngine, toEngine, { requireComplete = false } = {}) {
  const msgs = bridgeMessagesForSession(session);
  const priorRaw = msgs.length && msgs[msgs.length - 1].role === 'user'
    ? msgs.slice(0, -1) : msgs;
  const prior = requireComplete ? priorRaw : priorRaw.flatMap(m => m?.role === 'user' && String(m.text || '').trim()
    ? [{ ...m, text: String(m.text).trim() }] : projectContextMessages([m]));
  const turns = collectTurns(prior);
  if (requireComplete && !turns.length) {
    throw new Error('Automatic rollover blocked: prior conversation is unavailable. Restore the history or explicitly provide reviewed continuation context before retrying.');
  }
  if (!turns.length) return { preamble: '', note: null };

  const flat = turns.map(t => {
    const label = t.role === 'context'
      ? 'Context summary'
      : (t.role === 'user' ? 'User' : (fromEngine === 'codex' ? 'Codex' : 'Claude'));
    return `${label}: ${t.text}`;
  }).join('\n\n');

  const context = buildBridgeContext({ messages: prior, fullText: flat, stateDir: STATE_DIR, requireComplete });
  const body = context.text;
  const how = context.omitted ? '近期脈絡與可讀回的轉錄快照' : '全文轉錄';

  const preamble =
    `[以下是這條對話先前在 ${fromEngine === 'codex' ? 'Codex' : 'Claude'} 的脈絡（${how}），` +
    `供你接手；請依使用者接下來的訊息回應，勿複述本段]\n${body}\n\n---\n\n[使用者的新訊息]\n`;
  const note = `↪ 已帶入前文脈絡（${fromEngine}→${toEngine}，${how}）`;
  return { preamble, note };
}

function pendingContextPreamble(ctx) {
  if (!ctx || !ctx.text) return '';
  const mode = ctx.mode === 'summary' || ctx.mode === 'compact' ? 'summary' : 'transcript';
  return `[The previous conversation has been reset. Use this ${mode} as the only prior context for the new engine thread; do not quote it back unless needed.]\n` +
    `${ctx.text}\n\n---\n\n[User's new message]\n`;
}

export function continuationPlan(session, { engine, hasHistory, confirmBridge = false, pendingContext = false }) {
  const sameEngine = session.lastEngine === engine;
  const canNativeResume = sameEngine && !!session.engineRefs?.[engine] && !session._resumeFailed;
  if (pendingContext || !sameEngine || !hasHistory || canNativeResume) {
    return { resume: canNativeResume, forceBridge: false, gate: false };
  }
  if (session._resumeFailed && !confirmBridge) {
    return { resume: false, forceBridge: false, gate: true };
  }
  return { resume: false, forceBridge: true, gate: false };
}

export function claudeSessionIdentityArgs(session, nativeResumeId, { sessionIdOverride = null } = {}) {
  if (nativeResumeId) return { args: ['--resume', nativeResumeId], expectedSessionId: null };
  const sessionId = sessionIdOverride || session.id;
  return { args: ['--session-id', sessionId], expectedSessionId: sessionId };
}

export function shouldStartFreshClaudeThread({ engine, pendingContext = false, prevEngine = null, forceBridge = false }) {
  return engine === 'claude' && !!(pendingContext || forceBridge || (prevEngine && prevEngine !== engine));
}

export function claimClaudeNativeSession(session, nativeId) {
  if (!session || !nativeId) return { changed: false, removedTwin: false };
  session.engineRefs ||= { claude: null, codex: null };
  const previous = session.engineRefs.claude || null;
  session.engineRefs.claude = nativeId;
  let removedTwin = false;
  let movedMessages = 0;
  const nativeTwin = sessions.get(nativeId);
  if (nativeTwin && nativeTwin.id !== session.id && nativeTwin.source === 'native' && nativeTwin.agentType === 'claude') {
    movedMessages = absorbHubMessages(nativeId, session);
    removedTwin = removeSession(nativeId, { deleteLog: true });
  }
  return { changed: previous !== nativeId, previous, current: nativeId, removedTwin, movedMessages };
}

export async function runEngine(session, userText, opts) {
  const { broadcast, isResumeTap = false, forceBridge = false } = opts;
  const engine = session.agentType === 'codex' ? 'codex' : 'claude';
  cancelAutoResume(session, { persist: false });
  const danger = !!session.autoAllow;

  let nativeResumeId = null;
  let preamble = '';
  let claudeSessionIdOverride = null;
  let budgetRollover = false;
  const pendingContext = session.pendingContext || null;
  const prevEngine = pendingContext ? null : session.lastEngine;
  session._usedNativeResume = false;
  delete session._expectedClaudeSessionId;

  try {
  if (pendingContext) {
    preamble = pendingContextPreamble(pendingContext);
    session.pendingContext = null;
    session.engineRefs = { claude: null, codex: null };
    session.lastEngine = null;
    persistIndex();
  } else if (prevEngine && prevEngine !== engine) {
    const { preamble: pre, note } = await buildBridge(session, prevEngine, engine);
    preamble = pre;
    if (note) {
      const ts = appendMsg(session, { role: 'system', text: note });
      broadcast({ type: 'msg', id: session.id, ts, text: note, engine });
    }
  } else if (isResumeTap && session.engineRefs[engine] && !forceBridge) {
    if (await nativeHistoryWithinBudget(session, engine, session.engineRefs[engine])) {
      nativeResumeId = session.engineRefs[engine];
      session._usedNativeResume = true;
    } else {
      const { preamble: pre } = await buildBridge(session, engine, engine, { requireComplete: true });
      preamble = pre;
      budgetRollover = true;
    }
  } else if (forceBridge) {
    const { preamble: pre } = await buildBridge(session, engine, engine);
    preamble = pre;
    if (pre) {
      const note = '↪ 原生續接無法使用，已用前文脈絡（bridge）接續這條對話';
      const ts = appendMsg(session, { role: 'system', text: note });
      broadcast({ type: 'msg', id: session.id, ts, text: note, engine });
    }
    session.engineRefs[engine] = null;
    session._resumeFailed = false;
  }
  } catch (err) {
    session.status = 'error';
    const text = `Context handoff could not be prepared: ${err.message}`;
    const ts = appendMsg(session, { role: 'error', engine, text });
    persistIndex();
    broadcast({ type: 'msg', id: session.id, ts, text, error: true, engine });
    broadcast({ type: 'sessions', data: sessionsArr() });
    broadcast({ type: 'done', id: session.id, ts: Date.now(), code: -1 });
    emitTurnEnd(session, { code: -1, engine, cancelled: false, broadcast });
    return;
  }
  if (shouldStartFreshClaudeThread({ engine, pendingContext: !!pendingContext, prevEngine, forceBridge: forceBridge || budgetRollover })) {
    claudeSessionIdOverride = crypto.randomUUID();
  }

  session.status = 'running';
  session.lastEngine = engine;
  const autoCommitBaseline = engine === 'codex' ? captureGitSnapshot(session.cwd) : null;
  broadcast({ type: 'sessions', data: sessionsArr() });

  let fullPrompt = preamble + userText;
  let evidenceChars = 0;
  let evidenceOmitted = 0;
  let evidenceCache = null;
  try {
    const epoch = await evidenceContextEpoch(session, engine, nativeResumeId);
    evidenceCache = filterEvidenceFiles([], { epoch, cache: session._taskEvidenceCache }).nextCache;
    const taskEvidence = taskEvidenceForCwd(session.cwd, userText, {
      filterFiles(files) {
        const filtered = filterEvidenceFiles(files, { epoch, cache: session._taskEvidenceCache });
        evidenceCache = filtered.nextCache;
        evidenceOmitted = filtered.omittedCount;
        return filtered.files;
      },
    });
    if (taskEvidence) {
      evidenceChars = taskEvidence.text.length;
      fullPrompt = `${taskEvidence.text}\n\n${fullPrompt}`;
      if (taskEvidence.truncated) evidenceCache = null;
    }
  } catch (err) {
    session.status = 'error';
    const text = `⚠️ AHR task evidence 載入失敗，已擋下啟動：${err.message}`;
    const ts = appendMsg(session, { role: 'error', engine, text });
    broadcast({ type: 'msg', id: session.id, ts, text, error: true, engine });
    broadcast({ type: 'sessions', data: sessionsArr() });
    broadcast({ type: 'done', id: session.id, ts: Date.now(), code: -1 });
    emitTurnEnd(session, { code: -1, engine, cancelled: false, broadcast });
    return;
  }
  let enginePrompt = fullPrompt;
  if (engine === 'codex' && !nativeResumeId) {
    let built = null;
    try {
      built = codexBootstrapForCwd(session.cwd);
    } catch (err) {
      session.status = 'error';
      const text = `⚠️ Codex authority bootstrap 失敗，已擋下啟動：${err.message}`;
      const ts = appendMsg(session, { role: 'error', engine, text });
      broadcast({ type: 'msg', id: session.id, ts, text, error: true, engine });
      broadcast({ type: 'sessions', data: sessionsArr() });
      broadcast({ type: 'done', id: session.id, ts: Date.now(), code: -1 });
      emitTurnEnd(session, { code: -1, engine, cancelled: false, broadcast });
      return;
    }
    if (built) {
      enginePrompt = `${built.text}\n\n${fullPrompt}`;
      if (built.evidence) {
        session.codexBootstrapEvidence = built.evidence;
        persistIndex();
      }
    }
  }
  const spawnEnv = { ...process.env };
  delete spawnEnv.ANTHROPIC_API_KEY;
  const modelArg = normalizedModelArg(engine, session.model);
  const effortArg = normalizedEffortArg(engine, session.effort);

  let bin;
  const claudeModelAttempts = engine === 'claude' ? claudeModelAttemptChain(modelArg) : [modelArg];
  let claudeTransientRetries = 0;

  function startProcess(activeModelArg = modelArg, modelAttemptIndex = 0) {
  let args;
  if (engine === 'claude') {
    args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    if (danger) args.push('--dangerously-skip-permissions');
    if (activeModelArg) args.push('--model', activeModelArg, ...claudeModelFallbackArgs(activeModelArg));
    if (effortArg) args.push('--effort', effortArg);
    const identity = claudeSessionIdentityArgs(session, nativeResumeId, { sessionIdOverride: claudeSessionIdOverride });
    args.push(...identity.args);
    if (identity.expectedSessionId) {
      session.engineRefs ||= { claude: null, codex: null };
      session.engineRefs.claude = identity.expectedSessionId;
      session._expectedClaudeSessionId = identity.expectedSessionId;
    }
    bin = 'claude';
  } else {
    const base = ['--json', '--skip-git-repo-check'];
    const effortOverride = effortArg ? ['-c', `model_reasoning_effort=${effortArg}`] : [];
    if (nativeResumeId) {
      const resumeGuard = danger ? ['--dangerously-bypass-approvals-and-sandbox'] : [];
      args = ['exec', 'resume', ...resumeGuard, ...base, ...effortOverride, nativeResumeId];
    } else {
      const execGuard = danger
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['-s', 'read-only'];
      args = ['exec', ...execGuard, ...base, ...effortOverride];
      if (modelArg) args.push('-m', modelArg);
    }
    bin = 'codex';
  }

  const proc = spawnCli(bin, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: session.cwd,
    env: spawnEnv,
  });
  session.proc = proc;
  session._activeEngine = engine;
  session._acceptsLiveInput = engine === 'claude';
  session._endingInput = false;
  session._activeModel = activeModelArg ?? null;
  session.pid = proc.pid;
  persistIndex();

  const runId = crypto.randomUUID();
  let observedNativeId = nativeResumeId;
  const contextObserver = createContextObserver(STATE_DIR, () => ({
    run_id: runId, session_id: session.id, native_session_id: observedNativeId,
    engine, cwd: session.cwd, model: session._activeModel,
  }), () => console.error('[agent-hub-remote] context metadata write failed'));
  session._contextObserver = contextObserver;
  contextObserver.record({ stage: 'start', prompt_chars: enginePrompt.length,
    bootstrap_chars: enginePrompt.length - fullPrompt.length,
    evidence_chars: evidenceChars, evidence_omitted: evidenceOmitted,
    bridge_chars: preamble.length, native_resume: !!nativeResumeId });

  if (engine === 'claude') {
    proc.stdin.write(claudeUserLine(enginePrompt), 'utf8');
  } else {
    proc.stdin.write(enginePrompt, 'utf8');
    proc.stdin.end();
  }

  let buf = '';
  session._claudeTurnUsage = null;
  session._codexTurnUsage = null;
  session._emittedText = false;
  session._hadToolActivity = false;
  session._stderrBuf = '';
  session._claudeRetryableErrorBuf = '';
  session._codexTextBuf = '';
  session._sawStreamEvent = false;
  session._runTextTail = '';
  session._authErrorBuf = '';

  function noteRunText(t) {
    if (!t) return;
    session._runTextTail = ((session._runTextTail || '') + '\n' + String(t)).slice(-1500);
  }

  function onClaudeEvent(ev) {
    session._sawStreamEvent = true;
    let identityChanged = false;
    let removedNativeTwin = false;
    if (ev.session_id) {
      observedNativeId = ev.session_id;
      if (session._expectedClaudeSessionId && ev.session_id !== session._expectedClaudeSessionId) {
        console.error(`[agent-hub-remote] claude session id mismatch for hub ${session.id}: expected ${session._expectedClaudeSessionId}, got ${ev.session_id}`);
      }
      const claim = claimClaudeNativeSession(session, ev.session_id);
      identityChanged = claim.changed;
      removedNativeTwin = claim.removedTwin;
      if (removedNativeTwin) {
        console.error(`[agent-hub-remote] removed native Claude twin ${ev.session_id} after hub ${session.id} claimed it`);
      }
    }
    if (ev.type === 'rate_limit_event') _captureRateLimitEvent(ev);
    const claudeUsage = ev?.message?.usage || ev?.usage;
    if (claudeUsage) {
      session._claudeTurnUsage = normalizeClaudeTurnUsage(claudeUsage, {
        session_id: session.id,
        native_session_id: session.engineRefs.claude || ev.session_id,
        cwd: session.cwd,
        model: session._activeModel || session.model || null,
        turn_ts: ev.timestamp,
      });
    }
    contextObserver.observe('claude', ev, claudeUsage ? session._claudeTurnUsage : null);
    if (ev.type === 'assistant') {
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          session._emittedText = true;
          noteRunText(block.text);
          const ts = appendMsg(session, { role: 'assistant', engine, text: block.text });
          broadcast({ type: 'msg', id: session.id, ts, text: block.text, engine });
        } else {
          if (block.type === 'tool_use') session._hadToolActivity = true;
          const toolText = formatClaudeToolUse(block);
          if (toolText) {
            const ts = appendMsg(session, { role: 'system', kind: 'tool-diff', engine, text: toolText });
            broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'tool-diff', text: toolText, engine });
          }
        }
      }
    }
    if (ev.type === 'user') {
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'tool_result') session._hadToolActivity = true;
        const toolText = formatClaudeToolResult(block);
        if (toolText) {
          const ts = appendMsg(session, { role: 'system', kind: 'tool-diff', engine, text: toolText });
          broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'tool-diff', text: toolText, engine });
        }
      }
    }
    if (ev.type === 'result' && typeof ev.subtype === 'string' && ev.subtype.startsWith('error')) {
      const errText = String(ev.error ?? ev.result ?? 'error');
      noteRunText(errText);
      if (detectAuthFailure(errText)) {
        session._authErrorBuf = ((session._authErrorBuf || '') + '\n' + errText).trim().slice(-2000);
      }
      if (!session._emittedText && !session._hadToolActivity && isClaudeRetryableStartupFailure(errText)) {
        session._claudeRetryableErrorBuf = (
          (session._claudeRetryableErrorBuf || '') + '\n' + errText
        ).trim().slice(-2000);
      } else {
        const ts = appendMsg(session, { role: 'error', engine, text: errText });
        broadcast({ type: 'msg', id: session.id, ts, text: `⚠️ ${errText}`, error: true, engine });
      }
    }
    if (ev.type === 'result' && ev.subtype === 'success'
        && typeof ev.result === 'string' && ev.result.trim()) {
      noteRunText(ev.result);
      if (!session._emittedText) {
        const ts = appendMsg(session, { role: 'assistant', engine, text: ev.result });
        broadcast({ type: 'msg', id: session.id, ts, text: ev.result, engine });
      }
    }
    if (ev.type === 'result' && !session._endingInput && proc.stdin && proc.stdin.writable) {
      session._endingInput = true;
      proc.stdin.end();
    }
    if (identityChanged || removedNativeTwin) persistIndex();
    if (removedNativeTwin) broadcast({ type: 'sessions', data: sessionsArr() });
  }

  function fmtCodexItem(item) {
    if (!item) return null;
    if (item.type === 'agent_message') {
      const text = (item.text || '').trim();
      return text ? { role: 'assistant', text } : null;
    }
    if (item.type === 'command_execution') {
      const text = formatCodexCommandExecution(item);
      return text ? { role: 'system', kind: 'tool-diff', text } : null;
    }
    return null;
  }

  function onCodexEvent(ev) {
    if (!ev || !ev.type) return;
    session._sawStreamEvent = true;
    if (ev.type === 'thread.started' && ev.thread_id) {
      observedNativeId = ev.thread_id;
      session.engineRefs.codex = ev.thread_id;
      return;
    }
    if (ev.type === 'turn.completed' && ev.usage) {
      session._codexTurnUsage = normalizeCodexTurnUsage(ev.usage, {
        session_id: session.id,
        native_session_id: session.engineRefs.codex,
        cwd: session.cwd,
        model: session._activeModel || session.model || null,
      });
      contextObserver.observe('codex', ev, session._codexTurnUsage);
      return;
    }
    if (ev.type === 'item.completed') {
      const msg = fmtCodexItem(ev.item);
      if (msg) {
        session._emittedText = true;
        if (msg.role === 'assistant') noteRunText(msg.text);
        if (msg.kind === 'tool-diff' && /windows sandbox: spawn setup/i.test(msg.text)) {
          session._sandboxSpawnFailures = (session._sandboxSpawnFailures || 0) + 1;
        }
        const ts = appendMsg(session, { role: msg.role, kind: msg.kind, engine, text: msg.text });
        broadcast({ type: 'msg', id: session.id, ts, role: msg.role, kind: msg.kind, text: msg.text, engine });
      }
    }
    if (ev.type === 'error' || ev.type === 'thread.failed' || ev.type === 'exec.failed') {
      const msg = ev.message || ev.error || ev.reason || JSON.stringify(ev);
      noteRunText(msg);
      const ts = appendMsg(session, { role: 'error', engine, text: msg });
      broadcast({ type: 'msg', id: session.id, ts, text: `⚠️ ${msg}`, error: true, engine });
    }
  }

  const onEvent = engine === 'claude' ? onClaudeEvent : onCodexEvent;

  proc.stdout.on('data', chunk => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { onEvent(JSON.parse(line)); }
      catch {
        if (engine === 'claude') {
          noteRunText(line);
          if (!session._emittedText && !session._hadToolActivity && isClaudeRetryableStartupFailure(line)) {
            session._claudeRetryableErrorBuf = (
              (session._claudeRetryableErrorBuf || '') + '\n' + line
            ).trim().slice(-2000);
          } else {
            const ts = appendMsg(session, { role: 'assistant', engine, text: line });
            broadcast({ type: 'msg', id: session.id, ts, text: line, engine });
          }
        } else {
          session._codexTextBuf = ((session._codexTextBuf || '') + line + '\n').slice(-2000);
        }
      }
    }
  });

  proc.stdout.on('end', () => {
    if (!buf.trim()) return;
    try { onEvent(JSON.parse(buf)); }
    catch {
      if (engine === 'claude') {
        noteRunText(buf);
        if (!session._emittedText && !session._hadToolActivity && isClaudeRetryableStartupFailure(buf)) {
          session._claudeRetryableErrorBuf = (
            (session._claudeRetryableErrorBuf || '') + '\n' + buf
          ).trim().slice(-2000);
        } else {
          const ts = appendMsg(session, { role: 'assistant', engine, text: buf });
          broadcast({ type: 'msg', id: session.id, ts, text: buf, engine });
        }
      }
    }
    buf = '';
  });

  proc.stderr.on('data', chunk => {
    session._stderrBuf = ((session._stderrBuf || '') + chunk.toString()).slice(-4000);
  });

  let turnEnded = false;
  function endTurn(code, cancelled) {
    if (turnEnded) return false;
    turnEnded = true;
    broadcast({ type: 'done', id: session.id, ts: Date.now(), code });
    emitTurnEnd(session, { code, engine, cancelled, broadcast });
    return true;
  }

  proc.on('error', err => {
    if (session.proc === proc) {
      session.proc = null; session.pid = null;
      session._activeEngine = null; session._acceptsLiveInput = false; session._endingInput = false;
    }
    const wasCancelled = !!session.cancelled;
    session.cancelled = false;
    session.status = wasCancelled ? 'idle' : 'error';
    const text = err.code === 'ENOENT'
      ? `⚠️ ${bin} 找不到（未安裝或不在 PATH）`
      : `⚠️ ${err.message}`;
    const ts = appendMsg(session, { role: 'error', engine, text });
    broadcast({ type: 'msg', id: session.id, ts, text, error: true, engine });
    broadcast({ type: 'sessions', data: sessionsArr() });
    endTurn(-1, wasCancelled);
  });

  proc.on('close', async code => {
    if (turnEnded) return;
    const wasCancelled = !!session.cancelled;
    let confirmedAuthErrorText = '';
    if (!wasCancelled && code !== 0) {
      const rawAuthErrorText = [session._authErrorBuf, session._stderrBuf].filter(Boolean).join('\n');
      if (detectAuthFailure(rawAuthErrorText)) {
        const authStatus = await verifyClaudeAuth().catch(() => null);
        if (authStatus && authStatus.loggedIn === false) confirmedAuthErrorText = rawAuthErrorText;
      }
    }
    if (session.proc === proc) {
      session.proc = null; session.pid = null;
      session._activeEngine = null; session._acceptsLiveInput = false; session._endingInput = false;
    }
    const failureReason = code !== 0
      ? [((session._claudeRetryableErrorBuf || '').trim()),
         ((session._stderrBuf || '').trim()),
         (engine === 'codex' ? (session._codexTextBuf || '').trim() : '')]
          .filter(Boolean).join('\n').slice(-1000) || `exit ${code}`
      : '';
    if (wasCancelled) {
      session.status = 'idle';
      session.cancelled = false;
    } else {
      const canRetryClaudeStartup = engine === 'claude'
        && code !== 0
        && !session._emittedText
        && !session._hadToolActivity
        && isClaudeRetryableStartupFailure(failureReason);
      const transientUpstreamFailure = canRetryClaudeStartup
        && isClaudeTransientUpstreamFailure(failureReason);
      const retrySameClaudeModel = transientUpstreamFailure && claudeTransientRetries < 1;
      const nextClaudeModel = canRetryClaudeStartup
        && !retrySameClaudeModel
        && (isClaudeModelStartupFailure(failureReason) || transientUpstreamFailure)
        && modelAttemptIndex < claudeModelAttempts.length - 1
        ? claudeModelAttempts[modelAttemptIndex + 1]
        : null;
      if (retrySameClaudeModel) {
        claudeTransientRetries += 1;
        const current = activeModelArg || 'default';
        const note = `Claude upstream temporarily unavailable on ${current}; retrying ${current}.`;
        const ts = appendMsg(session, { role: 'system', kind: 'swap', engine, text: note });
        session.status = 'running';
        broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'swap', text: note, engine });
        broadcast({ type: 'sessions', data: sessionsArr() });
        return startProcess(activeModelArg, modelAttemptIndex);
      }
      if (nextClaudeModel) {
        const current = activeModelArg || 'default';
        const reason = isClaudeTransientUpstreamFailure(failureReason)
          ? 'upstream temporarily unavailable'
          : 'model unavailable';
        const note = `Claude ${reason} on ${current}; retrying ${nextClaudeModel}.`;
        const ts = appendMsg(session, { role: 'system', kind: 'swap', engine, text: note });
        session.status = 'running';
        broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'swap', text: note, engine });
        broadcast({ type: 'sessions', data: sessionsArr() });
        return startProcess(nextClaudeModel, modelAttemptIndex + 1);
      }
      session.status = code === 0 ? 'idle' : 'error';
      if (code === 0) {
        session._taskEvidenceCache = evidenceCache;
        session._resumeFailed = false;
        session._limitAttempts = 0;
      }
      if (code !== 0) {
        const failure = classifyRunFailure({
          usedNativeResume: !!session._usedNativeResume,
          sawStreamEvent: !!session._sawStreamEvent,
          texts: [session._runTextTail, failureReason].filter(Boolean).join('\n'),
          errorText: confirmedAuthErrorText,
        });
        if (failure.kind === 'limit') {
          handleUsageLimitFailure(session, broadcast, engine, failure.resetAt);
        } else if (failure.kind === 'auth') {
          handleAuthFailure(session, broadcast, engine);
        } else {
          if (failure.kind === 'resume-failed') session._resumeFailed = true;
          const reason = failureReason;
          const ts = appendMsg(session, { role: 'error', engine, text: reason });
          broadcast({ type: 'msg', id: session.id, ts, text: `⚠️ ${reason}`, error: true, engine });
        }
      }
    }
    let turnUsage = null;
    if (!wasCancelled && code === 0 && engine === 'codex' && session._codexTurnUsage) {
      turnUsage = {
        ...session._codexTurnUsage,
        logged_at: new Date().toISOString(),
        session_id: session.id,
        native_session_id: session.engineRefs.codex || session._codexTurnUsage.native_session_id,
        cwd: session.cwd,
        model: session._activeModel || session.model || null,
      };
      try {
        recordCodexTurnUsage(turnUsage);
      } catch (e) {
        console.error('[agent-hub-remote] codex usage log failed', e.message);
      }
    }
    if (!wasCancelled && code === 0 && engine === 'claude' && session._claudeTurnUsage) {
      turnUsage = {
        ...session._claudeTurnUsage,
        logged_at: new Date().toISOString(),
        session_id: session.id,
        native_session_id: session.engineRefs.claude || session._claudeTurnUsage.native_session_id,
        cwd: session.cwd,
        model: session._activeModel || session.model || null,
      };
    }
    if (!wasCancelled && code === 0 && engine === 'codex') {
      let autoCommitText = null;
      try {
        autoCommitText = formatAutoCommitResult(runCodexAutoCommit(autoCommitBaseline));
      } catch (e) {
        autoCommitText = `Auto-commit skipped: ${String(e.message || e).slice(0, 240)}`;
      }
      const isAutoCommitSkip = !!autoCommitText && autoCommitText.startsWith('Auto-commit skipped:');
      if (autoCommitText && (!isAutoCommitSkip || session._autoCommitSkipNote !== autoCommitText)) {
        const text = autoCommitText;
        const ts = appendMsg(session, { role: 'system', kind: 'auto-commit', engine, text });
        broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'auto-commit', text, engine });
      }
      session._autoCommitSkipNote = isAutoCommitSkip ? autoCommitText : null;
    }
    if (!wasCancelled && code === 0) {
      _flushRateLimits();
      appendUsageSnapshot(session, engine, broadcast, turnUsage);
    }
    if ((session._sandboxSpawnFailures || 0) >= 3) {
      const text = `⚠️ Codex sandbox degraded：本 turn 有 ${session._sandboxSpawnFailures} 個 tool call 因 "windows sandbox: spawn setup" 失敗（codex CLI 內部沙箱問題，非指令錯誤）。建議重送該 turn 或開新 session。`;
      const ts = appendMsg(session, { role: 'system', kind: 'sandbox-degraded', engine, text });
      broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'sandbox-degraded', text, engine });
    }
    session._sandboxSpawnFailures = 0;
    try {
      const outcome = recordHarnessOutcome({
        session,
        engine,
        code,
        wasCancelled,
        messages: loadMessages(session.id, 0),
      });
      recordHarnessCoverage(STATE_DIR, {
        cwd: session?.cwd || null,
        instrumented: !outcome?.skipped,
      });
      if (outcome?.review?.due) {
        const text = `M5 harness review due: ${outcome.review.unreviewedNeedsReview} unreviewed needs-review event(s) of ${outcome.review.unreviewedEvents} in backlog (${outcome.review.needsReviewEvents} lifetime) — ${outcome.path}. Review when convenient; this notice is not sent to model context.`;
        const ts = appendMsg(session, { role: 'system', kind: 'harness-outcome', engine, text });
        broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'harness-outcome', text, engine });
      }
    } catch (e) {
      console.error('[agent-hub-remote] harness outcome log failed', e.message);
    }
    session._codexTurnUsage = null;
    session._claudeTurnUsage = null;
    persistIndex();
    broadcast({ type: 'sessions', data: sessionsArr() });
    endTurn(code, wasCancelled);
  });

  return proc;
  }

  return startProcess(claudeModelAttempts[0], 0);
}
