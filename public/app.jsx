// agent-hub-remote v2 — app shell（真後端版，守凍結 §F）。
// 與 ui/ 原型差異：拔 IOSDevice/TweaksPanel 預覽殼；mock 模擬 → 真 fetch + WS；
// fork/compact/delete v1 隱藏（無 §F 後端，plan 決策）。
// 認證：L1 Tailscale Serve；L2 step-up TOTP → action-token（spec §5.4）。
// 無 session cookie、無 30min elevated 概念；危險動作每次重新 step-up。

const { useState: useStateA, useEffect: useEffectA, useRef: useRefA } = React;

const now = () => new Date().toTimeString().slice(0, 5);
const STEP_UP_SKIPPED = Symbol('step-up-skipped');
const AHR_NATIVE_SLASH_COMMANDS = new Set(['/help', '/clear', '/compact', '/rewind', '/review-flow']);

function isAhrNativeSlash(value) {
  const parsed = window.parseSlash ? window.parseSlash(value) : null;
  return !!(parsed && AHR_NATIVE_SLASH_COMMANDS.has(parsed.cmd));
}

function StepUpTotpModal({ dialog, onChange, onSubmit, onCancel, onPasskey, onSkip }) {
  if (!dialog) return null;
  return (
    <>
      <div className="sheet-scrim" onClick={dialog.busy ? undefined : onCancel}/>
      <div className="sheet" style={{
        position: 'fixed', left: 12, right: 12, bottom: 12, maxWidth: 460,
        margin: '0 auto', zIndex: 61,
      }}>
        <div className="sheet-head">
          <button className="nav-btn" onClick={onCancel} disabled={dialog.busy} aria-label="cancel">
            <span className="ic-x"/>
          </button>
          <div className="crumb"><span className="crumb-cmd">{dialog.title || 'step-up'}</span></div>
        </div>
        <div className="sheet-body" style={{ paddingBottom: 12 }}>
          <div className="sec" style={{ padding: 14 }}>
            <div className="sec-h" style={{ padding: 0 }}>TOTP fallback</div>
            {dialog.body ? <div className="hint" style={{ padding: '8px 0 0' }}>{dialog.body}</div> : null}
            {dialog.passkeyError ? (
              <div className="hint" style={{ padding: '8px 0 0', color: 'var(--st-error)' }}>
                Passkey failed: {dialog.passkeyError}
              </div>
            ) : null}
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={dialog.code || ''}
              onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
              disabled={dialog.busy}
              placeholder="000000"
              aria-label="TOTP code"
              style={{
                width: '100%', height: 38, marginTop: 12, padding: '0 10px',
                border: '1px solid var(--border)', background: 'var(--raised)',
                color: dialog.error ? 'var(--st-error)' : 'var(--fg)',
                font: 'inherit', letterSpacing: '0.08em', textAlign: 'center',
                outline: 'none',
              }}
            />
            {dialog.error ? (
              <div className="hint" style={{ padding: '8px 0 0', color: 'var(--st-error)' }}>{dialog.error}</div>
            ) : null}
          </div>
        </div>
        <div className="sheet-foot">
          {dialog.allowSkip ? (
            <button className="btn" onClick={onSkip} disabled={dialog.busy}>skip</button>
          ) : null}
          {dialog.passkeyAvailable ? (
            <button className="btn" onClick={onPasskey} disabled={dialog.busy}>use Passkey</button>
          ) : null}
          <button className="btn primary" onClick={onSubmit} disabled={dialog.busy || (dialog.code || '').length !== 6}>
            submit
          </button>
        </div>
      </div>
    </>
  );
}

function StartupPasskeyGate({ gate, onVerify, onRefresh, onEnroll, onTotpChange, onTotpSubmit }) {
  if (!gate || gate.verified) return null;
  const passkeys = gate.passkeys || {};
  const count = Number.isFinite(passkeys.count) ? passkeys.count : 0;
  const canEnroll = !!passkeys.enrollEnabled;
  const noPasskeys = !gate.checking && !gate.loading && !passkeys.error && count <= 0;
  const showTotp = !!gate.totpVisible;
  return (
    <>
      <div className="sheet-scrim"/>
      <div className="sheet" style={{
        position: 'fixed', left: 12, right: 12, bottom: 12, maxWidth: 460,
        margin: '0 auto', zIndex: 62,
      }}>
        <div className="sheet-head">
          <div className="crumb"><span className="crumb-cmd">startup passkey</span></div>
        </div>
        <div className="sheet-body" style={{ paddingBottom: 12 }}>
          <div className="sec" style={{ padding: 14 }}>
            <div className="sec-h" style={{ padding: 0 }}>Startup verification</div>
            <div className="hint" style={{ padding: '8px 0 0' }}>
              AHR restarted. Verify this browser once before reconnecting sessions.
            </div>
            {!showTotp ? (
              <div className="hint" style={{ padding: '8px 0 0' }}>
                {gate.busy ? 'Opening Passkey verification...' : 'Waiting for Passkey verification...'}
              </div>
            ) : null}
            {gate.error ? (
              <div className="hint" style={{ padding: '8px 0 0', color: 'var(--st-error)' }}>
                {gate.error}
              </div>
            ) : null}
            {passkeys.error ? (
              <div className="hint" style={{ padding: '8px 0 0', color: 'var(--st-error)' }}>
                {passkeys.error}
              </div>
            ) : null}
            {noPasskeys ? (
              <div className="hint" style={{ padding: '8px 0 0' }}>
                No passkey is enrolled for this AHR origin.
                {passkeys.enrollFlagPath ? ` Enrollment flag: ${passkeys.enrollFlagPath}` : ''}
              </div>
            ) : null}
            {showTotp ? (
              <>
                <div className="sec-h" style={{ padding: '12px 0 0' }}>TOTP backup</div>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={gate.code || ''}
                  onChange={(e) => onTotpChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={(e) => { if (e.key === 'Enter') onTotpSubmit(); }}
                  disabled={gate.busy || gate.checking}
                  placeholder="000000"
                  aria-label="startup TOTP code"
                  style={{
                    width: '100%', height: 38, marginTop: 8, padding: '0 10px',
                    border: '1px solid var(--border)', background: 'var(--raised)',
                    color: gate.error ? 'var(--st-error)' : 'var(--fg)',
                    font: 'inherit', letterSpacing: '0.08em', textAlign: 'center',
                    outline: 'none',
                  }}
                />
              </>
            ) : null}
          </div>
        </div>
        <div className="sheet-foot">
          {showTotp && noPasskeys && canEnroll ? (
            <button className="btn" onClick={onEnroll} disabled={gate.busy || gate.checking}>enroll Passkey</button>
          ) : null}
          {showTotp ? (
            <button className="btn" onClick={onRefresh} disabled={gate.busy || gate.checking}>refresh</button>
          ) : null}
          {showTotp ? (
            <button className="btn" onClick={() => onTotpSubmit()} disabled={gate.busy || gate.checking || (gate.code || '').length !== 6}>
            submit TOTP
            </button>
          ) : null}
          {showTotp ? (
            <button className="btn primary" onClick={onVerify} disabled={gate.busy || gate.checking || noPasskeys}>
              retry Passkey
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

function fallbackMsgKey(msg) {
  return [
    msg.t || '',
    msg.kind || '',
    msg.engine || '',
    msg.ts || '',
    msg.text || '',
  ].join('\u001f');
}

function sameUiMessage(a, b) {
  if (!a || !b) return false;
  const ak = a._key || fallbackMsgKey(a);
  const bk = b._key || fallbackMsgKey(b);
  return ak === bk;
}

function appendUiMessage(prev, sid, msg) {
  const arr = prev[sid] || [];
  if (arr.some(m => sameUiMessage(m, msg))) return prev;
  return { ...prev, [sid]: [...arr, msg] };
}

function App() {
  const [view, setView] = useStateA('thread');
  const [wsState, setWsState] = useStateA('connecting');

  const [sessions, setSessions] = useStateA([]);
  const [messagesById, setMessagesById] = useStateA({});
  const [activeId, setActiveId] = useStateA(null);
  const [drafts, setDrafts] = useStateA({});
  const [queues, setQueues] = useStateA({});
  const [pendingFiles, setPendingFiles] = useStateA({});
  const [projectFilter, setProjectFilter] = useStateA(null);
  const [rowActionsId, setRowActionsId] = useStateA(null);
  const [renameId, setRenameId] = useStateA(null);
  const [stepDialog, setStepDialog] = useStateA(null);
  const [passkeyAvailable, setPasskeyAvailable] = useStateA(false);
  const [startupGate, setStartupGate] = useStateA({ checking: true, verified: false, busy: false, error: '', passkeys: null });
  const [nativeRefreshBusy, setNativeRefreshBusy] = useStateA(false);
  // Unread agent-message counts per session; in-memory only (cleared on reload).
  const [unreadById, setUnreadById] = useStateA({});

  const activeIdRef = useRefA(null);
  const sessionsRef = useRefA([]);
  const refreshingSessionsRef = useRefA(false);
  const stepResolveRef = useRefA(null);
  const startupVerifiedRef = useRefA(false);
  const startupBootIdRef = useRefA(null);
  const startupPasskeyAttemptedRef = useRefA(false);
  const mainStartedRef = useRefA(false);
  const connRef = useRefA(null);
  const localTokenRequestRef = useRefA(false);
  // Per-session set of message keys we've already incorporated. Authoritative
  // dedupe source so unread counting can't double-count a re-delivered message.
  const seenMsgKeysRef = useRefA(new Map());
  // Tracks whether the socket was down, so we only backfill unread on a true
  // reconnect (not on the initial connect).
  const wasDownRef = useRefA(false);
  activeIdRef.current = activeId;
  sessionsRef.current = sessions;

  async function refreshSessions({ selectFirst = false } = {}) {
    if (refreshingSessionsRef.current) return sessionsRef.current;
    refreshingSessionsRef.current = true;
    setNativeRefreshBusy(true);
    try {
      let ss;
      try {
        ss = await window.AHR.refreshSessions();
      } catch (e) {
        ss = await window.AHR.sessions();
      }
      setSessions(ss);
      pruneUnread(ss);
      if (selectFirst && ss.length && !activeIdRef.current) {
        const first = ss[0];
        setActiveId(first.sessionId);
        await refreshThread(first.sessionId, { markRead: true });
      }
      return ss;
    } finally {
      refreshingSessionsRef.current = false;
      setNativeRefreshBusy(false);
    }
  }

  async function refreshStartupPasskeys() {
    setStartupGate(prev => ({ ...prev, checking: true, error: '' }));
    try {
      const status = await window.AHR.passkeyStatus();
      setPasskeyAvailable(!!(status && status.enrolled));
      setStartupGate(prev => ({ ...prev, checking: false, passkeys: status, error: '' }));
      return status;
    } catch (e) {
      const passkeys = { error: e.message || String(e) };
      setStartupGate(prev => ({ ...prev, checking: false, passkeys }));
      return passkeys;
    }
  }

  async function ensureStartupVerified() {
    try {
      const status = await window.AHR.startupStatus();
      if (status && status.verified) {
        startupVerifiedRef.current = true;
        startupBootIdRef.current = status.bootId || startupBootIdRef.current;
        startupPasskeyAttemptedRef.current = false;
        setStartupGate(prev => ({
          ...prev, checking: false, verified: true, busy: false, error: '',
          bootId: status.bootId || prev.bootId,
        }));
        return true;
      }

      startupVerifiedRef.current = false;
      const bootId = status && status.bootId || null;
      const newBoot = bootId && bootId !== startupBootIdRef.current;
      if (newBoot) {
        startupBootIdRef.current = bootId;
        startupPasskeyAttemptedRef.current = false;
      }
      let passkeys;
      try {
        passkeys = await window.AHR.passkeyStatus();
        setPasskeyAvailable(!!(passkeys && passkeys.enrolled));
      } catch (e) {
        passkeys = { error: e.message || String(e) };
      }
      const alreadyTried = startupPasskeyAttemptedRef.current;
      setStartupGate(prev => ({
        ...prev, checking: false, verified: false, busy: false,
        error: alreadyTried ? prev.error : '',
        bootId: bootId || prev.bootId,
        passkeys,
        totpVisible: alreadyTried ? true : false,
        code: alreadyTried ? (prev.code || '') : '',
      }));
      return false;
    } catch (e) {
      if (startupVerifiedRef.current) return true;
      setStartupGate(prev => ({
        ...prev, checking: false, verified: false, busy: false,
        error: e.message || String(e),
      }));
      return false;
    }
  }

  async function reloadAfterStartupUnlock() {
    if (!mainStartedRef.current) {
      await startMain();
      return;
    }
    try { await window.AHR.dirs(); } catch (e) {}
    try { await refreshSessions({ selectFirst: true }); } catch (e) {}
  }

  async function verifyStartupPasskey() {
    startupPasskeyAttemptedRef.current = true;
    setStartupGate(prev => ({ ...prev, busy: true, error: '', totpVisible: false }));
    try {
      const r = await window.AHR.stepUpPasskey({ action: 'startup' });
      await window.AHR.startupUnlock(r.token);
      startupVerifiedRef.current = true;
      setPasskeyAvailable(true);
      setStartupGate(prev => ({ ...prev, checking: false, verified: true, busy: false, error: '', totpVisible: false, code: '' }));
      await reloadAfterStartupUnlock();
      return true;
    } catch (e) {
      if (e.status === 404) setPasskeyAvailable(false);
      let passkeys = startupGate.passkeys;
      try { passkeys = await window.AHR.passkeyStatus(); } catch (statusErr) {}
      setStartupGate(prev => ({
        ...prev, checking: false, verified: false, busy: false,
        error: e.message || String(e),
        passkeys,
        totpVisible: true,
      }));
      return false;
    }
  }

  async function triggerStartupPasskey() {
    if (startupVerifiedRef.current || startupPasskeyAttemptedRef.current) return false;
    return verifyStartupPasskey();
  }

  function updateStartupTotpCode(code) {
    setStartupGate(prev => ({ ...prev, code, error: '' }));
    if (code.length === 6) setTimeout(() => submitStartupTotp(code), 0);
  }

  async function submitStartupTotp(codeOverride) {
    const code = codeOverride || (startupGate && startupGate.code) || '';
    if (startupGate.busy || code.length !== 6) return false;
    setStartupGate(prev => ({ ...prev, busy: true, error: '' }));
    try {
      const r = await window.AHR.stepUpTotp({ action: 'startup', code });
      await window.AHR.startupUnlock(r.token);
      startupVerifiedRef.current = true;
      setStartupGate(prev => ({ ...prev, checking: false, verified: true, busy: false, error: '', code: '' }));
      await reloadAfterStartupUnlock();
      return true;
    } catch (e) {
      setStartupGate(prev => ({
        ...prev, checking: false, verified: false, busy: false,
        error: e.message || String(e),
      }));
      return false;
    }
  }

  async function enrollStartupPasskey() {
    setStartupGate(prev => ({ ...prev, busy: true, error: '' }));
    try {
      await window.AHR.enrollPasskey('AHR startup Passkey');
      setStartupGate(prev => ({ ...prev, busy: false }));
      await refreshStartupPasskeys();
    } catch (e) {
      setStartupGate(prev => ({
        ...prev, checking: false, verified: false, busy: false,
        error: e.message || String(e),
      }));
    }
  }

  // Drop unread (and dedupe) entries for sessions that no longer exist, so a
  // removed session can't leave the global ☰ dot stuck on with no row to clear.
  function pruneUnread(nextSessions) {
    const ids = new Set(nextSessions.map(s => s.sessionId));
    setUnreadById(prev => {
      let changed = false;
      const next = {};
      for (const k of Object.keys(prev)) {
        if (ids.has(k)) next[k] = prev[k]; else changed = true;
      }
      return changed ? next : prev;
    });
    for (const k of [...seenMsgKeysRef.current.keys()]) {
      if (!ids.has(k)) seenMsgKeysRef.current.delete(k);
    }
  }

  // Process one live message: dedupe via the seen-set (authoritative, so unread
  // can't double-count a re-delivered message), append, then count unread for an
  // agent message landing on a non-active session.
  function handleIncomingMsg(sid, msg) {
    const key = msg._key || fallbackMsgKey(msg);
    let seen = seenMsgKeysRef.current.get(sid);
    if (!seen) { seen = new Set(); seenMsgKeysRef.current.set(sid, seen); }
    const isNew = !seen.has(key);
    if (isNew) seen.add(key);
    setMessagesById(prev => appendUiMessage(prev, sid, msg));
    if (!isNew) return;
    if (msg.t === 'agent' && sid !== activeIdRef.current) {
      setUnreadById(prev => ({ ...prev, [sid]: (prev[sid] || 0) + 1 }));
    }
    if (msg.t === 'agent' && (document.hidden || sid !== activeIdRef.current) && window.AHRNotifications) {
      const sess = sessionsRef.current.find(s => s.sessionId === sid);
      window.AHRNotifications.output(sess, msg);
    }
  }

  // Agent messages that arrived for inactive sessions while the socket was down
  // never hit the live handler. Reload the thread and count agent messages not
  // already in the seen-set, so the badge reflects what was missed.
  // `gap` is how many messages were added while the socket was down (new minus
  // last-known msgCount). Count agent messages only within that newest segment —
  // never the whole tail — so a session with no in-memory baseline (never opened
  // this lifetime) can't have its entire history counted as unread.
  async function backfillUnread(sid, gap) {
    try {
      const msgs = await window.AHR.thread(sid);
      let seen = seenMsgKeysRef.current.get(sid);
      if (!seen) { seen = new Set(); seenMsgKeysRef.current.set(sid, seen); }
      const n = Math.min(gap, msgs.length);     // tail is capped; a >tail gap can only under-count
      const segment = n > 0 ? msgs.slice(-n) : [];
      let added = 0;
      for (const m of segment) {
        const key = m._key || fallbackMsgKey(m);
        if (m.t === 'agent' && !seen.has(key)) added++;   // intersect seen-set: race-safe vs live path
      }
      // Seed dedupe keys for the whole loaded tail so the live path won't recount.
      for (const m of msgs) seen.add(m._key || fallbackMsgKey(m));
      setMessagesById(prev => ({ ...prev, [sid]: msgs }));
      if (added > 0) setUnreadById(prev => ({ ...prev, [sid]: (prev[sid] || 0) + added }));
    } catch (e) {}
  }

  async function backfillOnReconnect() {
    const prevById = new Map(sessionsRef.current.map(s => [s.sessionId, s.msgCount || 0]));
    let ss;
    try { ss = await refreshSessions(); } catch (e) { return; }
    for (const s of ss) {
      if (s.sessionId === activeIdRef.current) continue;
      const old = prevById.get(s.sessionId);
      if (old === undefined) continue;          // new session: don't retro-count its history
      const gap = (s.msgCount || 0) - old;
      if (gap > 0) backfillUnread(s.sessionId, gap);
    }
  }

  function handleWsState(state) {
    setWsState(state);
    if (state === 'ok' && wasDownRef.current) {
      wasDownRef.current = false;
      backfillOnReconnect();
    }
    if (state === 'down') {
      wasDownRef.current = true;
      setTimeout(() => {
        ensureStartupVerified().then(ok => { if (!ok) triggerStartupPasskey(); });
      }, 500);
    }
  }

  async function startMain() {
    if (mainStartedRef.current || !startupVerifiedRef.current) return;
    mainStartedRef.current = true;
    try { await window.AHR.dirs(); } catch (e) {}
    try { await refreshSessions({ selectFirst: true }); } catch (e) {}
    try {
      const status = await window.AHR.passkeyStatus();
      setPasskeyAvailable(!!(status && status.enrolled));
    } catch (e) {}
    connRef.current = window.AHR.connect({
      onState: handleWsState,
      onSessions: (mapped) => { setSessions(mapped); pruneUnread(mapped); },
      onMsg: handleIncomingMsg,
      onDone: (sid) => {
        setSessions(prev => prev.map(s => s.sessionId === sid && s.status === 'running'
          ? { ...s, status: 'idle' } : s));
        scheduleDequeue(sid);
      },
      onReload: (sid) => refreshThread(sid, { markRead: sid === activeIdRef.current }),
    });
    checkPendingLocalTokenRequest();
  }

  // ── 掛載：拉 dirs + sessions，開 WS ────────────────────────────────────────
  useEffectA(() => {
    let cancelled = false;
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        ensureStartupVerified().then(ok => {
          if (ok) {
            refreshSessions();
            checkPendingLocalTokenRequest();
          } else {
            triggerStartupPasskey();
          }
        });
      }
    };
    const onStartupRequired = (ev) => {
      startupVerifiedRef.current = false;
      const detail = ev && ev.detail || {};
      if (detail.bootId && detail.bootId !== startupBootIdRef.current) {
        startupBootIdRef.current = detail.bootId;
        startupPasskeyAttemptedRef.current = false;
      }
      setStartupGate(prev => ({
        ...prev, checking: false, verified: false, busy: false, error: '',
        bootId: detail.bootId || prev.bootId,
        totpVisible: startupPasskeyAttemptedRef.current ? true : false,
      }));
      refreshStartupPasskeys().then(() => { triggerStartupPasskey(); });
    };
    const onLocalTokenRequest = async (ev) => {
      if (localTokenRequestRef.current) return;
      localTokenRequestRef.current = true;
      try {
        const result = await mintLocalToken();
        try { await window.AHR.clearLocalTokenRequest(); } catch (e) {}
        if (result && activeIdRef.current) {
          pushMsg(activeIdRef.current, {
            t: 'system', kind: 'auth',
            text: 'local orchestration authorized',
            ts: now(),
          });
        }
      } catch (e) {
        if (activeIdRef.current) {
          pushMsg(activeIdRef.current, {
            t: 'system', kind: 'error',
            text: 'local orchestration authorization failed: ' + (e.message || String(e)),
            ts: now(),
          });
        }
      } finally {
        localTokenRequestRef.current = false;
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('ahr_startup_required', onStartupRequired);
    window.addEventListener('ahr_local_token_request', onLocalTokenRequest);
    (async () => {
      const ok = await ensureStartupVerified();
      if (!cancelled && ok) await startMain();
      if (!cancelled && !ok) await triggerStartupPasskey();
    })();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('ahr_startup_required', onStartupRequired);
      window.removeEventListener('ahr_local_token_request', onLocalTokenRequest);
      if (connRef.current) connRef.current.close();
      connRef.current = null;
    };
  }, []);

  async function checkPendingLocalTokenRequest() {
    try {
      const pending = await window.AHR.localTokenRequestPending();
      if (pending && pending.pending) {
        window.dispatchEvent(new CustomEvent('ahr_local_token_request', { detail: pending }));
      }
    } catch (e) {}
  }

  // Unread is cleared in refreshThread (only after a successful load); the
  // global ☰ dot lights when any still-existing session has unread.
  const hasUnread = Object.values(unreadById).some(n => n > 0);

  const activeSession = sessions.find(s => s.sessionId === activeId) || sessions[0] || null;
  const activeMessages = (activeId && messagesById[activeId]) || [];
  const activeQueue = (activeId && queues[activeId]) || [];
  const draft = (activeId && drafts[activeId]) || '';
  const setDraft = (v) => setDrafts(prev => ({ ...prev, [activeId]: v }));
  const activePendingFiles = (activeId && pendingFiles[activeId]) || [];

  function addPendingFile(file) {
    if (!file || !activeId) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setPendingFiles(prev => ({
        ...prev,
        [activeId]: [...(prev[activeId] || []), {
          dataUrl: e.target.result,
          name: file.name || 'attachment.bin',
          type: file.type || '',
          size: file.size,
          isImage: !!(file.type && file.type.startsWith('image/')),
        }],
      }));
    };
    reader.readAsDataURL(file);
  }

  function removePendingFile(idx) {
    setPendingFiles(prev => {
      const files = [...(prev[activeId] || [])];
      files.splice(idx, 1);
      return { ...prev, [activeId]: files };
    });
  }

  async function pickSession(s) {
    setActiveId(s.sessionId);
    setView('thread');
    await refreshThread(s.sessionId, { markRead: true });
  }

  // markRead clears unread for this session, but only after the thread loads
  // successfully — a failed/aborted load must not zero the badge for messages
  // the user never actually saw.
  async function refreshThread(sid, { markRead = false } = {}) {
    if (!sid) return false;
    try {
      const msgs = await window.AHR.thread(sid);
      setMessagesById(prev => ({ ...prev, [sid]: msgs }));
      seenMsgKeysRef.current.set(sid, new Set(msgs.map(m => m._key || fallbackMsgKey(m))));
      if (markRead) setUnreadById(prev => (prev[sid] ? { ...prev, [sid]: 0 } : prev));
      return true;
    } catch (e) { return false; }
  }

  function openDrawer() {
    setView('drawer');
    refreshSessions();
  }

  function applyActionResult(sid, result) {
    if (result && result.messages) {
      setMessagesById(prev => ({ ...prev, [sid]: result.messages }));
    }
    if (result && result.session) {
      setSessions(prev => prev.map(s => s.sessionId === sid ? result.session : s));
    }
  }

  function pushMsg(sid, msg) {
    setMessagesById(prev => appendUiMessage(prev, sid, msg));
  }
  function setStatus(sid, status) {
    setSessions(prev => prev.map(s => s.sessionId === sid ? { ...s, status } : s));
  }

  // ── 送訊息：續送既有 session（唯一接回既有對話的路徑，plan #4）──────────────
  async function sendText(sid, text, files) {
    const hasText = text && text.trim().length > 0;
    const hasFiles = files && files.length > 0;
    if (!hasText && !hasFiles) return;
    const sess = sessions.find(s => s.sessionId === sid);
    const optimisticText = text + (hasFiles ? `\n[files: ${files.length}]` : '');

    // Show an optimistic local user message; websocket echoes from the server are ignored.
    pushMsg(sid, { t: 'user', text: optimisticText, ts: now() });
    setSessions(prev => prev.map(s => s.sessionId === sid
      ? { ...s, status: 'running', msgCount: (s.msgCount || 0) + 1, updatedAt: Date.now() }
      : s));
    let uploadedFiles = [];

    // Upload attachments before sending so the engine receives local temp paths.
    if (hasFiles) {
      try {
        const results = await Promise.all(
          files.map(file => window.AHR.upload(sid, {
            base64: file.dataUrl,
            filename: file.name,
            type: file.type,
            size: file.size,
          }))
        );
        uploadedFiles = results;
      } catch (e) {
        pushMsg(sid, { t: 'system', kind: 'error', text: '檔案上傳失敗：' + e.message, ts: now() });
        setStatus(sid, 'error');
        return;
      }
      setPendingFiles(prev => ({ ...prev, [sid]: [] }));
    }

    const payload = {
      text,
      engine: sess && sess.agentType,
      model: sess && sess.model,
      files: uploadedFiles.length ? uploadedFiles : undefined,
    };
    try {
      await window.AHR.send(sid, payload);
    } catch (e) {
      // 原生 resume 失敗 → 後端阻擋並要求同意改走 bridge（禁止無脈絡開新）。
      if (e.status === 409 && e.body && e.body.needBridgeConsent) {
        const ok = window.confirm(e.body.error || '原生續接失敗，要用前文脈絡（bridge）接續嗎？');
        if (!ok) {
          pushMsg(sid, { t: 'system', kind: 'error', text: '已取消接續：未同意 bridge，未開新對話（原訊息未送出）。', ts: now() });
          setStatus(sid, 'idle');
          return;
        }
        try {
          await window.AHR.send(sid, { ...payload, confirmBridge: true });
        } catch (e2) {
          pushMsg(sid, { t: 'system', kind: 'error', text: '送出失敗：' + e2.message, ts: now() });
          setStatus(sid, 'error');
        }
        return;
      }
      pushMsg(sid, { t: 'system', kind: 'error', text: '送出失敗：' + e.message, ts: now() });
      setStatus(sid, 'error');
    }
  }

  async function sendLiveInput(sid, text) {
    if (!sid || !text || !text.trim()) return;
    pushMsg(sid, { t: 'user', text, ts: now() });
    setSessions(prev => prev.map(s => s.sessionId === sid
      ? { ...s, msgCount: (s.msgCount || 0) + 1, updatedAt: Date.now() }
      : s));
    try {
      await window.AHR.liveInput(sid, text);
    } catch (e) {
      pushMsg(sid, { t: 'system', kind: 'error', text: 'live input failed: ' + e.message, ts: now() });
    }
  }

  function scheduleDequeue(sid) {
    setTimeout(() => {
      setQueues(prev => {
        const q = prev[sid] || [];
        if (!q.length) return prev;
        const [head, ...rest] = q;
        setTimeout(() => sendText(sid, head), 50);
        return { ...prev, [sid]: rest };
      });
    }, 300);
  }

  function send() {
    const hasText = draft.trim().length > 0;
    const hasFiles = activePendingFiles.length > 0;
    if (!hasText && !hasFiles) return;
    if (!activeId) return;
    const text = draft.trim();
    if (hasText && isAhrNativeSlash(text)) { setDraft(''); runSlash(activeId, text); return; }
    if (activeSession && activeSession.status === 'running') {
      if (hasFiles) {
        pushMsg(activeId, { t: 'system', kind: 'error', text: '檔案需等目前回合結束後再送出', ts: now() });
        return;
      }
      setDraft('');
      if (hasText) sendLiveInput(activeId, text);
      return;
    }
    setDraft('');
    sendText(activeId, text, activePendingFiles);
  }

  function queueDraft() {
    if (!draft.trim() || !activeId) return;
    setQueues(prev => ({ ...prev, [activeId]: [...(prev[activeId] || []), draft.trim()] }));
    setDraft('');
  }

  async function stop() {
    if (!activeId) return;
    try { await window.AHR.cancel(activeId); } catch (e) {}
    setStatus(activeId, 'idle');
  }
  async function stopFromList(s) {
    try { await window.AHR.cancel(s.sessionId); } catch (e) {}
    setStatus(s.sessionId, 'idle');
  }

  // ── slash：v1 僅保留純前端可實現者；其餘明示未支援 ─────────────────────────
  // step-up helper：Passkey UV first, TOTP fallback only when needed.
  function resolveStepDialog(token) {
    const resolve = stepResolveRef.current;
    stepResolveRef.current = null;
    setStepDialog(null);
    if (resolve) resolve(token || null);
  }

  function requestTotpStepUp({ action, sessionId, title, body, passkeyError, canUsePasskey, allowSkip }) {
    return new Promise(resolve => {
      stepResolveRef.current = resolve;
      setStepDialog({
        action, sessionId, title, body, passkeyError: passkeyError || '',
        passkeyAvailable: !!canUsePasskey,
        allowSkip: !!allowSkip,
        code: '', error: '', busy: false,
      });
    });
  }

  function skipStepDialog() {
    const resolve = stepResolveRef.current;
    stepResolveRef.current = null;
    setStepDialog(null);
    if (resolve) resolve(STEP_UP_SKIPPED);
  }

  function updateTotpCode(code) {
    setStepDialog(d => d ? { ...d, code, error: '' } : d);
    if (code.length === 6) setTimeout(() => submitTotpStepUp(code), 0);
  }

  async function submitTotpStepUp(codeOverride) {
    const code = codeOverride || (stepDialog && stepDialog.code) || '';
    if (!stepDialog || stepDialog.busy || code.length !== 6) return;
    setStepDialog(d => d ? { ...d, busy: true, error: '' } : d);
    try {
      const r = await window.AHR.stepUpTotp({
        code,
        action: stepDialog.action,
        sessionId: stepDialog.sessionId,
      });
      resolveStepDialog(r.token);
    } catch (e) {
      setStepDialog(d => d ? { ...d, busy: false, error: e.message || String(e) } : d);
    }
  }

  async function retryPasskeyStepUp() {
    if (!stepDialog || stepDialog.busy) return;
    setStepDialog(d => d ? { ...d, busy: true, error: '', passkeyError: '' } : d);
    try {
      const r = await window.AHR.stepUpPasskey({
        action: stepDialog.action,
        sessionId: stepDialog.sessionId,
      });
      setPasskeyAvailable(true);
      resolveStepDialog(r.token);
    } catch (e) {
      if (e.status === 404) setPasskeyAvailable(false);
      setStepDialog(d => d ? {
        ...d, busy: false, passkeyError: e.message || String(e),
        passkeyAvailable: e.status !== 404,
      } : d);
    }
  }

  async function stepUp({ action, sessionId, confirmText, title, body, allowSkip }) {
    if (confirmText && !window.confirm(confirmText)) return null;
    let canPasskey = passkeyAvailable;
    if (!canPasskey) {
      try {
        const status = await window.AHR.passkeyStatus();
        canPasskey = !!(status && status.enrolled);
        setPasskeyAvailable(canPasskey);
      } catch (e) {}
    }
    if (!canPasskey) {
      return requestTotpStepUp({ action, sessionId, title, body, canUsePasskey: false, allowSkip });
    }
    try {
      const r = await window.AHR.stepUpPasskey({ action, sessionId });
      setPasskeyAvailable(true);
      return r.token;
    } catch (e) {
      if (e.status === 404) setPasskeyAvailable(false);
      return requestTotpStepUp({
        action, sessionId, title, body,
        passkeyError: e.message || String(e),
        canUsePasskey: e.status !== 404,
        allowSkip,
      });
    }
  }

  async function restartServer() {
    try {
      const token = await stepUp({
        action: 'restart',
        confirmText: 'Restart agent-hub-remote server now?',
        title: 'restart server',
        body: 'Enter TOTP only if Passkey verification is unavailable.',
      });
      if (!token) return;
      if (activeId) {
        pushMsg(activeId, { t: 'system', kind: 'restart', text: 'server restart requested', ts: now() });
      }
      await window.AHR.restartServer(token);
    } catch (e) {
      if (activeId) {
        pushMsg(activeId, { t: 'system', kind: 'error', text: 'server restart failed: ' + e.message, ts: now() });
      }
    }
  }

  async function mintLocalToken() {
    const token = await stepUp({
      action: 'mint-local-token',
      title: 'local orchestration',
      body: 'Enter TOTP only if Passkey verification is unavailable.',
    });
    if (!token) return null;
    return window.AHR.mintLocalToken(token);
  }

  async function runSlash(sid, value) {
    const parsed = window.parseSlash(value);
    if (!parsed) return;
    const { cmd, args } = parsed;
    const sysSlash = (text) => pushMsg(sid, { t: 'system', kind: 'slash', cmd, text, ts: now() });
    switch (cmd) {
      case '/help':
        sysSlash('Supported: `/help`, `/clear`, `/compact`, `/rewind`, `/rewind N`.\n' +
          '`/compact` summarizes the effective thread and starts the next engine turn from that summary. `/rewind N` keeps context before user turn N and starts a new engine thread.');
        break;
      case '/clear':
        setMessagesById(prev => ({ ...prev, [sid]: [] }));
        sysSlash('*前端檢視已清* · 後端對話與 JSONL 保留（重開即回）');
        break;
      case '/compact':
        sysSlash('Compacting session...');
        try {
          const result = await window.AHR.compact(sid);
          applyActionResult(sid, result);
        } catch (e) {
          sysSlash('Compact failed: ' + (e.message || String(e)));
        }
        break;
      case '/rewind': {
        const n = args && args.trim() ? Number(args.trim()) : null;
        if (!n) {
          try {
            const info = await window.AHR.rewindTurns(sid);
            const turns = info.turns || [];
            if (!turns.length) {
              sysSlash('No user turns to rewind.');
              break;
            }
            const recent = turns.slice(-8).reverse().map(t => `#${t.n} ${t.text}`).join('\n');
            sysSlash(`User turns (${turns.length}). Run \`/rewind N\` to discard turn N and everything after it.\n\n${recent}`);
          } catch (e) {
            sysSlash('Rewind list failed: ' + (e.message || String(e)));
          }
          break;
        }
        if (!Number.isInteger(n) || n < 1) {
          sysSlash('Usage: `/rewind N`, where N is a positive user turn number.');
          break;
        }
        sysSlash(`Rewinding before turn #${n}...`);
        try {
          const result = await window.AHR.rewind(sid, n);
          applyActionResult(sid, result);
        } catch (e) {
          sysSlash('Rewind failed: ' + (e.message || String(e)));
        }
        break;
      }
      case '/review-flow': {
        try {
          const token = await stepUp({
            action: 'review-flow',
            sessionId: sid,
            title: 'review flow',
            body: 'Passkey first; enter TOTP only if Passkey is unavailable. Use skip to continue without step-up.',
            allowSkip: true,
          });
          if (!token) {
            sysSlash('Review flow canceled before sending.');
            break;
          }
          sysSlash(token === STEP_UP_SKIPPED
            ? 'Review flow step-up skipped; sending command.'
            : 'Review flow authorized; sending command.');
          if (activeSession && activeSession.status === 'running') sendLiveInput(sid, value);
          else sendText(sid, value);
        } catch (e) {
          sysSlash('Review flow step-up failed: ' + (e.message || String(e)));
        }
        break;
      }
      default:
        sysSlash(`\`${cmd}\` is not supported by AHR yet.`);
    }
  }
  function pickSlash(c) {
    if (c.args) setDraft(c.name + ' ');
    else {
      setDraft('');
      if (isAhrNativeSlash(c.name)) runSlash(activeId, c.name);
      else if (activeSession && activeSession.status === 'running') sendLiveInput(activeId, c.name);
      else sendText(activeId, c.name);
    }
  }

  // ── toggleAuto（spec §6.1）─────────────────────────────────────────────────
  // 開啟：需 step-up 換 action-token；關閉：降權直接打 API。
  async function toggleAuto() {
    if (!activeSession) return;
    const sid = activeSession.sessionId;
    if (activeSession.autoAllow) {
      // 關閉 = 降權，無需 step-up
      try { await window.AHR.autoAllow(sid, false); } catch (e) {}
      setSessions(prev => prev.map(s => s.sessionId === sid ? { ...s, autoAllow: false } : s));
      return;
    }
    // 開啟
    try {
      const token = await stepUp({
        action: 'autoallow-on',
        sessionId: sid,
        confirmText: '開啟 auto-mode？後續工具呼叫將跳過權限詢問，直到手動關閉。',
        title: 'auto-mode',
        body: 'Enter TOTP only if Passkey verification is unavailable.',
      });
      if (!token) return false;
      await window.AHR.autoAllow(sid, true, token);
      setSessions(prev => prev.map(s => s.sessionId === sid
        ? { ...s, autoAllow: true } : s));
      pushMsg(sid, { t: 'system', kind: 'swap', text: '✓ auto-mode 已開（手動關閉前持續有效）', ts: now() });
      return true;
    } catch (e) {
      pushMsg(sid, { t: 'system', kind: 'error', text: 'step-up 失敗：' + e.message, ts: now() });
      throw e;
    }
  }

  // ── 開新 session ──────────────────────────────────────────────────────────
  async function createSession({ cwd, engine, model, autoAllow, prompt }) {
    try {
      let actionToken;
      if (autoAllow) {
        actionToken = await stepUp({
          action: 'create-with-autoallow',
          confirmText: '開新 session 並啟用 auto-mode？',
          title: 'new session auto-mode',
          body: 'Enter TOTP only if Passkey verification is unavailable.',
        });
        if (!actionToken) return;
      }
      const { sessionId } = await window.AHR.createSession({
        cwd, engine, model, autoAllow, prompt, actionToken,
      });
      const optimistic = {
        sessionId, name: (prompt || `new ${engine}`).split('\n')[0].slice(0, 35),
        status: 'starting', agentType: engine, cwd, model: model || null,
        autoAllow: !!autoAllow,
        msgCount: prompt ? 1 : 0,
        updatedAt: Date.now(), accent: window.AHR.accentOf(sessionId),
      };
      setSessions(prev => [optimistic, ...prev.filter(s => s.sessionId !== sessionId)]);
      setMessagesById(prev => ({ ...prev, [sessionId]: prompt ? [{ t: 'user', text: prompt, ts: now() }] : [] }));
      setActiveId(sessionId);
      setView('thread');
      refreshThread(sessionId, { markRead: true });
    } catch (e) {
      alert('建立失敗：' + e.message);
    }
  }

  async function patchActive(patch) {
    if (!activeSession) return;
    const sid = activeSession.sessionId;
    setSessions(prev => prev.map(s => s.sessionId === sid ? { ...s, ...patch } : s));
    if (patch.name != null) { try { await window.AHR.rename(sid, patch.name); } catch (e) {} }
    // agentType/model：不單獨打 API，隨下一次 /send 帶上（plan §H：中途切引擎）
  }

  const innerApp = (
    <>
      <StartupPasskeyGate
        gate={startupGate}
        onVerify={verifyStartupPasskey}
        onRefresh={refreshStartupPasskeys}
        onEnroll={enrollStartupPasskey}
        onTotpChange={updateStartupTotpCode}
        onTotpSubmit={submitStartupTotp}
      />
      {activeSession ? (
        <Thread
          key={activeSession.sessionId}
          session={activeSession}
          messages={activeMessages}
          queue={activeQueue}
          onOpenDrawer={openDrawer}
          onOpenOptions={() => setView('options')}
          onToggleAuto={toggleAuto}
          value={draft}
          setValue={setDraft}
          onSend={send}
          onStop={stop}
          onQueue={queueDraft}
          onSlashPick={pickSlash}
          wsState={wsState}
          files={activePendingFiles}
          onAddFile={addPendingFile}
          onRemoveFile={removePendingFile}
          onRestartServer={restartServer}
          hasUnread={hasUnread}
        />
      ) : (
        <div className="empty" style={{ position: 'absolute', inset: 0, zIndex: 2,
             background: 'var(--bg)', display: 'flex', flexDirection: 'column',
             alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <div className="empty-h">尚無對話</div>
          <div style={{ color: 'var(--fg-mute)' }}>建立第一條對話開始</div>
          <button className="btn" onClick={openDrawer}
            style={{ marginTop: 12 }}>☰ 開啟抽屜</button>
        </div>
      )}

      {view === 'drawer' && (
        <Drawer
          onClose={() => setView('thread')}
          sessions={sessions}
          activeId={activeId}
          projectFilter={projectFilter}
          setProjectFilter={setProjectFilter}
          onPick={pickSession}
          onStop={stopFromList}
          unread={unreadById}
          onNew={() => setView('new-session')}
          onOpenSettings={() => setView('settings')}
          onOpenUsage={() => setView('usage')}
          onRefresh={refreshSessions}
          refreshing={nativeRefreshBusy}
          onLongPress={(s) => { setRowActionsId(s.sessionId); setView('row-actions'); }}
        />
      )}

      {view === 'new-session' && (
        <NewSession
          sessions={sessions}
          projectFilter={projectFilter}
          onClose={() => setView('drawer')}
          onStart={(payload) => createSession(payload)}
        />
      )}

      {view === 'options' && activeSession && (
        <Options
          session={activeSession}
          onClose={() => setView('thread')}
          onSwapEngine={(eng) => patchActive({ agentType: eng, model: null })}
          onChangeModel={(m) => patchActive({ model: m })}
          onToggleAuto={toggleAuto}
          onRename={() => { setRenameId(activeId); setView('rename'); }}
          onArchive={() => { patchActive({ status: 'archived' }); setView('thread'); }}
          onDelete={null}
        />
      )}

      {view === 'settings' && (
        <Settings onClose={() => setView('drawer')} />
      )}

      {view === 'usage' && <Usage onClose={() => setView('drawer')} />}

      {view === 'row-actions' && (() => {
        const target = sessions.find(s => s.sessionId === rowActionsId) || activeSession;
        if (!target) return null;
        return (
          <RowActions
            session={target}
            onClose={() => { setRowActionsId(null); setView('drawer'); }}
            onRename={() => { setRenameId(target.sessionId); setRowActionsId(null); setView('rename'); }}
            onDuplicate={null}
            onArchive={() => {
              const next = target.status === 'archived' ? 'idle' : 'archived';
              setSessions(prev => prev.map(s => s.sessionId === target.sessionId ? { ...s, status: next } : s));
              setRowActionsId(null); setView('drawer');
            }}
            onCopyId={() => { try { navigator.clipboard?.writeText(target.sessionId); } catch (e) {} }}
            onDelete={null}
          />
        );
      })()}

      {view === 'rename' && (() => {
        const target = sessions.find(s => s.sessionId === renameId) || activeSession;
        if (!target) return null;
        return (
          <Rename
            session={target}
            onClose={() => { setRenameId(null); setView('thread'); }}
            onSave={(newName) => {
              setSessions(prev => prev.map(s => s.sessionId === target.sessionId ? { ...s, name: newName } : s));
              window.AHR.rename(target.sessionId, newName).catch(() => {});
              setRenameId(null); setView('thread');
            }}
          />
        );
      })()}

      <StepUpTotpModal
        dialog={stepDialog}
        onChange={updateTotpCode}
        onSubmit={submitTotpStepUp}
        onCancel={() => resolveStepDialog(null)}
        onPasskey={retryPasskeyStepUp}
        onSkip={skipStepDialog}
      />
    </>
  );

  return <div className="app">{innerApp}</div>;
}

ReactDOM.createRoot(document.getElementById('stage')).render(<App />);
