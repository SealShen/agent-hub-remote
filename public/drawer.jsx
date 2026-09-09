// Drawer — left-side: project chips · new btn · filtered session list.
// One tap on a row enters thread. Running rows have an inline stop button.

const { useState: useStateD, useMemo: useMemoD } = React;

function ProjectChips({ projectFilter, setProjectFilter, sessions, onNew }) {
  const dirs = window.MOCK_DIRS;
  const counts = useMemoD(() => {
    const c = { __all: 0 };
    sessions.forEach(s => {
      if (s.status === 'archived') return;
      c.__all += 1;
      c[s.cwd] = (c[s.cwd] || 0) + 1;
    });
    return c;
  }, [sessions]);

  return (
    <div className="proj-row">
      <div className="proj-scroll">
        <button
          className={`proj-chip ${!projectFilter ? 'on' : ''}`}
          onClick={() => setProjectFilter(null)}>
          all <span className="pc-count">{counts.__all}</span>
        </button>
        {dirs.map(d => (
          <button key={d.alias}
            className={`proj-chip ${projectFilter === d.alias ? 'on' : ''}`}
            onClick={() => setProjectFilter(d.alias)}>
            {d.label} <span className="pc-count">{counts[d.alias] || 0}</span>
          </button>
        ))}
      </div>
      <button className="new-btn" onClick={onNew} aria-label="new conversation">
        <span className="ic-plus"/>
      </button>
    </div>
  );
}

function SessRow({ s, active, onTap, onStop, onLongPress, unread }) {
  const accent = window.ACCENTS[s.accent || 0];
  const showStop = s.status === 'running' || s.status === 'starting';
  const unreadCount = unread > 0 && window.AHR_showsUnread(s) ? unread : 0;
  const longPress = window.useLongPress
    ? window.useLongPress(() => onLongPress?.(s), 480)
    : {};
  return (
    <div
      className={`sess ${active ? 'active' : ''} ${s.status === 'archived' ? 'archived' : ''}`}
      style={active ? { borderLeftColor: accent } : null}
      role="button"
      tabIndex={0}
      onClick={onTap}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTap?.(); } }}
      {...longPress}>
      <span className={`dot ${s.status}`}/>
      <span className={`eng ${s.agentType === 'claude' ? 'cl' : 'cx'}`}>
        {s.agentType === 'claude' ? 'cl' : 'cx'}
      </span>
      <div className="sess-main">
        <div className="sess-name" style={{ color: active ? accent : undefined }}>
          {s.name}
        </div>
        <div className="sess-sub">
          <span>{window.STATUS_LABELS[s.status]}</span>
          <span style={{ color: 'var(--fg-mute)' }}>·</span>
          <span>{s.msgCount} msg</span>
          <span style={{ color: 'var(--fg-mute)' }}>·</span>
          <span>{window.formatRelative(s.updatedAt)}</span>
        </div>
      </div>
      {unreadCount > 0 && (
        <span className="unread-badge" aria-label={`${unreadCount} unread`}>
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
      {showStop && (
        <button
          className="stop-btn"
          onClick={(e) => { e.stopPropagation(); onStop?.(s); }}
          aria-label="stop">
        </button>
      )}
    </div>
  );
}

function Drawer({
  onClose,
  sessions,
  activeId,
  projectFilter,
  setProjectFilter,
  onPick,
  onStop,
  unread,
  onNew,
  onOpenSettings,
  onOpenUsage,
  onRefresh,
  refreshing,
  onLongPress,
}) {
  const [q, setQ] = useStateD('');

  const filtered = useMemoD(() => {
    return sessions.filter(s => {
      if (projectFilter && s.cwd !== projectFilter) return false;
      if (q && !s.name.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
  }, [sessions, projectFilter, q]);

  const main = filtered.filter(s => s.status !== 'archived');
  // Keep active rows chronological; users archive finished/error rows manually.
  main.sort((a, b) => b.updatedAt - a.updatedAt);
  const archived = filtered.filter(s => s.status === 'archived');

  // Many → show search
  const showSearch = sessions.filter(s => projectFilter ? s.cwd === projectFilter : true && s.status !== 'archived').length > 7;

  return (
    <>
      <div className="scrim" onClick={onClose}/>
      <div className="drawer">
        <div className="drawer-head">
          <button className="nav-btn" onClick={onClose} aria-label="close">
            <span className="ic-x"/>
          </button>
          <div className="host">
            <span className="h-state">●</span> {typeof window !== 'undefined' ? window.location.hostname : 'agent-hub'}
          </div>
          <button
            className="nav-btn"
            onClick={onRefresh}
            disabled={!!refreshing}
            aria-label="refresh native sessions">
            <span className="ic-restart"/>
          </button>
        </div>

        <ProjectChips
          projectFilter={projectFilter}
          setProjectFilter={setProjectFilter}
          sessions={sessions}
          onNew={onNew}
        />

        {showSearch && (
          <div className="d-search">
            <span className="ic-search"/>
            <input
              placeholder="search this project"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        )}

        <div className="scroll">
          {main.length === 0 && (
            <div className="empty">
              <div className="empty-h">no sessions in this project</div>
              <div>tap + to start one</div>
            </div>
          )}
          {main.map(s => (
            <SessRow key={s.sessionId}
              s={s}
              active={s.sessionId === activeId}
              onTap={() => onPick(s)}
              onStop={onStop}
              onLongPress={onLongPress}
              unread={unread ? unread[s.sessionId] : 0}
            />
          ))}

          {archived.length > 0 && (
            <>
              <div className="arch-div">archived · {archived.length}</div>
              {archived.map(s => (
                <SessRow key={s.sessionId}
                  s={s}
                  active={s.sessionId === activeId}
                  onTap={() => onPick(s)}
                  onLongPress={onLongPress}
                  unread={unread ? unread[s.sessionId] : 0}
                />
              ))}
            </>
          )}
        </div>

        <div className="d-foot">
          <button className="d-foot-btn" onClick={onOpenSettings}>⚙ settings</button>
          <button className="d-foot-btn" onClick={onOpenUsage}
            style={{ marginLeft: 14 }}>▤ 用量</button>
          <span style={{ flex: 1 }}/>
          <span>v0.1.0 · 50 cap</span>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { Drawer, ProjectChips, SessRow });
