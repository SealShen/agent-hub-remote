// Thread — the main screen. A single selected conversation.
// Title row · status strip · banner (optional) · message flow · composer.

const { useState, useRef, useEffect, useMemo } = React;

// Engine badge
function Eng({ engine }) {
  const code = engine === 'claude' ? 'cl' : 'cx';
  return <span className={`eng ${code}`}>{code}</span>;
}

function codeWindowText(lang, text) {
  return '```' + (lang || 'text') + '\n' + String(text || '') + '\n```';
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

const INLINE_IMAGE_RE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

function MessageAttachments({ attachments }) {
  const [expired, setExpired] = useState({});
  if (!attachments || !attachments.length) return null;
  return (
    <div className="msg-attachments">
      {attachments.map((att, i) => {
        const id = encodeURIComponent(att.id || '');
        const size = fmtBytes(att.size);
        const label = [att.name || 'attachment', size].filter(Boolean).join(' · ');
        if (INLINE_IMAGE_RE.test(att.id || '') && !expired[att.id]) {
          return (
            <div className="att-image" key={att.id || i}>
              <a href={`/uploads/${id}?disposition=inline`} target="_blank" rel="noopener noreferrer">
                <img src={`/uploads/${id}?disposition=inline`} alt={att.name || 'image'} onError={() => setExpired(v => ({ ...v, [att.id]: true }))}/>
              </a>
              <span title={label}>{label}</span>
              <a className="att-download" href={`/uploads/${id}?disposition=attachment`} download={att.name || 'attachment'} aria-label={`download ${att.name || 'attachment'}`}>↓</a>
            </div>
          );
        }
        if (expired[att.id]) {
          return <div className="att-expired" key={att.id || i}><span>已過期</span><span title={label}>{label}</span></div>;
        }
        return <a className="att-chip" key={att.id || i} href={`/uploads/${id}?disposition=attachment`} download={att.name || 'attachment'}><span>{att.name || 'attachment'}</span><small>{size}</small><b>↓</b></a>;
      })}
    </div>
  );
}

// One message
function Msg({ m, accent, enableRedmineLinks, sessionId }) {
  const MDComp = window.MD;
  if (m.t === 'system') {
    const kind = m.kind || '';
    // slash-generated system msg shows the command in accent + body in md
    if (kind === 'slash') {
      return (
        <div className={`sys slash`}>
          <span className="slash-cmd" style={{ color: accent }}>{m.cmd}</span>
          {m.text && (MDComp ? <MDComp text={m.text} enableRedmineLinks={enableRedmineLinks}/> : m.text)}
        </div>
      );
    }
    if ((kind === 'auto-commit' || kind === 'tool-diff') && MDComp) {
      return (
        <div className={`sys ${kind}`}>
          <MDComp text={m.text} enableRedmineLinks={enableRedmineLinks}/>
        </div>
      );
    }
    if (kind === 'restart' && MDComp) {
      return (
        <div className={`sys ${kind} code-window`}>
          <MDComp text={codeWindowText('status', m.text)}/>
        </div>
      );
    }
    return (
      <div className={`sys ${kind}`}>{m.text}</div>
    );
  }
  if (m.t === 'tool') {
    return (
      <div className="tool">
        <span className="tname">{m.name}</span>
        <span className="arrow">→</span>
        <span>{m.detail}</span>
      </div>
    );
  }
  const role = m.t; // user | agent
  return (
    <div className={`msg ${role}`}>
      <div className="role-row">
        {role === 'agent' && m.engine ? <Eng engine={m.engine}/> : null}
        <span>{role === 'user' ? 'you' : (m.engine === 'codex' ? 'codex' : 'claude')}</span>
        <span className="ts">{m.ts}</span>
      </div>
      <div className="body" style={role === 'user' ? { color: accent } : null}>
        {role === 'agent' && MDComp ? <MDComp text={m.text} enableRedmineLinks={enableRedmineLinks} sessionId={sessionId}/> : m.text}
        {m.streaming ? <span className="cursor"/> : null}
      </div>
      {role === 'user' ? <MessageAttachments attachments={m.attachments}/> : null}
    </div>
  );
}

// ── Composer ───────────────────────────────────────────────────
function composerTextareaMaxHeight(ta) {
  const app = ta.closest('.app');
  const wrap = ta.closest('.composer-wrap');
  const scroll = app && app.querySelector('.scroll');
  const appRect = app && app.getBoundingClientRect();
  const wrapRect = wrap && wrap.getBoundingClientRect();
  const taRect = ta.getBoundingClientRect();
  const visualHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const appHeight = appRect ? Math.min(appRect.height, visualHeight) : visualHeight;
  let fixedHeight = 0;

  if (app && wrap) {
    for (const child of app.children) {
      if (child === wrap || child === scroll) continue;
      fixedHeight += child.getBoundingClientRect().height;
    }
  }

  const wrapExtra = wrapRect ? Math.max(0, wrapRect.height - taRect.height) : 0;
  return Math.max(44, Math.floor(appHeight - fixedHeight - wrapExtra - 8));
}

function resizeComposerTextarea(ta) {
  ta.style.height = 'auto';
  const maxHeight = composerTextareaMaxHeight(ta);
  ta.style.maxHeight = `${maxHeight}px`;
  ta.style.overflowY = ta.scrollHeight > maxHeight ? 'auto' : 'hidden';
  ta.style.height = Math.min(maxHeight, ta.scrollHeight) + 'px';
}

const THREAD_FOLLOW_THRESHOLD = 80;

function isThreadNearBottom(el) {
  return (el.scrollHeight - el.scrollTop - el.clientHeight) <= THREAD_FOLLOW_THRESHOLD;
}

function threadScrollKey(messages) {
  const last = messages[messages.length - 1];
  return [
    messages.length,
    last ? (last._key || '') : '',
    last ? String(last.text || '').length : 0,
    last && last.streaming ? 1 : 0,
  ].join('\u001f');
}

function Composer({ session, value, setValue, onSend, onStop, onSlashPick, accent, files, onAddFile, onRemoveFile, onRestartServer, layoutKey }) {
  const ref = useRef(null);
  const fileRef = useRef(null);
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    resizeComposerTextarea(ta);
  }, [value, files && files.length, layoutKey]);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    const resize = () => resizeComposerTextarea(ta);
    window.addEventListener('resize', resize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', resize);
    };
  }, []);

  const isRunning = session.status === 'running' || session.status === 'starting';
  const hasFiles = files && files.length > 0;
  // 送出條件不分閒置/執行中：使用者只管把 input 丟出來，該插進當前回合還是排到
  // 下一輪由 app.jsx 的 fallback 決定，不該由介面逼使用者先分類。
  const canSend = value.trim().length > 0 || hasFiles;
  const showSlash = window.isSlashTrigger ? window.isSlashTrigger(value) : false;
  const Popup = window.SlashPopup;

  function handlePaste(e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file && onAddFile) onAddFile(file);
        break;
      }
    }
  }

  function handlePick(e) {
    for (const file of Array.from(e.target.files || [])) {
      if (onAddFile) onAddFile(file);
    }
    e.target.value = '';
  }

  return (
    <>
      {showSlash && Popup && (
        <Popup
          query={value}
          accent={accent}
          onPick={(c) => onSlashPick(c)}
        />
      )}
      {hasFiles && (
        <div className="file-strip">
          {files.map((file, i) => (
            <div key={i} className="file-chip" title={`${file.name || 'attachment'} ${fmtBytes(file.size)}`}>
              {file.isImage ? <img src={file.dataUrl} alt={file.name || 'image'}/> : <span className="file-icon">file</span>}
              <span className="file-name">{file.name || 'attachment'}</span>
              <span className="file-size">{fmtBytes(file.size)}</span>
              <button className="file-rm" onClick={() => onRemoveFile && onRemoveFile(i)} aria-label="remove file">x</button>
            </div>
          ))}
        </div>
      )}
      <div className="composer" style={{ '--accent': accent }}>
        <div className="prompt">$</div>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={isRunning ? '輸入下一則…' : ''}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
        />
        <div className="composer-actions">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="file-input"
            onChange={handlePick}
          />
          <button className="cm-btn restart" onClick={onRestartServer} aria-label="restart server" title="restart server">
            <span className="ic-restart"/>
          </button>
          <button className="cm-btn attach" onClick={() => fileRef.current && fileRef.current.click()} aria-label="attach file" title="attach file">
            <span className="ic-attach"/>
          </button>
          {/* 送出鍵不分閒置/執行中都是同一顆；執行中額外多一顆 stop */}
          <button className="cm-btn primary" disabled={!canSend} onClick={onSend} aria-label="send">
            <span className="ic-send"/>
          </button>
          {isRunning && (
            <button className="cm-btn stop" onClick={onStop} aria-label="stop">
              <span className="ic-stop"/>
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ── 重新登入橫幅 ─────────────────────────────────────────────
// OAuth 過期時原地完成登入，不必回到跑 AHR 的那台機器。
// continuation 與授權碼只活在這個 component 的 state 裡：不 push 進訊息流
// （會落盤 + 廣播），送出後立刻清掉輸入框。
function ReloginBanner({ onStart }) {
  const [phase, setPhase] = useState('idle');   // idle | starting | awaiting | submitting | done
  const [url, setUrl] = useState('');
  const [continuation, setContinuation] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');

  async function begin() {
    setErr('');
    setPhase('starting');
    try {
      const r = await onStart();
      if (!r) return setPhase('idle');            // 使用者取消 step-up
      setUrl(r.url);
      setContinuation(r.continuation);
      setPhase('awaiting');
    } catch (e) {
      setErr(e.message || String(e));
      setPhase('idle');
    }
  }

  async function submit() {
    const value = code.trim();
    if (!value) return;
    setErr('');
    setPhase('submitting');
    setCode('');                                   // 碼不留在輸入框
    try {
      const r = await window.AHR.reloginCode({ continuation, code: value });
      if (r && r.ok) return setPhase('done');
      setErr((r && r.error) || '登入失敗');
      setPhase(r && r.restart ? 'idle' : 'awaiting');
      if (r && r.restart) { setUrl(''); setContinuation(''); }
    } catch (e) {
      setErr(e.message || String(e));
      setPhase('awaiting');
    }
  }

  if (phase === 'done') {
    return <div className="banner relogin ok">✓ 已重新登入 · 送出下一則訊息即可接回原對話</div>;
  }

  return (
    <div className="banner relogin">
      <div className="relogin-row">
        <span>🔑 登入已過期</span>
        {phase === 'idle' && (
          <button onClick={begin}>取得登入連結</button>
        )}
        {phase === 'starting' && <span className="b-spinner"/>}
      </div>
      {phase !== 'idle' && url && (
        <div className="relogin-row">
          <a href={url} target="_blank" rel="noreferrer noopener">① 開啟登入頁</a>
          <input
            type="text"
            value={code}
            placeholder="② 貼上授權碼"
            autoComplete="off"
            spellCheck={false}
            onChange={e => setCode(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            disabled={phase === 'submitting'}
          />
          <button onClick={submit} disabled={phase === 'submitting' || !code.trim()}>
            {phase === 'submitting' ? '驗證中…' : '送出'}
          </button>
        </div>
      )}
      {err && <div className="relogin-err">{err}</div>}
    </div>
  );
}

// ── Thread main ─────────────────────────────────────────────
function Thread({ session, messages, queue, onOpenDrawer, onOpenOptions, onToggleAuto, value, setValue, onSend, onStop, onUnqueue, onSlashPick, wsState, files, onAddFile, onRemoveFile, onRestartServer, onReloginStart, hasUnread }) {
  const scrollRef = useRef(null);
  const followOutputRef = useRef(true);
  const accent = window.ACCENTS[session.accent || 0];
  const MDComp = window.MD;
  // Public build intentionally leaves private issue-tracker linkification disabled.
  const enableRedmineLinks = false;
  const [autoSubmitting, setAutoSubmitting] = useState(false);
  const [harness, setHarness] = useState(null);
  const outputScrollKey = useMemo(() => threadScrollKey(messages), [messages]);

  // Harness backlog 只增不減，而 turn-close 提醒是一次性 inline 訊息、發完就被後續
  // 對話淹沒，且落在哪個 session 全看哪一輪剛好命中——所以常駐顯示放狀態列。
  // msgCount 每輪都變，拿來當「turn 收尾後重抓」的觸發訊號。
  useEffect(() => {
    if (!window.AHR || !window.AHR.harnessStatus) return;
    let cancelled = false;
    window.AHR.harnessStatus(session.sessionId)
      .then(r => { if (!cancelled) setHarness(r && r.enabled ? r : null); })
      .catch(() => { if (!cancelled) setHarness(null); });
    return () => { cancelled = true; };
  }, [session.sessionId, session.msgCount]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followOutputRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [outputScrollKey]);

  useEffect(() => {
    followOutputRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.sessionId]);

  useEffect(() => {
    setAutoSubmitting(false);
  }, [session.sessionId, session.autoAllow]);

  async function toggleAutoMode() {
    if (autoSubmitting || !onToggleAuto) return;
    setAutoSubmitting(true);
    try { await onToggleAuto(); } catch (e) {}
    finally { setAutoSubmitting(false); }
  }

  function handleThreadScroll(e) {
    followOutputRef.current = isThreadNearBottom(e.currentTarget);
  }

  // Cycle through agent's last message char count for live indicator
  const last = messages[messages.length - 1];
  const isStreaming = last?.streaming;
  // auto-mode 是純 server side flag；無 30min elev TTL。手動關閉前持續有效。
  const autoActive = !!session.autoAllow;

  return (
    <div className="app" style={{ '--accent': accent }}>
      {/* nav row */}
      <div className="nav">
        <button className="nav-btn" onClick={onOpenDrawer} aria-label={hasUnread ? 'menu, unread messages' : 'menu'}>
          <span className="ic-menu"/>
          {hasUnread && <span className="nav-unread-dot"/>}
        </button>
        <div className="title-zone">
          <span className={`dot ${session.status}`}/>
          <Eng engine={session.agentType}/>
          <span className="name">{session.name}</span>
        </div>
        <button className="nav-btn" onClick={onOpenOptions} aria-label="options">
          <span className="ic-gear"/>
        </button>
      </div>

      {/* status strip */}
      <div className="status-strip">
        <span style={{ color: accent }}>{window.STATUS_LABELS[session.status]}</span>
        <span className="sep"/>
        <span>{window.AHR_modelLabel ? window.AHR_modelLabel(session) : session.model}</span>
        {session.effort ? (
          <>
            <span className="sep"/>
            <span>{window.AHR_effortLabel ? window.AHR_effortLabel(session.effort) : `${session.effort} effort`}</span>
          </>
        ) : null}
        <span className="sep"/>
        <span>{session.msgCount} msg</span>
        {harness && harness.unreviewed > 0 ? (
          <>
            <span className="sep"/>
            <span
              title={`harness review backlog：${harness.unreviewedNeedsReview} 筆待審`
                + `（cursor 後共 ${harness.unreviewed} 筆事件，`
                + `event ${harness.lastReviewedEventId + 1}–${harness.lastEventId}）`
                + `\n${harness.dir}`
                + (harness.lastReviewedAt ? `\n上次審查 ${String(harness.lastReviewedAt).slice(0, 10)}` : '')
                + (harness.provenanceOk === false ? `\n⚠ cursor provenance：${harness.provenanceReason}` : '')}
              style={{ color: 'var(--st-interrupted)', whiteSpace: 'nowrap' }}>
              {/* 顯示待審實數而非 cursor 後全部事件：後者多數是無訊號的正常回合，
                  用它當徽章會讓 backlog 看起來大一個量級而失去行動意義。 */}
              ⚑ {harness.unreviewedNeedsReview}/{harness.unreviewed} 待審
              {harness.provenanceOk === false ? ' ⚠' : ''}
            </span>
          </>
        ) : null}
        <span style={{ flex: 1 }}/>
        <span>{session.cwd}</span>
        <span className="sep"/>
        {autoActive ? (
          <button
            onClick={() => {
              if (window.confirm('關閉 auto mode？')) toggleAutoMode();
            }}
            disabled={autoSubmitting}
            style={{
              background: 'none', border: 'none', padding: 0,
              cursor: 'pointer', font: 'inherit', fontSize: 11, lineHeight: 1,
              color: 'var(--st-interrupted)', whiteSpace: 'nowrap',
            }}>
            auto-on
          </button>
        ) : (
          <button
            onClick={toggleAutoMode}
            disabled={autoSubmitting}
            style={{
              background: 'none', border: 'none', padding: 0,
              cursor: 'pointer', font: 'inherit', fontSize: 11, lineHeight: 1,
              color: 'var(--fg-mute)', whiteSpace: 'nowrap',
            }}>
            auto-off
          </button>
        )}
      </div>

      {/* banner — ws or interrupted */}
      {wsState === 'down' && (
        <div className="banner ws-down">
          <span className="b-spinner"/>
          WS 連線中斷 · 嘗試重連中
          <button>取消</button>
        </div>
      )}
      {wsState === 'reconnect' && (
        <div className="banner ws-reconnect">
          <span className="b-spinner"/>
          已重連 · 補回缺漏訊息 (tail=50)
        </div>
      )}
      {session.status === 'interrupted' && (
        <div className="banner resume">
          {MDComp ? <MDComp text={codeWindowText('status', '↻ 已重啟 · 送出下一則訊息將以 --resume 接回')}/> : '↻ 已重啟 · 送出下一則訊息將以 --resume 接回'}
        </div>
      )}
      {/* Codex 認證過期沒有對應的遠端 relogin 流程（engines.js handleAuthFailure
          只驅動 `claude auth login`）；橫幅只在 Claude 這一側渲染，Codex 的
          系統訊息會改請使用者到主機處理。 */}
      {session.status === 'auth-expired' && session._lastEngine !== 'codex' && onReloginStart && (
        <ReloginBanner onStart={onReloginStart}/>
      )}

      {/* thread */}
      <div className="scroll" ref={scrollRef} onScroll={handleThreadScroll}>
        <div className="thread">
          {messages.map((m, i) => <Msg key={m._key || i} m={m} accent={accent} enableRedmineLinks={enableRedmineLinks} sessionId={session.sessionId}/>)}
          {queue && queue.length > 0 && queue.map((q, i) => (
            <div key={q.id || ('q' + i)} className="msg user queued">
              <div className="role-row">
                <span>you</span>
                <span className="q-tag">queued{queue.length > 1 ? ` · ${i + 1}/${queue.length}` : ''}</span>
                {onUnqueue && (
                  <button className="q-cancel" onClick={() => onUnqueue(q.id)} aria-label="cancel queued input">×</button>
                )}
              </div>
              <div className="body" style={{ color: accent, opacity: 0.6 }}>
                {q.text}{q.files && q.files.length ? `${q.text ? '\n' : ''}[files: ${q.files.length}]` : ''}
              </div>
            </div>
          ))}
          {isStreaming ? <div style={{ height: 8 }}/> : null}
        </div>
      </div>

      {/* composer */}
      <div className="composer-wrap">
        <Composer
          session={session}
          value={value}
          setValue={setValue}
          onSend={onSend}
          onStop={onStop}
          onSlashPick={onSlashPick}
          accent={accent}
          files={files}
          onAddFile={onAddFile}
          onRemoveFile={onRemoveFile}
          onRestartServer={onRestartServer}
          layoutKey={`${session.status}:${wsState}`}
        />
      </div>
    </div>
  );
}

Object.assign(window, { Thread, Msg, Eng, Composer, AHR_fmtBytes: fmtBytes });
