// 引擎層：spawn claude / codex + 跨模型 bridge（plan §二-A、§A2、§三-3、#5 #6）
//
// 身分模型（#5）：session.id 是身分；engineRefs{claude,codex} 是各引擎原生
//   resume 指標。lastEngine = 上一輪實際跑的引擎。
// resume（#4）：原生 resume 只在「同引擎且 engineRefs[engine] 有值」時發生；
//   無 --continue fallback；resume 失敗明示錯誤、不靜默接錯。
// 跨模型（§A2）：跨引擎時不接對方舊原生 thread，一律從 messages[] 重 bridge
//   —— ≤2 輪全文轉錄；>2 輪委派 Gemma 摘要（gemma.js）。注入新引擎首 prompt。
// Codex 防護（§三-3 / #12）：Windows 無 OS 沙箱，不靠 --sandbox；危險旗標只在
//   session.autoAllow=true 時帶（toggle 開啟需 action-token，spec §5.4），否則走
//   codex exec 預設 approval（非互動 → 自動拒絕）。實作期驗證 codex 0.128.0 旗標名
//   （見 memory reference_codex_cli）。

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { absorbHubMessages, appendMsg, loadMessages, persistIndex, removeSession, sessions, sessionsArr } from './store.js';
import { summarize } from './gemma.js';
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
import { formatClaudeToolResult, formatClaudeToolUse, formatCodexCommandExecution } from './tool-display.js';

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

const BRIDGE_TRANSCRIPT_MAX_TURNS = 2;   // ≤2 輪全文轉錄，>2 走 Gemma 摘要（plan §A2）
const CLAUDE_MODELS = new Set(['sonnet', 'opus', 'haiku']);   // 防跨引擎 model carry-over（見 buildEngine 內濾）
// fable5 目前不可用：預設與 fallback 鏈改回 sonnet -> opus -> haiku（owner 決策 2026-06-13）
const CLAUDE_MODEL_PRIORITY = ['sonnet', 'opus', 'haiku'];
const CODEX_UNSUPPORTED_MODELS = new Set(['gpt-5-codex']);

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

// Workspace-specific bootstrap injected ahead of the first codex prompt is
// intentionally NOT baked into the source — it carries local paths and private
// workflow rules. Configure it via a gitignored `codex-bootstrap.local.json`
// (or `AHR_CODEX_BOOTSTRAP_CONFIG`); absent config means no injection.
// Format: an object or array of `{ "workspaceRoot": "~/path", "bootstrap": "..." }`.
// `bootstrap` should end with a `\n---` separator so ingest can strip it back off.
function loadCodexWorkspaceConfigs({ homeDir = os.homedir(), configPath } = {}) {
  const file = configPath
    || process.env.AHR_CODEX_BOOTSTRAP_CONFIG
    || path.join(codexBootstrapDir, 'codex-bootstrap.local.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .map((entry) => ({
      root: expandHome(entry && entry.workspaceRoot, homeDir),
      bootstrap: entry && typeof entry.bootstrap === 'string' ? entry.bootstrap : '',
    }))
    .filter((e) => e.root && e.bootstrap);
}

export function codexWorkspaceBootstrap(cwd, opts = {}) {
  if (!cwd) return '';
  const configs = loadCodexWorkspaceConfigs(opts);
  for (const cfg of configs) {
    if (isPathInside(cfg.root, cwd)) return cfg.bootstrap;
  }
  return '';
}

export function codexPromptForSession(session, prompt, opts = {}) {
  const bootstrap = codexWorkspaceBootstrap(session?.cwd, opts);
  return bootstrap ? `${bootstrap}\n\n${prompt}` : prompt;
}

function normalizedModelArg(engine, model) {
  const raw = model && model !== 'default' ? String(model) : null;
  if (!raw) return null;
  if (engine === 'codex') {
    const lower = raw.toLowerCase();
    if (CLAUDE_MODELS.has(lower) || /^claude-/i.test(raw)) return null;
    if (CODEX_UNSUPPORTED_MODELS.has(lower)) return null;
    return raw;
  }
  if (/^gpt-/i.test(raw)) return null;
  return raw;
}

export function claudeModelFallbackArgs(modelArg) {
  const current = String(modelArg || '').toLowerCase();
  const idx = CLAUDE_MODEL_PRIORITY.indexOf(current);
  const next = idx >= 0 ? CLAUDE_MODEL_PRIORITY[idx + 1] : null;
  // Claude CLI has one fallback slot; AHR retries the rest of the chain itself.
  return next ? ['--fallback-model', next] : [];
}

export function claudeModelAttemptChain(modelArg) {
  if (!modelArg) return [null];
  const raw = String(modelArg);
  const idx = CLAUDE_MODEL_PRIORITY.indexOf(raw.toLowerCase());
  return idx >= 0 ? CLAUDE_MODEL_PRIORITY.slice(idx) : [raw];
}

export function isClaudeModelStartupFailure(reason) {
  const text = String(reason || '').toLowerCase();
  return /\bmodel\b/.test(text) && (
    /not available|not exist|does not exist|not found|no access|not have access|do not have access/.test(text) ||
    /overloaded|unavailable|selected model|fallback model/.test(text)
  );
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
    // quota 有資料：顯示 5h/7d 訂閱配額百分比（使用者偏好格式）
    parts.push(`Claude ${[sessionPct && `5h ${sessionPct}`, weeklyPct && `7d ${weeklyPct}`].filter(Boolean).join(' / ')}`);
  } else {
    // fallback：statusLine 未含配額欄位時，顯示今日 token/cost/turns
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

// 由持久化 messages[] 抽脈絡（plan §A2，hub 統一來源、天然跨引擎）。
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

// 回傳 { preamble, note } —— preamble 前置到新引擎首 prompt；note 落 feed 系統訊息。
async function buildBridge(session, fromEngine, toEngine) {
  // server 已先 append 當前這則 user 訊息；bridge 只取「之前」的歷史，
  // 否則新問題會同時混進脈絡又被當新訊息接在後面（重複 + 門檻 off-by-one）。
  // Native sessions render from original JSONL, so the runtime cache can be
  // empty even when the UI shows history. Bridge from the same loader used by
  // GET /session/:id so cross-engine inheritance matches the visible thread.
  const msgs = bridgeMessagesForSession(session);
  const priorRaw = msgs.length && msgs[msgs.length - 1].role === 'user'
    ? msgs.slice(0, -1) : msgs;
  const prior = projectContextMessages(priorRaw);
  const turns = collectTurns(prior);
  if (!turns.length) return { preamble: '', note: null };
  const userTurns = turns.filter(t => t.role === 'user').length;

  const flat = turns.map(t => {
    const label = t.role === 'context'
      ? 'Context summary'
      : (t.role === 'user' ? 'User' : (fromEngine === 'codex' ? 'Codex' : 'Claude'));
    return `${label}: ${t.text}`;
  }).join('\n\n');

  let body, how;
  // toEngine=codex 一律全文：codex 沒有原生跨引擎接續，摘要漏脈絡的代價遠大於 prompt 長度。
  // toEngine=claude 維持 ≤2 全文 / >2 Gemma 摘要（plan §A2）。
  if (toEngine === 'codex' || userTurns <= BRIDGE_TRANSCRIPT_MAX_TURNS) {
    body = flat;
    how = '全文轉錄';
  } else {
    const sum = await summarize(flat);
    if (sum) { body = sum; how = 'Gemma 摘要'; }
    else { body = flat.slice(-12000); how = '轉錄（摘要不可用，截尾）'; }
  }

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

// 純函式：判定一條既有 session 這一輪該如何接續（供 server.js /send gate + 測試）。
// 硬性不變式：有前文的 session 絕不無脈絡開新（使用者要求）。回傳：
//   resume      —— 可原生 resume（同引擎 + 有指標 + 未標記 resume 失敗）
//   forceBridge —— 不能原生 resume 但有前文 → 必須用 messages[] 重建脈絡接續
//   gate        —— 須先阻擋並徵得同意（原生 resume 曾失敗且尚未同意 bridge）
// pendingContext（rewind/compact）/ 跨引擎 / 全新無前文：三者皆 false，
// 交由 runEngine 既有分支（pendingContextPreamble / 跨引擎 bridge / 開新）處理。
export function continuationPlan(session, { engine, hasHistory, confirmBridge = false, pendingContext = false }) {
  const sameEngine = session.lastEngine === engine;
  const canNativeResume = sameEngine && !!session.engineRefs?.[engine] && !session._resumeFailed;
  if (pendingContext || !sameEngine || !hasHistory || canNativeResume) {
    return { resume: canNativeResume, forceBridge: false, gate: false };
  }
  // 同引擎 + 有前文 + 無法原生 resume
  if (session._resumeFailed && !confirmBridge) {
    return { resume: false, forceBridge: false, gate: true };
  }
  return { resume: false, forceBridge: true, gate: false };
}

// 主入口。server 已先 append 使用者訊息。
//   opts: { broadcast, isResumeTap, forceBridge }
//   isResumeTap：使用者續送既有 session（plan #4）。
//   forceBridge：server gate（continuationPlan）判定無法原生 resume——resume 曾
//     失敗且已同意，或同引擎但無原生指標——要求改用 messages[] 重建脈絡接續。
//     硬性不變式：有前文者絕不無脈絡開新（claude / codex 同一套，無特例）。
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
    // The twin's hub JSONL may already hold hub-appended messages. Merge them into the
    // owner before deleting the log so removeSession(deleteLog:true) can't drop them.
    movedMessages = absorbHubMessages(nativeId, session);
    removedTwin = removeSession(nativeId, { deleteLog: true });
  }
  return { changed: previous !== nativeId, previous, current: nativeId, removedTwin, movedMessages };
}

export async function runEngine(session, userText, opts) {
  const { broadcast, isResumeTap = false, forceBridge = false } = opts;
  const engine = session.agentType === 'codex' ? 'codex' : 'claude';
  // autoAllow toggle 由 action-token 把關（spec §5.4）；toggle 開啟後即視為 danger。
  const danger = !!session.autoAllow;

  // ── 決定 resume vs bridge vs 全新 ──
  let nativeResumeId = null;
  let preamble = '';
  let claudeSessionIdOverride = null;
  const pendingContext = session.pendingContext || null;
  const prevEngine = pendingContext ? null : session.lastEngine;
  session._usedNativeResume = false;   // 本輪是否走原生 resume（close handler 判 resume 失敗用）
  delete session._expectedClaudeSessionId;

  if (pendingContext) {
    preamble = pendingContextPreamble(pendingContext);
    session.pendingContext = null;
    session.engineRefs = { claude: null, codex: null };
    session.lastEngine = null;
    persistIndex();
  } else if (prevEngine && prevEngine !== engine) {
    // 跨引擎：一律重 bridge，不接對方舊原生 thread（plan §A2）
    const { preamble: pre, note } = await buildBridge(session, prevEngine, engine);
    preamble = pre;
    if (note) {
      const ts = appendMsg(session, { role: 'system', text: note });
      broadcast({ type: 'msg', id: session.id, ts, text: note, engine });
    }
  } else if (isResumeTap && session.engineRefs[engine] && !forceBridge) {
    // 同引擎 + 有原生指標 + 未被要求改 bridge → 原生 resume
    nativeResumeId = session.engineRefs[engine];
    session._usedNativeResume = true;
  } else if (forceBridge) {
    // 同引擎但無法原生 resume（resume 失效已同意 / 同引擎無原生指標）。
    // 一律從 messages[] 重建脈絡接續，禁止無脈絡開新（使用者硬性要求）。
    const { preamble: pre } = await buildBridge(session, engine, engine);
    preamble = pre;
    // pre 為空 = 實際無前文 → 本就是新對話，安全；有前文才落提示。
    if (pre) {
      const note = '↪ 原生續接無法使用，已用前文脈絡（bridge）接續這條對話';
      const ts = appendMsg(session, { role: 'system', text: note });
      broadcast({ type: 'msg', id: session.id, ts, text: note, engine });
    }
    // 失效的原生指標作廢；新進程回報的 session_id 會成為新的 engineRefs[engine]。
    session.engineRefs[engine] = null;
    session._resumeFailed = false;
  }
  if (shouldStartFreshClaudeThread({ engine, pendingContext: !!pendingContext, prevEngine, forceBridge })) {
    claudeSessionIdOverride = crypto.randomUUID();
  }
  // 其餘 = 真‧無前文的新 session → 開新（continuationPlan 保證不會讓有前文者走到這）

  session.status = 'running';
  session.lastEngine = engine;
  const autoCommitBaseline = engine === 'codex' ? captureGitSnapshot(session.cwd) : null;
  broadcast({ type: 'sessions', data: sessionsArr() });

  const fullPrompt = preamble + userText;
  // workspace bootstrap 只注入新 codex thread；原生 resume 的 thread 首輪已含同段內容
  const enginePrompt = engine === 'codex' && !nativeResumeId
    ? codexPromptForSession(session, fullPrompt)
    : fullPrompt;
  const spawnEnv = { ...process.env };
  delete spawnEnv.ANTHROPIC_API_KEY;   // 走訂閱 OAuth，勿用 API key（memory）

  // 'default' 哨兵（或空）= 用引擎帳號預設 model，不送 -m/--model。
  // data.js 已正規化;此處再防一道（codex ChatGPT 帳號送 gpt-5-codex/claude 名 → 400）。
  // 跨引擎切換 session.model 不會 reset（server.js 只在使用者主動改才覆寫），
  // 所以這裡按引擎相容濾：claude 模型名餵給 codex / gpt 模型名餵給 claude，皆退回帳號預設。
  const modelArg = normalizedModelArg(engine, session.model);

  let bin;
  const claudeModelAttempts = engine === 'claude' ? claudeModelAttemptChain(modelArg) : [modelArg];

  function startProcess(activeModelArg = modelArg, modelAttemptIndex = 0) {
  let args;
  if (engine === 'claude') {
    args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    if (danger) args.push('--dangerously-skip-permissions');
    if (activeModelArg) args.push('--model', activeModelArg, ...claudeModelFallbackArgs(activeModelArg));
    const identity = claudeSessionIdentityArgs(session, nativeResumeId, { sessionIdOverride: claudeSessionIdOverride });
    args.push(...identity.args);
    if (identity.expectedSessionId) {
      session.engineRefs ||= { claude: null, codex: null };
      session.engineRefs.claude = identity.expectedSessionId;
      session._expectedClaudeSessionId = identity.expectedSessionId;
    }
    bin = 'claude';
  } else {
    // Codex §三-3 / #12（codex 0.130.0 實測 `codex exec --help`）：
    //   exec 無 --ask-for-approval 旗標；sandbox 以 -s <mode> 設定
    //   [read-only|workspace-write|danger-full-access]。
    //   未 elevate → -s read-only；非 TTY spawn → 需批准的命令自動拒絕。
    //   elevate 且 autoAllow → bypass 全開。
    const base = ['--json', '--skip-git-repo-check'];
    if (nativeResumeId) {
      // exec resume 無 -s flag；危險旗標只有 --dangerously-bypass；
      // 非 danger 路徑依賴非 TTY spawn 自動拒批准（無控台 → approval 超時拒絕）。
      const resumeGuard = danger ? ['--dangerously-bypass-approvals-and-sandbox'] : [];
      args = ['exec', 'resume', nativeResumeId, ...resumeGuard, ...base];
    } else {
      // exec -s <mode> 明確指定沙箱等級（codex exec --help 0.130.0）
      const execGuard = danger
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['-s', 'read-only'];
      args = ['exec', ...execGuard, ...base];
      if (modelArg) args.push('-m', modelArg);
    }
    bin = 'codex';
  }

  const proc = spawn(bin, args, {
    shell: true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: session.cwd,
    env: spawnEnv,
  });
  session.proc = proc;
  session._activeEngine = engine;
  session._acceptsLiveInput = engine === 'claude';
  session._endingInput = false;
  // 本輪實際服務的 model（含 fallback 降級後的當前 attempt）；每次 spawn/retry 都覆寫，
  // 不持久化、不汙染使用者選定的 session.model（見下方 retry block）。供 usage 歸因用。
  session._activeModel = activeModelArg ?? null;
  session.pid = proc.pid;       // 持久化 PID 供重啟收屍（plan #6）
  persistIndex();

  if (engine === 'claude') {
    proc.stdin.write(claudeUserLine(enginePrompt), 'utf8');
  } else {
    proc.stdin.write(enginePrompt, 'utf8');
    proc.stdin.end();
  }

  let buf = '';
  session._claudeTurnUsage = null;
  session._codexTurnUsage = null;
  session._emittedText = false;   // 本輪是否已輸出過 assistant 文字（result 兜底去重）
  session._stderrBuf = '';        // 本輪 stderr 緩衝；只在 code≠0 時當診斷（見下）
  session._codexTextBuf = '';     // Codex 非 JSON stdout 緩衝（error 診斷）

  function onClaudeEvent(ev) {
    let identityChanged = false;
    let removedNativeTwin = false;
    if (ev.session_id) {
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
    if (ev.type === 'assistant') {
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          session._emittedText = true;
          const ts = appendMsg(session, { role: 'assistant', engine, text: block.text });
          broadcast({ type: 'msg', id: session.id, ts, text: block.text, engine });
        } else {
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
        const toolText = formatClaudeToolResult(block);
        if (toolText) {
          const ts = appendMsg(session, { role: 'system', kind: 'tool-diff', engine, text: toolText });
          broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'tool-diff', text: toolText, engine });
        }
      }
    }
    if (ev.type === 'result' && ev.subtype === 'error') {
      const ts = appendMsg(session, { role: 'error', engine, text: ev.error ?? 'error' });
      broadcast({ type: 'msg', id: session.id, ts, text: `⚠️ ${ev.error ?? 'error'}`, error: true, engine });
    }
    // result-only 回覆（trivial prompt 不發 assistant 事件，只給最終 result 字串）
    // 兜底：避免內容遺失。已由 assistant 事件輸出過的內容，這裡用 _emitted 去重。
    if (ev.type === 'result' && ev.subtype === 'success'
        && typeof ev.result === 'string' && ev.result.trim()
        && !session._emittedText) {
      const ts = appendMsg(session, { role: 'assistant', engine, text: ev.result });
      broadcast({ type: 'msg', id: session.id, ts, text: ev.result, engine });
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
    if (ev.type === 'thread.started' && ev.thread_id) {
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
      return;
    }
    if (ev.type === 'item.completed') {
      const msg = fmtCodexItem(ev.item);
      if (msg) {
        session._emittedText = true;
        const ts = appendMsg(session, { role: msg.role, kind: msg.kind, engine, text: msg.text });
        broadcast({ type: 'msg', id: session.id, ts, role: msg.role, kind: msg.kind, text: msg.text, engine });
      }
    }
    // Codex error events（thread.failed / error / ...）→ 顯示並保存診斷
    if (ev.type === 'error' || ev.type === 'thread.failed' || ev.type === 'exec.failed') {
      const msg = ev.message || ev.error || ev.reason || JSON.stringify(ev);
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
          const ts = appendMsg(session, { role: 'assistant', engine, text: line });
          broadcast({ type: 'msg', id: session.id, ts, text: line, engine });
        } else {
          // Codex 非 JSON stdout 緩衝，供 non-zero exit 時診斷
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
        const ts = appendMsg(session, { role: 'assistant', engine, text: buf });
        broadcast({ type: 'msg', id: session.id, ts, text: buf, engine });
      }
    }
    buf = '';
  });

  // stderr ≠ 錯誤訊號：codex / claude --verbose 會把良性進度與提示
  // （如 "Reading prompt from stdin..."）寫到 stderr。只緩衝、尾端截斷，
  // 不即時當紅字廣播；真失敗時由 close handler（code≠0）當診斷回收。
  // 對齊 legacy codex-runner.js（stderrBuf 緩衝 → 僅 !ok 時當 error）。
  proc.stderr.on('data', chunk => {
    session._stderrBuf = ((session._stderrBuf || '') + chunk.toString()).slice(-4000);
  });

  proc.on('error', err => {
    if (session.proc === proc) {
      session.proc = null; session.pid = null;
      session._activeEngine = null; session._acceptsLiveInput = false; session._endingInput = false;
    }
    session.status = 'error';
    const text = err.code === 'ENOENT'
      ? `⚠️ ${bin} 找不到（未安裝或不在 PATH）`
      : `⚠️ ${err.message}`;
    const ts = appendMsg(session, { role: 'error', engine, text });
    broadcast({ type: 'msg', id: session.id, ts, text, error: true, engine });
    broadcast({ type: 'sessions', data: sessionsArr() });
    broadcast({ type: 'done', id: session.id, ts: Date.now(), code: -1 });
  });

  proc.on('close', code => {
    if (session.proc === proc) {
      session.proc = null; session.pid = null;
      session._activeEngine = null; session._acceptsLiveInput = false; session._endingInput = false;
    }
    const wasCancelled = !!session.cancelled;
    const failureReason = code !== 0
      ? [((session._stderrBuf || '').trim()),
         (engine === 'codex' ? (session._codexTextBuf || '').trim() : '')]
          .filter(Boolean).join('\n').slice(-1000) || `exit ${code}`
      : '';
    if (wasCancelled) {
      session.status = 'idle';
      session.cancelled = false;
      // 跨引擎一致：取消不丟棄原生指標（claude / codex 同一套，無特例）。
      // 下一輪照常先試原生 resume；resume 失敗才由 continuationPlan gate
      // 徵詢同意後改走 bridge。絕不因取消而無脈絡開新。
    } else {
      const nextClaudeModel = engine === 'claude'
        && code !== 0
        && !session._emittedText
        && isClaudeModelStartupFailure(failureReason)
        && modelAttemptIndex < claudeModelAttempts.length - 1
        ? claudeModelAttempts[modelAttemptIndex + 1]
        : null;
      if (nextClaudeModel) {
        const current = activeModelArg || 'default';
        const note = `Claude model ${current} unavailable; retrying ${nextClaudeModel}.`;
        const ts = appendMsg(session, { role: 'system', kind: 'swap', engine, text: note });
        session.status = 'running';
        // 不改寫 session.model：保留使用者選定的 model，避免 incident 後黏在降級 model、
        // 且 UI 選擇器仍顯示原選擇。本輪實際服務 model 由 startProcess 設的 _activeModel 反映，
        // 下一輪仍從原 model 重試（fable 復原後自動回到 fable）。
        broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'swap', text: note, engine });
        broadcast({ type: 'sessions', data: sessionsArr() });
        return startProcess(nextClaudeModel, modelAttemptIndex + 1);
      }
      session.status = code === 0 ? 'idle' : 'error';
      if (code === 0) {
        session._resumeFailed = false;   // 成功一輪即清除 resume 失敗標記
      }
      if (code !== 0) {
        // 不再無條件清空 engineRefs[engine]——那會讓下一輪無脈絡開新（已禁止）。
        // 改為：若本輪是原生 resume 卻失敗 → 標記 _resumeFailed，下一輪由
        // /session/:id/send 的 continuationPlan gate 攔下、徵得同意後改走 bridge。
        // 暫時性錯誤（rate limit / 崩潰）保留指標，下一輪仍可重試原生 resume。
        if (session._usedNativeResume) session._resumeFailed = true;
        // 非零退出 → 補真診斷（對齊 legacy codex-runner.js:136）：
        // 緩衝的 stderr 尾段;無 stderr 時退而求其次 `exit <code>`。
        const reason = failureReason;
        const ts = appendMsg(session, { role: 'error', engine, text: reason });
        broadcast({ type: 'msg', id: session.id, ts, text: `⚠️ ${reason}`, error: true, engine });
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
      try {
        const result = runCodexAutoCommit(autoCommitBaseline);
        const text = formatAutoCommitResult(result);
        if (text) {
          const ts = appendMsg(session, { role: 'system', kind: 'auto-commit', engine, text });
          broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'auto-commit', text, engine });
        }
      } catch (e) {
        const text = `Auto-commit skipped: ${String(e.message || e).slice(0, 240)}`;
        const ts = appendMsg(session, { role: 'system', kind: 'auto-commit', engine, text });
        broadcast({ type: 'msg', id: session.id, ts, role: 'system', kind: 'auto-commit', text, engine });
      }
    }
    if (!wasCancelled && code === 0) {
      _flushRateLimits();   // flush last turn's rate_limit data on session end
      appendUsageSnapshot(session, engine, broadcast, turnUsage);
    }
    session._codexTurnUsage = null;
    session._claudeTurnUsage = null;
    persistIndex();
    broadcast({ type: 'sessions', data: sessionsArr() });
    broadcast({ type: 'done', id: session.id, ts: Date.now(), code });
  });

  return proc;
  }

  return startProcess(claudeModelAttempts[0], 0);
}
