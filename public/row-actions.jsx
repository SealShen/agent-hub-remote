// row-actions — bottom action sheet shown when a session row is long-pressed
// in the drawer. Quick access: rename / duplicate / archive / copy id / delete.

const { useState: useStateRA } = React;

// hook for long-press → fire callback after `ms` of held pointer
window.useLongPress = function useLongPress(onLong, ms = 500) {
  const tref = React.useRef(null);
  const start = React.useRef({ x: 0, y: 0 });
  const moved = React.useRef(false);

  const clear = () => {
    if (tref.current) clearTimeout(tref.current);
    tref.current = null;
  };

  return {
    onPointerDown: (e) => {
      moved.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      tref.current = setTimeout(() => {
        if (!moved.current) onLong(e);
      }, ms);
    },
    onPointerMove: (e) => {
      const dx = e.clientX - start.current.x;
      const dy = e.clientY - start.current.y;
      if (dx * dx + dy * dy > 36) { moved.current = true; clear(); }
    },
    onPointerUp:     clear,
    onPointerLeave:  clear,
    onPointerCancel: clear,
    onContextMenu:   (e) => { e.preventDefault(); onLong(e); },  // desktop testing
  };
};

function RowActions({ session, onClose, onRename, onDuplicate, onArchive,
                      onCopyId, onDelete }) {
  const accent = window.ACCENTS[session.accent || 0];
  const archived = session.status === 'archived';
  const [copied, setCopied] = useStateRA(false);

  function copy() {
    onCopyId();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <>
      <div className="sheet-scrim" onClick={onClose}/>
      <div className="actions-sheet" style={{ '--accent': accent }}>
        {/* preview of the row we're acting on */}
        <div className="actions-preview">
          <span className={`dot ${session.status}`}/>
          <span className={`eng ${session.agentType === 'claude' ? 'cl' : 'cx'}`}>
            {session.agentType === 'claude' ? 'cl' : 'cx'}
          </span>
          <div className="ap-main">
            <div className="ap-name" style={{ color: accent }}>{session.name}</div>
            <div className="ap-sub">
              {window.STATUS_LABELS[session.status]} ·{' '}
              {session.msgCount} msg · {window.formatRelative(session.updatedAt)}
            </div>
          </div>
        </div>

        <button className="act-btn" onClick={onRename}>
          <span className="act-glyph">a/</span>
          rename
        </button>
        {onDuplicate && (
          <button className="act-btn" onClick={onDuplicate}>
            <span className="act-glyph">⎘</span>
            duplicate · fork from here
          </button>
        )}
        <button className={`act-btn ${archived ? '' : 'warn'}`} onClick={onArchive}>
          <span className="act-glyph">{archived ? '↺' : '⌃'}</span>
          {archived ? 'unarchive' : 'archive'}
        </button>
        <button className="act-btn" onClick={copy}>
          <span className="act-glyph">#</span>
          {copied ? 'copied · ' : 'copy id · '}
          <span style={{ color: 'var(--fg-mute)', fontSize: 12, marginLeft: 4 }}>
            {session.sessionId.slice(0, 18)}…
          </span>
        </button>
        {onDelete && (
          <button className="act-btn danger" onClick={onDelete}>
            <span className="act-glyph">×</span>
            delete · permanent
          </button>
        )}

        <div className="act-cancel">
          <button className="btn" onClick={onClose}>cancel</button>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { RowActions });
