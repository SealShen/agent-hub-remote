// options — bottom sheet from the gear icon on Thread's nav row.
// Per-session controls: engine swap · model · flags · rename · archive · delete · meta.

const { useState: useStateO } = React;
const CLAUDE_MODEL_ORDER = window.AHR_CLAUDE_MODEL_ORDER || ['sonnet', 'opus', 'haiku'];

function OptRow({ label, sub, right, onClick, danger, warn }) {
  const cls = `row ${danger ? 'danger' : ''} ${warn ? 'warn' : ''}`;
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={cls} onClick={onClick}
      style={onClick ? { width: '100%', textAlign: 'left' } : null}>
      <div className="r-label">
        {label}
        {sub ? <div className="r-sub">{sub}</div> : null}
      </div>
      {right}
    </Tag>
  );
}

function shortId(id) {
  if (!id) return '-';
  const s = String(id);
  return s.length > 30 ? s.slice(0, 30) + '...' : s;
}

function MetaId({ k, v }) {
  if (!v) return null;
  return <div><span className="k">{k}</span>{' '}<span className="v">{shortId(v)}</span></div>;
}

function Options({ session, onClose, onSwapEngine, onChangeModel, onToggleAuto,
                   onToggleElevated, onRename, onArchive, onDelete }) {
  const [confirm, setConfirm] = useStateO(null); // null | 'archive' | 'delete'
  const accent = window.ACCENTS[session.accent || 0];
  const selectedModel = session.agentType === 'codex'
    ? 'default'
    : (session.model || CLAUDE_MODEL_ORDER[0]);

  const modelList = session.agentType === 'claude'
    ? CLAUDE_MODEL_ORDER
    : ['default'];   // codex：用帳號預設 model（ChatGPT 帳號不支援 gpt-5-codex 寫死 id）
  const refs = session._engineRefs || {};
  const resetRefs = session._contextReset && session._contextReset.previousEngineRefs
    ? session._contextReset.previousEngineRefs
    : {};
  const resetLabel = session._contextReset
    ? `${session._contextReset.op || 'reset'} previous`
    : '';

  return (
    <>
      <div className="sheet-scrim" onClick={onClose}/>
      <div className="sheet" style={{ '--accent': accent }}>
        <div className="sheet-head">
          <div className="crumb">
            <span className="dot idle" style={{ background: accent, marginRight: 6, verticalAlign: 'middle' }}/>
            <span className="crumb-cmd">session options</span>
          </div>
          <button className="nav-btn" onClick={onClose} aria-label="close">
            <span className="ic-x"/>
          </button>
        </div>

        <div className="sheet-body">
          {/* ENGINE / MODEL */}
          <div className="sec">
            <div className="sec-h">engine</div>
            <div className="opt-grid">
              {[
                { id: 'claude', code: 'cl', name: 'claude' },
                { id: 'codex',  code: 'cx', name: 'codex'  },
              ].map(e => {
                const isCurrent = session.agentType === e.id;
                return (
                  <button key={e.id}
                    className={`opt ${isCurrent ? 'on' : ''}`}
                    onClick={() => { if (!isCurrent) onSwapEngine(e.id); }}>
                    <div className="opt-h">
                      <span className={`eng ${e.code}`}>{e.code}</span>
                      {e.name}
                    </div>
                    <div className="opt-sub">
                      {isCurrent ? 'current' : 'switch · carries 8k ctx'}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="sec">
            <div className="sec-h">model</div>
            <div className={`opt-grid ${modelList.length === 3 ? 'cols-3' : ''}`}>
              {modelList.map(m => (
                <button key={m}
                  className={`opt ${selectedModel === m ? 'on' : ''}`}
                  onClick={() => onChangeModel(m)}>
                  <div className="opt-h" style={{ fontSize: 13 }}>
                    {window.AHR_modelLabel ? window.AHR_modelLabel(m, session.agentType) : m}
                  </div>
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <div className="r-label">
                auto-on
                <div className="r-sub">
                  {session.autoAllow ? 'on - --dangerously-skip-permissions' : 'TOTP step-up required to enable'}
                </div>
              </div>
              <button
                className={`tg ${session.autoAllow ? 'on' : ''}`}
                onClick={() => { if (onToggleAuto) onToggleAuto(); }}
                aria-label="auto-on">
                [{session.autoAllow ? 'V' : ' '}]
              </button>
            </div>
          </div>

          {/* META */}
          <div className="sec" style={{ padding: 0 }}>
            <div className="sec-h" style={{ padding: '14px 14px 8px' }}>metadata</div>
            <div className="row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, paddingTop: 8, paddingBottom: 10 }}>
              <div className="su-meta" style={{ width: '100%' }}>
                <div><span className="k">hub id</span>{' '}<span className="v">{shortId(session.sessionId)}</span></div>
                <MetaId k="claude id" v={refs.claude}/>
                <MetaId k="codex id" v={refs.codex}/>
                {resetLabel ? <div><span className="k">{resetLabel}</span></div> : null}
                <MetaId k="old claude" v={resetRefs.claude}/>
                <MetaId k="old codex" v={resetRefs.codex}/>
                <div><span className="k">cwd</span>{' '}<span className="v">{session.cwd}</span></div>
                <div><span className="k">msgs</span>{' '}<span className="v">{session.msgCount}</span></div>
              </div>
            </div>
            <OptRow
              label="rename"
              sub="set a custom name"
              onClick={onRename}
              right={<span style={{ color: 'var(--fg-mute)' }}>›</span>}
            />
          </div>

          {/* DANGER */}
          <div className="sec" style={{ padding: 0 }}>
            <div className="sec-h" style={{ padding: '14px 14px 8px' }}>session</div>
            <OptRow
              label={session.status === 'archived' ? 'unarchive' : 'archive'}
              sub="keep in list, hide by default"
              onClick={() => setConfirm('archive')}
              right={<span style={{ color: 'var(--fg-mute)' }}>›</span>}
            />
            {onDelete && (
              <OptRow
                label="delete session"
                sub="remove JSONL + drop index entry"
                danger
                onClick={() => setConfirm('delete')}
                right={<span style={{ color: 'var(--st-error)' }}>›</span>}
              />
            )}
          </div>
        </div>

        {confirm ? (
          <div className="sheet-foot" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <div className="hint" style={{ padding: 0, color: confirm === 'delete' ? 'var(--st-error)' : 'var(--st-interrupted)' }}>
              {confirm === 'delete'
                ? '⚠ this is permanent. JSONL + metadata will be removed.'
                : 'archive will keep the JSONL but hide the row by default.'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setConfirm(null)}>cancel</button>
              <button
                className={`btn ${confirm === 'delete' ? 'danger' : 'warn'}`}
                onClick={() => {
                  if (confirm === 'delete') onDelete();
                  else onArchive();
                  setConfirm(null);
                }}>
                {confirm === 'delete' ? 'delete · permanent' : 'archive'}
              </button>
            </div>
          </div>
        ) : (
          <div className="sheet-foot">
            <button className="btn" onClick={onClose} style={{ flex: 1 }}>done</button>
          </div>
        )}
      </div>
    </>
  );
}

Object.assign(window, { Options, OptRow });
