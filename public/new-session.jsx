// new-session — full-height sheet from drawer's "+" button.
// Pick: project · engine · model · flags · optional first prompt.
// Title row left:  ←       right:  start (only enabled when project + engine + first prompt set)

const { useState: useStateNS, useMemo: useMemoNS } = React;

const ENGINES = [
  { id: 'claude', code: 'cl', name: 'claude',
    desc: 'sonnet/opus · tool-use heavy', accent: 'var(--eng-cl)' },
  { id: 'codex',  code: 'cx', name: 'codex',
    desc: 'gpt-5-codex · exec sandbox',   accent: 'var(--eng-cx)' },
];

const CLAUDE_MODELS = window.AHR_CLAUDE_MODELS || [
  { id: 'sonnet', label: 'sonnet', sub: 'default · fast' },
  { id: 'opus', label: 'opus', sub: 'deep · slow' },
  { id: 'haiku', label: 'haiku', sub: 'cheap · trivia' },
];

const MODELS = {
  claude: CLAUDE_MODELS,
  codex: [
    { id: 'default', label: 'default', sub: 'account default' },
  ],
};

function NewSession({ onClose, onStart, sessions, projectFilter }) {
  const dirs = window.MOCK_DIRS;
  const [cwd,    setCwd]    = useStateNS(projectFilter || dirs[0].alias);
  const [engine, setEngine] = useStateNS('claude');
  const [model,  setModel]  = useStateNS(MODELS.claude[0].id);
  // auto-allow：純前端 toggle，start 時才 step-up（spec §5.4）
  const [autoOn, setAutoOn] = useStateNS(false);
  const [prompt, setPrompt] = useStateNS('');

  function pickEngine(id) {
    setEngine(id);
    setModel(MODELS[id][0].id);
  }

  function toggleAuto() {
    if (autoOn) {
      if (window.confirm('關閉 auto mode？')) {
        setAutoOn(false);
      }
    } else {
      setAutoOn(true);
    }
  }

  const canStart = !!cwd && !!engine && !!model;
  const projectSessions = sessions.filter(s => s.cwd === cwd && s.status !== 'archived').length;

  return (
    <>
      <div className="sheet-scrim" onClick={onClose}/>
      <div className="sheet full">
        <div className="sheet-head">
          <button className="nav-btn" onClick={onClose} aria-label="back">
            <span className="ic-x"/>
          </button>
          <div className="crumb">
            <span className="crumb-cmd">new session</span>
            {cwd ? <span> · {cwd}</span> : null}
          </div>
        </div>

        <div className="sheet-body">
          {/* PROJECT */}
          <div className="sec">
            <div className="sec-h">
              project <span className="sec-hint">cwd · {projectSessions} active</span>
            </div>
            <div className="opt-grid">
              {dirs.map(d => (
                <button key={d.alias}
                  className={`opt ${cwd === d.alias ? 'on' : ''}`}
                  onClick={() => setCwd(d.alias)}>
                  <div className="opt-h">{d.label}</div>
                  <div className="opt-sub">{d.path}</div>
                </button>
              ))}
            </div>
          </div>

          {/* ENGINE */}
          <div className="sec">
            <div className="sec-h">engine</div>
            <div className="opt-grid">
              {ENGINES.map(e => (
                <button key={e.id}
                  className={`opt ${engine === e.id ? 'on' : ''}`}
                  onClick={() => pickEngine(e.id)}>
                  <div className="opt-h">
                    <span className={`eng ${e.code}`}>{e.code}</span>
                    {e.name}
                  </div>
                  <div className="opt-sub">{e.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* MODEL */}
          <div className="sec">
            <div className="sec-h">model</div>
            <div className={`opt-grid ${MODELS[engine].length === 3 ? 'cols-3' : ''}`}>
              {MODELS[engine].map(m => (
                <button key={m.id}
                  className={`opt ${model === m.id ? 'on' : ''}`}
                  onClick={() => setModel(m.id)}>
                  <div className="opt-h">{m.label}</div>
                  <div className="opt-sub">{m.sub}</div>
                </button>
              ))}
            </div>
          </div>

          {/* FLAGS */}
          <div className="sec" style={{ padding: 0 }}>
            <div className="sec-h" style={{ padding: '14px 14px 0' }}>flags</div>
            <div className="row" style={{ marginTop: 8 }}>
              <div className="r-label">
                auto-on
                <div className="r-sub">
                  {autoOn ? 'step-up required on start' : 'dangerous tool calls require step-up'}
                </div>
              </div>
              <button
                className={`tg ${autoOn ? 'on' : ''}`}
                onClick={toggleAuto}
                aria-label="auto-on">
                [{autoOn ? 'V' : ' '}]
              </button>
            </div>
          </div>

          {/* FIRST PROMPT */}
          <div className="sec">
            <div className="sec-h">
              first prompt <span className="sec-hint">optional · sets the session name</span>
            </div>
            <div className="ns-prompt">
              <div className="ns-tic">$</div>
              <textarea
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="describe the task, or leave blank to open empty…"
              />
            </div>
            <div className="hint">
              <span className="k">⏎</span> newline ·{' '}
              <span className="k">⌘⏎</span> start
            </div>
          </div>
        </div>

        <div className="sheet-foot">
          <button className="btn" onClick={onClose}>cancel</button>
          <button
            className="btn primary"
            disabled={!canStart}
            onClick={() => onStart({
              cwd, engine, model,
              autoAllow: autoOn,
              prompt,
            })}>
            <span className="ic-send" style={{ marginRight: 4 }}/>
            start session
          </button>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { NewSession });
