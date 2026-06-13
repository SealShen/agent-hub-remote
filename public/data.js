// agent-hub-remote — 真 adapter（取代 Claude Design 原 mock）。
// 守凍結 §F 後端，於前端做 §F ⇄ UI 形狀對映（INTEGRATION.md：data.js 是唯一要改的檔）。
// 後端協定見 server.js；身分 = hub uuid（UI 沿用欄位名 sessionId）。

// ── UI 仍依賴的常數（沿用原 mock 定義）──────────────────────────────────────
window.ACCENTS = ['#a78bfa', '#34d399', '#fb923c', '#f472b6', '#38bdf8', '#facc15'];

window.STATUS_LABELS = {
  running: '執行中', starting: '啟動中', interrupted: '已中斷',
  idle: '閒置', error: '錯誤', archived: '已封存',
};

window.formatRelative = function (ts) {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
};

// React init 時同步讀取 → 先給空集合，掛載後由 AHR.bootstrap() 拉真資料
window.MOCK_DIRS = [];
window.MOCK_SESSIONS = [];
window.MOCK_MESSAGES = {};

// ── shape 對映 ──────────────────────────────────────────────────────────────
function _accentOf(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0;
  return h % 6;
}
function _hhmm(ms) {
  const d = new Date(ms || Date.now());
  return d.toTimeString().slice(0, 5);
}

function _engineRefs(m) {
  const refs = m && m.engineRefs ? m.engineRefs : {};
  return { claude: refs.claude || null, codex: refs.codex || null };
}

function _resetIdLine(reset) {
  const refs = reset && reset.previousEngineRefs ? reset.previousEngineRefs : null;
  if (!refs) return '';
  const parts = [];
  if (refs.claude) parts.push(`old claude id: ${refs.claude}`);
  if (refs.codex) parts.push(`old codex id: ${refs.codex}`);
  return parts.length ? parts.join('\n') : '';
}

let _dirs = [];   // [{alias,label,path}]
function _cwdToAlias(cwd) {
  if (!cwd) return null;
  const norm = String(cwd).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  let best = null;
  for (const d of _dirs) {
    const p = String(d.path || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    if (p && (norm === p || norm.startsWith(p + '/'))) {
      if (!best || p.length > best._plen) best = { ...d, _plen: p.length };
    }
  }
  return best ? best.alias : cwd;
}

window.AHR_CLAUDE_MODELS = [
  { id: 'sonnet', label: 'sonnet', sub: 'default · fast' },
  { id: 'opus', label: 'opus', sub: 'deep · slow' },
  { id: 'haiku', label: 'haiku', sub: 'cheap · trivia' },
];
window.AHR_CLAUDE_MODEL_ORDER = window.AHR_CLAUDE_MODELS.map(m => m.id);

window.AHR_modelLabel = function (value, engine) {
  const isSession = value && typeof value === 'object';
  const agentType = engine || (isSession ? value.agentType : null);
  const model = isSession ? value.model : value;
  if (agentType === 'codex') return 'GPT';
  // 完整 claude-* ID 縮成家族名顯示（claude-fable-5 → fable）
  const m = /^claude-([a-z]+)/i.exec(model || '');
  if (m) return m[1].toLowerCase();
  return model || '';
};

// §F session meta → UI session
window.AHR_mapSession = function (m) {
  return {
    sessionId: m.id,
    name: m.name || '(未命名)',
    status: m.archived ? 'archived' : (m.status || 'idle'),
    agentType: m.agentType === 'codex' ? 'codex' : 'claude',
    cwd: _cwdToAlias(m.cwd),
    model: m.model || null,
    autoAllow: !!m.autoAllow,
    msgCount: m.msgCount || 0,
    updatedAt: m.updatedAt || Date.now(),
    accent: _accentOf(m.id),
    _cwdAbs: m.cwd,
    _lastEngine: m.lastEngine || null,
    _engineRefs: _engineRefs(m),
    _contextReset: m.contextReset || null,
  };
};

// §F message（JSONL 一行）→ UI message
window.AHR_mapMsg = function (m, sessEngine) {
  const ts = _hhmm(m.ts);
  const key = [m.role || '', m.kind || '', m.engine || sessEngine || '', m.ts || '', m.text || ''].join('\u001f');
  if (m.role === 'user') return { t: 'user', text: m.text || '', ts, _key: key };
  if (m.role === 'assistant')
    return { t: 'agent', engine: m.engine || sessEngine || 'claude', text: m.text || '', ts, _key: key };
  if (m.role === 'error')
    return { t: 'system', kind: 'error', text: m.text || 'error', ts, _key: key };
  // system
  const resetLine = _resetIdLine(m.contextReset);
  const txt = (m.text || '') + (resetLine ? '\n' + resetLine : '');
  let kind = m.kind || 'info';
  if (/^↻|重啟|interrupted|中斷/.test(txt)) kind = 'restart';
  else if (/^↪|帶入前文脈絡|脈絡/.test(txt)) kind = 'swap';
  return { t: 'system', kind, text: txt, ts, contextReset: m.contextReset || null, _key: key };
};

// ── §F API（皆走相對路徑；cookie 由瀏覽器帶）────────────────────────────────
async function _j(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) {
    if (j && j.needStartupVerification) {
      window.dispatchEvent(new CustomEvent('ahr_startup_required', { detail: j }));
    }
    const e = new Error((j && j.error) || ('HTTP ' + r.status));
    e.status = r.status;
    e.body = j;
    throw e;
  }
  return j;
}

function _b64urlToBuffer(value) {
  const s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function _bufferToB64url(buffer) {
  const bytes = new Uint8Array(buffer || 0);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function _prepareCreateOptions(options) {
  return {
    ...options,
    challenge: _b64urlToBuffer(options.challenge),
    user: { ...options.user, id: _b64urlToBuffer(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map(c => ({
      ...c,
      id: _b64urlToBuffer(c.id),
    })),
  };
}

function _prepareGetOptions(options) {
  return {
    ...options,
    challenge: _b64urlToBuffer(options.challenge),
    allowCredentials: (options.allowCredentials || []).map(c => ({
      ...c,
      id: _b64urlToBuffer(c.id),
    })),
  };
}

function _registrationToJSON(cred) {
  const response = {
    clientDataJSON: _bufferToB64url(cred.response.clientDataJSON),
    attestationObject: _bufferToB64url(cred.response.attestationObject),
  };
  const transports = cred.response.getTransports && cred.response.getTransports();
  if (transports && transports.length) response.transports = transports;
  if (cred.response.getAuthenticatorData) {
    const data = cred.response.getAuthenticatorData();
    if (data) response.authenticatorData = _bufferToB64url(data);
  }
  if (cred.response.getPublicKey) {
    const publicKey = cred.response.getPublicKey();
    if (publicKey) response.publicKey = _bufferToB64url(publicKey);
  }
  if (cred.response.getPublicKeyAlgorithm) {
    response.publicKeyAlgorithm = cred.response.getPublicKeyAlgorithm();
  }
  return {
    id: cred.id,
    rawId: _bufferToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    response,
  };
}

function _authenticationToJSON(cred) {
  return {
    id: cred.id,
    rawId: _bufferToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    response: {
      clientDataJSON: _bufferToB64url(cred.response.clientDataJSON),
      authenticatorData: _bufferToB64url(cred.response.authenticatorData),
      signature: _bufferToB64url(cred.response.signature),
      userHandle: cred.response.userHandle ? _bufferToB64url(cred.response.userHandle) : undefined,
    },
  };
}

async function _createPasskey(options) {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('Passkey not supported');
  const cred = await navigator.credentials.create({ publicKey: _prepareCreateOptions(options) });
  if (!cred) throw new Error('Passkey enrollment cancelled');
  return _registrationToJSON(cred);
}

async function _getPasskey(options) {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('Passkey not supported');
  const cred = await navigator.credentials.get({ publicKey: _prepareGetOptions(options) });
  if (!cred) throw new Error('Passkey verification cancelled');
  return _authenticationToJSON(cred);
}

const NOTIFY_KEY = 'ahr.notify.output';

function _notifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

window.AHRNotifications = {
  supported() {
    return _notifySupported();
  },
  status() {
    if (!_notifySupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    return localStorage.getItem(NOTIFY_KEY) === '1' && Notification.permission === 'granted'
      ? 'enabled'
      : 'disabled';
  },
  async enable() {
    if (!_notifySupported()) return 'unsupported';
    const perm = Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;
    if (perm !== 'granted') {
      localStorage.removeItem(NOTIFY_KEY);
      return perm === 'denied' ? 'denied' : 'disabled';
    }
    localStorage.setItem(NOTIFY_KEY, '1');
    return 'enabled';
  },
  disable() {
    localStorage.removeItem(NOTIFY_KEY);
    return this.status();
  },
  output(session, msg) {
    if (this.status() !== 'enabled') return;
    const title = `${msg.engine === 'codex' ? 'Codex' : 'Claude'} output`;
    const body = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 180)
      || (session && session.name) || 'agent-hub';
    try {
      const n = new Notification(title, {
        body,
        tag: `ahr-output-${session ? session.sessionId : 'unknown'}`,
        renotify: true,
      });
      n.onclick = () => {
        try { window.focus(); } catch (e) {}
        n.close();
      };
      if (navigator.vibrate) navigator.vibrate(80);
    } catch (e) {}
  },
};

// Model normalize: `default` means account default.
// Codex clears model metadata so stale Claude names do not display or persist.
function _model(m, engine) {
  if (engine === 'codex') return '';
  return (!m || m === 'default') ? undefined : m;
}

function _mapActionResult(r) {
  const session = r && r.session ? window.AHR_mapSession(r.session) : null;
  const eng = r && r.session ? r.session.agentType : null;
  return {
    ...r,
    session,
    messages: (r && r.messages ? r.messages : []).map(m => window.AHR_mapMsg(m, eng)),
  };
}

window.AHR = {
  accentOf: _accentOf,

  async dirs() {
    _dirs = await _j('GET', '/dirs');
    window.MOCK_DIRS = _dirs.map(d => ({ alias: d.alias, label: d.label, path: d.path }));
    return window.MOCK_DIRS;
  },

  async sessions() {
    const arr = await _j('GET', '/sessions');
    return arr.map(window.AHR_mapSession);
  },

  async refreshSessions() {
    const data = await _j('POST', '/sessions/refresh', {});
    return (data.sessions || []).map(window.AHR_mapSession);
  },

  async thread(sid) {
    const data = await _j('GET', `/session/${sid}?tail=200`);
    const eng = data.agentType;
    return (data.messages || []).map(m => window.AHR_mapMsg(m, eng));
  },

  // 開新（無 id）；回 { sessionId }。autoAllow=true 時必須帶 actionToken（spec §5.4）。
  createSession({ cwd, engine, model, autoAllow, prompt, actionToken }) {
    return _j('POST', '/sessions', {
      text: prompt || '', cwd, agentType: engine, model: _model(model, engine),
      autoAllow: !!autoAllow,
      ...(actionToken ? { actionToken } : {}),
    });
  },

  // 上傳圖片（base64 data URL）→ 回 { path }，供 sendWithImages 收集路徑
  upload(sid, { base64, filename, type, size }) {
    return _j('POST', `/session/${sid}/upload`, {
      base64,
      filename: filename || 'attachment.bin',
      type: type || '',
      size: Number.isFinite(size) ? size : undefined,
    });
  },

  // 續送既有 session（唯一接回既有對話的路徑）；可中途切引擎/model（plan §H）
  send(sid, { text, engine, model, imagePaths, files, confirmBridge }) {
    return _j('POST', `/session/${sid}/send`, {
      text, agentType: engine || undefined, model: _model(model, engine),
      ...(imagePaths && imagePaths.length ? { imagePaths } : {}),
      ...(files && files.length ? { files } : {}),
      ...(confirmBridge ? { confirmBridge: true } : {}),
    });
  },

  async compact(sid) {
    return _mapActionResult(await _j('POST', `/session/${sid}/compact`, {}));
  },

  rewindTurns(sid) {
    return _j('GET', `/session/${sid}/rewind`);
  },

  async rewind(sid, turn) {
    return _mapActionResult(await _j('POST', `/session/${sid}/rewind`, { turn }));
  },

  // 用量監測（概念對齊 aqua5230/usage）：5h/7d 配額 + 今日 token/cost + 7 日趨勢
  usage(force) { return _j('GET', '/usage' + (force ? '?force=1' : '')); },
  restartServer(actionToken) { return _j('POST', '/server/restart', { actionToken }); },
  startupStatus() { return _j('GET', '/startup/status'); },
  startupUnlock(actionToken) { return _j('POST', '/startup/unlock', { actionToken }); },
  localTokenStatus() { return _j('GET', '/local-token/status'); },
  requestLocalToken(reason) { return _j('POST', '/local-token/request', { reason: reason || 'local orchestration' }); },
  localTokenRequestPending() { return _j('GET', '/local-token/request/pending'); },
  clearLocalTokenRequest() { return _j('POST', '/local-token/request/clear', {}); },
  mintLocalToken(actionToken) { return _j('POST', '/local-token/mint', { actionToken }); },
  revokeLocalToken() { return _j('POST', '/local-token/revoke', {}); },

  liveInput(sid, text) {
    return _j('POST', `/session/${sid}/live-input`, { text });
  },
  cancel(sid) { return _j('POST', `/session/${sid}/cancel`); },
  rename(sid, name) { return _j('POST', `/session/${sid}/rename`, { name }); },

  // Step-up（spec §5.1）：拿一次性 action-token 換危險動作
  //   action: 'restart' | 'autoallow-on' | 'create-with-autoallow' | 'startup' | 'mint-local-token' | 'review-flow'
  //   sessionId: action !== 'restart' 時必填
  stepUpTotp({ code, action, sessionId }) {
    return _j('POST', '/step-up/totp', { code, action, ...(sessionId ? { sessionId } : {}) });
  },
  passkeyStatus() {
    return _j('GET', '/passkey/status');
  },
  async stepUpPasskey({ action, sessionId }) {
    const options = await _j('POST', '/step-up/passkey/start', { action, ...(sessionId ? { sessionId } : {}) });
    const assertion = await _getPasskey(options);
    return _j('POST', '/step-up/passkey/finish', { action, ...(sessionId ? { sessionId } : {}), assertion });
  },
  async enrollPasskey(name) {
    const options = await _j('POST', '/enroll/passkey/start', { name: name || 'Passkey' });
    const attestation = await _createPasskey(options);
    return _j('POST', '/enroll/passkey/finish', { attestation });
  },
  // 關閉 autoAllow 不需要 step-up（降權）；開啟由呼叫端先 stepUpTotp 拿 actionToken
  autoAllow(sid, on, actionToken) {
    return _j('POST', `/session/${sid}/autoallow`, { on: !!on, ...(actionToken ? { actionToken } : {}) });
  },

  // WS：§F envelope → UI 回呼。自動重連（iOS 切 app 回來、tailnet 抖動）。
  connect({ onSessions, onMsg, onDone, onState, onReload }) {
    let ws, alive = false, backoff = 1000, closedByUs = false;
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/';
    function open() {
      onState && onState(alive ? 'reconnect' : 'connecting');
      ws = new WebSocket(url);
      ws.onopen = () => { alive = true; backoff = 1000; onState && onState('ok'); };
      ws.onmessage = ev => {
        let o; try { o = JSON.parse(ev.data); } catch { return; }
        if (o.type === 'sessions') onSessions && onSessions((o.data || []).map(window.AHR_mapSession));
        else if (o.type === 'msg') {
          if (o.fromUser) return;   // UI 已樂觀顯示使用者訊息，避免重複
          onMsg && onMsg(o.id, window.AHR_mapMsg(
            { role: o.role || (o.error ? 'error' : 'assistant'), kind: o.kind, text: o.text, ts: o.ts, engine: o.engine }, null));
        } else if (o.type === 'done') onDone && onDone(o.id, o.code);
        else if (o.type === 'thread_reload') onReload && onReload(o.id);
        else if (o.type === 'usage_update') window.dispatchEvent(new CustomEvent('ahr_usage_update'));
        else if (o.type === 'local_token_request') {
          window.dispatchEvent(new CustomEvent('ahr_local_token_request', { detail: o }));
        }
      };
      ws.onclose = () => {
        if (closedByUs) return;
        onState && onState('down');
        window.AHR.startupStatus().then(status => {
          if (status && !status.verified) {
            window.dispatchEvent(new CustomEvent('ahr_startup_required', { detail: status }));
          }
        }).catch(() => {});
        setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 15000);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }
    open();
    // iOS Chrome 切回前景時若 socket 已死，立即重連並補洞由呼叫端 re-GET
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && ws && ws.readyState > 1) open();
    });
    return { close() { closedByUs = true; try { ws.close(); } catch {} } };
  },
};
