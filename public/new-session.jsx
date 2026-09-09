// new-session — full-height sheet from drawer's "+" button.
// Pick: project · engine · model · flags · first prompt and/or attachments.
// Title row left:  ←       right:  start (enabled when setup + first-turn content are ready)

const { useState: useStateNS, useMemo: useMemoNS, useRef: useRefNS } = React;

const ENGINES = [
  { id: 'claude', code: 'cl', name: 'claude',
    desc: 'sonnet/opus · tool-use heavy', accent: 'var(--eng-cl)' },
  { id: 'codex',  code: 'cx', name: 'codex',
    desc: 'gpt-5-codex · exec sandbox',   accent: 'var(--eng-cx)' },
];

// data.js 的 AHR_CLAUDE_MODELS 是唯一真相；這份只在它沒載入時頂替，兩邊要一起改。
const CLAUDE_MODELS = window.AHR_CLAUDE_MODELS || [
  { id: 'sonnet', label: 'sonnet', sub: 'default · fast' },
  { id: 'opus', label: 'opus', sub: 'deep · agentic' },
  { id: 'haiku', label: 'haiku', sub: 'cheap · trivia' },
  { id: 'fable', label: 'fable', sub: 'creative · prose' },
];

const MODELS = {
  claude: CLAUDE_MODELS,
  codex: [
    { id: 'default', label: 'default', sub: 'account default' },
  ],
};
const EFFORTS = window.AHR_EFFORT_LEVELS || {
  claude: [
    { id: 'default', label: 'default', sub: 'Claude default' },
    { id: 'low', label: 'low', sub: 'fast · scoped' },
    { id: 'medium', label: 'medium', sub: 'lower spend' },
    { id: 'high', label: 'high', sub: 'balanced' },
    { id: 'xhigh', label: 'xhigh', sub: 'coding · deep' },
    { id: 'max', label: 'max', sub: 'session only' },
  ],
  codex: [
    { id: 'default', label: 'default', sub: 'Codex config' },
    { id: 'low', label: 'low', sub: 'fast' },
    { id: 'medium', label: 'medium', sub: 'balanced' },
    { id: 'high', label: 'high', sub: 'complex' },
    { id: 'xhigh', label: 'xhigh', sub: 'deepest' },
  ],
};

function NewSession({ onClose, onStart, onFilesChanged, onDiscard, sessions, projectFilter }) {
  const dirs = window.MOCK_DIRS;
  const [cwd,    setCwd]    = useStateNS(projectFilter || dirs[0].alias);
  const [engine, setEngine] = useStateNS('claude');
  const [model,  setModel]  = useStateNS(MODELS.claude[0].id);
  const [effort, setEffort] = useStateNS('default');
  // auto-allow：純前端 toggle，start 時才 step-up（spec §5.4）
  const [autoOn, setAutoOn] = useStateNS(false);
  const [prompt, setPrompt] = useStateNS('');
  // 附件：這裡只留瀏覽器端的 dataUrl，實際上傳等按下 start 才做（取消就什麼都沒發生）
  const [files, setFiles] = useStateNS([]);
  const [filesRevision, setFilesRevision] = useStateNS(0);
  const [readingFiles, setReadingFiles] = useStateNS(0);
  const [starting, setStarting] = useStateNS(false);
  const startingRef = useRefNS(false);
  const fileRef = useRefNS(null);
  const requestIdRef = useRefNS(
    (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : `new-session-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  function pickEngine(id) {
    setEngine(id);
    setModel(MODELS[id][0].id);
    setEffort('default');
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

  function addFiles(picked) {
    if (startingRef.current) return;
    for (const file of picked) {
      const reader = new FileReader();
      setReadingFiles(prev => prev + 1);
      reader.onload = (e) => {
        setFiles(prev => [...prev, {
          dataUrl: e.target.result,
          name: file.name || 'attachment.bin',
          type: file.type || '',
          size: file.size,
          isImage: !!(file.type && file.type.startsWith('image/')),
        }]);
        setFilesRevision(prev => prev + 1);
        if (onFilesChanged) onFilesChanged(requestIdRef.current);
      };
      reader.onerror = () => window.alert(`無法讀取附件：${file.name || 'attachment.bin'}`);
      reader.onloadend = () => setReadingFiles(prev => Math.max(0, prev - 1));
      reader.readAsDataURL(file);
    }
  }

  function handlePick(e) {
    addFiles(Array.from(e.target.files || []));
    e.target.value = '';
  }

  function handlePaste(e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addFiles([file]);
        break;
      }
    }
  }

  function removeFile(idx) {
    if (startingRef.current || idx < 0 || idx >= files.length) return;
    setFiles(prev => prev.filter((_, i) => i !== idx));
    setFilesRevision(prev => prev + 1);
    if (onFilesChanged) onFilesChanged(requestIdRef.current);
  }

  function closeSheet() {
    if (startingRef.current) return;
    if (onDiscard) onDiscard(requestIdRef.current);
    onClose();
  }

  const ready = !!cwd && !!engine && !!model;
  const hasFirstTurn = prompt.trim().length > 0 || files.length > 0;
  const canStart = ready && hasFirstTurn && !starting && readingFiles === 0;
  const projectSessions = sessions.filter(s => s.cwd === cwd && s.status !== 'archived').length;

  async function startSession() {
    if (!canStart || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      await onStart({
        cwd, engine, model, effort,
        autoAllow: autoOn,
        prompt,
        files,
        clientRequestId: requestIdRef.current,
        attachmentIdentity: `${requestIdRef.current}:${filesRevision}`,
      });
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  return (
    <>
      <div className="sheet-scrim" onClick={closeSheet}/>
      <div className="sheet full">
        <div className="sheet-head">
          <button className="nav-btn" onClick={closeSheet} aria-label="back">
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
            {/* 預設 2 欄：claude 四個 model 排成 2×2，手機上比擠成一排好按 */}
            <div className="opt-grid">
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

          {/* EFFORT */}
          <div className="sec">
            <div className="sec-h">effort</div>
            <div className="opt-grid cols-3">
              {(EFFORTS[engine] || EFFORTS.claude).map(e => (
                <button key={e.id}
                  className={`opt ${effort === e.id ? 'on' : ''}`}
                  onClick={() => setEffort(e.id)}>
                  <div className="opt-h">{e.label}</div>
                  <div className="opt-sub">{e.sub}</div>
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
                onPaste={handlePaste}
                placeholder="describe the task, or attach files…"
              />
            </div>
            {files.length > 0 && (
              <div className="file-strip">
                {files.map((file, i) => (
                  <div key={i} className="file-chip" title={file.name}>
                    {file.isImage
                      ? <img src={file.dataUrl} alt={file.name}/>
                      : <span className="file-icon">file</span>}
                    <span className="file-name">{file.name}</span>
                    <span className="file-size">
                      {window.AHR_fmtBytes ? window.AHR_fmtBytes(file.size) : ''}
                    </span>
                    <button className="file-rm" onClick={() => removeFile(i)} aria-label="remove file">x</button>
                  </div>
                ))}
              </div>
            )}
            <div className="hint" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span>
                <span className="k">⏎</span> newline ·{' '}
                <span className="k">⌘⏎</span> start
              </span>
              <span style={{ flex: 1 }}/>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="file-input"
                onChange={handlePick}
              />
              <button
                className="btn"
                disabled={starting || readingFiles > 0}
                onClick={() => fileRef.current && fileRef.current.click()}>
                <span className="ic-attach" style={{ marginRight: 4 }}/>
                {readingFiles > 0 ? 'reading…' : `attach${files.length ? ` · ${files.length}` : ''}`}
              </button>
            </div>
          </div>
        </div>

        <div className="sheet-foot">
          <button className="btn" onClick={closeSheet} disabled={starting}>cancel</button>
          <button
            className="btn primary"
            disabled={!canStart}
            onClick={startSession}>
            <span className="ic-send" style={{ marginRight: 4 }}/>
            {starting ? 'starting...' : 'start session'}
          </button>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { NewSession });
