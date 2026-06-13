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

// One message
function Msg({ m, accent }) {
  const MDComp = window.MD;
  if (m.t === 'system') {
    const kind = m.kind || '';
    // slash-generated system msg shows the command in accent + body in md
    if (kind === 'slash') {
      return (
        <div className={`sys slash`}>
          <span className="slash-cmd" style={{ color: accent }}>{m.cmd}</span>
          {m.text && (MDComp ? <MDComp text={m.text}/> : m.text)}
        </div>
      );
    }
    if ((kind === 'auto-commit' || kind === 'tool-diff') && MDComp) {
      return (
        <div className={`sys ${kind}`}>
          <MDComp text={m.text}/>
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
        {role === 'agent' && MDComp ? <MDComp text={m.text}/> : m.text}
        {m.streaming ? <span className="cursor"/> : null}
      </div>
    </div>
  );
}

// ── Composer ───────────────────────────────────────────────────
function Composer({ session, value, setValue, onSend, onStop, onQueue, onSlashPick, accent, files, onAddFile, onRemoveFile, onRestartServer }) {
  const ref = useRef(null);
  const fileRef = useRef(null);
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
  }, [value]);

  const isRunning = session.status === 'running' || session.status === 'starting';
  const hasFiles = files && files.length > 0;
  const canQueue = value.trim().length > 0 && !hasFiles;
  const canSend = value.trim().length > 0 || hasFiles;
  const canLiveSend = value.trim().length > 0 && !hasFiles;
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
          placeholder={isRunning ? '排到目前回合之後…' : ''}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (isRunning ? canLiveSend : canSend) onSend();
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
          {isRunning && canQueue && (
            <button className="cm-btn queue" onClick={onQueue} aria-label="queue">
              <span className="ic-plus"/>
            </button>
          )}
          {isRunning && (
            <button className="cm-btn primary" disabled={!canLiveSend} onClick={onSend} aria-label="send live input" title="send live input">
              <span className="ic-send"/>
            </button>
          )}
          {isRunning ? (
            <button className="cm-btn stop" onClick={onStop} aria-label="stop">
              <span className="ic-stop"/>
            </button>
          ) : (
            <button className="cm-btn primary" disabled={!canSend} onClick={onSend} aria-label="send">
              <span className="ic-send"/>
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ── Thread main ─────────────────────────────────────────────
function Thread({ session, messages, queue, onOpenDrawer, onOpenOptions, onToggleAuto, value, setValue, onSend, onStop, onQueue, onSlashPick, wsState, files, onAddFile, onRemoveFile, onRestartServer, hasUnread }) {
  const scrollRef = useRef(null);
  const accent = window.ACCENTS[session.accent || 0];
  const MDComp = window.MD;
  const [autoSubmitting, setAutoSubmitting] = useState(false);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, session.sessionId]);

  useEffect(() => {
    setAutoSubmitting(false);
  }, [session.sessionId, session.autoAllow]);

  async function toggleAutoMode() {
    if (autoSubmitting || !onToggleAuto) return;
    setAutoSubmitting(true);
    try { await onToggleAuto(); } catch (e) {}
    finally { setAutoSubmitting(false); }
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
        <span className="sep"/>
        <span>{session.msgCount} msg</span>
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

      {/* thread */}
      <div className="scroll" ref={scrollRef}>
        <div className="thread">
          {messages.map((m, i) => <Msg key={m._key || i} m={m} accent={accent}/>)}
          {queue && queue.length > 0 && queue.map((q, i) => (
            <div key={'q' + i} className="msg user queued">
              <div className="role-row">
                <span>you</span>
                <span className="q-tag">queued{queue.length > 1 ? ` · ${i + 1}/${queue.length}` : ''}</span>
              </div>
              <div className="body" style={{ color: accent, opacity: 0.6 }}>{q}</div>
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
          onQueue={onQueue}
          onSlashPick={onSlashPick}
          accent={accent}
          files={files}
          onAddFile={onAddFile}
          onRemoveFile={onRemoveFile}
          onRestartServer={onRestartServer}
        />
      </div>
    </div>
  );
}

Object.assign(window, { Thread, Msg, Eng, Composer });
