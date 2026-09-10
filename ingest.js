// 本機原生 Claude Code session 收錄層（取代 TG bot 的關鍵）。
//
// 原生 session 存在 ~/.claude/projects/<編碼cwd>/<uuid>.jsonl，schema 與 hub
// 的 {role,text,ts} 不同，且檔案持續成長（TG bot / CLI 仍在寫）。本模組：
//   - 前向偵測：掃 projects 子目錄、讀首個含 cwd 的事件，比對目標 cwd
//     （不反推編碼名，因 drive 大小寫不穩定）。
//   - 惰性索引：開機只做輕量單遍掃描（標題/起訖時間/則數），不全量轉換。
//   - 開啟才轉換：loadNative() 把原生 JSONL 攤平成 hub 訊息，支援 tail。
//
// 身分對映：hub session.id = 原生 uuid；engineRefs.claude = 同一 uuid，
// 故「點選續接」會走 engines.js 既有的 `claude --resume <uuid>`，直接接回
// 那條原生對話（含 TG bot 開的）。
//
// 批次 4：discovery/scan I/O 全面改成 fs.promises，經 concurrency.js 的共用
// limiter 界定同輪 refresh 內的最大同時 fs 操作數（見 DEFAULT_NATIVE_IO_CONCURRENCY）。
// 這一批只把「阻塞的 I/O 等待」搬出主執行緒；split/JSON.parse 仍是同步 CPU
// work（見各 measureRefreshPhase 呼叫），batch 4 不宣稱、也不改變這件事。
// loadNative()/loadCodexNative()（開啟單一 session 時的全文轉換）不在 refresh
// 掃描路徑上，維持同步，本批未觸碰。

import fs from 'fs';
import path from 'path';
import os from 'os';
import { stripBridgePreambleForTitle } from './title-cleanup.js';
import { createLimiter } from './concurrency.js';
import {
  incrementRefreshCounter,
  measureRefreshPhase,
  measureRefreshPhaseAsync,
  recordRefreshError,
  trackNativeIoConcurrency,
} from './session-refresh-instrumentation.js';

const fsp = fs.promises;

const NATIVE_ROOT = process.env.AHR_CLAUDE_PROJECTS_DIR
  ? path.resolve(process.env.AHR_CLAUDE_PROJECTS_DIR)
  : path.join(os.homedir(), '.claude', 'projects');
const CODEX_ROOT = process.env.AHR_CODEX_SESSIONS_DIR
  ? path.resolve(process.env.AHR_CODEX_SESSIONS_DIR)
  : path.join(os.homedir(), '.codex', 'sessions');
const parsedProjectDirCacheTtlMs = Number.parseInt(process.env.AHR_CLAUDE_DIR_CACHE_TTL_MS || '', 10);
const PROJECT_DIR_CACHE_TTL_MS = Number.isFinite(parsedProjectDirCacheTtlMs) && parsedProjectDirCacheTtlMs >= 0
  ? parsedProjectDirCacheTtlMs
  : 30_000;

// 同一輪 refresh 內，native fs 操作（readdir/stat/open+read）的預設同時上限。
// 沒有共用 limiter 時（例如測試直接呼叫 scanNative/scanCodexNative）各自建立
// 一個此上限的 limiter；store.ingestProjects 會建立單一 limiter 貫穿整輪，
// 讓 Codex 全樹 walk 與各 workspace 的 Claude 掃描共用同一個全域上限。
const parsedIoConcurrency = Number.parseInt(process.env.AHR_NATIVE_IO_CONCURRENCY || '', 10);
export const DEFAULT_NATIVE_IO_CONCURRENCY = Number.isFinite(parsedIoConcurrency) && parsedIoConcurrency > 0
  ? parsedIoConcurrency
  : 24;

function defaultLimiter() {
  return createLimiter(DEFAULT_NATIVE_IO_CONCURRENCY);
}

// 測試專用延遲：只在明確設定環境變數時生效，讓 atomic-publish／bounded-concurrency
// regression 能在不依賴真實磁碟速度的情況下，確定性地把 async scan 窗口拉寬到可觀察。
// 正式環境不得設定此變數。
const parsedTestDelay = Number.parseInt(process.env.AHR_NATIVE_SCAN_TEST_DELAY_MS || '', 10);
const NATIVE_SCAN_TEST_DELAY_MS = Number.isFinite(parsedTestDelay) && parsedTestDelay > 0 ? parsedTestDelay : 0;
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function readFileWithTestDelay(p) {
  if (NATIVE_SCAN_TEST_DELAY_MS > 0) await delay(NATIVE_SCAN_TEST_DELAY_MS);
  return fsp.readFile(p, 'utf8');
}

// 開機掃描每檔讀取上限（找標題/時間夠用，避免大檔全載）
const HEAD_BYTES = 64 * 1024;
// 噪音事件：非對話本體，索引與轉換都略過
const SKIP_TYPES = new Set([
  'queue-operation', 'attachment', 'last-prompt', 'summary', 'message',
]);

function eqPath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function markDiscoveryIncomplete(discoveryState) {
  if (discoveryState) discoveryState.complete = false;
}

function safeParse(line, metrics = null, discoveryState = null) {
  return measureRefreshPhase(metrics, 'splitJsonParseMs', () => {
    try {
      const parsed = JSON.parse(line);
      incrementRefreshCounter(metrics, 'jsonLinesParsed');
      return parsed;
    } catch {
      markDiscoveryIncomplete(discoveryState);
      recordRefreshError(metrics, 'json-parse');
      return null;
    }
  }, { sampleRss: false });
}

// content 可能是 string 或 block 陣列；攤平成單段純文字（給 hub thread 用）
function flattenContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && b.text) parts.push(b.text);
    else if (b.type === 'thinking') { /* 收合：歷史瀏覽不需思考鏈 */ }
    else if (b.type === 'tool_use') {
      const inp = b.input ? JSON.stringify(b.input) : '';
      parts.push(`⏵ ${b.name || 'tool'}${inp ? ' ' + inp.slice(0, 300) : ''}`);
    } else if (b.type === 'tool_result') {
      let t = b.content;
      if (Array.isArray(t)) t = t.map(x => (x && x.text) || '').join('');
      if (typeof t !== 'string') t = JSON.stringify(t ?? '');
      parts.push(`⏴ ${String(t).slice(0, 800)}`);
    }
  }
  return parts.join('\n').trim();
}

// 包裝噪音（slash 展開、caveat、system-reminder、IDE 注入、compaction 前言…）
// → 不適合當標題，跳過去抓後面第一句真人輸入
const NAME_NOISE = /^\s*(<(local-command|command-name|command-message|command-args|command-stdout|system-reminder|user-prompt-submit-hook|ide_opened_file|ide_selection|ide_diagnostics)\b|This session is being continued from a previous conversation|Caveat: The messages below were generated by the user)/i;

// 真人輸入判定：type==='user'（content 可能是 string 或 block 陣列）
function isHumanUser(ev) {
  return ev && ev.type === 'user' && ev.message && ev.message.content != null;
}

// 取「第一句乾淨真人文字」：string 直接用；陣列則取第一個非噪音 text block
// （略過 tool_result / ide 注入 / image-only）。回傳 null 表示此訊息不適合當標題。
function humanTitleText(ev) {
  if (!isHumanUser(ev)) return null;
  const c = ev.message.content;
  if (typeof c === 'string') {
    const t = stripBridgePreambleForTitle(c);
    return t && !NAME_NOISE.test(t) ? t : null;
  }
  if (Array.isArray(c)) {
    for (const b of c) {
      if (b && b.type === 'text' && typeof b.text === 'string') {
        const t = stripBridgePreambleForTitle(b.text);
        if (t && !NAME_NOISE.test(t)) return t;
      }
    }
  }
  return null;
}

const COMPACT_RE = /^\s*This session is being continued from a previous conversation/i;

// compaction 接續 session：唯一 user 訊息常就是整份摘要。Claude Code 摘要
// 有穩定錨點，依序抓「Primary Request and Intent」→「Summary」首句 → 去前言。
function compactionTitle(text) {
  if (!text) return null;
  let m = text.match(/Primary Request and Intent:\s*\n*\s*[-*\d.]*\s*([^\n]{4,})/i);
  if (m) return m[1].trim().slice(0, 60);
  m = text.match(/\bSummary:\s*\n+\s*(?:\d+\.\s*)?([^\n]{4,})/i);
  if (m) return m[1].trim().slice(0, 60);
  const body = text
    .replace(COMPACT_RE, '')
    .replace(/^[^.]*?summarized below:?/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return body ? body.slice(0, 60) : null;
}

function tsOf(ev) {
  const t = ev && ev.timestamp ? Date.parse(ev.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
}

// 目錄遍歷：同層子目錄平行遞迴（經共用 limiter 界定總同時 I/O），檔案清單維持
// 「本層先於子孫」的順序即可——下游只依 id 去重與逐檔 scan，不依賴原本 DFS
// 的逐項交錯順序。
async function walkJsonl(root, depth, metrics, limiter) {
  if (depth > 5) return [];
  if (depth === 0) incrementRefreshCounter(metrics, 'rootsTraversed');
  let ents;
  try {
    // Phase timing is nested inside limiter.run() so it measures actual
    // execution only, not time spent queued behind the concurrency cap —
    // wrapping it the other way around would sum overlapping queue-wait
    // windows across every concurrent op into a wildly inflated total.
    ents = await limiter.run(() => trackNativeIoConcurrency(metrics, () => (
      measureRefreshPhaseAsync(metrics, 'directoryTraversalMs', () => fsp.readdir(root, { withFileTypes: true }))
    )));
  } catch {
    recordRefreshError(metrics, 'directory-traversal');
    return [];
  }
  const files = [];
  const dirs = [];
  for (const ent of ents) {
    const p = path.join(root, ent.name);
    if (ent.isDirectory()) dirs.push(p);
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) files.push(p);
  }
  if (dirs.length) {
    const nested = await Promise.all(dirs.map(d => walkJsonl(d, depth + 1, metrics, limiter)));
    for (const list of nested) files.push(...list);
  }
  return files;
}

function flattenCodexContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if ((item.type === 'input_text' || item.type === 'output_text') && item.text) {
      parts.push(String(item.text));
    }
  }
  return parts.join('\n').trim();
}

function codexPayloadText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.message === 'string') return payload.message.trim();
  return flattenCodexContent(payload.content);
}

function isCodexUserNoise(text) {
  return /^\s*(#\s*AGENTS\.md instructions|#\s*Codex workspace bootstrap|<recommended_plugins>|<environment_context>|You are Codex,|Knowledge cutoff:)/i.test(text || '');
}

// runEngine 對設定了 workspace bootstrap 的 cwd，codex prompt 會把 bootstrap 前置在「同一則」
// user message（engines.js codexBootstrapForCwd）；ingest 時剝掉前綴留真實使用者文字，
// 剝完為空（或無終止符的純 bootstrap）才整則略過。
// v2（exact-content 注入）：只認同 nonce 的 end 哨兵。嵌入的權威檔內容含 `---`
// 水平線，若回退 legacy `\n---\n\n` 會在嵌入內容處誤切、洩漏其餘全文——因此
// 帶 v2 標記但找不到 end 哨兵時，整則視為 bootstrap（回空），永不退回 legacy。
// legacy 分隔線只服務歷史 JSONL 裡的舊指針式 bootstrap 與 manual 設定。
const CODEX_BOOTSTRAP_SEP = '\n---\n\n';
const CODEX_BOOTSTRAP_V2_MARK = /<!--\s*ahr:codex-workspace-bootstrap:v2\s+nonce=([\w-]+)\s*-->/;
function stripCodexBootstrap(text) {
  if (!/^\s*#\s*Codex workspace bootstrap/i.test(text || '')) return text;
  const v2 = text.match(CODEX_BOOTSTRAP_V2_MARK);
  if (v2) {
    const end = `<!-- ahr:codex-workspace-bootstrap:end nonce=${v2[1]} -->`;
    const i = text.indexOf(end);
    return i === -1 ? '' : text.slice(i + end.length).trim();
  }
  const i = text.indexOf(CODEX_BOOTSTRAP_SEP);
  return i === -1 ? '' : text.slice(i + CODEX_BOOTSTRAP_SEP.length).trim();
}

function codexTitleText(payload) {
  const text = stripBridgePreambleForTitle(stripCodexBootstrap(codexPayloadText(payload)).replace(/\s+/g, ' ').trim());
  if (!text || isCodexUserNoise(text)) return null;
  return text.slice(0, 60);
}

// 偵測哪些 projects 子目錄對映到 targetCwd（可能多個：drive 大小寫差異）
const dirCache = new Map();
async function detectProjectDirs(targetCwd, metrics, { forceDiscovery = false, limiter }) {
  const ck = path.resolve(targetCwd).toLowerCase();
  const now = Date.now();
  const cached = dirCache.get(ck);
  if (!forceDiscovery && cached && cached.expiresAt > now) {
    incrementRefreshCounter(metrics, 'cacheHits');
    incrementRefreshCounter(metrics, 'directoryCacheHits');
    return cached.dirs;
  }
  incrementRefreshCounter(metrics, 'rootsTraversed');
  let subs = [];
  try {
    const ents = await limiter.run(() => trackNativeIoConcurrency(metrics, () => (
      measureRefreshPhaseAsync(metrics, 'directoryTraversalMs', () => fsp.readdir(NATIVE_ROOT, { withFileTypes: true }))
    )));
    subs = ents.filter(d => d.isDirectory()).map(d => path.join(NATIVE_ROOT, d.name));
  } catch {
    recordRefreshError(metrics, 'directory-traversal');
    if (cached) {
      incrementRefreshCounter(metrics, 'directoryCacheStaleFallbacks');
      return cached.dirs;
    }
    return [];
  }

  const discoveryState = { complete: true };
  // 各候選目錄互相獨立（不同 project dir），經共用 limiter 平行探測，總同時
  // I/O 仍受單一上限約束。
  const perDir = await Promise.all(subs.map(async (dir) => {
    let files;
    try {
      files = await limiter.run(() => trackNativeIoConcurrency(metrics, () => (
        measureRefreshPhaseAsync(metrics, 'directoryTraversalMs', () => fsp.readdir(dir))
      )));
      files = files.filter(f => f.endsWith('.jsonl'));
    } catch {
      recordRefreshError(metrics, 'directory-traversal');
      markDiscoveryIncomplete(discoveryState);
      return null;
    }
    if (!files.length) return null;
    // 讀最新一檔的前段，找首個帶 cwd 的事件比對
    const mtimes = await Promise.all(files.map(f => statMtime(path.join(dir, f), metrics, discoveryState, limiter)));
    let newestFile = files[0];
    let newestMtime = mtimes[0];
    for (let i = 1; i < files.length; i++) {
      if (mtimes[i] > newestMtime) { newestMtime = mtimes[i]; newestFile = files[i]; }
    }
    const probe = await readHead(path.join(dir, newestFile), metrics, discoveryState, limiter);
    let cwd = null;
    const lines = measureRefreshPhase(metrics, 'splitJsonParseMs', () => probe.split('\n'));
    for (const line of lines) {
      if (!line) continue;
      const ev = safeParse(line, metrics, discoveryState);
      if (ev && ev.cwd) { cwd = ev.cwd; break; }
    }
    return (cwd && eqPath(cwd, targetCwd)) ? dir : null;
  }));
  const hit = perDir.filter(Boolean);
  // A partial traversal is never authoritative. Keep the previous valid mapping
  // available as a stale fallback, but do not turn an I/O failure into a trusted
  // empty collection that hides newly-created Claude project directories.
  if (discoveryState.complete) {
    dirCache.set(ck, {
      dirs: hit,
      discoveredAt: now,
      expiresAt: now + PROJECT_DIR_CACHE_TTL_MS,
    });
  } else if (cached) {
    incrementRefreshCounter(metrics, 'directoryCacheStaleFallbacks');
    return cached.dirs;
  }
  return hit;
}

async function statMtime(p, metrics, discoveryState, limiter) {
  try {
    return await limiter.run(() => trackNativeIoConcurrency(metrics, () => (
      measureRefreshPhaseAsync(
        metrics,
        'statFingerprintMs',
        async () => (await fsp.stat(p)).mtimeMs,
        { sampleRss: false },
      )
    )));
  } catch {
    markDiscoveryIncomplete(discoveryState);
    recordRefreshError(metrics, 'stat');
    return 0;
  }
}

async function readHead(p, metrics, discoveryState, limiter) {
  incrementRefreshCounter(metrics, 'filesProbed');
  try {
    return await limiter.run(() => trackNativeIoConcurrency(metrics, () => (
      measureRefreshPhaseAsync(metrics, 'fileReadMs', async () => {
        const handle = await fsp.open(p, 'r');
        try {
          const buf = Buffer.alloc(HEAD_BYTES);
          const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
          return buf.toString('utf8', 0, bytesRead);
        } finally {
          await handle.close();
        }
      })
    )));
  } catch {
    markDiscoveryIncomplete(discoveryState);
    recordRefreshError(metrics, 'file-read');
    return '';
  }
}

// 掃描：標題（首句真人輸入，跳包裝噪音）、起始時間、最後時間。
// 包裝噪音可能很深（slash 展開 + caveat + system-reminder 動輒數十 KB），
// 故全檔讀取但「name+createdAt 到手即停」——多數對話前段就命中，僅純
// 工具/子代理轉錄（無真人句）才會讀到底並回退命名。
async function scanSession(nativePath, metrics, limiter) {
  const id = path.basename(nativePath, '.jsonl');
  incrementRefreshCounter(metrics, 'filesScanned');
  let raw;
  try {
    raw = await limiter.run(() => trackNativeIoConcurrency(metrics, () => (
      measureRefreshPhaseAsync(metrics, 'fileReadMs', () => readFileWithTestDelay(nativePath))
    )));
    incrementRefreshCounter(metrics, 'filesParsed');
  } catch {
    recordRefreshError(metrics, 'file-read');
    raw = '';
  }
  let aiTitle = null, humanName = null, createdAt = null, firstCompaction = null;
  let sawAssistant = false;
  const lines = measureRefreshPhase(metrics, 'splitJsonParseMs', () => raw.split('\n'));
  for (const line of lines) {
    if (!line) continue;
    const ev = safeParse(line, metrics);
    if (!ev) continue;
    if (createdAt == null) { const t = tsOf(ev); if (t) createdAt = t; }
    // ai-title：Claude Code 自身生成的乾淨標題，最佳來源
    if (!aiTitle && ev.type === 'ai-title' && ev.aiTitle) {
      aiTitle = String(ev.aiTitle).trim();
    }
    if (!humanName) {
      const t = humanTitleText(ev);
      if (t) humanName = t.replace(/\s+/g, ' ').slice(0, 60);
    }
    if (!firstCompaction && isHumanUser(ev) &&
        typeof ev.message.content === 'string' && COMPACT_RE.test(ev.message.content)) {
      firstCompaction = ev.message.content;
    }
    // 是否有實質助理輸出（含工具呼叫）——決定「實質為空」判定
    if (!sawAssistant && ev.type === 'assistant' && ev.message &&
        flattenContent(ev.message.content)) {
      sawAssistant = true;
    }
    if (aiTitle && createdAt != null) break;   // ai-title 命中即足夠
  }
  // 優先序：ai-title > 第一句真人輸入 > compaction 摘要錨點 > 回退
  const name = aiTitle || humanName ||
    (firstCompaction ? compactionTitle(firstCompaction) : null);
  // 實質為空：無乾淨標題/真人句、無助理輸出、非 compaction 接續
  // → 純 system-reminder / ide 注入 / 中止無交談的殼，收錄時剔除
  const empty = !aiTitle && !humanName && !sawAssistant && !firstCompaction;
  const mtime = await statMtime(nativePath, metrics, null, limiter);
  return {
    id,
    name: name || `(native ${id.slice(0, 8)})`,
    createdAt: createdAt ?? mtime,
    updatedAt: mtime,
    nativePath,
    source: 'native',
    agentType: 'claude',
    empty,
    engineRefs: { claude: id, codex: null },
  };
}

// 列出某 cwd 的所有原生 session（輕量 meta；訊息開啟時才轉換）
export async function scanNative(targetCwd, metrics = null, { forceDiscovery = false, limiter = null } = {}) {
  const activeLimiter = limiter || defaultLimiter();
  const dirs = await detectProjectDirs(targetCwd, metrics, { forceDiscovery, limiter: activeLimiter });
  const filesByDir = await Promise.all(dirs.map(async (dir) => {
    try {
      const names = await activeLimiter.run(() => trackNativeIoConcurrency(metrics, () => (
        measureRefreshPhaseAsync(metrics, 'directoryTraversalMs', () => fsp.readdir(dir))
      )));
      return names.filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f));
    } catch {
      recordRefreshError(metrics, 'directory-traversal');
      return [];
    }
  }));
  const nativePaths = filesByDir.flat();
  const metas = await Promise.all(nativePaths.map(p => scanSession(p, metrics, activeLimiter)));
  const resolvedCwd = path.resolve(targetCwd);
  for (const meta of metas) meta.cwd = resolvedCwd;
  return metas;
}

function normalizedWorkspaceMap(targetCwds) {
  const workspaces = Array.isArray(targetCwds) ? targetCwds : [targetCwds];
  const byResolvedPath = new Map();
  for (const cwd of workspaces) {
    if (typeof cwd !== 'string' || !cwd.trim()) continue;
    const resolved = path.resolve(cwd);
    const key = resolved.toLowerCase();
    if (!byResolvedPath.has(key)) byResolvedPath.set(key, resolved);
  }
  return byResolvedPath;
}

function validCodexCwd(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

async function scanCodexSession(nativePath, workspaceByResolvedPath, metrics, limiter) {
  incrementRefreshCounter(metrics, 'filesScanned');
  let raw;
  try {
    raw = await limiter.run(() => trackNativeIoConcurrency(metrics, () => (
      measureRefreshPhaseAsync(metrics, 'fileReadMs', () => readFileWithTestDelay(nativePath))
    )));
    incrementRefreshCounter(metrics, 'filesParsed');
  } catch {
    recordRefreshError(metrics, 'file-read');
    raw = '';
  }

  const fallbackId = path.basename(nativePath, '.jsonl').replace(/^rollout-[^-]+-[^-]+-/, '');
  let id = fallbackId;
  let cwd = null;
  let createdAt = null;
  let title = null;
  let sawAssistant = false;

  const lines = measureRefreshPhase(metrics, 'splitJsonParseMs', () => raw.split('\n'));
  for (const line of lines) {
    if (!line) continue;
    const ev = safeParse(line, metrics);
    if (!ev) continue;
    if (createdAt == null) { const t = tsOf(ev); if (t) createdAt = t; }
    const payload = ev.payload;
    if (ev.type === 'session_meta' && payload && typeof payload === 'object') {
      if (payload.id) id = String(payload.id);
      cwd = validCodexCwd(payload.cwd) || cwd;
    } else if (ev.type === 'turn_context' && payload && typeof payload === 'object') {
      cwd = validCodexCwd(payload.cwd) || cwd;
    } else if (ev.type === 'event_msg' && payload && payload.type === 'user_message' && !title) {
      title = codexTitleText(payload);
    } else if (ev.type === 'response_item' && payload && payload.type === 'message') {
      if (payload.role === 'user' && !title) title = codexTitleText(payload);
      if (payload.role === 'assistant' && codexPayloadText(payload)) sawAssistant = true;
    }
  }

  if (!cwd) return null;
  const targetCwd = workspaceByResolvedPath.get(path.resolve(cwd).toLowerCase());
  if (!targetCwd) return null;
  const mtime = await statMtime(nativePath, metrics, null, limiter);
  return {
    id: `codex-${id}`,
    name: title || `(codex ${id.slice(0, 8)})`,
    createdAt: createdAt ?? mtime,
    updatedAt: mtime,
    nativePath,
    source: 'native',
    agentType: 'codex',
    empty: !title && !sawAssistant,
    engineRefs: { claude: null, codex: id },
    cwd: path.resolve(targetCwd),
  };
}

export async function scanCodexNative(targetCwds, metrics = null, { limiter = null } = {}) {
  const workspaceByResolvedPath = normalizedWorkspaceMap(targetCwds);
  if (!workspaceByResolvedPath.size) return [];
  const activeLimiter = limiter || defaultLimiter();
  const files = await walkJsonl(CODEX_ROOT, 0, metrics, activeLimiter);
  const metas = await Promise.all(files.map(f => scanCodexSession(f, workspaceByResolvedPath, metrics, activeLimiter)));
  return metas.filter(Boolean);
}

// 開啟時全量轉換成 hub 訊息 [{role,text,ts}]；tail>0 只回尾段
export function loadNative(nativePath, tail = 0) {
  let raw;
  try { raw = fs.readFileSync(nativePath, 'utf8'); }
  catch { return []; }
  const msgs = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const ev = safeParse(line);
    if (!ev || !ev.type || SKIP_TYPES.has(ev.type)) continue;
    const m = ev.message;
    if (!m || !m.role) continue;
    const text = flattenContent(m.content);
    if (!text) continue;
    msgs.push({ role: m.role, text, ts: tsOf(ev) ?? Date.now() });
  }
  if (tail > 0 && msgs.length > tail) return msgs.slice(-tail);
  return msgs;
}

// 測試/呼叫端可建立自訂上限的 limiter，跨多次 scanNative/scanCodexNative 呼叫共用，
// 驗證全域同時 I/O 上限（見 store.ingestProjects 的實際用法）。
export function createNativeIoLimiter(limit = DEFAULT_NATIVE_IO_CONCURRENCY) {
  return createLimiter(limit);
}

export function loadCodexNative(nativePath, tail = 0) {
  let raw;
  try { raw = fs.readFileSync(nativePath, 'utf8'); }
  catch { return []; }
  const msgs = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const ev = safeParse(line);
    if (!ev || ev.type !== 'response_item') continue;
    const payload = ev.payload;
    if (!payload || payload.type !== 'message') continue;
    if (payload.role !== 'user' && payload.role !== 'assistant') continue;
    let text = codexPayloadText(payload);
    if (payload.role === 'user') text = stripCodexBootstrap(text);
    if (!text || (payload.role === 'user' && isCodexUserNoise(text))) continue;
    msgs.push({
      role: payload.role,
      engine: payload.role === 'assistant' ? 'codex' : undefined,
      text,
      ts: tsOf(ev) ?? Date.now(),
    });
  }
  if (tail > 0 && msgs.length > tail) return msgs.slice(-tail);
  return msgs;
}
