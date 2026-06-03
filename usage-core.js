// usage-core —— 單一用量計算層（agent-hub /usage 與未來 Windows tray 共用邏輯）。
//
// 概念對齊 aqua5230/usage：不打任何 API，只讀 Claude Code / Codex 本機既有檔案。
// 三個來源：
//   1) ~/.claude/usage-status.json  —— statusLine hook 落地的原始 JSON（5h/7d 訂閱配額%）
//   2) ~/.claude/usage-log.jsonl    —— 每 turn token+cost（今日彙總 + 7 日趨勢 + 5h 滾動）
//   3) ~/.codex/sessions/**/*.jsonl —— Codex 對話最後一筆 rate_limits（配額%）
//
// schema 容錯：statusLine / codex 欄位名各版本不一，一律以「深度搜尋 key 名」抓值。

import fs from 'fs';
import os from 'os';
import path from 'path';

const HOME = os.homedir();
const STATUS_JSON = path.join(HOME, '.claude', 'usage-status.json');
const CLAUDE_USAGE_LOG = process.env.AHR_CLAUDE_USAGE_LOG ||
  path.join(HOME, '.claude', 'usage-log.jsonl');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const CODEX_USAGE_LOG = process.env.AHR_CODEX_USAGE_LOG ||
  path.join(HOME, '.codex', 'usage-log.jsonl');
const CREDENTIALS_FILE = path.join(HOME, '.claude', '.credentials.json');
const API_CACHE_FILE = path.join(HOME, '.claude', 'usage-api-cache.json');
const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const API_POLL_MS = 60_000;
const API_CACHE_TTL_MS = 5 * 60_000;

// 訂閱用戶用不到精確金額，僅沿用 usage-tracker 的估算費率（USD / 1M tokens）
const RATES = { input: 3.0, cache_creation: 3.75, cache_read: 0.3, output: 15.0 };

let _cache = { at: 0, data: null };
const CACHE_MS = 15_000;

// ---- 通用：在巢狀 dict/list 遞迴找第一個 key 命中 re 且值為 number 的值 ----
function deepFindNum(obj, re) {
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur && typeof cur === 'object') {
      for (const [k, v] of Object.entries(cur)) {
        if (re.test(String(k)) && typeof v === 'number' && isFinite(v)) return v;
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return null;
}

// 找疑似時間戳（reset / expires）；回傳 epoch ms 或 null
function deepFindResetMs(obj, re) {
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur && typeof cur === 'object') {
      for (const [k, v] of Object.entries(cur)) {
        if (re.test(String(k))) {
          const ms = toMs(v);
          if (ms) return ms;
        }
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return null;
}

function toMs(v) {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000; // s vs ms
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!isNaN(t)) return t;
    const n = Number(v);
    if (isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  }
  return null;
}

function localDateKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normPct(v) {
  if (v == null) return null;
  let f = Number(v);
  if (!isFinite(f)) return null;
  if (f >= 0 && f <= 1) f *= 100;       // 0~1 比例 → %
  return Math.max(0, Math.min(100, Math.round(f * 10) / 10));
}

// ---- 來源 1：statusLine 落地的訂閱配額 ----
function directRateLimit(raw, key) {
  const rl = raw && typeof raw === 'object' ? raw.rate_limits : null;
  const entry = rl && typeof rl === 'object' ? rl[key] : null;
  if (!entry || typeof entry !== 'object') return {};
  return {
    pct: entry.used_percentage ?? entry.used_percent ?? entry.percent_used,
    reset: entry.resets_at ?? entry.reset_at ?? entry.expires_at ?? entry.renews_at,
  };
}

function readClaudeQuotaFromStatusLine() {
  try {
    const j = JSON.parse(fs.readFileSync(STATUS_JSON, 'utf-8'));
    const raw = j.raw ?? j;
    const capturedAt = (j._captured_at ? j._captured_at * 1000 : null);
    const q5 = directRateLimit(raw, 'five_hour');
    const q7 = directRateLimit(raw, 'seven_day');
    const s5 = normPct(q5.pct ?? deepFindNum(raw, /five.?hour|5h|session.*(pct|percent|used|util)|^session$/i));
    const wk = normPct(q7.pct ?? deepFindNum(raw, /seven.?day|week|7d/i));
    const reset5 = toMs(q5.reset) ?? deepFindResetMs(raw, /(five.?hour|5h|session).*(reset|expire|renew)|^resets?_at$/i);
    const resetWk = toMs(q7.reset) ?? deepFindResetMs(raw, /(seven.?day|week|7d).*(reset|expire|renew)/i);
    return {
      available: s5 != null || wk != null,
      session_pct: s5,
      weekly_pct: wk,
      session_reset_ms: reset5,
      weekly_reset_ms: resetWk,
      captured_at: capturedAt,
      stale: capturedAt ? (Date.now() - capturedAt > 3600_000) : true,
      raw_keys: raw && typeof raw === 'object' ? Object.keys(raw) : [],
      source: 'statusline',
    };
  } catch {
    return { available: false, reason: 'usage-status.json 尚未產生（等 Claude Code 狀態列刷新）' };
  }
}

// ---- API source：/api/oauth/usage（同 /usage 指令的資料源） ----
// statusLine 餵的 rate_limits.used_percentage 是「每次 API 回應 header」的快照，
// 跟 in-session /usage 看到的 utilization 不一致（statusLine 常落後甚至顯示 0）。
// 此源由背景 poller 每 60s 抓一次，token 只活在記憶體裡，cache 檔不存 token。
let _apiCacheMem = null;
function loadApiCacheFromDisk() {
  try {
    _apiCacheMem = JSON.parse(fs.readFileSync(API_CACHE_FILE, 'utf-8'));
  } catch {
    _apiCacheMem = null;
  }
  return _apiCacheMem;
}

function readClaudeQuotaFromApiCache() {
  const j = _apiCacheMem || loadApiCacheFromDisk();
  if (!j || !j.captured_at || !j.data) return null;
  const ageMs = Date.now() - j.captured_at;
  if (ageMs > API_CACHE_TTL_MS) return null;
  const d = j.data || {};
  const f5 = d.five_hour || {};
  const f7 = d.seven_day || {};
  const s5 = normPct(f5.utilization);
  const wk = normPct(f7.utilization);
  if (s5 == null && wk == null) return null;
  return {
    available: true,
    session_pct: s5,
    weekly_pct: wk,
    session_reset_ms: toMs(f5.resets_at),
    weekly_reset_ms: toMs(f7.resets_at),
    captured_at: j.captured_at,
    stale: false,
    source: 'api',
  };
}

function readClaudeQuota() {
  const fromApi = readClaudeQuotaFromApiCache();
  if (fromApi) return fromApi;
  return readClaudeQuotaFromStatusLine();
}

// ---- Background poller：把 /api/oauth/usage 結果寫入 cache 檔 ----
let _apiPollerStarted = false;
let _apiPollerWarned = false;
async function fetchUsageFromApi() {
  if (process.env.AHR_USAGE_API_DISABLE === '1') return null;
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
  } catch {
    return null;
  }
  const oauth = creds.claudeAiOauth || {};
  const token = oauth.accessToken;
  if (!token) return null;
  // 過期或 60s 內到期就不發；refresh 留給 Claude CLI 自己處理
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt - Date.now() < 60_000) return null;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(USAGE_API_URL, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (!_apiPollerWarned) {
        console.error(`[usage-api] HTTP ${res.status} from /api/oauth/usage (此訊息只印一次)`);
        _apiPollerWarned = true;
      }
      return null;
    }
    const data = await res.json();
    const payload = { captured_at: Date.now(), data };
    _apiCacheMem = payload;
    try {
      const tmp = API_CACHE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, API_CACHE_FILE);
    } catch {}
    return payload;
  } catch (e) {
    if (!_apiPollerWarned) {
      console.error(`[usage-api] fetch failed: ${e.message} (此訊息只印一次)`);
      _apiPollerWarned = true;
    }
    return null;
  } finally {
    clearTimeout(to);
  }
}

export function startUsageApiPoller() {
  if (_apiPollerStarted) return;
  _apiPollerStarted = true;
  loadApiCacheFromDisk();
  fetchUsageFromApi().catch(() => {});
  const t = setInterval(() => { fetchUsageFromApi().catch(() => {}); }, API_POLL_MS);
  if (t.unref) t.unref();
}

// ---- 來源 2：usage-log.jsonl 的 token/cost 歷史 ----
function readUsageLogFile(logPath) {
  let lines;
  try {
    lines = fs.readFileSync(logPath, 'utf-8').split('\n');
  } catch {
    return { available: false };
  }
  const now = Date.now();
  const dayMs = 86400_000;
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const todayMs = startToday.getTime();

  let todayCost = 0, todayTok = 0, todayTurns = 0;
  let win5hTok = 0, win5hTurns = 0;
  const byDay = {}; // yyyy-mm-dd -> {cost,tok}

  for (const ln of lines) {
    if (!ln) continue;
    let d;
    try { d = JSON.parse(ln); } catch { continue; }
    const ts = Date.parse(d.turn_ts || d.logged_at || 0);
    if (isNaN(ts)) continue;
    const additiveCacheRead = d.cache_read_is_subset ? 0 : (d.cache_read_tokens || 0);
    const fallbackTot = (d.input_tokens || 0) + (d.cache_creation_tokens || 0) +
                additiveCacheRead + (d.output_tokens || 0);
    const tot = typeof d.total_tokens === 'number' ? d.total_tokens : fallbackTot;
    const cost = typeof d.estimated_cost_usd === 'number' ? d.estimated_cost_usd : 0;

    if (ts >= todayMs) { todayCost += cost; todayTok += tot; todayTurns++; }
    if (now - ts <= 5 * 3600_000) { win5hTok += tot; win5hTurns++; }
    if (now - ts <= 7 * dayMs) {
      const key = localDateKey(ts);
      (byDay[key] ??= { cost: 0, tok: 0 });
      byDay[key].cost += cost;
      byDay[key].tok += tot;
    }
  }
  const series = [];
  for (let i = 6; i >= 0; i--) {
    const key = localDateKey(now - i * dayMs);
    const e = byDay[key] || { cost: 0, tok: 0 };
    series.push({ date: key, cost: Math.round(e.cost * 100) / 100, tokens: e.tok });
  }
  return {
    available: true,
    today: { cost: Math.round(todayCost * 100) / 100, tokens: todayTok, turns: todayTurns },
    window5h: { tokens: win5hTok, turns: win5hTurns },
    series7d: series,
  };
}

function readUsageLog() {
  return readUsageLogFile(CLAUDE_USAGE_LOG);
}

function readCodexUsageLog() {
  return readUsageLogFile(CODEX_USAGE_LOG);
}

function firstNum(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export function normalizeCodexTurnUsage(raw, meta = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const input = firstNum(raw.input_tokens, raw.inputTokens, raw.prompt_tokens, raw.promptTokens);
  const additiveCacheRead = firstNum(raw.cache_read_tokens, raw.cache_read_input_tokens);
  const cachedInputSubset = firstNum(
    raw.cached_input_tokens,
    raw.cachedInputTokens,
    raw.input_token_details?.cached_tokens
  );
  const cacheRead = additiveCacheRead || cachedInputSubset;
  const cacheReadIsSubset = raw.cache_read_is_subset === true || (!additiveCacheRead && cachedInputSubset > 0);
  const cacheCreation = firstNum(
    raw.cache_creation_tokens,
    raw.cache_creation_input_tokens,
    raw.cacheCreationInputTokens,
    raw.cache_write_tokens,
    raw.cache_write_input_tokens
  );
  const output = firstNum(raw.output_tokens, raw.outputTokens, raw.completion_tokens, raw.completionTokens);
  const summedTotal = input + (cacheReadIsSubset ? 0 : cacheRead) + cacheCreation + output;
  const total = firstNum(raw.total_tokens, raw.totalTokens, summedTotal);
  if (!summedTotal && !total) return null;
  return {
    source: 'codex',
    engine: 'codex',
    logged_at: meta.logged_at || new Date().toISOString(),
    turn_ts: meta.turn_ts || new Date().toISOString(),
    session_id: meta.session_id || null,
    native_session_id: meta.native_session_id || null,
    cwd: meta.cwd || '',
    model: meta.model || null,
    input_tokens: input,
    cache_creation_tokens: cacheCreation,
    cache_read_tokens: cacheRead,
    cache_read_is_subset: cacheReadIsSubset,
    output_tokens: output,
    total_tokens: total || summedTotal,
    estimated_cost_usd: typeof raw.estimated_cost_usd === 'number' ? raw.estimated_cost_usd : undefined,
  };
}

export function normalizeClaudeTurnUsage(raw, meta = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const input = firstNum(raw.input_tokens, raw.inputTokens, raw.prompt_tokens, raw.promptTokens);
  const cacheCreation = firstNum(
    raw.cache_creation_tokens,
    raw.cache_creation_input_tokens,
    raw.cacheCreationInputTokens,
    raw.cache_write_tokens,
    raw.cache_write_input_tokens
  );
  const cacheRead = firstNum(
    raw.cache_read_tokens,
    raw.cache_read_input_tokens,
    raw.cacheReadInputTokens,
    raw.cached_input_tokens,
    raw.cachedInputTokens
  );
  const output = firstNum(raw.output_tokens, raw.outputTokens, raw.completion_tokens, raw.completionTokens);
  const summedTotal = input + cacheCreation + cacheRead + output;
  const total = firstNum(raw.total_tokens, raw.totalTokens, summedTotal);
  if (!summedTotal && !total) return null;
  return {
    source: 'claude',
    engine: 'claude',
    logged_at: meta.logged_at || raw.logged_at || new Date().toISOString(),
    turn_ts: meta.turn_ts || raw.turn_ts || raw.timestamp || new Date().toISOString(),
    session_id: meta.session_id || raw.session_id || null,
    native_session_id: meta.native_session_id || raw.native_session_id || raw.session_id || null,
    cwd: meta.cwd || raw.cwd || '',
    model: meta.model || raw.model || null,
    input_tokens: input,
    cache_creation_tokens: cacheCreation,
    cache_read_tokens: cacheRead,
    cache_read_is_subset: false,
    output_tokens: output,
    total_tokens: total || summedTotal,
    estimated_cost_usd: typeof raw.estimated_cost_usd === 'number' ? raw.estimated_cost_usd : undefined,
  };
}

export function usageEntryKey(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const engine = entry.engine || entry.source || 'usage';
  const sessionId = entry.native_session_id || entry.session_id || '';
  const turnTs = entry.turn_ts || entry.logged_at || '';
  const out = entry.output_tokens || 0;
  const total = entry.total_tokens || 0;
  return `${engine}:${sessionId}:${turnTs}:${out}:${total}`;
}

function fmtTokens(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatTurnUsageLine(turnUsage) {
  if (!turnUsage || typeof turnUsage !== 'object') return null;
  const label = turnUsage.engine === 'claude' ? 'Claude' : 'Codex';
  const additiveCacheRead = turnUsage.cache_read_is_subset ? 0 : (turnUsage.cache_read_tokens || 0);
  const inputTotal = (turnUsage.input_tokens || 0) +
    (turnUsage.cache_creation_tokens || 0) +
    additiveCacheRead;
  const parts = [
    turnUsage.output_tokens ? `out ${fmtTokens(turnUsage.output_tokens)}` : null,
    inputTotal ? `in ${fmtTokens(inputTotal)}` : null,
    turnUsage.cache_read_is_subset && turnUsage.cache_read_tokens
      ? `cached ${fmtTokens(turnUsage.cache_read_tokens)}`
      : null,
    turnUsage.total_tokens ? `total ${fmtTokens(turnUsage.total_tokens)}` : null,
  ].filter(Boolean);
  return parts.length ? `${label} turn ${parts.join(' / ')}` : null;
}

export function readLatestUsageEntry(engine = 'claude') {
  const logPath = engine === 'codex' ? CODEX_USAGE_LOG : CLAUDE_USAGE_LOG;
  let lines;
  try {
    lines = fs.readFileSync(logPath, 'utf-8').split('\n');
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let raw;
    try { raw = JSON.parse(line); } catch { continue; }
    const normalized = engine === 'codex'
      ? normalizeCodexTurnUsage(raw, raw)
      : normalizeClaudeTurnUsage(raw, raw);
    if (normalized) return normalized;
  }
  return null;
}

export function recordCodexTurnUsage(entry) {
  if (!entry || typeof entry !== 'object') return false;
  fs.mkdirSync(path.dirname(CODEX_USAGE_LOG), { recursive: true });
  fs.appendFileSync(CODEX_USAGE_LOG, JSON.stringify(entry) + '\n', 'utf-8');
  return true;
}
// ---- 來源 3：Codex 最近 session 的 rate_limits ----
// _codexNewestCache：快取上次找到的最新檔。下次只 stat 該檔 + 其父目錄；
// 父目錄 mtime 沒變表示沒有新檔加入，沿用 cache。父目錄變了才走完整遞迴掃描。
// codex 把 sessions 依日期分目錄，每次重掃會幾百次 stat，turn 結束 force:true
// 累積會卡，這條 cache 把常態成本壓到 2 次 stat。
let _codexNewestCache = null;
function _scanCodexRecursive(dir, depth = 0) {
  if (depth > 4) return null;
  let best = null;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = _scanCodexRecursive(p, depth + 1);
      if (sub && (!best || sub.mtime > best.mtime)) best = sub;
    } else if (e.name.endsWith('.jsonl')) {
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs, parent: dir };
    }
  }
  return best;
}
function newestCodexJsonl(dir) {
  // Fast path：父目錄與檔本身都還在、父目錄 mtime 未變 → cache 有效。
  if (_codexNewestCache) {
    try {
      const fileSt = fs.statSync(_codexNewestCache.path);
      const parentSt = fs.statSync(_codexNewestCache.parent);
      if (parentSt.mtimeMs === _codexNewestCache.parentMtime) {
        _codexNewestCache.mtime = fileSt.mtimeMs;
        return { path: _codexNewestCache.path, mtime: fileSt.mtimeMs };
      }
    } catch { /* fall through */ }
  }
  const best = _scanCodexRecursive(dir);
  if (best) {
    let parentMtime = 0;
    try { parentMtime = fs.statSync(best.parent).mtimeMs; } catch {}
    _codexNewestCache = { path: best.path, parent: best.parent, parentMtime, mtime: best.mtime };
  } else {
    _codexNewestCache = null;
  }
  return best ? { path: best.path, mtime: best.mtime } : null;
}

function readCodexQuota() {
  try {
    const f = newestCodexJsonl(CODEX_SESSIONS);
    if (!f) return { available: false };
    const lines = fs.readFileSync(f.path, 'utf-8').split('\n');
    // Scan all lines to get the last rate_limits entry (newest reading)
    let primary = null, secondary = null;
    for (const ln of lines) {
      if (!ln || !ln.includes('rate_limit')) continue;
      let d; try { d = JSON.parse(ln); } catch { continue; }
      // Schema: d.payload.rate_limits.{primary,secondary}.used_percent
      const rl = d?.payload?.rate_limits;
      if (!rl || typeof rl !== 'object') continue;
      const p = rl.primary?.used_percent;
      const s = rl.secondary?.used_percent;
      if (p != null) primary = normPct(p);
      if (s != null) secondary = normPct(s);
    }
    if (primary != null || secondary != null) {
      return {
        available: true,
        primary_pct: primary,
        secondary_pct: secondary,
        mtime_ms: f.mtime,
        source: path.basename(f.path),
      };
    }
    return { available: false };
  } catch {
    return { available: false };
  }
}

export function getUsage({ force = false } = {}) {
  if (!force && _cache.data && Date.now() - _cache.at < CACHE_MS) return _cache.data;
  const codexUsage = readCodexUsageLog();
  const codexQuota = readCodexQuota();
  const data = {
    ok: true,
    generated_at: Date.now(),
    claude: { quota: readClaudeQuota(), ...readUsageLog() },
    codex: { ...codexUsage, ...codexQuota, quota: codexQuota, usage_available: codexUsage.available },
  };
  _cache = { at: Date.now(), data };
  return data;
}
