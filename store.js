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
import { scanNative, scanCodexNative, loadNative, loadCodexNative, createNativeIoLimiter } from './ingest.js';
import {
  incrementRefreshCounter,
  measureRefreshPhase,
  recordRefreshError,
} from './session-refresh-instrumentation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.AHR_STATE_DIR
  ? path.resolve(process.env.AHR_STATE_DIR)
  : path.join(__dirname, '.state');
const SESS_DIR = path.join(STATE_DIR, 'sessions');
const INDEX_PATH = path.join(STATE_DIR, 'index.json');
export { STATE_DIR };
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
// Native sessions are rebuilt from their native JSONL after hydrate. Keep only
// snapshots that carry pending queue intent across that handoff; otherwise the
// native re-ingest would recreate them with queued: [] and lose user input.
const pendingNativeQueueMeta = new Map();

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
    effort: s.effort || null,
    autoAllow: !!s.autoAllow,
    archived: !!s.archived,
    engineRefs: { claude: s.engineRefs?.claude ?? null, codex: s.engineRefs?.codex ?? null },
    lastEngine: s.lastEngine || null,
    // codex authority bootstrap 證據（gate plan）：workspaceRoot/files+sha256/loadedAt/
    // authority_loaded/nonce。只進 metadata，不落 chat message；hydrate 經 blankRecord spread 還原
    codexBootstrapEvidence: s.codexBootstrapEvidence || null,
    // usage-limit 自動接續排程（engines.js）：{at,engine,reason,attempts,setAt}；
    // 重啟後由 server 呼叫 armPersistedAutoResumes 重掛 timer
    autoResume: s.autoResume || null,
    // 使用者在本輪回覆完成前先排的下一輪 input：[{id,text,ts}]，
    // 由 server 的 turn-end hook 依序送出（下方 §排程輸入）
    queued: queuedInputs(s),
    pid: s.pid ?? null,
    msgCount: s.msgCount || 0,
    source: s.source || null,
    nativePath: s.nativePath || null,
    contextReset: s.contextReset || null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// ── 排程輸入（在本輪回覆完成前先排下一輪 input）────────────────────────────
// 真相放在 session metadata → 隨 metaOf 落盤 index.json、隨 sessionsArr 推播給所有
// 前端、hydrate 經 blankRecord spread 還原。關鍵差別在於：關掉瀏覽器分頁、換裝置、
// 重啟服務都不會掉——純前端佇列做不到這點（手機一鎖屏就沒人負責送出）。
// 這裡只管資料；「何時可以送」的政策在 server.js（turn-end hook）。
export const QUEUE_LIMIT = 20;

export function queuedInputs(s) {
  return Array.isArray(s?.queued) ? s.queued : [];
}

// Upload cleanup also runs during startup. Include native queue snapshots that
// hydrate has retained but ingestProjects has not rebuilt yet (for example while
// a native scan is temporarily failing), so their attachment files stay alive.
export function allQueuedInputs() {
  const items = [];
  for (const session of sessions.values()) items.push(...queuedInputs(session));
  for (const [id, meta] of pendingNativeQueueMeta) {
    if (!sessions.has(id)) items.push(...queuedInputs(meta));
  }
  return items;
}

// 回傳新項目；無內容或已達上限回 null（呼叫端負責轉成使用者看得懂的錯誤）。
// files 是已上傳完成的描述（{path,name,type,size}），排程只存路徑不存內容；
// 上傳檔的 TTL 是 24 小時（server.js UPLOAD_TTL_MS），遠長於一個回合。
export function enqueueInput(s, text, files) {
  const body = String(text ?? '');
  const attachments = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!body.trim() && !attachments.length) return null;
  const list = queuedInputs(s);
  if (list.length >= QUEUE_LIMIT) return null;
  const item = { id: newId(), text: body, ts: Date.now() };
  if (attachments.length) item.files = attachments;
  s.queued = [...list, item];
  persistIndex();
  return item;
}

export function dequeueInput(s) {
  const list = queuedInputs(s);
  if (!list.length) return null;
  s.queued = list.slice(1);
  persistIndex();
  return list[0];
}

// 送不出去時放回隊首：使用者打的字不因為一次擋下就消失
export function requeueInput(s, item) {
  if (!item) return;
  s.queued = [item, ...queuedInputs(s)];
  persistIndex();
}

export function removeQueuedInput(s, qid) {
  const list = queuedInputs(s);
  const next = list.filter(q => q && q.id !== qid);
  if (next.length === list.length) return false;
  s.queued = next;
  persistIndex();
  return true;
}

export function clearQueuedInputs(s) {
  const n = queuedInputs(s).length;
  if (!n) return 0;
  s.queued = [];
  persistIndex();
  return n;
}

let persistTimer = null;
export function persistIndex() {
  // debounce：高頻 append 時不要每則重寫 index
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const arr = [...sessions.values()].map(metaOf);
    // A transient native scan failure must not erase a persisted queue. Retain
    // the skipped metadata until ingestProjects successfully rebuilds the record.
    for (const [id, meta] of pendingNativeQueueMeta) {
      if (!sessions.has(id)) arr.push(meta);
    }
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
    // agentType is the currently selected engine and can change before a bridge
    // read. Keep the immutable transcript provenance separate so a native Claude
    // JSONL is never parsed with the Codex loader (or vice versa).
    const nativeEngineType = rec.nativeEngineType || rec.agentType;
    const hist = nativeEngineType === 'codex'
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
  pendingNativeQueueMeta.clear();
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
    if (meta.source === 'native') {
      if (queuedInputs(meta).length) pendingNativeQueueMeta.set(meta.id, meta);
      continue;
    }
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
export async function ingestProjects(cwdList, metrics = null, { forceProjectDiscovery = false } = {}) {
  const workspaces = (cwdList || []).filter(Boolean);
  incrementRefreshCounter(metrics, 'nativeScans');
  if (metrics) metrics.counters.workspaceCount = workspaces.length;
  // Batch 4: `taken` is (re)computed against the *live* sessions Map right
  // before the synchronous merge below runs (not here, before scanning) — see
  // the comment above that computation for why this is the whole atomic-
  // publish mechanism this function needs.
  let added = 0;
  const ingestMetas = (metas) => {
    measureRefreshPhase(metrics, 'reconciliationMs', () => {
      for (const m of metas) {
        if (m.empty) continue;   // 實質為空（純噪音殼）不收錄
        if (taken.has(m.id)) {
          // Codex may prepend a synthetic <recommended_plugins> user message before
          // the real prompt. Older ingest versions used it as the native title.
          // Repair only that known generated title; never overwrite a manual rename.
          const existing = sessions.get(m.id);
          if (existing?.source === 'native'
              && /^\s*<recommended_plugins>/i.test(existing.name || '')
              && m.name
              && !/^\s*<recommended_plugins>/i.test(m.name)) {
            existing.name = m.name;
            existing.updatedAt = Math.max(Number(existing.updatedAt) || 0, Number(m.updatedAt) || 0);
          }
          continue;
        }
        taken.add(m.id);
        const persistedNativeMeta = pendingNativeQueueMeta.get(m.id);
        pendingNativeQueueMeta.delete(m.id);
        sessions.set(m.id, {
          id: m.id,
          name: m.name,
          status: 'idle',
          agentType: m.agentType === 'codex' ? 'codex' : 'claude',
          cwd: m.cwd,
          model: null,
          effort: null,
          autoAllow: false,
          archived: false,
          engineRefs: m.engineRefs || { claude: m.id, codex: null },
          lastEngine: m.agentType === 'codex' ? 'codex' : 'claude',
          pid: null,
          msgCount: 0,            // 惰性：開啟轉換後才知精確則數
          source: 'native',
          nativeEngineType: m.agentType === 'codex' ? 'codex' : 'claude',
          nativePath: m.nativePath,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
          messages: [],
          queued: persistedNativeMeta ? queuedInputs(persistedNativeMeta) : [],
          proc: null,
          cancelled: false,
        });
        added++;
      }
    });
  };
  // ── candidate snapshot (async; must not touch `sessions`) ────────────────
  // Codex full-tree walk and every workspace's Claude discovery share one
  // limiter and run concurrently — none of this reads or writes `sessions`,
  // so GET/WS/bridge readers see only the pre-refresh snapshot for the whole
  // duration of this block.
  const limiter = createNativeIoLimiter();
  const codexScan = scanCodexNative(workspaces, metrics, { limiter }).catch((e) => {
    recordRefreshError(metrics, 'codex-scan');
    console.error('[ingest] codex scan 失敗:', e.message);
    return [];
  });
  const claudeScans = Promise.all(workspaces.map((cwd) => (
    scanNative(cwd, metrics, { forceDiscovery: forceProjectDiscovery, limiter }).catch((e) => {
      recordRefreshError(metrics, 'claude-scan');
      console.error('[ingest] claude scan 失敗:', cwd, e.message);
      return [];
    })
  )));
  const [codexMetas, claudeMetasByWorkspace] = await Promise.all([codexScan, claudeScans]);
  const codexMetasByWorkspace = new Map();
  for (const meta of codexMetas) {
    const key = path.resolve(meta.cwd).toLowerCase();
    if (!codexMetasByWorkspace.has(key)) codexMetasByWorkspace.set(key, []);
    codexMetasByWorkspace.get(key).push(meta);
  }

  // ── atomic publish (fully synchronous — no `await` from here on) ─────────
  // `taken` is computed against the live sessions Map *now*, not at scan-
  // start, so a session that appeared while the scan above was awaiting I/O
  // is never clobbered. ingestMetas only ever adds ids that are still absent
  // from `taken`; it never overwrites or removes an already-tracked session.
  // That makes this revalidation sufficient for atomic publish today — the
  // fuller per-record generation/version + field-ownership rebase the plan
  // describes for updating or removing *existing* records has nothing to
  // attach to yet and is deferred to batch 5.
  const taken = measureRefreshPhase(metrics, 'reconciliationMs', () => {
    const ids = new Set();
    for (const s of sessions.values()) {
      ids.add(s.id);
      if (s.engineRefs?.claude) ids.add(s.engineRefs.claude);
      if (s.engineRefs?.codex) ids.add(`codex-${s.engineRefs.codex}`);
    }
    return ids;
  });
  for (let i = 0; i < workspaces.length; i++) {
    const cwd = workspaces[i];
    ingestMetas(claudeMetasByWorkspace[i]);
    const codexKey = typeof cwd === 'string' && cwd.trim()
      ? path.resolve(cwd).toLowerCase()
      : null;
    ingestMetas(codexKey ? codexMetasByWorkspace.get(codexKey) || [] : []);
    if (codexKey) codexMetasByWorkspace.delete(codexKey);
  }
  measureRefreshPhase(metrics, 'reconciliationMs', applyRetention);
  persistIndex();
  return added;
}

export function createSession({ name, agentType, cwd, model, effort, autoAllow }) {
  const now = Date.now();
  const s = {
    id: newId(),
    name: name || null,
    status: 'idle',
    agentType,
    cwd,
    model: model || null,
    effort: effort || null,
    autoAllow: !!autoAllow,
    archived: false,
    engineRefs: { claude: null, codex: null },
    lastEngine: null,
    pid: null,
    msgCount: 0,
    createdAt: now,
    updatedAt: now,
    messages: [],
    queued: [],
    proc: null,
    cancelled: false,
  };
  sessions.set(s.id, s);
  applyRetention();
  persistIndex();
  return s;
}

export function sessionsArr(metrics = null) {
  return measureRefreshPhase(metrics, 'sessionsMaterializationMs', () => (
    [...sessions.values()]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(metaOf)
  ));
}
