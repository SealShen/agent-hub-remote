// 持久化層（plan §二-B、#3 #8 #10 #6）
//  - .state/index.json    : 僅 metadata 陣列，write-file-atomic（Windows-safe）
//  - .state/sessions/<id>.jsonl : 訊息 append-only，每行一則（避免整檔重寫）
//  - 開機 hydrate：重建 Map；running/starting → interrupted + 系統訊息
//  - 每專案(cwd)各保留最近 50（updatedAt），超過者 archived（主列表隱藏、仍可接回）
//  - 身分 = hub 內部穩定 id（uuid）；engineRefs{claude,codex} 為 per-engine 指標

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import writeFileAtomic from 'write-file-atomic';
import { scanNative, scanCodexNative, loadNative, loadCodexNative } from './ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.AHR_STATE_DIR
  ? path.resolve(process.env.AHR_STATE_DIR)
  : path.join(__dirname, '.state');
const SESS_DIR = path.join(STATE_DIR, 'sessions');
const INDEX_PATH = path.join(STATE_DIR, 'index.json');
const CONTEXT_CONTROL_KIND = 'context-control';

const RETAIN = 50;          // plan §二-B / #10
const MSG_CACHE_CAP = 2000; // 記憶體內訊息快取上限（讀檔仍是全量真相）

fs.mkdirSync(SESS_DIR, { recursive: true });

// id = 身分（plan §二-5）。永不外露為使用者輸入前綴。
export function newId() {
  return crypto.randomUUID();
}

// in-memory 真相表：id -> record
export const sessions = new Map();

function jsonlPath(id) {
  return path.join(SESS_DIR, id + '.jsonl');
}

// index.json 只放 metadata（plan #8）；proc/messages/cancelled 不落盤
function metaOf(s) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    agentType: s.agentType,
    cwd: s.cwd,
    model: s.model || null,
    autoAllow: !!s.autoAllow,
    archived: !!s.archived,
    engineRefs: { claude: s.engineRefs?.claude ?? null, codex: s.engineRefs?.codex ?? null },
    lastEngine: s.lastEngine || null,
    pid: s.pid ?? null,
    msgCount: s.msgCount || 0,
    source: s.source || null,
    nativePath: s.nativePath || null,
    contextReset: s.contextReset || null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

let persistTimer = null;
export function persistIndex() {
  // debounce：高頻 append 時不要每則重寫 index
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const arr = [...sessions.values()].map(metaOf);
    try {
      writeFileAtomic.sync(INDEX_PATH, JSON.stringify(arr));
    } catch (e) {
      console.error('[store] index 寫入失敗:', e.message);
    }
  }, 250);
}

// 訊息 append-only：寫一行 JSONL + 更新 metadata
export function appendMsg(s, entry) {
  if (entry.ts == null) entry.ts = Date.now();
  try {
    fs.appendFileSync(jsonlPath(s.id), JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[store] jsonl append 失敗:', e.message);
  }
  s.messages.push(entry);
  if (s.messages.length > MSG_CACHE_CAP) s.messages.shift();
  s.msgCount = (s.msgCount || 0) + 1;
  s.updatedAt = entry.ts;
  persistIndex();
  return entry.ts;
}

export function removeSession(id, { deleteLog = false } = {}) {
  const existed = sessions.delete(id);
  if (deleteLog) {
    try { fs.rmSync(jsonlPath(id), { force: true }); }
    catch (e) { console.error('[store] session jsonl delete failed:', e.message); }
  }
  if (existed) {
    applyRetention();
    persistIndex();
  }
  return existed;
}

// Number of hub-appended JSONL entries for a session (excludes native transcript).
export function hubMessageCount(id) {
  return readHubJsonl(id).length;
}

// Move any hub-appended messages from `fromId`'s JSONL into `owner` before the source
// session is discarded, so claiming a native twin never silently drops hub-side messages
// (usage notes, context controls, etc.) that were appended to the twin. Returns the count
// moved. The native transcript file (nativePath) is untouched — only the hub JSONL moves.
export function absorbHubMessages(fromId, owner) {
  if (!owner || fromId === owner.id) return 0;
  const entries = readHubJsonl(fromId);
  if (!entries.length) return 0;
  // appendMsg sets owner.updatedAt = entry.ts on every call, so moving older twin
  // messages would drag updatedAt backwards (and reorder the session list). Pin it to
  // the newest of {prior owner.updatedAt, moved timestamps} after the merge. msgCount is
  // already kept accurate by appendMsg's per-entry increment.
  let maxTs = owner.updatedAt || 0;
  for (const entry of entries) {
    appendMsg(owner, entry);
    if (typeof entry.ts === 'number' && entry.ts > maxTs) maxTs = entry.ts;
  }
  owner.updatedAt = maxTs;
  persistIndex();
  return entries.length;
}

function readHubJsonl(id) {
  let lines;
  try {
    lines = fs.readFileSync(jsonlPath(id), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const out = [];
  for (const l of lines) {
    try { out.push(JSON.parse(l)); } catch { /* 壞行跳過 */ }
  }
  return out;
}

function isContextControl(m) {
  return m && m.role === 'system' && m.kind === CONTEXT_CONTROL_KIND;
}

function latestContextReset(id) {
  let reset = null;
  for (const m of readHubJsonl(id)) {
    if (isContextControl(m) && m.contextReset) reset = m.contextReset;
  }
  return reset;
}

function publicControlMessage(m) {
  const out = {
    role: 'system',
    kind: m.op === 'rewind' ? 'rewind' : 'compact',
    text: m.text || (m.op === 'rewind' ? 'Session rewound.' : 'Session compacted.'),
    ts: m.ts || Date.now(),
  };
  if (m.context) out.context = m.context;
  if (m.contextMode) out.contextMode = m.contextMode;
  if (m.contextReset) out.contextReset = m.contextReset;
  if (m.op) out.op = m.op;
  if (m.turn != null) out.turn = m.turn;
  return out;
}

function userTurnIndices(messages) {
  const idx = [];
  messages.forEach((m, i) => {
    if (m && m.role === 'user' && m.text && String(m.text).trim()) idx.push(i);
  });
  return idx;
}

function projectMessages(raw) {
  let out = [];
  for (const m of raw) {
    if (isContextControl(m)) {
      const display = publicControlMessage(m);
      if (m.op === 'compact') {
        out = [display];
      } else if (m.op === 'rewind') {
        const turn = Number(m.turn);
        const idx = userTurnIndices(out);
        const cut = Number.isInteger(turn) && turn >= 1 && turn <= idx.length
          ? idx[turn - 1]
          : out.length;
        out = out.slice(0, cut);
        out.push(display);
      } else {
        out.push(display);
      }
      continue;
    }
    out.push(m);
  }
  return out;
}

function combinedMessages(id) {
  const rec = sessions.get(id);
  if (rec && rec.source === 'native') {
    const hist = rec.agentType === 'codex'
      ? loadCodexNative(rec.nativePath, 0)
      : loadNative(rec.nativePath, 0);
    return hist.concat(readHubJsonl(id));
  }
  return readHubJsonl(id);
}

// 讀訊息（plan §F：?tail=N 只取尾段）
// 原生收錄 session：歷史來自原生 JSONL（惰性轉換），續接後 hub 自寫的新輪
// 追加在 .state 內，兩者依時間串接，最後才套 tail。
export function loadMessages(id, tail) {
  const out = projectMessages(combinedMessages(id));
  if (tail && tail > 0 && out.length > tail) return out.slice(-tail);
  return out;
}

export function appendContextControl(s, { op, turn, context, contextMode, text, contextReset }) {
  const ts = appendMsg(s, {
    role: 'system',
    kind: CONTEXT_CONTROL_KIND,
    op,
    turn,
    context: context || '',
    contextMode: contextMode || null,
    contextReset: contextReset || null,
    text,
  });
  if (contextReset) s.contextReset = contextReset;
  return ts;
}

export function syncMessageCount(s) {
  if (!s) return 0;
  const count = loadMessages(s.id, 0).length;
  s.msgCount = count;
  s.updatedAt = Date.now();
  persistIndex();
  return count;
}

export function pendingContextFromControls(s) {
  if (!s) return null;
  const raw = combinedMessages(s.id);
  let pending = null;
  for (const m of raw) {
    if (isContextControl(m)) {
      pending = {
        text: m.context || '',
        mode: m.contextMode || m.op || 'reset',
        op: m.op || 'reset',
        resetOnly: !m.context,
        freshThread: true,
        contextReset: m.contextReset || null,
        ts: m.ts || null,
      };
    } else if (pending && m.role === 'user' && m.text && String(m.text).trim()) {
      pending = null;
    }
  }
  return pending;
}

function blankRecord(meta) {
  return {
    ...meta,
    engineRefs: meta.engineRefs || { claude: null, codex: null },
    messages: [],      // runtime 快取，hydrate 時尾端載入
    proc: null,
    cancelled: false,
  };
}

// 開機重建。回傳「需收屍的孤兒」清單：上次 running/starting 且 pid 仍存活者。
// 由 server 在 hydrate 後 taskkill 收屍再轉 interrupted（plan #6）。
export function hydrate() {
  let arr = [];
  try {
    arr = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    if (!Array.isArray(arr)) arr = [];
  } catch {
    arr = [];   // 無 state → 等同全新啟動（plan §二-7）
  }

  const orphans = [];
  for (const meta of arr) {
    if (!meta || !meta.id) continue;
    // 原生收錄 session 不從 index 還原：磁碟上的原生 JSONL 才是真相，
    // 由 ingestProjects() 在 hydrate 後重新掃描注入（避免吃到過期快照）。
    if (meta.source === 'native') continue;
    const wasActive = meta.status === 'running' || meta.status === 'starting';
    if (wasActive && meta.pid) orphans.push({ id: meta.id, pid: meta.pid });

    const rec = blankRecord(meta);
    rec.contextReset = meta.contextReset || latestContextReset(meta.id) || null;
    rec.pid = null;
    if (wasActive) {
      rec.status = 'interrupted';
      // 系統訊息（plan §二-B）：直接落盤，使重啟後 feed 可見
      const note = { role: 'system', text: '↻ 服務已重啟，此對話被中斷 — 點此可續接', ts: Date.now() };
      try { fs.appendFileSync(jsonlPath(rec.id), JSON.stringify(note) + '\n'); } catch {}
      rec.msgCount = (rec.msgCount || 0) + 1;
      rec.updatedAt = note.ts;
    }
    // 尾端載入快取（feed 即時可見，全量真相仍在檔）
    rec.messages = loadMessages(rec.id, MSG_CACHE_CAP);
    // 實質為空的 hub 對話（建立後從未產生任何訊息）：重啟後不還原。
    // 須同時 msgCount===0 才剔除——避免 FS 讀取抖動（鎖/佔位檔）被誤判為空
    // 而把已有訊息的正常 session 永久從 index 移除。
    if (!rec.messages.length && (rec.msgCount || 0) === 0) continue;
    sessions.set(rec.id, rec);
  }

  applyRetention();
  persistIndex();
  return orphans;
}

// 每專案（cwd）各自保留最近 RETAIN（依 updatedAt），超過者 archived
// （不分 idle/running，plan #10）。改為 per-cwd：忙碌專案不再排擠安靜專案，
// 每個專案都能載入自己過去 RETAIN 則 session。
export function applyRetention() {
  const byCwd = new Map();
  for (const s of sessions.values()) {
    const key = s.cwd || '';
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key).push(s);
  }
  for (const group of byCwd.values()) {
    group.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    group.forEach((s, i) => { s.archived = i >= RETAIN; });
  }
}

// 收錄本機原生 Claude session（plan：取代 TG bot）。對 cwdList 內每個專案掃描
// ~/.claude/projects 對映目錄，把每條原生對話注入為 hub session（惰性、可續接）。
// 去重：原生 uuid 已是某 hub session 的 id 或 engineRefs.claude 時跳過。
export function ingestProjects(cwdList) {
  const taken = new Set();
  for (const s of sessions.values()) {
    taken.add(s.id);
    if (s.engineRefs?.claude) taken.add(s.engineRefs.claude);
    if (s.engineRefs?.codex) taken.add(`codex-${s.engineRefs.codex}`);
  }
  let added = 0;
  for (const cwd of cwdList || []) {
    if (!cwd) continue;
    let metas = [];
    try { metas = metas.concat(scanNative(cwd)); }
    catch (e) { console.error('[ingest] claude scan 失敗:', cwd, e.message); }
    try { metas = metas.concat(scanCodexNative(cwd)); }
    catch (e) { console.error('[ingest] codex scan 失敗:', cwd, e.message); }
    for (const m of metas) {
      if (m.empty) continue;   // 實質為空（純噪音殼）不收錄
      if (taken.has(m.id)) continue;
      taken.add(m.id);
      sessions.set(m.id, {
        id: m.id,
        name: m.name,
        status: 'idle',
        agentType: m.agentType === 'codex' ? 'codex' : 'claude',
        cwd: m.cwd,
        model: null,
        autoAllow: false,
        archived: false,
        engineRefs: m.engineRefs || { claude: m.id, codex: null },
        lastEngine: m.agentType === 'codex' ? 'codex' : 'claude',
        pid: null,
        msgCount: 0,            // 惰性：開啟轉換後才知精確則數
        source: 'native',
        nativePath: m.nativePath,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        messages: [],
        proc: null,
        cancelled: false,
      });
      added++;
    }
  }
  applyRetention();
  persistIndex();
  return added;
}

export function createSession({ name, agentType, cwd, model, autoAllow }) {
  const now = Date.now();
  const s = {
    id: newId(),
    name: name || null,
    status: 'idle',
    agentType,
    cwd,
    model: model || null,
    autoAllow: !!autoAllow,
    archived: false,
    engineRefs: { claude: null, codex: null },
    lastEngine: null,
    pid: null,
    msgCount: 0,
    createdAt: now,
    updatedAt: now,
    messages: [],
    proc: null,
    cancelled: false,
  };
  sessions.set(s.id, s);
  applyRetention();
  persistIndex();
  return s;
}

export function sessionsArr() {
  return [...sessions.values()]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(metaOf);
}
