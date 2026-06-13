// agent-hub-remote public server.
// Bind loopback and expose it through Tailscale Serve inside a private tailnet.
// Implements the structured route protocol used by the browser UI.

import { parsePort } from './env.js';
import express from 'express';
import http from 'http';
import { spawn } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

import {
  assertSecret, rejectFunnel, handleStepUpTotp, verifyActionToken, audit,
  handlePasskeyStatus, handleEnrollPasskeyStart, handleEnrollPasskeyFinish,
  handleStepUpPasskeyStart, handleStepUpPasskeyFinish,
  handleStartupStatus, handleStartupUnlock, requireStartupVerified,
  verifyStartupCookie,
  verifyLocalToken, handleLocalTokenMint, handleLocalTokenStatus, handleLocalTokenRevoke,
  isLocalLoopbackRequest, getLocalTokenStatus, waitForLocalToken,
} from './auth.js';
import {
  sessions, hydrate, createSession, sessionsArr, loadMessages,
  appendMsg, persistIndex, applyRetention, ingestProjects,
  appendContextControl, syncMessageCount, pendingContextFromControls,
} from './store.js';
import { runEngine, killTree, canAcceptLiveInput, writeLiveInput, continuationPlan } from './engines.js';
import { projectContextMessages } from './context-projection.js';
import { summarize } from './gemma.js';
import { rewindTranscriptFallback } from './rewind-context.js';
import {
  formatTurnUsageLine,
  getUsage,
  normalizeClaudeTurnUsage,
  normalizeCodexTurnUsage,
  readLatestUsageEntry,
  startUsageApiPoller,
  usageEntryKey,
} from './usage-core.js';

assertSecret();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PORT = parsePort(process.env.AHR_HTTP_PORT || process.env.AHR_PORT || process.env.AGENT_HUB_PORT);
const BIND_HOST = process.env.AHR_BIND_HOST || '127.0.0.1';

// ── 多目錄登錄表（plan §二-C）：dirs.json > ALLOWED_DIRS env > 預設 ──────────
function loadDirs() {
  // dirs.json: [{ alias, path, label? }]
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(__dirname, 'dirs.json'), 'utf8'));
    if (Array.isArray(arr) && arr.length) return arr;
  } catch { /* fallthrough */ }
  // ALLOWED_DIRS=alias:path;alias:path
  const env = process.env.ALLOWED_DIRS;
  if (env && env.trim()) {
    const out = [];
    for (const part of env.split(';')) {
      const i = part.indexOf(':');
      if (i < 1) continue;
      out.push({ alias: part.slice(0, i).trim(), path: part.slice(i + 1).trim() });
    }
    if (out.length) return out;
  }
  // 預設只暴露 $HOME，讓陌生人 clone 就能跑；正式使用請設 ALLOWED_DIRS 或 dirs.json
  return [
    { alias: 'home', path: HOME, label: 'home' },
  ];
}
const DIRS = loadDirs();
const DIR_BY_ALIAS = new Map(DIRS.map(d => [d.alias, d]));
const CLAUDE_MODELS = new Set(['sonnet', 'opus', 'haiku']);
const CODEX_UNSUPPORTED_MODELS = new Set(['gpt-5-codex']);

function codexModelArg(model) {
  const raw = model && model !== 'default' ? String(model) : null;
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (CLAUDE_MODELS.has(lower) || /^claude-/i.test(raw)) return null;
  if (CODEX_UNSUPPORTED_MODELS.has(lower)) return null;
  return raw;
}

function resolveCwd(alias) {
  const d = DIR_BY_ALIAS.get(alias);
  return d ? path.resolve(d.path) : null;
}

function isLinkedGitWorktree(cwd) {
  if (!cwd) return false;
  try {
    return fs.statSync(path.join(cwd, '.git')).isFile();
  } catch {
    return false;
  }
}

function codexWriteGuard(agentType, cwd, autoAllow) {
  if (agentType !== 'codex' || !autoAllow) return null;
  // Linked worktree remains advisory metadata; step-up gates autoAllow.
  return null;
}

function allowAutoModeAction(req, res, action, sessionId) {
  if (verifyLocalToken(req)) return true;
  return verifyActionToken(req, res, { action, sessionId });
}

// ── File upload temp storage. Files are deleted after AHR_UPLOAD_TTL_MS. ──
const uploadTtlRaw = parseInt(process.env.AHR_UPLOAD_TTL_MS || `${24 * 60 * 60 * 1000}`, 10);
const UPLOAD_TTL_MS = Number.isFinite(uploadTtlRaw) ? Math.max(60_000, uploadTtlRaw) : 24 * 60 * 60 * 1000;
const AHR_MEDIA_DIR = path.join(os.tmpdir(), 'agent-hub-remote', 'uploads');
try { fs.mkdirSync(AHR_MEDIA_DIR, { recursive: true }); } catch {}

function cleanupExpiredUploads() {
  const cutoff = Date.now() - UPLOAD_TTL_MS;
  let entries = [];
  try { entries = fs.readdirSync(AHR_MEDIA_DIR, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const p = path.join(AHR_MEDIA_DIR, entry.name);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {}
  }
}
cleanupExpiredUploads();
setInterval(cleanupExpiredUploads, Math.min(60 * 60 * 1000, UPLOAD_TTL_MS)).unref();

function sanitizeUploadName(filename) {
  const base = path.basename(String(filename || 'attachment.bin'));
  const safe = base.replace(/[^\w.\-() ]+/g, '_').replace(/\s+/g, '_').slice(0, 80);
  return safe || 'attachment.bin';
}

function isStoredUpload(p) {
  if (!p || typeof p !== 'string') return false;
  const root = path.resolve(AHR_MEDIA_DIR) + path.sep;
  const resolved = path.resolve(p);
  return resolved === path.resolve(AHR_MEDIA_DIR) || resolved.startsWith(root);
}

function normalizeAttachedFile(f) {
  if (!f) return null;
  const filePath = typeof f === 'string' ? f : f.path;
  if (!isStoredUpload(filePath)) return null;
  return {
    path: path.resolve(filePath),
    name: typeof f === 'object' && f.name ? String(f.name).slice(0, 160) : path.basename(filePath),
    type: typeof f === 'object' && f.type ? String(f.type).slice(0, 120) : '',
    size: typeof f === 'object' && Number.isFinite(f.size) ? f.size : null,
  };
}

const COMPACT_INPUT_LIMIT = 25_000;
const REWIND_INLINE_LIMIT = 6_000;

function conversationMessages(messages) {
  return projectContextMessages(messages).filter(m =>
    (m.role === 'user' || m.role === 'assistant') &&
    m.text && String(m.text).trim()
  );
}

function userTurnIndices(messages) {
  const idx = [];
  messages.forEach((m, i) => {
    if (m.role === 'user' && m.text && String(m.text).trim()) idx.push(i);
  });
  return idx;
}

function conversationText(messages, maxChars = COMPACT_INPUT_LIMIT) {
  let out = '';
  for (const m of conversationMessages(messages)) {
    const tag = m.role === 'user' ? 'User' : 'Assistant';
    const body = String(m.text).length > 2000 ? String(m.text).slice(0, 2000) + '...[truncated]' : String(m.text);
    out += `${tag}: ${body}\n\n`;
    if (out.length > maxChars) return out.slice(0, maxChars);
  }
  return out.trim();
}

function compactPrompt(transcript) {
  return `Summarize this user/assistant conversation into compact continuation context. Write in Traditional Chinese unless exact technical names or source wording should remain English. Keep it under 500 Chinese characters when possible, and include:
1. Current user goal and important constraints.
2. Decisions already made.
3. Files, commands, routes, or APIs that matter.
4. Open tasks and next concrete step.

Do not add generic advice. Output only the summary.

--- Conversation ---
${transcript}`;
}

function cleanupClaudePrintSession(tempSessionId) {
  const root = path.join(HOME, '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(root, d.name, tempSessionId + '.jsonl');
    try { fs.unlinkSync(p); } catch {}
  }
}

function runClaudeSummary(transcript, cwd, model) {
  return new Promise((resolve) => {
    const tempSessionId = crypto.randomUUID();
    const args = ['--print', '--no-session-persistence', '--session-id', tempSessionId];
    const modelArg = model && model !== 'default' && !/^gpt-/i.test(model) ? model : null;
    if (modelArg) args.push('--model', modelArg);
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY;

    let proc;
    try {
      proc = spawn('claude', args, {
        cwd,
        windowsHide: true,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
    } catch {
      return resolve(null);
    }

    let output = '';
    let stderr = '';
    let settled = false;
    // resolve exactly once; clear the timer and clean up the temp session on every path.
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupClaudePrintSession(tempSessionId);
      resolve(value);
    };
    // shell:true spawns claude under a shell; proc.kill() only signals the shell, so on
    // Windows the claude child tree survives. Use killTree() (taskkill /T) like the other
    // AHR shutdown paths to bound the whole tree on timeout.
    const timer = setTimeout(() => {
      console.error('[agent-hub-remote] compact summary timed out, killing process tree');
      try { killTree(proc); } catch {}
      finish(null);
    }, 10_000);
    proc.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-1000); });
    proc.on('error', () => finish(null));
    proc.on('close', code => {
      if (code === 0 && output.trim()) return finish(output.trim());
      if (!settled) console.error('[agent-hub-remote] compact summary failed', code, stderr);
      finish(null);
    });
    proc.stdin.write(compactPrompt(transcript), 'utf8');
    proc.stdin.end();
  });
}

function codexSummaryText(ev) {
  if (!ev || typeof ev !== 'object') return '';
  if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message') {
    return String(ev.item.text || '').trim();
  }
  if (ev.type === 'agent_message') return String(ev.text || '').trim();
  if (ev.type === 'turn.completed' && typeof ev.output === 'string') return ev.output.trim();
  return '';
}

function runCodexSummary(transcript, cwd, model) {
  return new Promise((resolve) => {
    const args = ['exec', '-s', 'read-only', '--json', '--skip-git-repo-check'];
    const modelArg = codexModelArg(model);
    if (modelArg) args.push('-m', modelArg);
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    let proc;
    try {
      proc = spawn('codex', args, {
        cwd,
        windowsHide: true,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
    } catch {
      return resolve(null);
    }

    let buf = '';
    let output = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value && value.trim() ? value.trim() : null);
    };
    const timer = setTimeout(() => {
      console.error('[agent-hub-remote] codex compact summary timed out, killing process tree');
      try { killTree(proc); } catch {}
      finish(null);
    }, 45_000);

    proc.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const text = codexSummaryText(JSON.parse(line));
          if (text) output += (output ? '\n' : '') + text;
        } catch {
          output += (output ? '\n' : '') + line.trim();
        }
      }
    });
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-1000); });
    proc.on('error', () => finish(null));
    proc.on('close', code => {
      if (buf.trim()) {
        try {
          const text = codexSummaryText(JSON.parse(buf));
          if (text) output += (output ? '\n' : '') + text;
        } catch {
          output += (output ? '\n' : '') + buf.trim();
        }
      }
      if (code === 0 && output.trim()) return finish(output.trim());
      if (!settled) console.error('[agent-hub-remote] codex compact summary failed', code, stderr);
      finish(null);
    });
    proc.stdin.write(compactPrompt(transcript), 'utf8');
    proc.stdin.end();
  });
}

async function summarizeForSession(transcript, s) {
  if (s.agentType === 'codex') {
    const codexSummary = await runCodexSummary(transcript, s.cwd, s.model);
    if (codexSummary) return codexSummary;
    const localSummary = await summarize(compactPrompt(transcript));
    if (localSummary) return localSummary;
    return null;
  }

  const claudeSummary = await runClaudeSummary(transcript, s.cwd, s.model);
  if (claudeSummary) return claudeSummary;
  const localSummary = await summarize(compactPrompt(transcript));
  if (localSummary) return localSummary;
  return null;
}

async function contextForMessages(messages, s) {
  const transcript = conversationText(messages);
  if (!transcript) return { context: '', mode: 'cleared' };
  if (transcript.length <= REWIND_INLINE_LIMIT) return { context: transcript, mode: 'transcript' };
  const summary = await summarizeForSession(transcript, s);
  if (summary) return { context: summary, mode: 'summary' };

  const fallback = rewindTranscriptFallback(transcript);
  console.error(
    `[agent-hub-remote] rewind summary unavailable; using transcript fallback ` +
    `(session=${s.id}, engine=${s.agentType}, chars=${transcript.length}, fallback=${fallback.context.length})`
  );
  return fallback;
}

function sessionPayload(s) {
  return sessionsArr().find(m => m.id === s.id) || null;
}

function actionPayload(s) {
  return {
    ok: true,
    session: sessionPayload(s),
    messages: loadMessages(s.id, 0),
  };
}

function engineRefsSnapshot(s) {
  return {
    claude: s.engineRefs?.claude || null,
    codex: s.engineRefs?.codex || null,
  };
}

function contextResetMeta(s, { op, turn } = {}) {
  return {
    op: op || 'reset',
    turn: turn ?? null,
    ts: Date.now(),
    agentType: s.agentType === 'codex' ? 'codex' : 'claude',
    lastEngine: s.lastEngine || null,
    previousEngineRefs: engineRefsSnapshot(s),
  };
}

function applyContextReset(s, pending, resetMeta) {
  s.pendingContext = { ...pending, contextReset: resetMeta || pending.contextReset || null, freshThread: true };
  s.contextReset = resetMeta || null;
  s.engineRefs = { claude: null, codex: null };
  s.lastEngine = null;
  s.pid = null;
  s.cancelled = false;
  s.status = 'idle';
  s.archived = false;
  syncMessageCount(s);
  applyRetention();
  persistIndex();
}

// ── 開機 hydrate + 孤兒收屍（plan #6）────────────────────────────────────────
let startupOrphans = [];
function recoverInterruptedSessions() {
  startupOrphans = hydrate();
  for (const { id, pid } of startupOrphans) {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      console.error(`[agent-hub-remote] 收屍孤兒 pid=${pid} (session ${id})`);
    } catch (e) { console.error('[agent-hub-remote] 收屍失敗', pid, e.message); }
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  }
}

// ── 收錄本機原生 Claude session（取代 TG bot）──────────────────────────────
// 預設收錄所有 ALLOWED_DIRS；可由 AHR_INGEST_ALIASES=alias1,alias2 子集化。
const INGEST_ALIASES = (process.env.AHR_INGEST_ALIASES
  ? process.env.AHR_INGEST_ALIASES.split(',').map(s => s.trim()).filter(Boolean)
  : DIRS.map(d => d.alias));
// Safe to run repeatedly; store.ingestProjects dedupes by native ids.
function refreshNativeSessions(reason = 'api') {
  const cwds = INGEST_ALIASES.map(a => resolveCwd(a)).filter(Boolean);
  try {
    const added = ingestProjects(cwds);
    const data = sessionsArr();
    console.error(`[agent-hub-remote] native session ingest (${reason}): +${added} (${cwds.join(', ')})`);
    return { ok: true, added, sessions: data, refreshedAt: Date.now() };
  } catch (e) {
    console.error('[agent-hub-remote] native session ingest failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Express + WS ────────────────────────────────────────────────────────────
const app = express();
if (process.env.AHR_ACCESS_LOG === '1') {
  const ACCESS_LOG_PATH = path.join(__dirname, 'ahr_access.log');
  app.use((req, res, next) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      host: req.headers.host || '',
      ua: req.headers['user-agent'] || '',
      remote: req.socket.remoteAddress || '',
    }) + '\n';
    fs.appendFile(ACCESS_LOG_PATH, line, () => {});
    next();
  });
}
app.use(rejectFunnel);   // Guardrail: reject accidental Funnel ingress.
app.use(express.json({ limit: '12mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
let pendingLocalTokenRequest = null;
let pendingLocalOrchestrateApproval = null;

server.on('upgrade', (req, socket, head) => {
  // Funnel ingress carries this header; reject websocket upgrades too.
  if (req.headers['tailscale-funnel-request']) { socket.destroy(); return; }
  if (!verifyStartupCookie(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function setPendingLocalTokenRequest(reason) {
  pendingLocalTokenRequest = {
    reason,
    requestedAt: Date.now(),
  };
  broadcast({ type: 'local_token_request', ...pendingLocalTokenRequest });
}

function getPendingLocalTokenRequest() {
  return pendingLocalTokenRequest;
}

wss.on('connection', (ws, req) => {
  ws.send(JSON.stringify({ type: 'sessions', data: sessionsArr() }));
});

function sameResolvedPath(a, b) {
  if (!a || !b) return false;
  try {
    return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
  } catch {
    return false;
  }
}

function usageEntryFromBody(body) {
  if (!body || typeof body !== 'object' || !Object.keys(body).length) return null;
  const engine = String(body.engine || body.source || 'claude').toLowerCase() === 'codex'
    ? 'codex'
    : 'claude';
  const raw = body.usage && typeof body.usage === 'object' ? body.usage : body;
  const meta = {
    logged_at: body.logged_at,
    turn_ts: body.turn_ts || body.timestamp,
    session_id: body.session_id,
    native_session_id: body.native_session_id || body.session_id,
    cwd: body.cwd,
    model: body.model,
  };
  const entry = engine === 'codex'
    ? normalizeCodexTurnUsage(raw, meta)
    : normalizeClaudeTurnUsage(raw, meta);
  if (entry && body.transcript_path) entry.transcript_path = String(body.transcript_path);
  return entry;
}

function matchingUsageSession(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const engine = entry.engine === 'codex' ? 'codex' : 'claude';
  const ids = new Set([entry.session_id, entry.native_session_id].filter(Boolean).map(String));
  if (entry.transcript_path) {
    for (const s of sessions.values()) {
      if (s.agentType === engine && sameResolvedPath(s.nativePath, entry.transcript_path)) return s;
    }
  }
  if (ids.size) {
    for (const s of sessions.values()) {
      if (s.agentType !== engine) continue;
      const nativeId = engine === 'codex' ? s.engineRefs?.codex : s.engineRefs?.claude;
      if (ids.has(String(s.id)) || (nativeId && ids.has(String(nativeId)))) return s;
    }
  }
  const cwd = entry.cwd ? path.resolve(String(entry.cwd)).toLowerCase() : '';
  if (!cwd) return null;
  const candidates = [...sessions.values()]
    .filter(s => s.agentType === engine && s.cwd && path.resolve(s.cwd).toLowerCase() === cwd)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return candidates[0] || null;
}

function appendUsageNotification(entry) {
  if (!entry) return { appended: false, reason: 'no_usage' };
  const s = matchingUsageSession(entry);
  if (!s) return { appended: false, reason: 'no_session' };
  const turnText = formatTurnUsageLine(entry);
  if (!turnText) return { appended: false, reason: 'no_text', sessionId: s.id };
  const key = usageEntryKey(entry);
  if (key && loadMessages(s.id, 0).some(m => m.kind === 'usage' && m.usageKey === key)) {
    return { appended: false, duplicate: true, sessionId: s.id };
  }
  const text = `Usage: ${turnText}`;
  const ts = appendMsg(s, { role: 'system', kind: 'usage', engine: entry.engine, text, usageKey: key });
  broadcast({ type: 'msg', id: s.id, ts, role: 'system', kind: 'usage', text, engine: entry.engine, usageKey: key });
  return { appended: true, sessionId: s.id };
}

// ── Step-up（spec §5.1）：危險動作前先換 60s 一次性 action-token ────────────
app.post('/step-up/totp', handleStepUpTotp);
app.get('/passkey/status', handlePasskeyStatus);
app.post('/enroll/passkey/start', handleEnrollPasskeyStart);
app.post('/enroll/passkey/finish', handleEnrollPasskeyFinish);
app.post('/step-up/passkey/start', handleStepUpPasskeyStart);
app.post('/step-up/passkey/finish', handleStepUpPasskeyFinish);
app.get('/startup/status', handleStartupStatus);
app.post('/startup/unlock', handleStartupUnlock);
// 鑄造本機編排 token：pre-gate（與 unlock/step-up 同層，passkey action-token 即唯一閘），
// 讓 owner 重啟後一次 passkey 即可授權本機 orchestrator，毋須先取得 startup cookie。
app.post('/local-token/mint', handleLocalTokenMint);
app.post('/local-token/request', async (req, res) => {
  if (!isLocalLoopbackRequest(req)) return res.status(403).json({ error: 'local only' });
  const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 160) : 'local orchestration';
  const status = getLocalTokenStatus();
  if (status.active) return res.json({ ok: true, active: true, path: status.path, bootId: status.bootId });
  setPendingLocalTokenRequest(reason);
  return res.status(202).json({ ok: true, pending: true, path: status.path, bootId: status.bootId });
});

app.post('/local-orchestrate/session/:id/send', async (req, res) => {
  if (!isLocalLoopbackRequest(req)) return res.status(403).json({ error: 'local only' });
  if (pendingLocalOrchestrateApproval) {
    return res.status(409).json({ error: 'another local handoff is pending approval' });
  }

  const previousStatus = getLocalTokenStatus();
  const approvalId = crypto.randomBytes(12).toString('base64url');
  pendingLocalOrchestrateApproval = {
    id: approvalId,
    sessionId: req.params.id,
    requestedAt: Date.now(),
  };

  try {
    const reason = req.body && req.body.reason
      ? String(req.body.reason).slice(0, 160)
      : `send handoff to ${req.params.id}`;
    setPendingLocalTokenRequest(reason);
    const requestedWait = Number(req.body && req.body.waitMs);
    const waitMs = Number.isFinite(requestedWait)
      ? Math.max(0, Math.min(requestedWait, 120_000))
      : 90_000;
    const previousIssuedAt = previousStatus.issuedAt || 0;
    const status = await waitForLocalToken(waitMs, { afterIssuedAt: previousIssuedAt });

    const freshApproval = status.active && (status.issuedAt || 0) > previousIssuedAt;
    if (!freshApproval || !pendingLocalOrchestrateApproval || pendingLocalOrchestrateApproval.id !== approvalId) {
      return res.status(403).json({
        ok: false,
        error: 'local orchestration authorization required',
        needLocalAuthorization: true,
        pending: true,
        path: status.path,
        bootId: status.bootId,
      });
    }

    return handleSessionSend(req, res);
  } finally {
    if (pendingLocalOrchestrateApproval && pendingLocalOrchestrateApproval.id === approvalId) {
      pendingLocalOrchestrateApproval = null;
    }
  }
});

// Stop hook 呼叫：觸發所有已連線瀏覽器立即刷新用量卡（無需 session）。
// 防護：loopback IP + 拒任何 reverse-proxy 標頭（Tailscale Funnel 會 proxy
// 成 127.0.0.1 連線使單純 IP 檢查失效；含 X-Forwarded-*/Forwarded/Via 即視為
// 經過 proxy，一律拒）。
app.post('/usage/notify', (req, res) => {
  const ip = req.socket.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'local only' });
  }
  const proxyHeaders = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
                       'x-real-ip', 'forwarded', 'via'];
  if (proxyHeaders.some(h => req.headers[h])) {
    return res.status(403).json({ error: 'local only' });
  }
  const bodyEntry = usageEntryFromBody(req.body);
  const entry = bodyEntry || readLatestUsageEntry('claude');
  let ingestResult = null;
  if (entry && entry.engine === 'claude') {
    ingestResult = refreshNativeSessions('usage-notify');
    if (ingestResult.ok && ingestResult.added) {
      broadcast({ type: 'sessions', data: ingestResult.sessions });
    }
  }
  const result = appendUsageNotification(entry);
  broadcast({ type: 'usage_update' });
  res.json({ ok: true, ...result, ingested: ingestResult ? ingestResult.added : 0 });
});

function startupGateBypass(req) {
  const p = req.path || '/';
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (p === '/' || p === '/index.html') return true;
    if (path.extname(p)) return true;
  }
  return false;
}

app.use((req, res, next) => {
  if (startupGateBypass(req)) return next();
  return requireStartupVerified(req, res, next);
});

// 以下路由 L1（Tailscale Serve）已驗身份；危險動作另靠 action-token 升權。

// 撤銷本機編排 token：post-gate（降權動作，要求呼叫者已驗身—cookie 或本機 token—
// 以免 tailnet 匿名端 DoS 掉本機授權）。
app.get('/local-token/status', handleLocalTokenStatus);
app.get('/local-token/request/pending', (req, res) => {
  const pending = getPendingLocalTokenRequest();
  res.json({ ok: true, pending: !!pending, ...(pending || {}) });
});
app.post('/local-token/request/clear', (req, res) => {
  pendingLocalTokenRequest = null;
  res.json({ ok: true });
});
app.post('/local-token/revoke', handleLocalTokenRevoke);

// ── 協定 §F ────────────────────────────────────────────────────────────────
app.get('/dirs', (req, res) => {
  // path 供前端把 session 絕對 cwd 對映回專案 chip（plan §H）
  res.json(DIRS.map(d => {
    const resolved = path.resolve(d.path);
    const linkedWorktree = isLinkedGitWorktree(resolved);
    return {
      alias: d.alias,
      label: d.label || d.alias,
      path: resolved,
      linkedWorktree,
      codexWriteAllowed: true,
    };
  }));
});

app.get('/sessions', (req, res) => {
  res.json(sessionsArr());
});

app.post('/sessions/refresh', (req, res) => {
  const result = refreshNativeSessions('api');
  if (!result.ok) return res.status(500).json({ error: result.error || 'native refresh failed' });
  broadcast({ type: 'sessions', data: result.sessions });
  res.json(result);
});

app.get('/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const tail = parseInt(req.query.tail || '0', 10);
  res.json({
    ...sessionsArr().find(m => m.id === s.id),
    messages: loadMessages(s.id, tail > 0 ? tail : 0),
  });
});

app.get('/all-messages', (req, res) => {
  // 凍結的次要混合檢視（plan §F）
  const all = [];
  for (const s of sessions.values()) {
    for (const m of loadMessages(s.id, 0)) all.push({ ...m, sessionId: s.id, name: s.name });
  }
  all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  res.json(all.slice(-500));
});

// 用量監測（概念對齊 aqua5230/usage）：5h/7d 訂閱配額 + 今日 token/cost + 7 日趨勢 + Codex
app.get('/usage', (req, res) => {
  try {
    res.json(getUsage({ force: req.query.force === '1' }));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// Restart the current Node server; ahr_wrapper.ps1 / Scheduled Task brings it back.
app.post('/server/restart', (req, res) => {
  if (!verifyActionToken(req, res, { action: 'restart' })) return;
  audit(req, true, 'restart');
  res.json({ ok: true, restarting: true });
  const timer = setTimeout(() => {
    console.error('[agent-hub-remote] restart requested from UI');
    server.close(() => process.exit(0));
    const hardExit = setTimeout(() => process.exit(0), 1500);
    hardExit.unref();
  }, 250);
  timer.unref();
});

// 開新 session（plan §A：無 id = 在指定 cwd 開新）
app.post('/sessions', (req, res) => {
  const { text, cwd: alias, agentType, model, autoAllow } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
  const cwd = resolveCwd(alias);
  if (!cwd) return res.status(400).json({ error: `未知專案 alias: ${alias}` });
  const at = agentType === 'codex' ? 'codex' : 'claude';

  if (autoAllow && !allowAutoModeAction(req, res, 'create-with-autoallow')) return;
  const writeGuard = codexWriteGuard(at, cwd, !!autoAllow);
  if (writeGuard) {
    return res.status(409).json({ error: writeGuard, needWorktree: true });
  }

  const s = createSession({
    name: String(text).trim().slice(0, 35),
    agentType: at, cwd, model: model || null,
    autoAllow: !!autoAllow,
  });
  if (autoAllow) audit(req, true, 'autoallow-on', `new-session ${s.id}`);

  const ts = appendMsg(s, { role: 'user', text: String(text) });
  broadcast({ type: 'msg', id: s.id, ts, text: String(text), fromUser: true });
  broadcast({ type: 'sessions', data: sessionsArr() });
  runEngine(s, String(text), { broadcast, isResumeTap: false })
    .catch(e => console.error('[agent-hub-remote] runEngine 失敗', e));

  res.json({ sessionId: s.id });
});

// 上傳圖片到暫存目錄，回傳絕對路徑供 Claude Read 工具讀取
app.post('/session/:id/upload', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const { base64, filename, type, size } = req.body || {};
  if (!base64 || typeof base64 !== 'string') return res.status(400).json({ error: 'base64 required' });

  const originalName = sanitizeUploadName(filename);
  const ext = path.extname(originalName) || '.bin';
  const stem = path.basename(originalName, ext).slice(0, 48) || 'attachment';
  const name = `ahr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${stem}${ext}`;
  const dest = path.join(AHR_MEDIA_DIR, name);
  try {
    const data = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
    const buf = Buffer.from(data, 'base64');
    fs.mkdirSync(AHR_MEDIA_DIR, { recursive: true });
    fs.writeFileSync(dest, buf);
    cleanupExpiredUploads();
    res.json({
      path: dest,
      name: originalName,
      type: typeof type === 'string' ? type.slice(0, 120) : '',
      size: Number.isFinite(size) ? size : buf.length,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// 續送既有 session（plan §A/#4：唯一接回既有對話的路徑 = 點 UI → 此路由）
app.post('/session/:id/live-input', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const { text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
  if (!s.proc) return res.status(409).json({ error: 'session is not running' });
  if (!canAcceptLiveInput(s)) {
    return res.status(409).json({ error: 'running session does not support live input for this engine' });
  }

  const liveText = String(text);
  if (!writeLiveInput(s, liveText)) {
    return res.status(409).json({ error: 'live input channel is closed' });
  }
  const ts = appendMsg(s, { role: 'user', kind: 'live-input', text: liveText });
  applyRetention();
  broadcast({ type: 'msg', id: s.id, ts, text: liveText, fromUser: true, kind: 'live-input' });
  broadcast({ type: 'sessions', data: sessionsArr() });
  res.json({ ok: true, live: true });
});

app.post('/session/:id/compact', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.proc) return res.status(409).json({ error: 'session is running' });

  const messages = loadMessages(s.id, 0);
  const convo = conversationMessages(messages);
  if (convo.length < 2) return res.status(400).json({ error: 'not enough conversation to compact' });

  const transcript = conversationText(convo);
  const summary = await summarizeForSession(transcript, s);
  if (!summary) return res.status(500).json({ error: 'compact summary failed' });

  const resetMeta = contextResetMeta(s, { op: 'compact' });
  appendContextControl(s, {
    op: 'compact',
    context: summary,
    contextMode: 'summary',
    contextReset: resetMeta,
    text: 'Session compacted. The next turn will start a new engine thread from this summary.',
  });
  applyContextReset(s, { text: summary, mode: 'compact', op: 'compact', resetOnly: false }, resetMeta);
  broadcast({ type: 'sessions', data: sessionsArr() });
  broadcast({ type: 'thread_reload', id: s.id });
  res.json(actionPayload(s));
});

app.get('/session/:id/rewind', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const messages = loadMessages(s.id, 0);
  const idx = userTurnIndices(messages);
  res.json({
    ok: true,
    turns: idx.map((i, n) => ({
      n: n + 1,
      text: String(messages[i].text || '').replace(/\s+/g, ' ').slice(0, 240),
    })),
  });
});

app.post('/session/:id/rewind', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.proc) return res.status(409).json({ error: 'session is running' });

  const turn = Number(req.body && req.body.turn);
  const messages = loadMessages(s.id, 0);
  const idx = userTurnIndices(messages);
  if (!idx.length) return res.status(400).json({ error: 'no user turns to rewind' });
  if (!Number.isInteger(turn) || turn < 1 || turn > idx.length) {
    return res.status(400).json({ error: `turn must be between 1 and ${idx.length}` });
  }

  const kept = messages.slice(0, idx[turn - 1]);
  const ctx = await contextForMessages(kept, s);
  if (!ctx) return res.status(500).json({ error: 'rewind summary failed' });

  const keptTurns = turn - 1;
  const modeText = ctx.mode === 'summary' ? 'summary' : (ctx.mode === 'transcript' ? 'transcript' : 'empty context');
  const resetMeta = contextResetMeta(s, { op: 'rewind', turn });
  appendContextControl(s, {
    op: 'rewind',
    turn,
    context: ctx.context,
    contextMode: ctx.mode,
    contextReset: resetMeta,
    text: keptTurns
      ? `Rewound before turn #${turn}. Kept turns #1-#${keptTurns} as ${modeText}; the next turn starts a new engine thread.`
      : `Rewound to the beginning before turn #${turn}. The next turn starts a new engine thread with no prior context.`,
  });
  applyContextReset(s, {
    text: ctx.context,
    mode: ctx.mode,
    op: 'rewind',
    resetOnly: !ctx.context,
  }, resetMeta);
  broadcast({ type: 'sessions', data: sessionsArr() });
  broadcast({ type: 'thread_reload', id: s.id });
  res.json(actionPayload(s));
});

function handleSessionSend(req, res) {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.proc) return res.status(409).json({ error: '此 session 仍在執行中' });
  const { text, agentType, model, imagePaths, files } = req.body || {};
  const hasText = text && String(text).trim();
  const attachments = [
    ...(Array.isArray(files) ? files : []),
    ...(Array.isArray(imagePaths) ? imagePaths : []),
  ].map(normalizeAttachedFile).filter(Boolean);
  const hasFiles = attachments.length > 0;
  if (!hasText && !hasFiles) return res.status(400).json({ error: 'text or files required' });

  // 選項面板（plan §H）：可中途切引擎/model。切引擎 → engines.js 偵測
  // lastEngine≠engine 觸發跨模型 bridge（plan §A2），不需額外旗標。
  const nextAgentType = agentType === 'codex'
    ? 'codex'
    : (agentType === 'claude' ? 'claude' : s.agentType);
  const writeGuard = codexWriteGuard(nextAgentType, s.cwd, !!s.autoAllow);
  if (writeGuard) {
    return res.status(409).json({ error: writeGuard, needWorktree: true });
  }
  if (agentType === 'claude' || agentType === 'codex') s.agentType = agentType;
  if (typeof model === 'string') s.model = model || null;

  s.archived = false;   // 重新活躍
  const pendingContext = pendingContextFromControls(s);
  if (pendingContext) s.pendingContext = pendingContext;

  // 禁止無脈絡開新（使用者硬性要求）：同引擎續接但原生 resume 失效時，先阻擋並
  // 徵得同意，再改走 bridge 接續；絕不靜默開無脈絡新對話。在 append 使用者訊息前
  // 攔截，被擋下的訊息不落盤、同意後重送才寫入一次。
  const hasHistory = loadMessages(s.id, 0).some(m => m.role === 'user' || m.role === 'assistant');
  const plan = continuationPlan(s, {
    engine: nextAgentType,
    hasHistory,
    confirmBridge: !!(req.body && req.body.confirmBridge),
    pendingContext: !!s.pendingContext,
  });
  if (plan.gate) {
    return res.status(409).json({
      error: '上一輪原生續接（resume）失敗，無法直接接續。要用前文脈絡（bridge）接續這條對話嗎？（不會無脈絡開新）',
      needBridgeConsent: true,
    });
  }

  // Attach uploaded local file paths to the prompt so the engine can read them.
  const safeText = hasText ? String(text) : '';
  const fileSection = hasFiles
    ? '\n\nAttached local files are available for this turn. Use the Read tool or shell commands to inspect them before answering when relevant:\n'
      + attachments.map(f => {
        const details = [f.name, f.type, f.size != null ? `${f.size} bytes` : null].filter(Boolean).join(', ');
        return `- ${f.path}${details ? ` (${details})` : ''}`;
      }).join('\n')
    : '';
  const displayText = safeText + (hasFiles ? `\n[files: ${attachments.length}]` : '');

  const ts = appendMsg(s, { role: 'user', text: displayText });
  applyRetention();
  broadcast({ type: 'msg', id: s.id, ts, text: displayText, fromUser: true });
  broadcast({ type: 'sessions', data: sessionsArr() });
  runEngine(s, safeText + fileSection, { broadcast, isResumeTap: true, forceBridge: plan.forceBridge })
    .catch(e => console.error('[agent-hub-remote] runEngine 失敗', e));

  res.json({ ok: true });
}

app.post('/session/:id/send', handleSessionSend);

app.post('/session/:id/cancel', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.proc) {
    s.cancelled = true;
    killTree(s.proc);
  }
  res.json({ ok: true });
});

app.post('/session/:id/rename', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const name = req.body && req.body.name;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  s.name = String(name).trim().slice(0, 80);
  s.updatedAt = Date.now();
  persistIndex();
  broadcast({ type: 'sessions', data: sessionsArr() });
  res.json({ ok: true });
});

// 切某 session autoAllow（spec §5.4：開啟需 action-token；本機編排 token 可代替；
// 關閉直接放行）
app.post('/session/:id/autoallow', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const on = !!(req.body && req.body.on);
  if (on && !allowAutoModeAction(req, res, 'autoallow-on', s.id)) return;
  const writeGuard = codexWriteGuard(s.agentType, s.cwd, on);
  if (writeGuard) {
    return res.status(409).json({ error: writeGuard, needWorktree: true });
  }
  s.autoAllow = on;
  audit(req, true, on ? 'autoallow-on' : 'autoallow-off', s.id);
  persistIndex();
  broadcast({ type: 'sessions', data: sessionsArr() });
  res.json({ ok: true, autoAllow: s.autoAllow });
});

// 前端（Claude Design 產出後置於 ./public/index.html）。尚未交接時給佔位頁。
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (/\.(?:html|css|js|jsx)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.get('/', (req, res) => {
  const idx = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.type('html').send(
    '<!DOCTYPE html><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="background:#141414;color:#d4d4d4;font:16px/1.6 monospace;padding:24px">' +
    '<h1>agent-hub-remote</h1><p>Backend is ready (port ' + PORT + '). Frontend is served from <code>public/index.html</code>.</p>' +
    '<p>Routes: <code>GET /dirs</code> <code>GET /sessions</code> <code>POST /sessions</code></p></body>');
});

// Bind loopback by default. Tailscale Serve forwards tailnet traffic here.
server.listen(PORT, BIND_HOST, () => {
  recoverInterruptedSessions();
  refreshNativeSessions('startup');
  console.log(`[agent-hub-remote] listening http://${BIND_HOST}:${PORT}`);
  console.log(`[agent-hub-remote] 專案登錄: ${DIRS.map(d => d.alias).join(', ')}`);
  if (startupOrphans.length) console.log(`[agent-hub-remote] 已收屍 ${startupOrphans.length} 個重啟前孤兒`);
  startUsageApiPoller();
});

// 自身被 kill 前，殺掉所有子進程避免孤兒（搭配 #6 PID 持久化雙保險）
function reapChildren() {
  for (const s of sessions.values()) if (s.proc) killTree(s.proc);
}
process.on('SIGINT', () => { reapChildren(); process.exit(0); });
process.on('SIGTERM', () => { reapChildren(); process.exit(0); });
