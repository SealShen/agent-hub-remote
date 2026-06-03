// agent-hub-remote v2 — app shell（真後端版，守凍結 §F）。
// 與 ui/ 原型差異：拔 IOSDevice/TweaksPanel 預覽殼；mock 模擬 → 真 fetch + WS；
// fork/compact/delete v1 隱藏（無 §F 後端，plan 決策）。
// 認證：L1 Tailscale Serve；L2 step-up TOTP → action-token（spec §5.4）。
// 無 session cookie、無 30min elevated 概念；危險動作每次重新 step-up。

const { useState: useStateA, useEffect: useEffectA, useRef: useRefA } = React;

const now = () => new Date().toTimeString().slice(0, 5);

function StepUpTotpModal({ dialog, onChange, onSubmit, onCancel, onPasskey }) {
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
  const [loadedThreads, setLoadedThreads] = useStateA({});
  const [stepDialog, setStepDialog] = useStateA(null);
  const [passkeyAvailable, setPasskeyAvailable] = useStateA(false);
  const [nativeRefreshBusy, setNativeRefreshBusy] = useStateA(false);

  const activeIdRef = useRefA(null);
  const messagesByIdRef = useRefA({});
  const sessionsRef = useRefA([]);
  const refreshingSessionsRef = useRefA(false);
  const stepResolveRef = useRefA(null);
  activeIdRef.current = activeId;
  messagesByIdRef.current = messagesById;
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
      if (selectFirst && ss.length && !activeIdRef.current) {
        const first = ss[0];
        setActiveId(first.sessionId);
        await refreshThread(first.sessionId);
      }
      return ss;
    } finally {
      refreshingSessionsRef.current = false;
      setNativeRefreshBusy(false);
    }
  }

  // ── 掛載：拉 dirs + sessions，開 WS ────────────────────────────────────────
  useEffectA(() => {
    let conn;
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshSessions();
    };
    document.addEventListener('visibilitychange', onVisible);
    (async () => {
      try { await window.AHR.dirs(); } catch (e) { /* 401 已轉跳 */ }
      try { await refreshSessions({ selectFirst: true }); } catch (e) {}
      try {
        const status = await window.AHR.passkeyStatus();
        setPasskeyAvailable(!!(status && status.enrolled));
      } catch (e) {}
      conn = window.AHR.connect({
        onState: setWsState,
        onSessions: (mapped) => setSessions(mapped),
        onMsg: (sid, msg) => {
          const duplicate = (messagesByIdRef.current[sid] || []).some(m => sameUiMessage(m, msg));
          setMessagesById(prev => appendUiMessage(prev, sid, msg));
          if (!duplicate && msg.t === 'agent' && (document.hidden || sid !== activeIdRef.current) && window.AHRNotifications) {
            const sess = sessionsRef.current.find(s => s.sessionId === sid);
            window.AHRNotifications.output(sess, msg);
          }
        },
        onDone: (sid) => {
          setSessions(prev => prev.map(s => s.sessionId === sid && s.status === 'running'
            ? { ...s, status: 'idle' } : s));
          scheduleDequeue(sid);
        },
        onReload: (sid) => refreshThread(sid),
      });
    })();
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      conn && conn.close();
    };
  }, []);

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
    if (!loadedThreads[s.sessionId]) {
      await refreshThread(s.sessionId);
    }
  }

  async function refreshThread(sid) {
    if (!sid) return;
    try {
      const msgs = await window.AHR.thread(sid);
      setMessagesById(prev => ({ ...prev, [sid]: msgs }));
      setLoadedThreads(prev => ({ ...prev, [sid]: true }));
    } catch (e) {}
  }

  function openDrawer() {
    setView('drawer');
    refreshSessions();
  }

  function applyActionResult(sid, result) {
    if (result && result.messages) {
      setMessagesById(prev => ({ ...prev, [sid]: result.messages }));
      setLoadedThreads(prev => ({ ...prev, [sid]: true }));
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
    if (hasText && text.startsWith('/')) { setDraft(''); runSlash(activeId, text); return; }
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

  function requestTotpStepUp({ action, sessionId, title, body, passkeyError, canUsePasskey }) {
    return new Promise(resolve => {
      stepResolveRef.current = resolve;
      setStepDialog({
        action, sessionId, title, body, passkeyError: passkeyError || '',
        passkeyAvailable: !!canUsePasskey,
        code: '', error: '', busy: false,
      });
    });
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

  async function stepUp({ action, sessionId, confirmText, title, body }) {
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
      return requestTotpStepUp({ action, sessionId, title, body, canUsePasskey: false });
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
      default:
        sysSlash(`\`${cmd}\` is not supported by AHR yet.`);
    }
  }
  function pickSlash(c) {
    if (c.args) setDraft(c.name + ' ');
    else { setDraft(''); runSlash(activeId, c.name); }
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
      if (prompt) setMessagesById(prev => ({ ...prev, [sessionId]: [{ t: 'user', text: prompt, ts: now() }] }));
      setLoadedThreads(prev => ({ ...prev, [sessionId]: true }));
      setActiveId(sessionId);
      setView('thread');
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
      {activeSession ? (
        <Thread
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

      {view === 'settings' && <Settings onClose={() => setView('drawer')} />}

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
      />
    </>
  );

  return <div className="app">{innerApp}</div>;
}

ReactDOM.createRoot(document.getElementById('stage')).render(<App />);
